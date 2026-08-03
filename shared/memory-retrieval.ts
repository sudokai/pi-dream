/**
 * Retrieval layer for adaptive memory: RRF fusion of FTS5 (lexical) and
 * MiniLM (semantic) over active memories. Recall-tuned, never precision:
 * the only exclusion is the semantic cosine floor; anything a retriever
 * surfaces stays surfaced. Never writes; never records citations.
 *
 * Query embedding runs on the interactive first turn, so the MiniLM
 * embedder is only touched when the vector index is non-empty (mirroring
 * ensureMemoryEmbeddings' empty-index guard). A missing or failing
 * embedder degrades to lexical-only retrieval.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  cosineSimilarityMemoryVectors,
  loadMemoryEmbedder,
  type MemoryEmbedFn,
} from "./memory-embedding.ts";
import {
  MEMORY_EMBEDDING_MODEL_ID,
  MEMORY_RETRIEVAL_COSINE_FLOOR,
  MEMORY_RETRIEVAL_MAX_CHARS,
  MEMORY_RETRIEVAL_MAX_UNITS,
  MEMORY_RETRIEVAL_MIN_QUERY_CHARS,
  MEMORY_RETRIEVAL_RRF_K,
  MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS,
  type MemoryKnowledgeKind,
  type MemoryLifecycleState,
  type MemoryNodeId,
} from "./memory-types.ts";

/** One retrieved memory candidate with per-retriever ranks retained. */
export interface MemoryRetrievalCandidate {
  nodeType: "memory";
  nodeId: number;
  prefixedId: MemoryNodeId;
  kind: MemoryKnowledgeKind;
  state: MemoryLifecycleState;
  text: string;
  recurrence: number;
  /** Fused RRF score (higher is better). */
  score: number;
  /** 1-based rank within the lexical retriever, or null when it missed. */
  lexicalRank: number | null;
  /** 1-based rank within the semantic retriever, or null when it missed. */
  semanticRank: number | null;
  /** Cosine score from the semantic retriever, or null. */
  semanticScore: number | null;
}

export interface MemoryRetrievalOptions {
  modelId?: string;
  /** Test seam; defaults to the local MiniLM pipeline. */
  embed?: MemoryEmbedFn | null;
  signal?: AbortSignal;
  maxUnits?: number;
  maxChars?: number;
  rrfK?: number;
  cosineFloor?: number;
}

export interface MemoryRetrievalResult {
  candidates: MemoryRetrievalCandidate[];
  /** Segments the query was split into for retrieval. */
  segments: string[];
  /** True when the embedder was unavailable/failed; semantic side skipped. */
  semanticDegraded: boolean;
  /** True when retrieval was skipped entirely (blank/greeting query). */
  skipped: boolean;
}

interface RetrievedNode {
  nodeType: "memory";
  nodeId: number;
  text: string;
  kind: MemoryKnowledgeKind;
  state: MemoryLifecycleState;
  recurrence: number;
  /** Best (lowest) lexical rank across segments, or null. */
  lexicalRank: number | null;
  /** Best (lowest) semantic rank across segments, or null. */
  semanticRank: number | null;
  /** Best (highest) semantic cosine across segments, or null. */
  semanticScore: number | null;
}

function loadRetrievedNode(
  db: DatabaseSync,
  nodeId: number,
): RetrievedNode | null {
  const row = db
    .prepare(
      `SELECT m.id, m.kind, m.state, v.text,
              (SELECT COUNT(DISTINCT o.source_session_id)
               FROM memory_observations mo
               JOIN observations o ON o.id = mo.observation_id
               WHERE mo.memory_id = m.id) AS recurrence
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       WHERE m.id = ? AND m.state = 'active'`,
    )
    .get(nodeId) as
    | {
        id: number;
        kind: MemoryKnowledgeKind;
        state: MemoryLifecycleState;
        text: string;
        recurrence: number;
      }
    | undefined;
  if (!row) return null;
  return {
    nodeType: "memory",
    nodeId: Number(row.id),
    text: String(row.text),
    kind: row.kind,
    state: row.state,
    recurrence: Number(row.recurrence),
    lexicalRank: null,
    semanticRank: null,
    semanticScore: null,
  };
}

/**
 * Tokenize free text into FTS-safe terms: maximal runs of Unicode letters or
 * digits. Quotes, dashes, asterisks, punctuation, and whitespace become
 * separators, so FTS5 syntax (`"`, `*`, `NEAR`, `AND`, `-`) can never
 * restructure the query. Non-ASCII letters survive, so non-English memory
 * text still matches.
 */
export function tokenizeMemoryFtsTerms(text: string): string[] {
  const matches = text.match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  return matches.map((t) => t.toLowerCase());
}

/**
 * Build a safe FTS5 MATCH expression: every term quoted and OR-joined.
 * Returns null when the input yields no terms.
 */
export function buildMemoryFtsQuery(input: string): string | null {
  const terms = tokenizeMemoryFtsTerms(input);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Split a query into retrieval segments: sentences greedily grouped so each
 * segment stays under MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS. Long task prompts
 * otherwise embed from their first paragraph only (MiniLM's wordpiece limit)
 * and OR-join hundreds of terms into common-word overlap ranking.
 */
export function segmentMemoryQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const sentences = trimmed
    .split(/(?<=[.!?\n])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const segments: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    // A single sentence longer than the cap becomes its own segment
    // (truncation of a segment is acceptable: it bounds rank noise).
    if (sentence.length > MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS) {
      if (current) {
        segments.push(current);
        current = "";
      }
      segments.push(sentence);
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS) {
      if (current) segments.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Whether a query is greeting-only: only greeting phrases remain after stripping. */
export function isMemoryGreetingOnlyQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const rest = trimmed
    .replace(
      /^(hi|hey|hello|yo|sup|howdy|hola|hiya|greetings|good\s+(morning|afternoon|evening|day))\b/gi,
      " ",
    )
    .replace(/what'?s?\s+up\b/gi, " ")
    .replace(/how\s+(are\s+you|are\s+things|do\s+you\s+do)\b/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return !rest.trim();
}

/** Whether retrieval should be skipped: blank, trivially short, or greeting-only. */
export function shouldSkipMemoryRetrieval(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < MEMORY_RETRIEVAL_MIN_QUERY_CHARS) return true;
  return isMemoryGreetingOnlyQuery(trimmed);
}

function rrfScore(
  lexicalRank: number | null,
  semanticRank: number | null,
  k: number,
): number {
  let score = 0;
  if (lexicalRank !== null) score += 1 / (k + lexicalRank);
  if (semanticRank !== null) score += 1 / (k + semanticRank);
  return score;
}

/** Whether the vector index has any rows (the parent-side embedder guard). */
function memoryVectorIndexHasRows(db: DatabaseSync, modelId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM embeddings WHERE model_id = ? LIMIT 1`)
    .get(modelId) as { ok: number } | undefined;
  return !!row;
}

function loadMemoryEmbeddingVectors(
  db: DatabaseSync,
  modelId: string,
): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  const rows = db
    .prepare(
      `SELECT e.node_id, e.vector
       FROM embeddings e
       WHERE e.model_id = ? AND e.node_type = 'memory'`,
    )
    .all(modelId) as Array<{ node_id: number; vector: Buffer }>;
  for (const row of rows) {
    const buf = row.vector;
    const aligned = new Float32Array(buf.byteLength / 4);
    const view = new Uint8Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength,
    );
    view.set(buf.subarray(0, aligned.byteLength));
    out.set(Number(row.node_id), aligned);
  }
  return out;
}

/**
 * Lexical retrieval for one segment: FTS5 MATCH with the sanitized OR-joined
 * query, ranked by bm25. Returns per-node ranks; an unusable query yields no
 * candidates (never an error).
 */
function lexicalCandidatesForSegment(
  db: DatabaseSync,
  segment: string,
  limit: number,
): Map<number, number> {
  const match = buildMemoryFtsQuery(segment);
  if (!match) return new Map();
  const rows = db
    .prepare(
      `SELECT rowid, rank FROM memory_fts
       WHERE memory_fts MATCH ?
       ORDER BY rank ASC
       LIMIT ?`,
    )
    .all(match, limit) as Array<{ rowid: number; rank: number }>;
  const out = new Map<number, number>();
  for (const row of rows) {
    const id = Number(row.rowid);
    const rank = out.size + 1;
    out.set(id, rank);
  }
  return out;
}

/**
 * Semantic retrieval: embed each query segment (MiniLM, mean-pooled,
 * normalized), score every indexed active memory by cosine, and keep nodes
 * at or above the cosine floor. Returns per-node best rank + score.
 */
async function semanticCandidates(
  segments: string[],
  embed: MemoryEmbedFn,
  vectors: Map<number, Float32Array>,
  floor: number,
  signal?: AbortSignal,
): Promise<{ ranks: Map<number, number>; scores: Map<number, number> }> {
  const ranks = new Map<number, number>();
  const scores = new Map<number, number>();

  for (const segment of segments) {
    if (signal?.aborted) break;
    let queryVector: Float32Array | undefined;
    try {
      const vectorsOut = await embed([segment]);
      queryVector = vectorsOut[0];
    } catch {
      // A failed embed degrades that segment; other segments still run.
      continue;
    }
    if (!queryVector) continue;

    const scored: Array<{ nodeId: number; score: number }> = [];
    for (const [nodeId, vector] of vectors) {
      const score = cosineSimilarityMemoryVectors(queryVector, vector);
      if (score >= floor) scored.push({ nodeId, score });
    }
    scored.sort((a, b) => b.score - a.score || a.nodeId - b.nodeId);
    for (let i = 0; i < scored.length; i++) {
      const node = scored[i]!;
      const rank = i + 1;
      const existing = ranks.get(node.nodeId);
      if (existing === undefined || rank < existing) {
        ranks.set(node.nodeId, rank);
        scores.set(node.nodeId, node.score);
      }
    }
  }
  return { ranks, scores };
}

/**
 * Find memory candidates for a query: per-segment lexical (FTS5) + semantic
 * (MiniLM with the cosine floor) retrieval, fused by Reciprocal Rank Fusion
 * and ordered by fused score descending. Retrieval is skipped entirely for
 * blank, trivially short, or greeting-only queries.
 *
 * The embedder is loaded only when the vector index is non-empty; an
 * unavailable or failing embedder yields no semantic candidates and the
 * result degrades to lexical-only. Never writes and never records citations.
 */
export async function findMemoryCandidates(
  db: DatabaseSync,
  query: string,
  opts: MemoryRetrievalOptions = {},
): Promise<MemoryRetrievalResult> {
  const modelId = opts.modelId ?? MEMORY_EMBEDDING_MODEL_ID;
  const rrfK = opts.rrfK ?? MEMORY_RETRIEVAL_RRF_K;
  const floor = opts.cosineFloor ?? MEMORY_RETRIEVAL_COSINE_FLOOR;
  const maxUnits = opts.maxUnits ?? MEMORY_RETRIEVAL_MAX_UNITS;
  const maxChars = opts.maxChars ?? MEMORY_RETRIEVAL_MAX_CHARS;
  const signal = opts.signal;

  const segments = segmentMemoryQuery(query);
  if (shouldSkipMemoryRetrieval(query) || segments.length === 0) {
    return { candidates: [], segments, semanticDegraded: false, skipped: true };
  }

  const lexicalRankByNode = new Map<number, number>();
  let lexicalCount = 0;
  for (const segment of segments) {
    if (signal?.aborted) break;
    const ranked = lexicalCandidatesForSegment(
      db,
      segment,
      maxUnits - lexicalCount,
    );
    lexicalCount += ranked.size;
    for (const [nodeId, rank] of ranked) {
      const existing = lexicalRankByNode.get(nodeId);
      if (existing === undefined || rank < existing) {
        lexicalRankByNode.set(nodeId, rank);
      }
    }
  }

  // Parent-side embedder guard: never touch the MiniLM pipeline when the
  // vector index is empty (a first turn on an empty workspace must not
  // block on a model download).
  let semanticDegraded = false;
  let semanticRankByNode = new Map<number, number>();
  let semanticScoreByNode = new Map<number, number>();
  const vectorIndexNonEmpty = memoryVectorIndexHasRows(db, modelId);
  if (!vectorIndexNonEmpty) {
    semanticDegraded = true;
  } else {
    let embed = opts.embed;
    if (embed === undefined) {
      embed = await loadMemoryEmbedder(modelId, signal);
    }
    if (!embed) {
      semanticDegraded = true;
    } else {
      const vectors = loadMemoryEmbeddingVectors(db, modelId);
      const semantic = await semanticCandidates(
        segments,
        embed,
        vectors,
        floor,
        signal,
      );
      semanticRankByNode = semantic.ranks;
      semanticScoreByNode = semantic.scores;
    }
  }

  const nodes = new Map<number, RetrievedNode>();
  const consider = (nodeId: number): RetrievedNode | null => {
    let node: RetrievedNode | null = nodes.get(nodeId) ?? null;
    if (!node) {
      node = loadRetrievedNode(db, nodeId);
      if (!node) return null;
      nodes.set(nodeId, node);
    }
    return node;
  };
  for (const nodeId of lexicalRankByNode.keys()) {
    const node = consider(nodeId);
    if (node) node.lexicalRank = lexicalRankByNode.get(nodeId) ?? null;
  }
  for (const nodeId of semanticRankByNode.keys()) {
    const node = consider(nodeId);
    if (node) {
      node.semanticRank = semanticRankByNode.get(nodeId) ?? null;
      node.semanticScore = semanticScoreByNode.get(nodeId) ?? null;
    }
  }

  const candidates: MemoryRetrievalCandidate[] = [...nodes.values()]
    .map((n) => ({
      nodeType: "memory" as const,
      nodeId: n.nodeId,
      prefixedId: `M:${n.nodeId}` as MemoryNodeId,
      kind: n.kind,
      state: n.state,
      text: n.text,
      recurrence: n.recurrence,
      score: rrfScore(n.lexicalRank, n.semanticRank, rrfK),
      lexicalRank: n.lexicalRank,
      semanticRank: n.semanticRank,
      semanticScore: n.semanticScore,
    }))
    .sort((a, b) => b.score - a.score || a.nodeId - b.nodeId);

  // Caps: retrieve more than the payload budget allows, but bound the work.
  // The char cap skips over-budget candidates rather than dropping the tail:
  // retrieval is recall-tuned, so a later smaller candidate must still surface.
  let chars = 0;
  let units = 0;
  const capped: MemoryRetrievalCandidate[] = [];
  for (const c of candidates) {
    if (units >= maxUnits) break;
    if (chars + c.text.length > maxChars) continue;
    chars += c.text.length;
    units++;
    capped.push(c);
  }
  return {
    candidates: capped,
    segments,
    semanticDegraded,
    skipped: false,
  };
}
