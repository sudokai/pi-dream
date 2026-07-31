/**
 * Hybrid BM25 (FTS5) + semantic candidate generation with RRF fusion.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  estimateMemoryTextTokens,
  formatMemoryNodeId,
  formatSummaryNodeId,
  MEMORY_HYBRID_POOL_SIZE,
  MEMORY_RRF_K,
  type MemoryKnowledgeKind,
  type MemorySearchCandidate,
  type MemorySearchableNodeType,
} from "./memory-types.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  getSummaryById,
} from "./memory-graph.ts";
import { computeMemoryRowHeat, computeSummaryRowHeat } from "./memory-heat.ts";
import {
  searchMemorySemantic,
  type MemoryEmbedFn,
} from "./memory-embedding.ts";
import { rebuildMemorySearchDocuments } from "./memory-database.ts";
import { isMemoryQueryBlank } from "./memory-abort.ts";

export interface MemoryBm25Hit {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  rank: number;
}

/**
 * Escape a user query for FTS5 MATCH (simple tokenization, phrase-safe).
 */
export function escapeMemoryFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  // Quote each token so FTS5 special chars are literal.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * BM25 ranking via FTS5. Returns hits ordered best-first with 1-based ranks.
 */
export function searchMemoryBm25(
  db: DatabaseSync,
  query: string,
  limit: number = MEMORY_HYBRID_POOL_SIZE,
): MemoryBm25Hit[] {
  const match = escapeMemoryFtsQuery(query);
  if (match === '""') return [];

  // Unexpected FTS/DB errors (SQLITE_CORRUPT, BUSY after busy_timeout, ...)
  // must propagate instead of degrading to an empty hit list: an empty BM25
  // result is indistinguishable from a genuinely empty index for every caller.
  const docCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM search_documents WHERE state = 'active'`,
    )
    .get() as { n: number };
  const ftsCount = db.prepare(`SELECT COUNT(*) AS n FROM search_fts`).get() as {
    n: number;
  };
  if (Number(docCount.n) > 0 && Number(ftsCount.n) === 0) {
    try {
      rebuildMemorySearchDocuments(db);
    } catch {
      // Best-effort self-heal only: a failed rebuild must not mask the missing
      // index state — the MATCH query below reflects whatever FTS rows exist.
    }
  }

  const rows = db
    .prepare(
      `SELECT search_fts.node_type AS node_type,
              search_fts.node_id AS node_id,
              bm25(search_fts) AS score
       FROM search_fts
       WHERE search_fts MATCH ?
       ORDER BY score ASC
       LIMIT ?`,
    )
    .all(match, limit) as Array<{
    node_type: MemorySearchableNodeType;
    node_id: number;
    score: number;
  }>;

  return rows.map((r, i) => ({
    nodeType: r.node_type,
    nodeId: Number(r.node_id),
    rank: i + 1,
  }));
}

/**
 * Reciprocal rank fusion of BM25 and semantic rank lists.
 */
export function fuseMemorySearchRanks(
  bm25: MemoryBm25Hit[],
  semantic: Array<{
    nodeType: MemorySearchableNodeType;
    nodeId: number;
    rank: number;
  }>,
  rrfK: number = MEMORY_RRF_K,
): Array<{
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  rrfScore: number;
  bm25Rank: number | null;
  semanticRank: number | null;
}> {
  const map = new Map<
    string,
    {
      nodeType: MemorySearchableNodeType;
      nodeId: number;
      rrfScore: number;
      bm25Rank: number | null;
      semanticRank: number | null;
    }
  >();

  const key = (t: string, id: number) => `${t}:${id}`;

  for (const hit of bm25) {
    const k = key(hit.nodeType, hit.nodeId);
    const entry = map.get(k) ?? {
      nodeType: hit.nodeType,
      nodeId: hit.nodeId,
      rrfScore: 0,
      bm25Rank: null,
      semanticRank: null,
    };
    entry.bm25Rank = hit.rank;
    entry.rrfScore += 1 / (rrfK + hit.rank);
    map.set(k, entry);
  }

  for (const hit of semantic) {
    const k = key(hit.nodeType, hit.nodeId);
    const entry = map.get(k) ?? {
      nodeType: hit.nodeType,
      nodeId: hit.nodeId,
      rrfScore: 0,
      bm25Rank: null,
      semanticRank: null,
    };
    entry.semanticRank = hit.rank;
    entry.rrfScore += 1 / (rrfK + hit.rank);
    map.set(k, entry);
  }

  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

export interface HybridMemorySearchOptions {
  limit?: number;
  rrfK?: number;
  embed?: MemoryEmbedFn | null;
  modelId?: string;
  semanticFloor?: number;
  signal?: AbortSignal;
}

/**
 * Hybrid candidate generation: BM25 + MiniLM → RRF → hydrated candidates with heat.
 * Does not apply LLM filtering — caller must plan/filter before exposing to the agent.
 */
export async function searchMemoryHybrid(
  db: DatabaseSync,
  query: string,
  opts: HybridMemorySearchOptions = {},
): Promise<{
  candidates: MemorySearchCandidate[];
  semanticDegraded: boolean;
  semanticError?: string;
}> {
  if (isMemoryQueryBlank(query)) {
    return { candidates: [], semanticDegraded: false };
  }

  const limit = opts.limit ?? MEMORY_HYBRID_POOL_SIZE;
  const rrfK = opts.rrfK ?? MEMORY_RRF_K;
  if (opts.signal?.aborted) {
    return { candidates: [], semanticDegraded: true, semanticError: "aborted" };
  }

  const bm25 = searchMemoryBm25(db, query, limit);
  // Do NOT soft-catch semantic failures here: searchMemorySemantic already
  // degrades gracefully for aborts and embedder unavailability. Unexpected
  // errors propagate so the caller's boundary handler surfaces them.
  const semanticResult = await searchMemorySemantic(db, query, {
    embed: opts.embed,
    modelId: opts.modelId,
    floor: opts.semanticFloor,
    limit,
    signal: opts.signal,
  });
  const semanticRanks = semanticResult.hits.map((h, i) => ({
    nodeType: h.nodeType,
    nodeId: h.nodeId,
    rank: i + 1,
  }));

  const fused = fuseMemorySearchRanks(bm25, semanticRanks, rrfK).slice(
    0,
    limit,
  );
  const generation = getMemoryActivityGeneration(db);
  const candidates: MemorySearchCandidate[] = [];

  for (const hit of fused) {
    if (hit.nodeType === "memory") {
      const mem = getMemoryById(db, hit.nodeId);
      if (!mem || mem.state !== "active") continue;
      const heat = computeMemoryRowHeat(
        db,
        mem.id,
        generation,
        mem.noveltyUntilGeneration,
      );
      candidates.push({
        nodeType: "memory",
        nodeId: mem.id,
        prefixedId: formatMemoryNodeId(mem.id),
        kind: mem.kind as MemoryKnowledgeKind,
        text: mem.text,
        heat,
        estimatedTokens: estimateMemoryTextTokens(mem.text),
        bm25Rank: hit.bm25Rank,
        semanticRank: hit.semanticRank,
        rrfScore: hit.rrfScore,
      });
    } else {
      const summary = getSummaryById(db, hit.nodeId);
      if (!summary || summary.state !== "active") continue;
      const heat = computeSummaryRowHeat(db, summary.id, generation);
      candidates.push({
        nodeType: "summary",
        nodeId: summary.id,
        prefixedId: formatSummaryNodeId(summary.id),
        kind: "summary",
        text: summary.text,
        heat,
        estimatedTokens: estimateMemoryTextTokens(summary.text),
        bm25Rank: hit.bm25Rank,
        semanticRank: hit.semanticRank,
        rrfScore: hit.rrfScore,
      });
    }
  }

  return {
    candidates,
    semanticDegraded: semanticResult.degraded,
    semanticError: semanticResult.error,
  };
}
