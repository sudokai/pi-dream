/**
 * Per-workspace SQLite database for adaptive memory.
 * WAL, foreign keys, busy timeout, transactional migrations via PRAGMA user_version.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { MEMORY_DB_BUSY_TIMEOUT_MS } from "./memory-types.ts";
import {
  ensureMemoryWorkspaceDataDir,
  memoryWorkspaceDbPath,
} from "./memory-workspace-id.ts";
import { ensureMemorySecureDir } from "./memory-fs.ts";

/**
 * Schema version. user_version uniquely determines shape. v6 and older
 * stores are discarded and re-mined from transcripts (the wipe-on-bump
 * policy); v7 is the first additive migration, preserving data.
 * v7 shape: v6 plus `source_sessions.total_messages` (so a partial mine
 * stays eligible — `mined_message_offset < total_messages`) and
 * `workspace_state.last_failed_run_at_ms` (cadence failure backoff).
 */
export const MEMORY_SCHEMA_VERSION = 7;

const SCHEMA_SQL = `
CREATE TABLE workspace_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  activity_generation INTEGER NOT NULL DEFAULT 0,
  turns_since_last_run INTEGER NOT NULL DEFAULT 0,
  last_successful_run_at_ms INTEGER NOT NULL DEFAULT 0,
  last_observed_transcript_mtime_ms INTEGER,
  recall_capacity_error TEXT,
  embedding_degraded_error TEXT,
  -- Cadence failure backoff: set when a dream fails; auto dreaming is gated
  -- on elapsed time since the last failure as well as the last success.
  last_failed_run_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source_sessions (
  session_id TEXT PRIMARY KEY,
  session_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  processed_mtime_ms INTEGER NOT NULL,
  content_hash TEXT,
  -- Incremental mining cursor: number of visible session messages already mined.
  mined_message_offset INTEGER NOT NULL DEFAULT 0,
  -- Visible-message count of the snapshot at checkpoint time. A checkpoint
  -- with mined_message_offset < total_messages is a partial mine: the session
  -- stays eligible and a later dream resumes at the cursor.
  total_messages INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE dream_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_text TEXT,
  reported_to_parent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact')),
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  current_version_id INTEGER,
  -- Normalized current-version text; denormalized projection maintained
  -- alongside current_version_id so active-memory dedupe has a unique target.
  normalized_text TEXT NOT NULL DEFAULT '',
  creation_generation INTEGER NOT NULL,
  -- Forget audit: which session retired the memory and the verbatim statement.
  retired_by_session_id TEXT,
  retired_evidence_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The version chain is the complete, append-only life of a memory: one row
-- per event (create or update), each carrying the distilled wording, the
-- verbatim evidence quote, and the source session that produced it. Nothing
-- is ever deleted; retirement is recorded on the memories row instead.
CREATE TABLE memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  text TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  creation_generation INTEGER NOT NULL,
  previous_version_id INTEGER REFERENCES memory_versions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE citation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type TEXT NOT NULL CHECK (node_type IN ('memory')),
  node_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('briefing', 'search')),
  pi_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE search_documents (
  node_type TEXT NOT NULL CHECK (node_type IN ('memory')),
  node_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (node_type, node_id)
);

-- FTS5 over active memory text; rowid equals the memory id so projection
-- maintenance can upsert/delete by rowid. Maintained alongside
-- search_documents by the shared projection helpers.
CREATE VIRTUAL TABLE memory_fts USING fts5(text, tokenize='unicode61');

CREATE TABLE embeddings (
  node_type TEXT NOT NULL CHECK (node_type IN ('memory')),
  node_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (node_type, node_id, model_id)
);

CREATE INDEX idx_memories_state ON memories(state);
-- Hard invariant: no two active memories share normalized body text. Retired
-- rows are excluded so a slot is freed when a memory is forgotten.
CREATE UNIQUE INDEX idx_memories_active_normalized_text ON memories(normalized_text)
  WHERE state = 'active';
CREATE INDEX idx_memory_versions_memory ON memory_versions(memory_id, id);
CREATE INDEX idx_citation_node ON citation_events(node_type, node_id, created_at);
CREATE INDEX idx_dream_runs_status ON dream_runs(status, reported_to_parent);
`;

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name=?",
    )
    .get(name) as { ok: number } | undefined;
  return !!row;
}

function createFreshSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_SQL);
    db.exec(
      "INSERT INTO workspace_state (id, activity_generation, turns_since_last_run, last_successful_run_at_ms) VALUES (1, 0, 0, 0)",
    );
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback or close failure is ignored.
    }
    throw err;
  }
}

const REQUIRED_TABLES = [
  "workspace_state",
  "source_sessions",
  "dream_runs",
  "memories",
  "memory_versions",
  "citation_events",
  "search_documents",
  "memory_fts",
  "embeddings",
] as const;

function validateMemorySchema(db: DatabaseSync): void {
  for (const name of REQUIRED_TABLES) {
    if (!tableExists(db, name)) {
      throw new Error(`Memory database missing required table: ${name}`);
    }
  }
}

/** Every table the extension has ever created, including FTS shadow tables and
 * retired table names from older schema versions (old stores are wiped, not
 * migrated). */
const ALL_KNOWN_TABLES = [
  "workspace_state",
  "source_sessions",
  "dream_runs",
  "learning_runs",
  "observations",
  "memories",
  "memory_versions",
  "memory_observations",
  "summaries",
  "summary_versions",
  "graph_edges",
  "recall_events",
  "citation_events",
  "search_documents",
  "search_fts",
  "search_fts_data",
  "search_fts_idx",
  "search_fts_content",
  "search_fts_docsize",
  "search_fts_config",
  "memory_fts",
  "memory_fts_data",
  "memory_fts_idx",
  "memory_fts_content",
  "memory_fts_docsize",
  "memory_fts_config",
  "embeddings",
  "consolidation_attempts",
  "maintenance_attempts",
] as const;

/**
 * Discard an out-of-date store wholesale (no backwards-compatibility shims):
 * any version below the current schema is wiped and recreated fresh. Only
 * `version > current` refuses, so an older extension never destroys a newer store.
 */
function wipeMemoryDatabase(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of ALL_KNOWN_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/**
 * Additive v6 → v7 migration (first non-destructive bump): adds the partial-
 * mine cursor column and the cadence failure-backoff column. Legacy v6
 * checkpoints are treated as fully mined (`total_messages = cursor`), which
 * preserves every existing memory and checkpoint; only sessions that were
 * committed with a partial cursor stay as they were recorded.
 */
function migrateV6ToV7(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "ALTER TABLE source_sessions ADD COLUMN total_messages INTEGER NOT NULL DEFAULT 0",
    );
    db.exec("UPDATE source_sessions SET total_messages = mined_message_offset");
    db.exec(
      "ALTER TABLE workspace_state ADD COLUMN last_failed_run_at_ms INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

function ensureSchema(db: DatabaseSync): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (version > MEMORY_SCHEMA_VERSION) {
    throw new Error(
      `Memory database version ${version} is newer than this extension (${MEMORY_SCHEMA_VERSION}); upgrade pi-dream before opening this workspace.`,
    );
  }
  if (version === MEMORY_SCHEMA_VERSION) {
    validateMemorySchema(db);
    return;
  }
  if (version === 6) {
    migrateV6ToV7(db);
    validateMemorySchema(db);
    return;
  }
  // Any older version (including a legacy v0/v1 store with data) is discarded
  // and recreated fresh; the dreamer re-mines session transcripts from disk.
  wipeMemoryDatabase(db);
  createFreshSchema(db);
}

export interface OpenMemoryDatabaseOptions {
  busyTimeoutMs?: number;
  /** When set, open this path instead of the workspace default. */
  dbPath?: string;
}

/**
 * Open (and migrate) the per-workspace memory database.
 * Creates parent directories as needed.
 */
export function openMemoryDatabase(
  workspaceId: string,
  opts: OpenMemoryDatabaseOptions = {},
): DatabaseSync {
  const dbPath =
    opts.dbPath ??
    (() => {
      ensureMemoryWorkspaceDataDir(workspaceId);
      return memoryWorkspaceDbPath(workspaceId);
    })();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  ensureMemorySecureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    `PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? MEMORY_DB_BUSY_TIMEOUT_MS}`,
  );
  ensureSchema(db);
  return db;
}

/**
 * Open a temporary in-memory or file database for tests.
 * Pass `:memory:` or a temp file path via `dbPath`.
 */
export function openMemoryDatabaseAtPath(
  dbPath: string,
  opts: { busyTimeoutMs?: number } = {},
): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    ensureMemorySecureDir(path.dirname(dbPath));
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec(
    `PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? MEMORY_DB_BUSY_TIMEOUT_MS}`,
  );
  ensureSchema(db);
  return db;
}

/** Close a database handle; idempotent. */
export function closeMemoryDatabase(db: DatabaseSync | null | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Nested rollback or close failure is ignored.
  }
}

/** Upsert one search document (canonical node-text projection + FTS row). */
export function upsertMemorySearchDocument(
  db: DatabaseSync,
  doc: {
    nodeType: "memory";
    nodeId: number;
    text: string;
    kind: string;
    state: string;
  },
): void {
  db.prepare(
    "DELETE FROM search_documents WHERE node_type = ? AND node_id = ?",
  ).run(doc.nodeType, doc.nodeId);
  db.prepare(
    `INSERT INTO search_documents (node_type, node_id, text, kind, state, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(doc.nodeType, doc.nodeId, doc.text, doc.kind, doc.state);
  db.prepare(`DELETE FROM memory_fts WHERE rowid = ?`).run(doc.nodeId);
  db.prepare(`INSERT INTO memory_fts (rowid, text) VALUES (?, ?)`).run(
    doc.nodeId,
    doc.text,
  );
}

/** Remove a node from the derived search projections (FTS + documents + embeddings). */
export function deleteMemorySearchDocument(
  db: DatabaseSync,
  nodeType: "memory",
  nodeId: number,
): void {
  db.prepare(
    "DELETE FROM search_documents WHERE node_type = ? AND node_id = ?",
  ).run(nodeType, nodeId);
  db.prepare("DELETE FROM embeddings WHERE node_type = ? AND node_id = ?").run(
    nodeType,
    nodeId,
  );
  db.prepare(`DELETE FROM memory_fts WHERE rowid = ?`).run(nodeId);
}

/**
 * Remove every embedding row for a memory (all models). Used by write paths
 * whose text changed but whose search document stays (revise): the next
 * embedding pass re-embeds from the fresh search_documents row.
 */
export function deleteMemoryEmbeddings(
  db: DatabaseSync,
  nodeType: "memory",
  nodeId: number,
): void {
  db.prepare("DELETE FROM embeddings WHERE node_type = ? AND node_id = ?").run(
    nodeType,
    nodeId,
  );
}
