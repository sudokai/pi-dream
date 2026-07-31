/**
 * Local MiniLM embeddings for hybrid memory search.
 * Vectors are rebuildable derived rows; cosine similarity is computed in-process.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_EMBEDDING_MODEL_ID,
  MEMORY_SEMANTIC_FLOOR,
} from "./memory-types.ts";

export type MemoryEmbedFn = (texts: string[]) => Promise<Float32Array[]>;

let cachedEmbedder: MemoryEmbedFn | null = null;
let embedderLoadError: string | null = null;
let embedderLoading: Promise<MemoryEmbedFn | null> | null = null;

/** Factory seam for deterministic embedder-load cancellation tests. */
export type MemoryEmbedderFactory = (
  modelId: string,
) => Promise<MemoryEmbedFn>;

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

function bufferToFloat32(buf: Buffer | Uint8Array): Float32Array {
  const copy = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Ensure alignment
  const aligned = new Float32Array(copy.byteLength / 4);
  const view = new Uint8Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength,
  );
  view.set(copy.subarray(0, aligned.byteLength));
  return aligned;
}

/** Create an embedder without binding it to any one caller's abort signal. */
async function createMemoryEmbedder(
  modelId: string,
): Promise<MemoryEmbedFn> {
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
  if (cachedEmbedder) return cachedEmbedder;
  if (embedderLoadError) return null;

  if (!embedderLoading) {
    embedderLoading = createMemoryEmbedder(modelId)
      .then((embedder) => {
        cachedEmbedder = embedder;
        embedderLoadError = null;
        return embedder;
      })
      .catch((err: unknown) => {
        embedderLoadError =
          err instanceof Error ? err.message : String(err);
        cachedEmbedder = null;
        return null;
      })
      .finally(() => {
        embedderLoading = null;
      });
  }

  return waitForMemoryEmbedderLoad(embedderLoading, signal);
}

/** Whether semantic indexing is currently degraded. */
export function memoryEmbeddingStatus(): {
  available: boolean;
  error: string | null;
  modelId: string;
} {
  return {
    available: cachedEmbedder !== null && embedderLoadError === null,
    error: embedderLoadError,
    modelId: MEMORY_EMBEDDING_MODEL_ID,
  };
}

/** Inject a fake embedder (tests). */
export function setMemoryEmbedderForTests(fn: MemoryEmbedFn | null): void {
  memoryEmbedderFactoryForTests = null;
  cachedEmbedder = fn;
  embedderLoadError = fn ? null : "test: embedder disabled";
  embedderLoading = null;
}

/** Inject a deferred embedder factory for load/cancellation tests. */
export function setMemoryEmbedderFactoryForTests(
  factory: MemoryEmbedderFactory | null,
): void {
  memoryEmbedderFactoryForTests = factory;
  cachedEmbedder = null;
  embedderLoadError = null;
  embedderLoading = null;
}

/** Reset embedder cache (tests). */
export function resetMemoryEmbedderForTests(): void {
  memoryEmbedderFactoryForTests = null;
  cachedEmbedder = null;
  embedderLoadError = null;
  embedderLoading = null;
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
    opts?.embed !== undefined ? opts.embed : await loadMemoryEmbedder(modelId, signal);
  if (!embed) {
    return {
      updated: 0,
      degraded: true,
      error: signal?.aborted
        ? "aborted"
        : (embedderLoadError ?? "Semantic embedder unavailable"),
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
      | { content_hash: string }
      | undefined;
    if (existing?.content_hash === contentHash) continue;

    const [vector] = await embed([doc.text]);
    if (signal?.aborted) {
      return { updated, degraded: true, error: "aborted" };
    }
    if (!vector) continue;
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

export interface MemorySemanticHit {
  nodeType: "memory" | "summary";
  nodeId: number;
  score: number;
}

/**
 * Rank active nodes by cosine similarity to the query embedding.
 * An empty index short-circuits before the embedder loads, so semantic
 * search never triggers a MiniLM download for a workspace with no memories.
 */
export async function searchMemorySemantic(
  db: DatabaseSync,
  query: string,
  opts?: {
    modelId?: string;
    embed?: MemoryEmbedFn | null;
    floor?: number;
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<{ hits: MemorySemanticHit[]; degraded: boolean; error?: string }> {
  const modelId = opts?.modelId ?? MEMORY_EMBEDDING_MODEL_ID;
  const floor = opts?.floor ?? MEMORY_SEMANTIC_FLOOR;
  const limit = opts?.limit ?? 50;
  const signal = opts?.signal;
  if (signal?.aborted) {
    return { hits: [], degraded: true, error: "aborted" };
  }

  const docCount = db
    .prepare(`SELECT COUNT(*) AS n FROM search_documents WHERE state = 'active'`)
    .get() as { n: number };
  if (Number(docCount.n) === 0) {
    return { hits: [], degraded: false };
  }

  const embed =
    opts?.embed !== undefined ? opts.embed : await loadMemoryEmbedder(modelId, signal);
  if (!embed) {
    return {
      hits: [],
      degraded: true,
      error: signal?.aborted
        ? "aborted"
        : (embedderLoadError ?? "Semantic embedder unavailable"),
    };
  }

  try {
    await ensureMemoryEmbeddings(db, { modelId, embed, signal });

    if (signal?.aborted) {
      return { hits: [], degraded: true, error: "aborted" };
    }
    const [queryVec] = await embed([query]);
    if (signal?.aborted) {
      return { hits: [], degraded: true, error: "aborted" };
    }
    if (!queryVec) {
      return { hits: [], degraded: true, error: "Failed to embed query" };
    }

    const rows = db
      .prepare(
        `SELECT e.node_type, e.node_id, e.vector
         FROM embeddings e
         JOIN search_documents d
           ON d.node_type = e.node_type AND d.node_id = e.node_id
         WHERE e.model_id = ? AND d.state = 'active'`,
      )
      .all(modelId) as Array<{
      node_type: "memory" | "summary";
      node_id: number;
      vector: Buffer;
    }>;

    const scored: MemorySemanticHit[] = [];
    for (const row of rows) {
      const vec = bufferToFloat32(row.vector);
      const score = cosineSimilarityMemoryVectors(queryVec, vec);
      if (score >= floor) {
        scored.push({
          nodeType: row.node_type,
          nodeId: Number(row.node_id),
          score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return { hits: scored.slice(0, limit), degraded: false };
  } catch (err) {
    if (signal?.aborted) {
      return { hits: [], degraded: true, error: "aborted" };
    }
    throw err;
  }
}
