/**
 * Memory queries, version history, and exact one-level open for audit.
 */

import type { DatabaseSync } from "node:sqlite";
import { deleteMemorySearchDocument } from "./memory-database.ts";
import {
  parseMemoryNodeId,
  type MemoryCitationSource,
  type MemoryKnowledgeKind,
  type MemoryLifecycleState,
  type MemoryRow,
  type MemorySearchableNodeType,
  type MemoryVersionRow,
} from "./memory-types.ts";

/** Current activity generation: the audit-only session counter stamped as creation_generation on new versions and memories; never a ranking input. */
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
    retiredBySessionId:
      r.retired_by_session_id === null || r.retired_by_session_id === undefined
        ? null
        : String(r.retired_by_session_id),
    retiredEvidenceText:
      r.retired_evidence_text === null || r.retired_evidence_text === undefined
        ? null
        : String(r.retired_evidence_text),
  };
}

/** Recurrence: distinct source sessions that produced a version of this memory. */
function recurrenceForMemory(db: DatabaseSync, memoryId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT source_session_id) AS n
       FROM memory_versions WHERE memory_id = ?`,
    )
    .get(memoryId) as { n: number };
  return Number(row.n);
}

const MEMORY_ROW_SELECT = `SELECT m.id, m.kind, m.state, m.current_version_id,
        m.creation_generation, m.created_at, m.updated_at,
        m.retired_by_session_id, m.retired_evidence_text, v.text
 FROM memories m
 JOIN memory_versions v ON v.id = m.current_version_id`;

/** Load one memory by integer id with current text and derived recurrence. */
export function getMemoryById(
  db: DatabaseSync,
  memoryId: number,
): MemoryRow | null {
  const r = db.prepare(`${MEMORY_ROW_SELECT} WHERE m.id = ?`).get(memoryId) as
    Record<string, unknown> | undefined;
  if (!r) return null;
  return mapMemoryRow(r, recurrenceForMemory(db, memoryId));
}

/** List active memories with current text. */
export function listActiveMemories(db: DatabaseSync): MemoryRow[] {
  const rows = db
    .prepare(`${MEMORY_ROW_SELECT} WHERE m.state = 'active' ORDER BY m.id ASC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    mapMemoryRow(r, recurrenceForMemory(db, Number(r.id))),
  );
}

/** List all memories (any state) for audit. */
export function listAllMemories(db: DatabaseSync): MemoryRow[] {
  const rows = db
    .prepare(`${MEMORY_ROW_SELECT} ORDER BY m.id ASC`)
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
    retired: 0,
  };
  for (const row of db
    .prepare(`SELECT state, COUNT(*) AS n FROM memories GROUP BY state`)
    .all() as Array<{ state: MemoryLifecycleState; n: number }>) {
    counts[row.state] = Number(row.n);
  }
  return counts;
}

/** Full version history of a memory (newest first), each with its evidence quote and source session. */
export function listMemoryVersions(
  db: DatabaseSync,
  memoryId: number,
): MemoryVersionRow[] {
  const rows = db
    .prepare(
      `SELECT id, memory_id, text, evidence_text, source_session_id,
              creation_generation, previous_version_id, created_at
       FROM memory_versions WHERE memory_id = ?
       ORDER BY id DESC`,
    )
    .all(memoryId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    memoryId: Number(r.memory_id),
    text: String(r.text),
    evidenceText: String(r.evidence_text),
    sourceSessionId: String(r.source_session_id),
    creationGeneration: Number(r.creation_generation),
    previousVersionId:
      r.previous_version_id === null || r.previous_version_id === undefined
        ? null
        : Number(r.previous_version_id),
    createdAt: String(r.created_at),
  }));
}

export interface MemoryOpenResult {
  target: MemoryRow;
  /** Version history (newest first), each row an immutable create/update event. */
  versions: MemoryVersionRow[];
  continuationCursor: string | null;
}

/** Default page size for /memory open version history. */
const MEMORY_OPEN_PAGE_DEFAULT = 40;

/** Maximum version rows returned per /memory open page. */
const MEMORY_OPEN_VERSIONS_MAX = 50;

/**
 * Exact one-level open: the memory plus its version history with evidence.
 * Pagination never splits a row; returns complete rows + cursor.
 */
export function openMemoryNodeExact(
  db: DatabaseSync,
  prefixedId: string,
  opts?: { cursor?: string | null; pageSize?: number },
): MemoryOpenResult {
  const parsed = parseMemoryNodeId(prefixedId);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const rawPage = opts?.pageSize ?? MEMORY_OPEN_PAGE_DEFAULT;
  const pageSize = Math.min(Math.max(1, rawPage), MEMORY_OPEN_VERSIONS_MAX);
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;

  const mem = getMemoryById(db, parsed.id);
  if (!mem) throw new Error(`Memory not found: ${prefixedId}`);
  const versions = listMemoryVersions(db, mem.id);
  const page = versions.slice(offset, offset + pageSize);
  const next =
    offset + pageSize < versions.length ? String(offset + pageSize) : null;

  return {
    target: mem,
    versions: page,
    continuationCursor: next,
  };
}

/**
 * Soft-retire a memory and remove it from the derived search projections
 * (FTS + documents + embeddings). Preserves versions, evidence, and the row
 * itself — retirement is retrieval exclusion only.
 */
export function retireMemoryNode(
  db: DatabaseSync,
  prefixedId: string,
): { nodeType: MemorySearchableNodeType; nodeId: number } {
  const parsed = parseMemoryNodeId(prefixedId);
  if (!parsed.ok) throw new Error(parsed.error);
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
