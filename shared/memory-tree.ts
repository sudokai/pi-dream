/**
 * Tree queries for the memory/summary containment tree.
 * A root is an active, non-conflicted node with no active `contains` edge
 * pointing at it from an active parent summary (edges from retired parents do
 * not block rootness). The tree is strict: every node has at most one active
 * parent, and containment is created only by validated summarize/promote/lifecycle
 * ops — never by `link`.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  estimateMemoryTextTokens,
  formatMemoryNodeId,
  formatSummaryNodeId,
  type GraphEdgeRow,
  type MemoryKnowledgeKind,
  type MemoryLifecycleState,
  type MemoryNodeId,
  type MemorySearchableNodeType,
  type SummaryNodeId,
} from "./memory-types.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  getSummaryById,
  listGraphEdgesFrom,
} from "./memory-graph.ts";
import { computeMemoryRowHeat, computeSummaryRowHeat } from "./memory-heat.ts";

/** One memory or summary node as rendered in the tree (root, child, or descendant). */
export interface MemoryTreeNode {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  prefixedId: MemoryNodeId | SummaryNodeId;
  kind: MemoryKnowledgeKind | "summary";
  state: MemoryLifecycleState;
  text: string;
  heat: number;
  estimatedTokens: number;
  creationGeneration: number;
  currentVersionId: number;
}

/** Active `contains` edges whose parent summary is active. */
function listActiveContainmentEdges(
  db: DatabaseSync,
  fromType: MemorySearchableNodeType,
  fromId: number,
): GraphEdgeRow[] {
  return listGraphEdgesFrom(db, fromType, fromId).filter(
    (e) => e.relation === "contains" && e.state === "active",
  );
}

function loadTreeNode(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
  generation: number,
): MemoryTreeNode | null {
  if (nodeType === "memory") {
    const mem = getMemoryById(db, nodeId);
    if (!mem) return null;
    return {
      nodeType: "memory",
      nodeId: mem.id,
      prefixedId: formatMemoryNodeId(mem.id),
      kind: mem.kind,
      state: mem.state,
      text: mem.text,
      heat: computeMemoryRowHeat(
        db,
        mem.id,
        generation,
        mem.noveltyUntilGeneration,
      ),
      estimatedTokens: estimateMemoryTextTokens(mem.text),
      creationGeneration: mem.creationGeneration,
      currentVersionId: mem.currentVersionId,
    };
  }
  const summary = getSummaryById(db, nodeId);
  if (!summary) return null;
  return {
    nodeType: "summary",
    nodeId: summary.id,
    prefixedId: formatSummaryNodeId(summary.id),
    kind: "summary",
    state: summary.state,
    text: summary.text,
    heat: computeSummaryRowHeat(db, summary.id, generation),
    estimatedTokens: estimateMemoryTextTokens(summary.text),
    creationGeneration: summary.creationGeneration,
    currentVersionId: summary.currentVersionId,
  };
}

/**
 * The single active parent summary of a node (strict tree), or null.
 * Only active `contains` edges from active summaries count.
 */
export function getMemoryNodeParent(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): { nodeType: "summary"; nodeId: number } | null {
  const row = db
    .prepare(
      `SELECT e.from_id AS from_id
       FROM graph_edges e
       JOIN summaries s ON s.id = e.from_id AND e.from_type = 'summary'
       WHERE e.relation = 'contains'
         AND e.state = 'active'
         AND s.state = 'active'
         AND e.to_type = ? AND e.to_id = ?
       ORDER BY e.id ASC
       LIMIT 1`,
    )
    .get(nodeType, nodeId) as { from_id: number } | undefined;
  return row ? { nodeType: "summary", nodeId: Number(row.from_id) } : null;
}

/** Does an active `contains` edge from an active parent summary point at this node? */
function hasActiveMemoryParent(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): boolean {
  return getMemoryNodeParent(db, nodeType, nodeId) !== null;
}

/** Whether a node is an active, non-conflicted root of the tree. */
export function isMemoryRoot(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): boolean {
  if (nodeType === "memory") {
    const mem = getMemoryById(db, nodeId);
    if (!mem || mem.state !== "active") return false;
  } else {
    const summary = getSummaryById(db, nodeId);
    if (!summary || summary.state !== "active") return false;
  }
  return !hasActiveMemoryParent(db, nodeType, nodeId);
}

/**
 * All roots: active, non-conflicted memories/summaries with no active
 * `contains` edge from an active parent summary. Ordered by heat descending,
 * then node id ascending (deterministic).
 */
export function listMemoryTreeRoots(db: DatabaseSync): MemoryTreeNode[] {
  const generation = getMemoryActivityGeneration(db);
  const nodes: MemoryTreeNode[] = [];
  for (const mem of db
    .prepare(`SELECT id FROM memories WHERE state = 'active' ORDER BY id ASC`)
    .all() as Array<{ id: number }>) {
    const node = loadTreeNode(db, "memory", Number(mem.id), generation);
    if (node) nodes.push(node);
  }
  for (const summary of db
    .prepare(`SELECT id FROM summaries WHERE state = 'active' ORDER BY id ASC`)
    .all() as Array<{ id: number }>) {
    const node = loadTreeNode(db, "summary", Number(summary.id), generation);
    if (node) nodes.push(node);
  }
  return nodes
    .filter((n) => !hasActiveMemoryParent(db, n.nodeType, n.nodeId))
    .sort((a, b) => b.heat - a.heat || a.nodeId - b.nodeId);
}

/**
 * Children of a node via active `contains` edges, in edge order.
 * Each child carries its state so conflicted children can be flagged by callers.
 */
export function listMemoryNodeChildren(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): MemoryTreeNode[] {
  const generation = getMemoryActivityGeneration(db);
  const children: MemoryTreeNode[] = [];
  for (const edge of listActiveContainmentEdges(db, nodeType, nodeId)) {
    const node = loadTreeNode(db, edge.toType, edge.toId, generation);
    if (node) children.push(node);
  }
  return children;
}

/** Active, non-conflicted children of a node. */
export function listMemoryNodeActiveChildren(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): MemoryTreeNode[] {
  return listMemoryNodeChildren(db, nodeType, nodeId).filter(
    (n) => n.state === "active",
  );
}

/**
 * Transitive descendants of a node via active `contains` edges.
 * Used by tests and invariant checks.
 */
export function listMemoryDescendants(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): MemoryTreeNode[] {
  const out: MemoryTreeNode[] = [];
  const stack: Array<{ nodeType: MemorySearchableNodeType; nodeId: number }> = [
    { nodeType, nodeId },
  ];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    const key = `${node.nodeType}:${node.nodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const child of listMemoryNodeChildren(
      db,
      node.nodeType,
      node.nodeId,
    )) {
      out.push(child);
      stack.push({ nodeType: child.nodeType, nodeId: child.nodeId });
    }
  }
  return out;
}

/** Estimated text tokens of the whole top layer. */
export function estimateTopLayerTokens(
  db: DatabaseSync,
  roots: MemoryTreeNode[] = listMemoryTreeRoots(db),
): number {
  return roots.reduce((sum, root) => sum + root.estimatedTokens, 0);
}
