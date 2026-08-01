/**
 * Local MiniLM embeddings for tree-consolidation pairing and new-node embedding.
 * Vectors are rebuildable derived rows; cosine similarity is computed in-process.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_EMBEDDING_MODEL_ID } from "./memory-types.ts";

export type MemoryEmbedFn = (texts: string[]) => Promise<Float32Array[]>;

interface MemoryEmbedderCacheEntry {
  embedder: MemoryEmbedFn | null;
  loadError: string | null;
  loading: Promise<MemoryEmbedFn | null> | null;
}

const memoryEmbedderCache = new Map<string, MemoryEmbedderCacheEntry>();

function getMemoryEmbedderCacheEntry(
  modelId: string,
): MemoryEmbedderCacheEntry {
  let entry = memoryEmbedderCache.get(modelId);
  if (!entry) {
    entry = { embedder: null, loadError: null, loading: null };
    memoryEmbedderCache.set(modelId, entry);
  }
  return entry;
}

/** Factory seam for deterministic embedder-load cancellation tests. */
export type MemoryEmbedderFactory = (modelId: string) => Promise<MemoryEmbedFn>;

let memoryEmbedderFactoryForTests: MemoryEmbedderFactory | null = null;

/** Content hash for embedding invalidation. */
export function hashMemoryEmbeddingContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarityMemoryVectors(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function float32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Create an embedder without binding it to any one caller's abort signal. */
async function createMemoryEmbedder(modelId: string): Promise<MemoryEmbedFn> {
  if (memoryEmbedderFactoryForTests) {
    return memoryEmbedderFactoryForTests(modelId);
  }

  const transformers = await import("@xenova/transformers");
  const { pipeline, env } = transformers as {
    pipeline: (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<
      (
        texts: string | string[],
        opts?: Record<string, unknown>,
      ) => Promise<{ data: Float32Array; dims: number[] }>
    >;
    env: { allowLocalModels?: boolean; useBrowserCache?: boolean };
  };
  // Prefer cache; allow remote download on first use.
  if (env) {
    env.allowLocalModels = true;
  }
  const extractor = await pipeline("feature-extraction", modelId, {
    quantized: true,
  });
  return async (texts) => {
    const out: Float32Array[] = [];
    for (const text of texts) {
      const result = await extractor(text, {
        pooling: "mean",
        normalize: true,
      });
      const data = result.data;
      out.push(
        data instanceof Float32Array
          ? data
          : Float32Array.from(data as ArrayLike<number>),
      );
    }
    return out;
  };
}

interface MemoryEmbedderLoadWaiter {
  finish: (embedder: MemoryEmbedFn | null) => void;
  fail: (error: unknown) => void;
  cancel: () => void;
}

// Keep one settlement reaction per shared load. Per-caller abort listeners are
// removed from this registry immediately, so a stalled model load does not
// retain every cancelled caller's closure and AbortSignal.
const memoryEmbedderLoadWaiters = new WeakMap<
  Promise<MemoryEmbedFn | null>,
  Set<MemoryEmbedderLoadWaiter>
>();
const memoryEmbedderLoadSettlementHandlers = new WeakSet<
  Promise<MemoryEmbedFn | null>
>();

function settleMemoryEmbedderLoadWaiters(
  loading: Promise<MemoryEmbedFn | null>,
  embedder: MemoryEmbedFn | null,
): void {
  const waiters = memoryEmbedderLoadWaiters.get(loading);
  if (!waiters) return;
  memoryEmbedderLoadWaiters.delete(loading);
  for (const waiter of waiters) waiter.finish(embedder);
}

function failMemoryEmbedderLoadWaiters(
  loading: Promise<MemoryEmbedFn | null>,
  error: unknown,
): void {
  const waiters = memoryEmbedderLoadWaiters.get(loading);
  if (!waiters) return;
  memoryEmbedderLoadWaiters.delete(loading);
  for (const waiter of waiters) waiter.fail(error);
}

function registerMemoryEmbedderLoadSettlement(
  loading: Promise<MemoryEmbedFn | null>,
): Set<MemoryEmbedderLoadWaiter> {
  let waiters = memoryEmbedderLoadWaiters.get(loading);
  if (!waiters) {
    waiters = new Set<MemoryEmbedderLoadWaiter>();
    memoryEmbedderLoadWaiters.set(loading, waiters);
  }
  if (!memoryEmbedderLoadSettlementHandlers.has(loading)) {
    memoryEmbedderLoadSettlementHandlers.add(loading);
    // The shared handler owns no caller-specific references. Each caller is
    // represented only while it is actively waiting in the registry above.
    void loading.then(
      (embedder) => settleMemoryEmbedderLoadWaiters(loading, embedder),
      (error: unknown) => failMemoryEmbedderLoadWaiters(loading, error),
    );
  }
  return waiters;
}

/** Return a shared load result, or detach this caller as soon as it aborts. */
function waitForMemoryEmbedderLoad(
  loading: Promise<MemoryEmbedFn | null>,
  signal?: AbortSignal,
): Promise<MemoryEmbedFn | null> {
  if (!signal) return loading;
  if (signal.aborted) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const waiters = registerMemoryEmbedderLoadSettlement(loading);
    // Two-phase init: the wait-handle must exist before its own cancel/cleanup
    // closures reference it, so it cannot be reduced to a const initializer.
    // eslint-disable-next-line prefer-const
    let waiter!: MemoryEmbedderLoadWaiter;
    let active = true;

    const removeWaiter = () => {
      const pending = memoryEmbedderLoadWaiters.get(loading);
      if (!pending) return;
      pending.delete(waiter);
      if (pending.size === 0) memoryEmbedderLoadWaiters.delete(loading);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", waiter.cancel);
    };
    waiter = {
      finish: (embedder) => {
        if (!active) return;
        active = false;
        cleanup();
        resolve(embedder);
      },
      fail: (error) => {
        if (!active) return;
        active = false;
        cleanup();
        reject(error);
      },
      cancel: () => {
        if (!active) return;
        active = false;
        cleanup();
        removeWaiter();
        resolve(null);
      },
    };

    waiters.add(waiter);
    signal.addEventListener("abort", waiter.cancel, { once: true });
    if (signal.aborted) waiter.cancel();
  });
}

/**
 * Load the local transformers.js MiniLM pipeline (lazy, cached).
 * Returns null and records degraded status when unavailable. An aborted caller
 * detaches immediately while a shared load continues for a later active turn.
 */
export async function loadMemoryEmbedder(
  modelId: string = MEMORY_EMBEDDING_MODEL_ID,
  signal?: AbortSignal,
): Promise<MemoryEmbedFn | null> {
  if (signal?.aborted) return null;
  const entry = getMemoryEmbedderCacheEntry(modelId);
  if (entry.embedder) return entry.embedder;
  if (entry.loadError) return null;

  if (!entry.loading) {
    entry.loading = createMemoryEmbedder(modelId)
      .then((embedder) => {
        entry.embedder = embedder;
        entry.loadError = null;
        return embedder;
      })
      .catch((err: unknown) => {
        entry.loadError = err instanceof Error ? err.message : String(err);
        entry.embedder = null;
        return null;
      })
      .finally(() => {
        entry.loading = null;
      });
  }

  return waitForMemoryEmbedderLoad(entry.loading, signal);
}

/**
 * In-process embedder availability. The embedder loads lazily on first use by
 * tree consolidation (merge pairing) or dreaming (new-node embedding), so a
 * fresh pi process reports `not_loaded` until a consolidation pass or dreaming
 * run warms it up. Splitting `not_loaded` / `loading` / `failed` prevents the
 * status from mistaking a lazy-load cold start for a broken index.
 */
export type MemoryEmbeddingState =
  "ready" | "loading" | "failed" | "not_loaded";

/** Whether semantic indexing is currently available for a model. */
export function memoryEmbeddingStatus(
  modelId: string = MEMORY_EMBEDDING_MODEL_ID,
): {
  state: MemoryEmbeddingState;
  available: boolean;
  error: string | null;
  modelId: string;
} {
  const entry = getMemoryEmbedderCacheEntry(modelId);
  const state: MemoryEmbeddingState =
    entry.embedder !== null && entry.loadError === null
      ? "ready"
      : entry.loadError !== null
        ? "failed"
        : entry.loading !== null
          ? "loading"
          : "not_loaded";
  return {
    state,
    available: state === "ready",
    error: entry.loadError,
    modelId,
  };
}

/** Inject a fake embedder (tests). */
export function setMemoryEmbedderForTests(
  fn: MemoryEmbedFn | null,
  modelId: string = MEMORY_EMBEDDING_MODEL_ID,
): void {
  memoryEmbedderFactoryForTests = null;
  const entry = getMemoryEmbedderCacheEntry(modelId);
  entry.embedder = fn;
  entry.loadError = fn ? null : "test: embedder disabled";
  entry.loading = null;
}

/** Inject a deferred embedder factory for load/cancellation tests. */
export function setMemoryEmbedderFactoryForTests(
  factory: MemoryEmbedderFactory | null,
): void {
  memoryEmbedderFactoryForTests = factory;
  memoryEmbedderCache.clear();
}

/** Reset embedder cache (tests). */
export function resetMemoryEmbedderForTests(): void {
  memoryEmbedderFactoryForTests = null;
  memoryEmbedderCache.clear();
}

function deleteMemoryEmbeddingRow(
  db: DatabaseSync,
  nodeType: string,
  nodeId: number,
  modelId: string,
): void {
  db.prepare(
    `DELETE FROM embeddings WHERE node_type = ? AND node_id = ? AND model_id = ?`,
  ).run(nodeType, nodeId, modelId);
}

/**
 * Ensure embeddings exist for all active search documents; skip unchanged hashes.
 * An empty index returns immediately without touching the embedder, so the
 * first turn on an empty workspace never blocks on a MiniLM download.
 */
export async function ensureMemoryEmbeddings(
  db: DatabaseSync,
  opts?: {
    modelId?: string;
    embed?: MemoryEmbedFn | null;
    signal?: AbortSignal;
  },
): Promise<{ updated: number; degraded: boolean; error?: string }> {
  const modelId = opts?.modelId ?? MEMORY_EMBEDDING_MODEL_ID;
  const signal = opts?.signal;
  if (signal?.aborted) {
    return { updated: 0, degraded: true, error: "aborted" };
  }

  const docs = db
    .prepare(
      `SELECT node_type, node_id, text FROM search_documents WHERE state = 'active'`,
    )
    .all() as Array<{ node_type: string; node_id: number; text: string }>;
  if (docs.length === 0) {
    return { updated: 0, degraded: false };
  }

  const embed =
    opts?.embed !== undefined
      ? opts.embed
      : await loadMemoryEmbedder(modelId, signal);
  if (!embed) {
    return {
      updated: 0,
      degraded: true,
      error: signal?.aborted
        ? "aborted"
        : (getMemoryEmbedderCacheEntry(modelId).loadError ??
          "Semantic embedder unavailable"),
    };
  }

  let updated = 0;
  for (const doc of docs) {
    if (signal?.aborted) {
      return { updated, degraded: true, error: "aborted" };
    }
    const contentHash = hashMemoryEmbeddingContent(doc.text);
    const existing = db
      .prepare(
        `SELECT content_hash FROM embeddings
         WHERE node_type = ? AND node_id = ? AND model_id = ?`,
      )
      .get(doc.node_type, doc.node_id, modelId) as
      { content_hash: string } | undefined;
    if (existing?.content_hash === contentHash) continue;

    let vector: Float32Array | undefined;
    try {
      const vectors = await embed([doc.text]);
      vector = vectors[0];
    } catch (err) {
      // Failed re-embed must not leave a stale vector for the old content hash.
      deleteMemoryEmbeddingRow(db, doc.node_type, doc.node_id, modelId);
      const detail = err instanceof Error ? err.message : String(err);
      return { updated, degraded: true, error: detail };
    }
    if (signal?.aborted) {
      return { updated, degraded: true, error: "aborted" };
    }
    if (!vector) {
      deleteMemoryEmbeddingRow(db, doc.node_type, doc.node_id, modelId);
      continue;
    }
    db.prepare(
      `INSERT INTO embeddings (node_type, node_id, model_id, content_hash, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(node_type, node_id, model_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         vector = excluded.vector,
         updated_at = datetime('now')`,
    ).run(
      doc.node_type,
      doc.node_id,
      modelId,
      contentHash,
      float32ToBuffer(vector),
    );
    updated++;
  }
  return { updated, degraded: false };
}
