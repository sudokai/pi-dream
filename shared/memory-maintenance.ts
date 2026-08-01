/**
 * Deterministic tree maintenance: promote planning + nearest-neighbor merge
 * pairing with an envelope-budgeted override, plus attempt counters and the
 * deterministic fallback text used by the commit layer.
 *
 * Merging is triggered by heat, not time: roots with heat <= cold threshold are
 * paired by semantic nearest-neighbor (cosine over stored embeddings) with no
 * similarity floor, so the tree provably coarsens. Fresh summaries are
 * merge-ineligible during a grace window. If the top layer still exceeds the
 * briefing token budget, the pass extends the candidate set with the coldest
 * remaining roots regardless of warmth (the budget override), which is not
 * subject to maintenanceMergeBound.
 *
 * The embedder is loaded only here (and by new-node embedding during learning)
 * — never by the parent-side briefing/search path.
 */

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "./memory-config.ts";
import {
  cosineSimilarityMemoryVectors,
  ensureMemoryEmbeddings,
  type MemoryEmbedFn,
} from "./memory-embedding.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  getSummaryById,
} from "./memory-graph.ts";
import { computeMemoryRowHeat, computeSummaryRowHeat } from "./memory-heat.ts";
import {
  estimateMemoryTextTokens,
  MEMORY_MAINTENANCE_MAX_ATTEMPTS,
  MEMORY_MAINTENANCE_SUMMARY_GRACE_GENERATIONS,
  type MemoryNodeId,
  type MemorySearchableNodeType,
  type SummaryNodeId,
} from "./memory-types.ts";
import {
  getMemoryNodeParent,
  listMemoryNodeChildren,
  listMemoryTreeRoots,
  type MemoryTreeNode,
} from "./memory-tree.ts";

/** Stable attempt-counter key for a merge pair (create and extend alike). */
export function memoryMaintenanceMergeKey(
  a: { nodeType: MemorySearchableNodeType; nodeId: number },
  b: { nodeType: MemorySearchableNodeType; nodeId: number },
): string {
  const x = `${a.nodeType}:${a.nodeId}`;
  const y = `${b.nodeType}:${b.nodeId}`;
  return x < y ? `merge:${x}+${y}` : `merge:${y}+${x}`;
}

/** Stable attempt-counter key for a promote (child + parent). */
export function memoryMaintenancePromoteKey(
  childType: MemorySearchableNodeType,
  childId: number,
  parentId: number,
): string {
  return `promote:${childType}:${childId}:${parentId}`;
}

/** Persisted consecutive-failure counter for one candidate. */
export function getMemoryMaintenanceAttempts(
  db: DatabaseSync,
  key: string,
): number {
  const row = db
    .prepare(`SELECT attempts FROM maintenance_attempts WHERE key = ?`)
    .get(key) as { attempts: number } | undefined;
  return row ? Number(row.attempts) : 0;
}

/** Increment the consecutive-failure counter; returns the new count. */
export function incrementMemoryMaintenanceAttempt(
  db: DatabaseSync,
  key: string,
  generation: number,
): number {
  const next = getMemoryMaintenanceAttempts(db, key) + 1;
  db.prepare(
    `INSERT INTO maintenance_attempts (key, attempts, last_generation)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       attempts = excluded.attempts,
       last_generation = excluded.last_generation,
       updated_at = datetime('now')`,
  ).run(key, next, generation);
  return next;
}

/** Reset the consecutive-failure counter (candidate covered). */
export function clearMemoryMaintenanceAttempt(
  db: DatabaseSync,
  key: string,
): void {
  db.prepare(`DELETE FROM maintenance_attempts WHERE key = ?`).run(key);
}

/** All persisted attempt counters (status surface). */
export function listMemoryMaintenanceAttempts(
  db: DatabaseSync,
): Array<{ key: string; attempts: number; lastGeneration: number }> {
  const rows = db
    .prepare(
      `SELECT key, attempts, last_generation FROM maintenance_attempts
       ORDER BY key ASC`,
    )
    .all() as Array<{
    key: string;
    attempts: number;
    last_generation: number;
  }>;
  return rows.map((r) => ({
    key: r.key,
    attempts: Number(r.attempts),
    lastGeneration: Number(r.last_generation),
  }));
}

/**
 * Deterministic fallback summary text: a labeled concatenation of the removed
 * roots' texts (creates: the member texts; extends: the old summary text
 * followed by the incoming roots' texts), truncated so that it satisfies
 * strict compaction by construction.
 */
export function buildMemoryFallbackSummaryText(
  oldSummaryText: string | null,
  members: Array<{ prefixedId: string; text: string }>,
): string {
  const baselineTokens =
    (oldSummaryText ? estimateMemoryTextTokens(oldSummaryText) : 0) +
    members.reduce((sum, m) => sum + estimateMemoryTextTokens(m.text), 0);
  const capChars = Math.min(
    4 * Math.max(1, baselineTokens - 1),
    800, // MEMORY_MAX_SUMMARY_CHARS
  );
  const parts: string[] = [];
  if (oldSummaryText) parts.push(oldSummaryText);
  for (const m of members) {
    parts.push(`${m.prefixedId} — ${m.text}`);
  }
  const joined = parts.join("; ");
  return joined.length > capChars ? joined.slice(0, capChars) : joined;
}

function nodeKey(nodeType: MemorySearchableNodeType, nodeId: number): string {
  return `${nodeType}:${nodeId}`;
}

export interface MemoryPromoteCandidate {
  key: string;
  childType: MemorySearchableNodeType;
  childId: number;
  childPrefixedId: MemoryNodeId | SummaryNodeId;
  childHeat: number;
  parentId: number;
  parentPrefixedId: SummaryNodeId;
  parentVersionId: number;
  /** Members the parent keeps after the promotion (>= 2 means a rewrite). */
  remainingMembersAfter: number;
  /** Number of active ancestors of the child (batch ordering). */
  depth: number;
}

export interface MemoryMergeMember {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  prefixedId: MemoryNodeId | SummaryNodeId;
  text: string;
  estimatedTokens: number;
}

export interface MemoryMergeCandidate {
  key: string;
  kind: "create" | "extend";
  reason: "cold" | "budget";
  similarity: number;
  /** create: both pair members; extend: the incoming roots only. */
  members: MemoryMergeMember[];
  /** extend only: the existing summary root being extended. */
  summaryId?: number;
  summaryPrefixedId?: SummaryNodeId;
  summaryText?: string;
  expectedVersionId?: number;
  /** Compaction baseline: est(old summary text) + Σ est(incoming) (extend) or Σ est(members) (create). */
  baselineTokens: number;
  /** Largest summary text the model may write: baselineTokens - 1. */
  outputCapTokens: number;
}

export interface MemoryMaintenancePlan {
  promotes: MemoryPromoteCandidate[];
  merges: MemoryMergeCandidate[];
  layerTokensBefore: number;
  /** Projected layer tokens after the batch using worst-case (cap) texts. */
  layerTokensAfterProjected: number;
  overBudget: boolean;
  budget: number;
  generation: number;
}

export interface MemoryMaintenancePlannerOptions {
  config: MemoryWorkspaceConfig;
  /** Test seam; defaults to the local MiniLM pipeline. */
  embed?: MemoryEmbedFn | null;
  signal?: AbortSignal;
}

function childHeat(
  db: DatabaseSync,
  child: MemoryTreeNode,
  generation: number,
): number {
  if (child.nodeType === "memory") {
    const mem = getMemoryById(db, child.nodeId);
    if (!mem) return 0;
    return computeMemoryRowHeat(
      db,
      mem.id,
      generation,
      mem.noveltyUntilGeneration,
    );
  }
  const summary = getSummaryById(db, child.nodeId);
  if (!summary) return 0;
  return computeSummaryRowHeat(db, summary.id, generation);
}

/** Depth of a child (number of active ancestors to the root). */
function memoryNodeDepth(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): number {
  let depth = 0;
  let current: { nodeType: MemorySearchableNodeType; nodeId: number } = {
    nodeType,
    nodeId,
  };
  const seen = new Set<string>();
  for (;;) {
    const parent = getMemoryNodeParent(db, current.nodeType, current.nodeId);
    if (!parent) break;
    const key = `summary:${parent.nodeId}`;
    if (seen.has(key)) break; // cycle guard (should not happen in a strict tree)
    seen.add(key);
    depth++;
    current = parent;
  }
  return depth;
}

/** Ancestor chain (parents to the root) is active and non-conflicted. */
function ancestorChainOk(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): boolean {
  let current: { nodeType: MemorySearchableNodeType; nodeId: number } = {
    nodeType,
    nodeId,
  };
  const seen = new Set<string>();
  for (;;) {
    const parent = getMemoryNodeParent(db, current.nodeType, current.nodeId);
    if (!parent) break;
    const key = `summary:${parent.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const summary = getSummaryById(db, parent.nodeId);
    if (!summary || summary.state !== "active") return false;
    current = parent;
  }
  return true;
}

/**
 * Schedulable promote batch: hot children of active summaries, at most one per
 * direct parent, no ancestor/descendant pairs in the same batch (highest
 * ancestor wins deterministically), and no candidate whose parent is retired by
 * a deeper candidate's cascade. The remainder defer to the next run.
 */
function planMemoryPromotes(
  db: DatabaseSync,
  generation: number,
  config: MemoryWorkspaceConfig,
): MemoryPromoteCandidate[] {
  const summaries = db
    .prepare(`SELECT id FROM summaries WHERE state = 'active' ORDER BY id ASC`)
    .all() as Array<{ id: number }>;

  const byParent = new Map<number, MemoryPromoteCandidate>();
  for (const row of summaries) {
    const parentId = Number(row.id);
    const children = listMemoryNodeChildren(db, "summary", parentId);
    for (const child of children) {
      if (child.state !== "active") continue;
      if (childHeat(db, child, generation) < config.hotHeatThreshold) continue;
      if (!ancestorChainOk(db, child.nodeType, child.nodeId)) continue;
      const remaining = listMemoryNodeChildren(db, "summary", parentId).filter(
        (c) => !(c.nodeType === child.nodeType && c.nodeId === child.nodeId),
      ).length;
      const candidate: MemoryPromoteCandidate = {
        key: memoryMaintenancePromoteKey(
          child.nodeType,
          child.nodeId,
          parentId,
        ),
        childType: child.nodeType,
        childId: child.nodeId,
        childPrefixedId: child.prefixedId,
        childHeat: child.heat,
        parentId,
        parentPrefixedId: `S:${parentId}`,
        parentVersionId: getSummaryById(db, parentId)?.currentVersionId ?? 0,
        remainingMembersAfter: remaining,
        depth: memoryNodeDepth(db, child.nodeType, child.nodeId),
      };
      const existing = byParent.get(parentId);
      if (
        !existing ||
        candidate.childHeat > existing.childHeat ||
        (candidate.childHeat === existing.childHeat &&
          candidate.childId < existing.childId)
      ) {
        byParent.set(parentId, candidate);
      }
    }
  }

  // Highest ancestor wins: process shallower children first, drop descendants
  // of already-kept children.
  const kept: MemoryPromoteCandidate[] = [];
  const sorted = [...byParent.values()].sort(
    (a, b) => a.depth - b.depth || a.childId - b.childId,
  );
  for (const cand of sorted) {
    const isDescendantOfKept = kept.some((k) =>
      isMemoryAncestorOf(
        db,
        k.childType,
        k.childId,
        cand.childType,
        cand.childId,
      ),
    );
    if (isDescendantOfKept) continue;
    kept.push(cand);
  }

  // Cascade order: process deepest first so a deeper promote that retires its
  // parent (dropping the ancestor chain) excludes shallower candidates whose
  // parent is retired by the cascade.
  const retired = new Set<number>();
  const batch: MemoryPromoteCandidate[] = [];
  for (const cand of [...kept].sort((a, b) => b.depth - a.depth)) {
    if (retired.has(cand.parentId)) continue;
    batch.push(cand);
    if (cand.remainingMembersAfter <= 1) {
      // Retire the parent and every active ancestor (reconciliation cascade).
      let current: { nodeType: MemorySearchableNodeType; nodeId: number } = {
        nodeType: "summary",
        nodeId: cand.parentId,
      };
      const seen = new Set<number>();
      while (!seen.has(current.nodeId)) {
        seen.add(current.nodeId);
        retired.add(current.nodeId);
        const parent = getMemoryNodeParent(
          db,
          current.nodeType,
          current.nodeId,
        );
        if (!parent) break;
        current = parent;
      }
    }
  }
  // Deterministic order for the learner: by key.
  batch.sort((a, b) => a.key.localeCompare(b.key));
  return batch;
}

/** Is `candidate` a descendant of `ancestor` (active contains edges)? */
function isMemoryAncestorOf(
  db: DatabaseSync,
  ancestorType: MemorySearchableNodeType,
  ancestorId: number,
  candidateType: MemorySearchableNodeType,
  candidateId: number,
): boolean {
  let current: { nodeType: MemorySearchableNodeType; nodeId: number } = {
    nodeType: candidateType,
    nodeId: candidateId,
  };
  const seen = new Set<string>();
  for (;;) {
    const parent = getMemoryNodeParent(db, current.nodeType, current.nodeId);
    if (!parent) break;
    const key = `summary:${parent.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (parent.nodeId === ancestorId && ancestorType === "summary") {
      return true;
    }
    current = parent;
  }
  return false;
}

export interface SimulatedRoot {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  prefixedId: MemoryNodeId | SummaryNodeId;
  text: string;
  estimatedTokens: number;
}

export interface MemoryPromoteSimulationInput {
  childType: MemorySearchableNodeType;
  childId: number;
  parentId: number;
  /** Actual rewrite text (commit) or null (planner: worst case, unchanged). */
  newSummaryText?: string | null;
}

/**
 * Simulate the top-layer effect of a promote batch against the current DB
 * (no writes). Mirrors the repository's promote + lifecycle reconciliation:
 * a parent dropping to <= 1 member is retired and every active ancestor is
 * retired too, resurfacing their remaining active children as roots.
 */
export function simulateMemoryPromoteLayer(
  db: DatabaseSync,
  promotes: MemoryPromoteSimulationInput[],
): { roots: SimulatedRoot[]; tokens: number; retiredSummaries: Set<number> } {
  const currentRoots = listMemoryTreeRoots(db);
  const roots = new Map<string, SimulatedRoot>();
  for (const r of currentRoots) {
    roots.set(nodeKey(r.nodeType, r.nodeId), {
      nodeType: r.nodeType,
      nodeId: r.nodeId,
      prefixedId: r.prefixedId,
      text: r.text,
      estimatedTokens: r.estimatedTokens,
    });
  }
  const retired = new Set<number>();

  const retireInSim = (summaryId: number): void => {
    if (retired.has(summaryId)) return;
    retired.add(summaryId);
    roots.delete(nodeKey("summary", summaryId));
    for (const child of listMemoryNodeChildren(db, "summary", summaryId)) {
      if (child.state !== "active") continue;
      roots.set(nodeKey(child.nodeType, child.nodeId), {
        nodeType: child.nodeType,
        nodeId: child.nodeId,
        prefixedId: child.prefixedId,
        text: child.text,
        estimatedTokens: child.estimatedTokens,
      });
    }
    const parent = getMemoryNodeParent(db, "summary", summaryId);
    if (parent) retireInSim(parent.nodeId);
  };

  const sorted = [...promotes].sort((a, b) => {
    const da = memoryNodeDepth(db, a.childType, a.childId);
    const db_ = memoryNodeDepth(db, b.childType, b.childId);
    return db_ - da;
  });
  for (const cand of sorted) {
    if (retired.has(cand.parentId)) continue;
    const remaining = listMemoryNodeChildren(
      db,
      "summary",
      cand.parentId,
    ).filter(
      (c) => !(c.nodeType === cand.childType && c.nodeId === cand.childId),
    );
    if (remaining.length >= 2) {
      // Parent survives, rewritten (worst case for the planner: text unchanged).
      if (cand.newSummaryText) {
        const existing = roots.get(nodeKey("summary", cand.parentId));
        if (existing) {
          existing.text = cand.newSummaryText;
          existing.estimatedTokens = estimateMemoryTextTokens(
            cand.newSummaryText,
          );
        }
      }
    } else {
      retireInSim(cand.parentId);
    }
    // The promoted child resurfaces as a root in both cases.
    const child = getMemoryTreeNodeForSim(db, cand.childType, cand.childId);
    if (child) {
      roots.set(nodeKey(child.nodeType, child.nodeId), child);
    }
  }

  const finalRoots = [...roots.values()];
  return {
    roots: finalRoots,
    tokens: finalRoots.reduce((sum, r) => sum + r.estimatedTokens, 0),
    retiredSummaries: retired,
  };
}

function getMemoryTreeNodeForSim(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): SimulatedRoot | null {
  if (nodeType === "memory") {
    const mem = getMemoryById(db, nodeId);
    if (!mem) return null;
    return {
      nodeType: "memory",
      nodeId,
      prefixedId: `M:${nodeId}` as MemoryNodeId,
      text: mem.text,
      estimatedTokens: estimateMemoryTextTokens(mem.text),
    };
  }
  const summary = getSummaryById(db, nodeId);
  if (!summary) return null;
  return {
    nodeType: "summary",
    nodeId,
    prefixedId: `S:${nodeId}` as SummaryNodeId,
    text: summary.text,
    estimatedTokens: estimateMemoryTextTokens(summary.text),
  };
}

interface PairPoolMember {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  prefixedId: MemoryNodeId | SummaryNodeId;
  text: string;
  estimatedTokens: number;
  heat: number;
  creationGeneration: number;
  isSummary: boolean;
  paired: boolean;
}

function loadMemoryEmbeddingVectors(
  db: DatabaseSync,
  modelId: string,
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const rows = db
    .prepare(
      `SELECT e.node_type, e.node_id, e.vector
       FROM embeddings e
       WHERE e.model_id = ?`,
    )
    .all(modelId) as Array<{
    node_type: MemorySearchableNodeType;
    node_id: number;
    vector: Buffer;
  }>;
  for (const row of rows) {
    const buf = row.vector;
    const aligned = new Float32Array(buf.byteLength / 4);
    const view = new Uint8Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength,
    );
    view.set(buf.subarray(0, aligned.byteLength));
    out.set(nodeKey(row.node_type, Number(row.node_id)), aligned);
  }
  return out;
}

/**
 * Greedy nearest-neighbor pairing over the pool (sorted heat ascending).
 * Deterministic tie-break by lowest node id; no similarity floor; a pair whose
 * attempt counter is at/past the bound is skipped (try the next partner).
 */
function greedyPairMemoryRoots(
  db: DatabaseSync,
  pool: PairPoolMember[],
  vectors: Map<string, Float32Array>,
): Array<{ a: PairPoolMember; b: PairPoolMember; similarity: number }> {
  const pairs: Array<{
    a: PairPoolMember;
    b: PairPoolMember;
    similarity: number;
  }> = [];
  const sorted = [...pool].sort(
    (x, y) => x.heat - y.heat || x.nodeId - y.nodeId,
  );
  for (const a of sorted) {
    if (a.paired) continue;
    const partners = sorted
      .filter((b) => b !== a && !b.paired)
      .map((b) => {
        const va = vectors.get(nodeKey(a.nodeType, a.nodeId));
        const vb = vectors.get(nodeKey(b.nodeType, b.nodeId));
        const score = va && vb ? cosineSimilarityMemoryVectors(va, vb) : 0;
        return { b, score };
      })
      .sort((x, y) => y.score - x.score || x.b.nodeId - y.b.nodeId);
    for (const { b, score } of partners) {
      if (
        getMemoryMaintenanceAttempts(db, memoryMaintenanceMergeKey(a, b)) >=
        MEMORY_MAINTENANCE_MAX_ATTEMPTS
      ) {
        continue;
      }
      a.paired = true;
      b.paired = true;
      pairs.push({ a, b, similarity: score });
      break;
    }
  }
  return pairs;
}

function buildMemoryMergeCandidate(
  pair: { a: PairPoolMember; b: PairPoolMember; similarity: number },
  reason: "cold" | "budget",
): MemoryMergeCandidate {
  const { a, b } = pair;
  const aIsSummary = a.isSummary;
  const bIsSummary = b.isSummary;
  const extendTarget = aIsSummary ? a : bIsSummary ? b : null;
  if (extendTarget) {
    const incoming = extendTarget === a ? b : a;
    const baselineTokens =
      extendTarget.estimatedTokens + incoming.estimatedTokens;
    return {
      key: memoryMaintenanceMergeKey(a, b),
      kind: "extend",
      reason,
      similarity: pair.similarity,
      members: [incoming],
      summaryId: extendTarget.nodeId,
      summaryPrefixedId: extendTarget.prefixedId as SummaryNodeId,
      summaryText: extendTarget.text,
      baselineTokens,
      outputCapTokens: Math.max(1, baselineTokens - 1),
    };
  }
  const baselineTokens = a.estimatedTokens + b.estimatedTokens;
  return {
    key: memoryMaintenanceMergeKey(a, b),
    kind: "create",
    reason,
    similarity: pair.similarity,
    members: [a, b],
    baselineTokens,
    outputCapTokens: Math.max(1, baselineTokens - 1),
  };
}

/**
 * Deterministic maintenance planning against the current DB state.
 * Promotes first (they change the root set), then merges with an
 * envelope-budgeted override. Loads the embedder for pairing — call only in
 * the child (never on the interactive parent path).
 */
export async function planMemoryMaintenance(
  db: DatabaseSync,
  opts: MemoryMaintenancePlannerOptions,
): Promise<MemoryMaintenancePlan> {
  const config = opts.config;
  const generation = getMemoryActivityGeneration(db);
  const promotes = planMemoryPromotes(db, generation, config);

  const promotedParentIds = new Set(promotes.map((p) => p.parentId));
  const sim = simulateMemoryPromoteLayer(
    db,
    promotes.map((p) => ({
      childType: p.childType,
      childId: p.childId,
      parentId: p.parentId,
    })),
  );

  // Embeddings power pairing only; degraded pairing (score 0) is fine.
  await ensureMemoryEmbeddings(db, {
    modelId: config.embeddingModel,
    embed: opts.embed,
    signal: opts.signal,
  });
  const vectors = loadMemoryEmbeddingVectors(db, config.embeddingModel);

  const toPool = (root: SimulatedRoot): PairPoolMember => {
    let heat = 0;
    let creationGeneration = 0;
    if (root.nodeType === "memory") {
      const mem = getMemoryById(db, root.nodeId);
      if (mem) {
        heat = computeMemoryRowHeat(
          db,
          mem.id,
          generation,
          mem.noveltyUntilGeneration,
        );
        creationGeneration = mem.creationGeneration;
      }
    } else {
      const summary = getSummaryById(db, root.nodeId);
      if (summary) {
        heat = computeSummaryRowHeat(db, summary.id, generation);
        creationGeneration = summary.creationGeneration;
      }
    }
    return {
      nodeType: root.nodeType,
      nodeId: root.nodeId,
      prefixedId: root.prefixedId,
      text: root.text,
      estimatedTokens: root.estimatedTokens,
      heat,
      creationGeneration,
      isSummary: root.nodeType === "summary",
      paired: false,
    };
  };

  const pastGrace = (m: PairPoolMember): boolean =>
    !m.isSummary ||
    generation >=
      m.creationGeneration + MEMORY_MAINTENANCE_SUMMARY_GRACE_GENERATIONS;

  const coldPool = sim.roots
    .filter((r) => !promotedParentIds.has(r.nodeId) || r.nodeType !== "summary")
    .map(toPool)
    .filter((m) => pastGrace(m) && m.heat <= config.coldHeatThreshold);

  const coldPairs = greedyPairMemoryRoots(db, coldPool, vectors).slice(
    0,
    config.maintenanceMergeBound,
  );

  const merges: MemoryMergeCandidate[] = [];
  let projected = sim.tokens;
  for (const pair of coldPairs) {
    const candidate = buildMemoryMergeCandidate(pair, "cold");
    merges.push(candidate);
    // Worst-case projection: the model writes at the output cap.
    projected -= 1;
  }

  // Budget override: not subject to maintenanceMergeBound; respects grace and
  // the attempt bound; targets the cap with monotonic measured compaction.
  if (projected > config.briefingTokenBudget) {
    const used = new Set<string>();
    for (const pair of coldPairs) {
      used.add(nodeKey(pair.a.nodeType, pair.a.nodeId));
      used.add(nodeKey(pair.b.nodeType, pair.b.nodeId));
    }
    const remaining = sim.roots
      .filter(
        (r) =>
          !used.has(nodeKey(r.nodeType, r.nodeId)) &&
          !(promotedParentIds.has(r.nodeId) && r.nodeType === "summary"),
      )
      .map(toPool)
      .filter((m) => pastGrace(m));
    const budgetPairs = greedyPairMemoryRoots(db, remaining, vectors);
    for (const pair of budgetPairs) {
      if (projected <= config.briefingTokenBudget) break;
      const candidate = buildMemoryMergeCandidate(pair, "budget");
      merges.push(candidate);
      projected -= 1;
    }
  }

  const overBudget = projected > config.briefingTokenBudget;
  return {
    promotes,
    merges,
    layerTokensBefore: sim.tokens,
    layerTokensAfterProjected: projected,
    overBudget,
    budget: config.briefingTokenBudget,
    generation,
  };
}

/**
 * Pure SQL/heat predicate (no embedder): any promote-eligible child, or >= 2
 * merge-eligible roots past grace, or the top-layer token estimate exceeding
 * briefingTokenBudget with >= 2 non-conflicted roots past grace (irrespective
 * of heat). All clauses exclude pairs at/past the attempt bound, so a budget
 * below a single node's estimate never spawns doomed runs.
 */
export function hasMemoryMaintenanceCandidates(
  db: DatabaseSync,
  opts: { config: MemoryWorkspaceConfig },
): boolean {
  const config = opts.config;
  const generation = getMemoryActivityGeneration(db);

  // Promote clause.
  const summaries = db
    .prepare(`SELECT id FROM summaries WHERE state = 'active' ORDER BY id ASC`)
    .all() as Array<{ id: number }>;
  for (const row of summaries) {
    const parentId = Number(row.id);
    for (const child of listMemoryNodeChildren(db, "summary", parentId)) {
      if (child.state !== "active") continue;
      if (childHeat(db, child, generation) < config.hotHeatThreshold) continue;
      if (!ancestorChainOk(db, child.nodeType, child.nodeId)) continue;
      const key = memoryMaintenancePromoteKey(
        child.nodeType,
        child.nodeId,
        parentId,
      );
      if (
        getMemoryMaintenanceAttempts(db, key) < MEMORY_MAINTENANCE_MAX_ATTEMPTS
      ) {
        return true;
      }
    }
  }

  const roots = listMemoryTreeRoots(db).map((r) => ({
    nodeType: r.nodeType,
    nodeId: r.nodeId,
    heat: r.heat,
    estimatedTokens: r.estimatedTokens,
    creationGeneration: r.creationGeneration,
    isSummary: r.nodeType === "summary",
  }));
  const pastGrace = (r: (typeof roots)[number]): boolean =>
    !r.isSummary ||
    generation >=
      r.creationGeneration + MEMORY_MAINTENANCE_SUMMARY_GRACE_GENERATIONS;

  const pairPossible = (eligible: (typeof roots)[number][]): boolean => {
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i]!;
        const b = eligible[j]!;
        if (
          getMemoryMaintenanceAttempts(db, memoryMaintenanceMergeKey(a, b)) <
          MEMORY_MAINTENANCE_MAX_ATTEMPTS
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const coldEligible = roots.filter(
    (r) => pastGrace(r) && r.heat <= config.coldHeatThreshold,
  );
  if (coldEligible.length >= 2 && pairPossible(coldEligible)) return true;

  const layerTokens = roots.reduce((sum, r) => sum + r.estimatedTokens, 0);
  if (layerTokens > config.briefingTokenBudget) {
    const graced = roots.filter((r) => pastGrace(r));
    if (graced.length >= 2 && pairPossible(graced)) return true;
  }
  return false;
}

/** Persisted last inspect-time maintenance batch (child writes, status reads). */
export interface PersistedMemoryMaintenanceInspect {
  runId: string;
  plannedAt: string;
  generation: number;
  promotes: Array<{
    key: string;
    child: string;
    parent: string;
    childHeat: number;
    remainingMembersAfter: number;
  }>;
  merges: Array<{
    key: string;
    kind: "create" | "extend";
    reason: "cold" | "budget";
    similarity: number;
    members: string[];
    baselineTokens: number;
    outputCapTokens: number;
    summaryId?: number;
  }>;
  layerTokens: number;
  overBudget: boolean;
  budget: number;
}

/** Read the persisted last inspect-time batch; null when absent/unreadable. */
export function readMemoryLastMaintenanceInspect(
  filePath: string,
): PersistedMemoryMaintenanceInspect | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedMemoryMaintenanceInspect;
    if (typeof parsed.runId !== "string" || !Array.isArray(parsed.merges)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
