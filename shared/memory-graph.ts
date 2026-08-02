/**
 * Graph queries and exact one-level expansion for memory/summary/observation nodes.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  deleteMemorySearchDocument,
  upsertMemorySearchDocument,
} from "./memory-database.ts";
import {
  estimateMemoryTextTokens,
  formatMemoryNodeId,
  formatObservationNodeId,
  formatSummaryNodeId,
  MEMORY_MAX_SUMMARY_CHARS,
  MEMORY_OPEN_CHILDREN_MAX,
  MEMORY_OPEN_PAGE_DEFAULT,
  parsePrefixedNodeId,
  validateMemoryBodyText,
  type GraphEdgeRow,
  type MemoryGraphEdgeState,
  type MemoryGraphRelation,
  type MemoryKnowledgeKind,
  type MemoryLifecycleState,
  type MemoryObservationRow,
  type MemoryRow,
  type MemorySearchableNodeType,
  type PrefixedNodeId,
  type SummaryRow,
} from "./memory-types.ts";
import { computeMemoryRowHeat, computeSummaryRowHeat } from "./memory-heat.ts";

export function getMemoryActivityGeneration(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT activity_generation FROM workspace_state WHERE id = 1`)
    .get() as { activity_generation: number } | undefined;
  return row ? Number(row.activity_generation) : 0;
}

/** Advance activity generation by one (first-turn recall opportunity). */
export function incrementMemoryActivityGeneration(db: DatabaseSync): number {
  db.prepare(
    `UPDATE workspace_state
     SET activity_generation = activity_generation + 1,
         updated_at = datetime('now')
     WHERE id = 1`,
  ).run();
  return getMemoryActivityGeneration(db);
}

function mapMemoryRow(
  r: Record<string, unknown>,
  recurrence: number,
): MemoryRow {
  return {
    id: Number(r.id),
    kind: r.kind as MemoryKnowledgeKind,
    state: r.state as MemoryLifecycleState,
    currentVersionId: Number(r.current_version_id),
    creationGeneration: Number(r.creation_generation),
    noveltyUntilGeneration:
      r.novelty_until_generation === null ||
      r.novelty_until_generation === undefined
        ? null
        : Number(r.novelty_until_generation),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    text: String(r.text),
    recurrence,
  };
}

function recurrenceForMemory(db: DatabaseSync, memoryId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT o.source_session_id) AS n
       FROM memory_observations mo
       JOIN observations o ON o.id = mo.observation_id
       WHERE mo.memory_id = ?`,
    )
    .get(memoryId) as { n: number };
  return Number(row.n);
}

/** Load one memory by integer id with current text and derived recurrence. */
export function getMemoryById(
  db: DatabaseSync,
  memoryId: number,
): MemoryRow | null {
  const r = db
    .prepare(
      `SELECT m.id, m.kind, m.state, m.current_version_id, m.creation_generation,
              m.novelty_until_generation, m.created_at, m.updated_at, v.text
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       WHERE m.id = ?`,
    )
    .get(memoryId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return mapMemoryRow(r, recurrenceForMemory(db, memoryId));
}

/** Load one summary by integer id with current text. */
export function getSummaryById(
  db: DatabaseSync,
  summaryId: number,
): SummaryRow | null {
  const r = db
    .prepare(
      `SELECT s.id, s.state, s.current_version_id, s.creation_generation,
              s.created_at, s.updated_at, v.text
       FROM summaries s
       JOIN summary_versions v ON v.id = s.current_version_id
       WHERE s.id = ?`,
    )
    .get(summaryId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    state: r.state as MemoryLifecycleState,
    currentVersionId: Number(r.current_version_id),
    creationGeneration: Number(r.creation_generation),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    text: String(r.text),
  };
}

/** Load one observation leaf. */
export function getObservationById(
  db: DatabaseSync,
  observationId: number,
): MemoryObservationRow | null {
  const r = db
    .prepare(
      `SELECT id, kind, text, normalized_text, source_session_id,
              creation_generation, created_at
       FROM observations WHERE id = ?`,
    )
    .get(observationId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    kind: r.kind as MemoryKnowledgeKind,
    text: String(r.text),
    normalizedText: String(r.normalized_text),
    sourceSessionId: String(r.source_session_id),
    creationGeneration: Number(r.creation_generation),
    createdAt: String(r.created_at),
  };
}

/** List active memories with current text. */
export function listActiveMemories(db: DatabaseSync): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.state, m.current_version_id, m.creation_generation,
              m.novelty_until_generation, m.created_at, m.updated_at, v.text
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       WHERE m.state = 'active'
       ORDER BY m.id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    mapMemoryRow(r, recurrenceForMemory(db, Number(r.id))),
  );
}

/** List active summaries with current text. */
export function listActiveSummaries(db: DatabaseSync): SummaryRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.state, s.current_version_id, s.creation_generation,
              s.created_at, s.updated_at, v.text
       FROM summaries s
       JOIN summary_versions v ON v.id = s.current_version_id
       WHERE s.state = 'active'
       ORDER BY s.id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    state: r.state as MemoryLifecycleState,
    currentVersionId: Number(r.current_version_id),
    creationGeneration: Number(r.creation_generation),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    text: String(r.text),
  }));
}

/** List all memories (any state) for audit. */
export function listAllMemories(db: DatabaseSync): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.state, m.current_version_id, m.creation_generation,
              m.novelty_until_generation, m.created_at, m.updated_at, v.text
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       ORDER BY m.id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    mapMemoryRow(r, recurrenceForMemory(db, Number(r.id))),
  );
}

/** List all summaries (any state) for audit. */
export function listAllSummaries(db: DatabaseSync): SummaryRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.state, s.current_version_id, s.creation_generation,
              s.created_at, s.updated_at, v.text
       FROM summaries s
       JOIN summary_versions v ON v.id = s.current_version_id
       ORDER BY s.id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    state: r.state as MemoryLifecycleState,
    currentVersionId: Number(r.current_version_id),
    creationGeneration: Number(r.creation_generation),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    text: String(r.text),
  }));
}

/** Count memories/summaries by state for status. */
export function countMemoryNodesByState(db: DatabaseSync): {
  memories: Record<MemoryLifecycleState, number>;
  summaries: Record<MemoryLifecycleState, number>;
} {
  const empty = (): Record<MemoryLifecycleState, number> => ({
    active: 0,
    conflicted: 0,
    superseded: 0,
    retired: 0,
  });
  const memories = empty();
  const summaries = empty();
  for (const row of db
    .prepare(`SELECT state, COUNT(*) AS n FROM memories GROUP BY state`)
    .all() as Array<{ state: MemoryLifecycleState; n: number }>) {
    memories[row.state] = Number(row.n);
  }
  for (const row of db
    .prepare(`SELECT state, COUNT(*) AS n FROM summaries GROUP BY state`)
    .all() as Array<{ state: MemoryLifecycleState; n: number }>) {
    summaries[row.state] = Number(row.n);
  }
  return { memories, summaries };
}

export function listGraphEdgesFrom(
  db: DatabaseSync,
  fromType: MemorySearchableNodeType,
  fromId: number,
): GraphEdgeRow[] {
  const rows = db
    .prepare(
      `SELECT id, relation, from_type, from_id, to_type, to_id, state, created_at
       FROM graph_edges WHERE from_type = ? AND from_id = ?
       ORDER BY id ASC`,
    )
    .all(fromType, fromId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    relation: r.relation as GraphEdgeRow["relation"],
    fromType: r.from_type as MemorySearchableNodeType,
    fromId: Number(r.from_id),
    toType: r.to_type as MemorySearchableNodeType,
    toId: Number(r.to_id),
    state: (r.state ?? "active") as MemoryGraphEdgeState,
    createdAt: String(r.created_at),
  }));
}

export function listGraphEdgesTo(
  db: DatabaseSync,
  toType: MemorySearchableNodeType,
  toId: number,
): GraphEdgeRow[] {
  const rows = db
    .prepare(
      `SELECT id, relation, from_type, from_id, to_type, to_id, state, created_at
       FROM graph_edges WHERE to_type = ? AND to_id = ?
       ORDER BY id ASC`,
    )
    .all(toType, toId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    relation: r.relation as GraphEdgeRow["relation"],
    fromType: r.from_type as MemorySearchableNodeType,
    fromId: Number(r.from_id),
    toType: r.to_type as MemorySearchableNodeType,
    toId: Number(r.to_id),
    state: (r.state ?? "active") as MemoryGraphEdgeState,
    createdAt: String(r.created_at),
  }));
}

/**
 * Soft-retire one graph edge (state flip; the row is kept as append-only audit).
 * Idempotent when no active edge matches.
 */
export function retireGraphEdge(
  db: DatabaseSync,
  relation: MemoryGraphRelation,
  fromType: MemorySearchableNodeType,
  fromId: number,
  toType: MemorySearchableNodeType,
  toId: number,
): void {
  db.prepare(
    `UPDATE graph_edges
     SET state = 'retired'
     WHERE relation = ? AND from_type = ? AND from_id = ?
       AND to_type = ? AND to_id = ? AND state = 'active'`,
  ).run(relation, fromType, fromId, toType, toId);
}

/** Observations supporting a memory. */
export function listObservationsForMemory(
  db: DatabaseSync,
  memoryId: number,
): MemoryObservationRow[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.kind, o.text, o.normalized_text, o.source_session_id,
              o.creation_generation, o.created_at
       FROM memory_observations mo
       JOIN observations o ON o.id = mo.observation_id
       WHERE mo.memory_id = ?
       ORDER BY o.id ASC`,
    )
    .all(memoryId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind as MemoryKnowledgeKind,
    text: String(r.text),
    normalizedText: String(r.normalized_text),
    sourceSessionId: String(r.source_session_id),
    creationGeneration: Number(r.creation_generation),
    createdAt: String(r.created_at),
  }));
}

/** Memory version history (newest first). */
export function listMemoryVersions(
  db: DatabaseSync,
  memoryId: number,
): Array<{
  id: number;
  text: string;
  previousVersionId: number | null;
  createdAt: string;
}> {
  const rows = db
    .prepare(
      `SELECT id, text, previous_version_id, created_at
       FROM memory_versions WHERE memory_id = ?
       ORDER BY id DESC`,
    )
    .all(memoryId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    text: String(r.text),
    previousVersionId:
      r.previous_version_id === null || r.previous_version_id === undefined
        ? null
        : Number(r.previous_version_id),
    createdAt: String(r.created_at),
  }));
}

/** List immutable summary revision history in newest-first order for audit opens. */
export function listSummaryVersions(
  db: DatabaseSync,
  summaryId: number,
): Array<{
  id: number;
  text: string;
  previousVersionId: number | null;
  createdAt: string;
}> {
  const rows = db
    .prepare(
      `SELECT id, text, previous_version_id, created_at
       FROM summary_versions WHERE summary_id = ?
       ORDER BY id DESC`,
    )
    .all(summaryId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    text: String(r.text),
    previousVersionId:
      r.previous_version_id === null || r.previous_version_id === undefined
        ? null
        : Number(r.previous_version_id),
    createdAt: String(r.created_at),
  }));
}

export interface MemoryOpenNodeRecord {
  prefixedId: PrefixedNodeId;
  nodeType: "memory" | "summary" | "observation";
  kind: string;
  state?: MemoryLifecycleState;
  text: string;
  heat?: number;
  recurrence?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface MemoryOpenResult {
  target: MemoryOpenNodeRecord;
  children: MemoryOpenNodeRecord[];
  lateral: Array<{
    relation: string;
    direction: "from" | "to";
    prefixedId: string;
  }>;
  versions?: Array<{ id: number; text: string; createdAt: string }>;
  continuationCursor: string | null;
}

/**
 * Exact one-level open: target + children + lateral link IDs.
 * Pagination never splits a node; returns complete nodes + cursor.
 */
export function openMemoryNodeExact(
  db: DatabaseSync,
  prefixedId: string,
  opts?: { cursor?: string | null; pageSize?: number },
): MemoryOpenResult {
  const parsed = parsePrefixedNodeId(prefixedId);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const rawPage = opts?.pageSize ?? MEMORY_OPEN_PAGE_DEFAULT;
  const pageSize = Math.min(Math.max(1, rawPage), MEMORY_OPEN_CHILDREN_MAX);
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const generation = getMemoryActivityGeneration(db);

  if (parsed.type === "observation") {
    const obs = getObservationById(db, parsed.id);
    if (!obs) throw new Error(`Observation not found: ${prefixedId}`);
    return {
      target: {
        prefixedId: formatObservationNodeId(obs.id),
        nodeType: "observation",
        kind: obs.kind,
        text: obs.text,
        createdAt: obs.createdAt,
      },
      children: [],
      lateral: [],
      continuationCursor: null,
    };
  }

  if (parsed.type === "memory") {
    const mem = getMemoryById(db, parsed.id);
    if (!mem) throw new Error(`Memory not found: ${prefixedId}`);
    const heat = computeMemoryRowHeat(
      db,
      mem.id,
      generation,
      mem.noveltyUntilGeneration,
    );
    const observations = listObservationsForMemory(db, mem.id);
    const page = observations.slice(offset, offset + pageSize);
    const next =
      offset + pageSize < observations.length
        ? String(offset + pageSize)
        : null;

    const edgesFrom = listGraphEdgesFrom(db, "memory", mem.id);
    const edgesTo = listGraphEdgesTo(db, "memory", mem.id);
    const lateral = [
      ...edgesFrom
        .filter((e) => e.relation !== "contains")
        .map((e) => ({
          relation: e.relation,
          direction: "from" as const,
          prefixedId:
            e.toType === "memory"
              ? formatMemoryNodeId(e.toId)
              : formatSummaryNodeId(e.toId),
        })),
      ...edgesTo
        .filter((e) => e.relation !== "contains")
        .map((e) => ({
          relation: e.relation,
          direction: "to" as const,
          prefixedId:
            e.fromType === "memory"
              ? formatMemoryNodeId(e.fromId)
              : formatSummaryNodeId(e.fromId),
        })),
    ];

    return {
      target: {
        prefixedId: formatMemoryNodeId(mem.id),
        nodeType: "memory",
        kind: mem.kind,
        state: mem.state,
        text: mem.text,
        heat,
        recurrence: mem.recurrence,
        createdAt: mem.createdAt,
        updatedAt: mem.updatedAt,
      },
      children: page.map((o) => ({
        prefixedId: formatObservationNodeId(o.id),
        nodeType: "observation" as const,
        kind: o.kind,
        text: o.text,
        createdAt: o.createdAt,
      })),
      lateral,
      versions: listMemoryVersions(db, mem.id).map((v) => ({
        id: v.id,
        text: v.text,
        createdAt: v.createdAt,
      })),
      continuationCursor: next,
    };
  }

  // summary
  const summary = getSummaryById(db, parsed.id);
  if (!summary) throw new Error(`Summary not found: ${prefixedId}`);
  const heat = computeSummaryRowHeat(db, summary.id, generation);
  const contains = listGraphEdgesFrom(db, "summary", summary.id).filter(
    (e) => e.relation === "contains" && e.state === "active",
  );
  const page = contains.slice(offset, offset + pageSize);
  const next =
    offset + pageSize < contains.length ? String(offset + pageSize) : null;

  const children: MemoryOpenNodeRecord[] = [];
  for (const edge of page) {
    if (edge.toType === "memory") {
      const mem = getMemoryById(db, edge.toId);
      if (!mem) continue;
      children.push({
        prefixedId: formatMemoryNodeId(mem.id),
        nodeType: "memory",
        kind: mem.kind,
        state: mem.state,
        text: mem.text,
        heat: computeMemoryRowHeat(
          db,
          mem.id,
          generation,
          mem.noveltyUntilGeneration,
        ),
        recurrence: mem.recurrence,
        createdAt: mem.createdAt,
        updatedAt: mem.updatedAt,
      });
    } else {
      const child = getSummaryById(db, edge.toId);
      if (!child) continue;
      children.push({
        prefixedId: formatSummaryNodeId(child.id),
        nodeType: "summary",
        kind: "summary",
        state: child.state,
        text: child.text,
        heat: computeSummaryRowHeat(db, child.id, generation),
        createdAt: child.createdAt,
        updatedAt: child.updatedAt,
      });
    }
  }

  const edgesFrom = listGraphEdgesFrom(db, "summary", summary.id);
  const edgesTo = listGraphEdgesTo(db, "summary", summary.id);
  const lateral = [
    ...edgesFrom
      .filter((e) => e.relation !== "contains")
      .map((e) => ({
        relation: e.relation,
        direction: "from" as const,
        prefixedId:
          e.toType === "memory"
            ? formatMemoryNodeId(e.toId)
            : formatSummaryNodeId(e.toId),
      })),
    ...edgesTo
      .filter((e) => e.relation !== "contains")
      .map((e) => ({
        relation: e.relation,
        direction: "to" as const,
        prefixedId:
          e.fromType === "memory"
            ? formatMemoryNodeId(e.fromId)
            : formatSummaryNodeId(e.fromId),
      })),
  ];

  return {
    target: {
      prefixedId: formatSummaryNodeId(summary.id),
      nodeType: "summary",
      kind: "summary",
      state: summary.state,
      text: summary.text,
      heat,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    children,
    lateral,
    versions: listSummaryVersions(db, summary.id).map((v) => ({
      id: v.id,
      text: v.text,
      createdAt: v.createdAt,
    })),
    continuationCursor: next,
  };
}

/**
 * Would inserting a contains edge create a cycle?
 * Walk from `to` following active contains edges; if we reach `from`, it's a cycle.
 */
export function wouldMemoryContainsEdgeCycle(
  db: DatabaseSync,
  fromType: MemorySearchableNodeType,
  fromId: number,
  toType: MemorySearchableNodeType,
  toId: number,
): boolean {
  if (fromType === toType && fromId === toId) return true;
  const stack: Array<{ type: MemorySearchableNodeType; id: number }> = [
    { type: toType, id: toId },
  ];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    const key = `${node.type}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (node.type === fromType && node.id === fromId) return true;
    const children = listGraphEdgesFrom(db, node.type, node.id).filter(
      (e) => e.relation === "contains" && e.state === "active",
    );
    for (const c of children) {
      stack.push({ type: c.toType, id: c.toId });
    }
  }
  return false;
}

function retireActiveContainsEdgesOf(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): void {
  db.prepare(
    `UPDATE graph_edges SET state = 'retired'
     WHERE relation = 'contains' AND state = 'active'
       AND from_type = ? AND from_id = ?`,
  ).run(nodeType, nodeId);
  db.prepare(
    `UPDATE graph_edges SET state = 'retired'
     WHERE relation = 'contains' AND state = 'active'
       AND to_type = ? AND to_id = ?`,
  ).run(nodeType, nodeId);
}

function retireMemorySummary(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): void {
  db.prepare(
    `UPDATE ${nodeType === "memory" ? "memories" : "summaries"}
     SET state = 'retired', updated_at = datetime('now') WHERE id = ?`,
  ).run(nodeId);
  deleteMemorySearchDocument(db, nodeType, nodeId);
  retireActiveContainsEdgesOf(db, nodeType, nodeId);
}

/** The single active parent summary id of a node, or null. */
function activeParentSummaryId(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): number | null {
  const row = db
    .prepare(
      `SELECT e.from_id AS sid
       FROM graph_edges e
       JOIN summaries s ON s.id = e.from_id AND e.from_type = 'summary'
       WHERE e.relation = 'contains' AND e.state = 'active' AND s.state = 'active'
         AND e.to_type = ? AND e.to_id = ?
       ORDER BY e.id ASC LIMIT 1`,
    )
    .get(nodeType, nodeId) as { sid: number } | undefined;
  return row ? Number(row.sid) : null;
}

/**
 * Lifecycle reconciliation: when nodes become inactive (conflicted, superseded,
 * retired), the same transaction retires their incoming `contains` edges, and
 * every active ancestor summary whose member set now contains an inactive node
 * is retired with its outgoing `contains` edges, resurfacing remaining active
 * children as roots. Caller must already hold a write transaction.
 *
 * `opts.rewriteParent` keeps the direct active parent of the first excluded
 * node alive by rewriting it (CAS + non-strict shrink) instead of retiring it.
 */
export function reconcileMemoryTreeExclusion(
  db: DatabaseSync,
  excluded: Array<{ nodeType: MemorySearchableNodeType; nodeId: number }>,
  opts?: {
    rewriteParent?: {
      expectedVersionId: number;
      newSummaryText: string;
    } | null;
  },
): void {
  for (const node of excluded) {
    retireActiveContainsEdgesOf(db, node.nodeType, node.nodeId);
  }

  const rewrite = opts?.rewriteParent ?? null;
  let rewrittenParentId: number | null = null;
  if (rewrite && excluded.length > 0) {
    const first = excluded[0]!;
    const parentId = activeParentSummaryId(db, first.nodeType, first.nodeId);
    if (parentId === null) {
      throw new Error(
        `Cannot rewrite a parent summary for excluded ${first.nodeType}:${first.nodeId}: it has no active parent summary`,
      );
    }
    const summary = getSummaryById(db, parentId);
    if (!summary || summary.state !== "active") {
      throw new Error(
        `Parent summary S:${parentId} is not active; cannot rewrite it`,
      );
    }
    if (
      !Number.isSafeInteger(rewrite.expectedVersionId) ||
      rewrite.expectedVersionId <= 0
    ) {
      throw new Error(
        `Parent summary S:${parentId} rewrite requires a positive expectedSummaryVersionId`,
      );
    }
    if (summary.currentVersionId !== rewrite.expectedVersionId) {
      throw new Error(
        `Parent summary S:${parentId} version is stale (expected ${rewrite.expectedVersionId}, have ${summary.currentVersionId})`,
      );
    }
    const textError = validateMemoryBodyText(
      rewrite.newSummaryText,
      MEMORY_MAX_SUMMARY_CHARS,
    );
    if (textError) throw new Error(`Parent summary rewrite: ${textError}`);
    if (
      estimateMemoryTextTokens(rewrite.newSummaryText) >
      estimateMemoryTextTokens(summary.text)
    ) {
      throw new Error(
        `Parent summary rewrite must not grow: S:${parentId} (${estimateMemoryTextTokens(rewrite.newSummaryText)} > ${estimateMemoryTextTokens(summary.text)} tokens)`,
      );
    }
    const verResult = db
      .prepare(
        `INSERT INTO summary_versions (summary_id, text, previous_version_id)
         VALUES (?, ?, ?)`,
      )
      .run(parentId, rewrite.newSummaryText.trim(), summary.currentVersionId);
    const versionId = Number(verResult.lastInsertRowid);
    const updated = db
      .prepare(
        `UPDATE summaries
         SET current_version_id = ?, updated_at = datetime('now')
         WHERE id = ? AND state = 'active' AND current_version_id = ?`,
      )
      .run(versionId, parentId, rewrite.expectedVersionId);
    if (Number(updated.changes) !== 1) {
      throw new Error(
        `Parent summary S:${parentId} changed while its rewrite was committing`,
      );
    }
    upsertMemorySearchDocument(db, {
      nodeType: "summary",
      nodeId: parentId,
      text: rewrite.newSummaryText.trim(),
      kind: "summary",
      state: "active",
    });
    rewrittenParentId = parentId;
  }

  // Retire every active summary whose member set contains an inactive node
  // (transitively: a retired summary's parent is affected too). Edges retired
  // in this same transaction count (the excluded node's incoming edge was just
  // retired), so the check scans any-state edges; only the rewritten parent is
  // exempt. Loop until fixed point.
  for (;;) {
    const affected = db
      .prepare(
        `SELECT DISTINCT e.from_id AS sid
         FROM graph_edges e
         JOIN summaries s ON s.id = e.from_id AND e.from_type = 'summary'
         LEFT JOIN memories m ON m.id = e.to_id AND e.to_type = 'memory'
         LEFT JOIN summaries cs ON cs.id = e.to_id AND e.to_type = 'summary'
         WHERE e.relation = 'contains' AND s.state = 'active'
           AND (
             (e.to_type = 'memory' AND m.state IS NOT NULL AND m.state != 'active')
             OR (e.to_type = 'summary' AND cs.state IS NOT NULL AND cs.state != 'active')
           )
           AND e.from_id != ?`,
      )
      .all(rewrittenParentId ?? -1) as Array<{ sid: number }>;
    if (affected.length === 0) break;
    for (const row of affected) {
      retireMemorySummary(db, "summary", Number(row.sid));
    }
  }
}

/**
 * Soft-retire a memory or summary and remove it from derived search indexes.
 * Preserves observations, versions, and edges; retires the node's containment
 * edges and resurfaced ancestors per the lifecycle reconciliation rules.
 */
export function retireMemoryNode(
  db: DatabaseSync,
  prefixedId: string,
): { nodeType: MemorySearchableNodeType; nodeId: number } {
  const parsed = parsePrefixedNodeId(prefixedId);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.type === "observation") {
    throw new Error(
      "Cannot forget an observation directly; forget its parent memory instead",
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (parsed.type === "memory") {
      const row = getMemoryById(db, parsed.id);
      if (!row) throw new Error(`Memory not found: ${prefixedId}`);
    } else {
      const row = getSummaryById(db, parsed.id);
      if (!row) throw new Error(`Summary not found: ${prefixedId}`);
    }
    db.prepare(
      `UPDATE ${parsed.type === "memory" ? "memories" : "summaries"}
       SET state = 'retired', updated_at = datetime('now') WHERE id = ?`,
    ).run(parsed.id);
    deleteMemorySearchDocument(db, parsed.type, parsed.id);
    reconcileMemoryTreeExclusion(db, [
      { nodeType: parsed.type, nodeId: parsed.id },
    ]);
    db.exec("COMMIT");
    return { nodeType: parsed.type, nodeId: parsed.id };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/** Record a recall event after a node is selected for output or opened. */
export function recordMemoryRecallEvent(
  db: DatabaseSync,
  input: {
    nodeType: MemorySearchableNodeType;
    nodeId: number;
    source: "startup" | "search" | "open";
    piSessionId?: string | null;
    activityGeneration?: number;
  },
): void {
  const generation =
    input.activityGeneration ?? getMemoryActivityGeneration(db);
  db.prepare(
    `INSERT INTO recall_events
       (node_type, node_id, activity_generation, source, pi_session_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.nodeType,
    input.nodeId,
    generation,
    input.source,
    input.piSessionId ?? null,
  );
}
