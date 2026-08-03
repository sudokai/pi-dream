/**
 * Graph queries and exact one-level expansion for memory/observation nodes.
 */

import type { DatabaseSync } from "node:sqlite";
import { deleteMemorySearchDocument } from "./memory-database.ts";
import {
  formatMemoryNodeId,
  formatObservationNodeId,
  parsePrefixedNodeId,
  type CitationEventRow,
  type GraphEdgeRow,
  type MemoryCitationSource,
  type MemoryGraphEdgeState,
  type MemoryGraphRelation,
  type MemoryKnowledgeKind,
  type MemoryLifecycleState,
  type MemoryObservationRow,
  type MemoryRow,
  type MemorySearchableNodeType,
  type PrefixedNodeId,
} from "./memory-types.ts";

/** Current activity generation: the audit-only session counter stamped as creation_generation on new observations and memories; never a ranking input. */
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
              m.created_at, m.updated_at, v.text
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       WHERE m.id = ?`,
    )
    .get(memoryId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return mapMemoryRow(r, recurrenceForMemory(db, memoryId));
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
              m.created_at, m.updated_at, v.text
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

/** List all memories (any state) for audit. */
export function listAllMemories(db: DatabaseSync): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.state, m.current_version_id, m.creation_generation,
              m.created_at, m.updated_at, v.text
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       ORDER BY m.id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    mapMemoryRow(r, recurrenceForMemory(db, Number(r.id))),
  );
}

/** Count memories by state for status. */
export function countMemoryNodesByState(
  db: DatabaseSync,
): Record<MemoryLifecycleState, number> {
  const counts: Record<MemoryLifecycleState, number> = {
    active: 0,
    conflicted: 0,
    superseded: 0,
    retired: 0,
  };
  for (const row of db
    .prepare(`SELECT state, COUNT(*) AS n FROM memories GROUP BY state`)
    .all() as Array<{ state: MemoryLifecycleState; n: number }>) {
    counts[row.state] = Number(row.n);
  }
  return counts;
}

/** Graph edges leaving a node (from_type/from_id), active and retired, oldest first. */
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

/** Graph edges arriving at a node (to_type/to_id), active and retired, oldest first. */
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

export interface MemoryOpenNodeRecord {
  prefixedId: PrefixedNodeId;
  nodeType: "memory" | "observation";
  kind: string;
  state?: MemoryLifecycleState;
  text: string;
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

/** Default page size for /memory open observations. */
const MEMORY_OPEN_PAGE_DEFAULT = 40;

/** Maximum observation children returned per /memory open page. */
const MEMORY_OPEN_CHILDREN_MAX = 50;

/**
 * Exact one-level open: target + observations + lateral link IDs.
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

  const mem = getMemoryById(db, parsed.id);
  if (!mem) throw new Error(`Memory not found: ${prefixedId}`);
  const observations = listObservationsForMemory(db, mem.id);
  const page = observations.slice(offset, offset + pageSize);
  const next =
    offset + pageSize < observations.length ? String(offset + pageSize) : null;

  const edgesFrom = listGraphEdgesFrom(db, "memory", mem.id);
  const edgesTo = listGraphEdgesTo(db, "memory", mem.id);
  const lateral = [
    ...edgesFrom.map((e) => ({
      relation: e.relation,
      direction: "from" as const,
      prefixedId: formatMemoryNodeId(e.toId),
    })),
    ...edgesTo.map((e) => ({
      relation: e.relation,
      direction: "to" as const,
      prefixedId: formatMemoryNodeId(e.fromId),
    })),
  ];

  return {
    target: {
      prefixedId: formatMemoryNodeId(mem.id),
      nodeType: "memory",
      kind: mem.kind,
      state: mem.state,
      text: mem.text,
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

/** List citation events for one node (newest first). */
export function listCitationEventsForNode(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): CitationEventRow[] {
  const rows = db
    .prepare(
      `SELECT id, node_type, node_id, source, pi_session_id, created_at
       FROM citation_events WHERE node_type = ? AND node_id = ?
       ORDER BY id DESC`,
    )
    .all(nodeType, nodeId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    nodeType: r.node_type as MemorySearchableNodeType,
    nodeId: Number(r.node_id),
    source: r.source as MemoryCitationSource,
    piSessionId:
      r.pi_session_id === null || r.pi_session_id === undefined
        ? null
        : String(r.pi_session_id),
    createdAt: String(r.created_at),
  }));
}

/**
 * Soft-retire a memory and remove it from the derived search projections
 * (FTS + documents + embeddings). Preserves observations, versions, and edges.
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
    const row = getMemoryById(db, parsed.id);
    if (!row) throw new Error(`Memory not found: ${prefixedId}`);
    db.prepare(
      `UPDATE memories SET state = 'retired', updated_at = datetime('now') WHERE id = ?`,
    ).run(parsed.id);
    deleteMemorySearchDocument(db, "memory", parsed.id);
    db.exec("COMMIT");
    return { nodeType: "memory", nodeId: parsed.id };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/** Record a citation event after a validated source is used in output. */
export function recordMemoryCitation(
  db: DatabaseSync,
  input: {
    nodeType: MemorySearchableNodeType;
    nodeId: number;
    source: MemoryCitationSource;
    piSessionId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO citation_events (node_type, node_id, source, pi_session_id)
     VALUES (?, ?, ?, ?)`,
  ).run(input.nodeType, input.nodeId, input.source, input.piSessionId ?? null);
}

/** Whether any citation event exists for a node. */
export function memoryHasCitations(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM citation_events
       WHERE node_type = ? AND node_id = ? LIMIT 1`,
    )
    .get(nodeType, nodeId) as { ok: number } | undefined;
  return !!row;
}
