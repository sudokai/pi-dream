/**
 * Per-workspace SQLite database for adaptive memory.
 * WAL, foreign keys, busy timeout, transactional migrations via PRAGMA user_version.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MEMORY_DB_BUSY_TIMEOUT_MS,
} from "./memory-types.ts";
import {
  ensureMemoryWorkspaceDataDir,
  memoryWorkspaceDbPath,
} from "./memory-workspace-id.ts";

export const MEMORY_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE workspace_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  activity_generation INTEGER NOT NULL DEFAULT 0,
  turns_since_last_run INTEGER NOT NULL DEFAULT 0,
  last_successful_run_at_ms INTEGER NOT NULL DEFAULT 0,
  last_observed_transcript_mtime_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source_sessions (
  session_id TEXT PRIMARY KEY,
  session_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  processed_mtime_ms INTEGER NOT NULL,
  content_hash TEXT,
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE learning_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_text TEXT,
  reported_to_parent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'correction', 'other')),
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  creation_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_session_id, normalized_text)
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'correction', 'other')),
  state TEXT NOT NULL CHECK (state IN ('active', 'conflicted', 'superseded', 'retired')),
  current_version_id INTEGER,
  creation_generation INTEGER NOT NULL,
  novelty_until_generation INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  text TEXT NOT NULL,
  previous_version_id INTEGER REFERENCES memory_versions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memory_observations (
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  PRIMARY KEY (memory_id, observation_id)
);

CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL CHECK (state IN ('active', 'conflicted', 'superseded', 'retired')),
  current_version_id INTEGER,
  creation_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE summary_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id INTEGER NOT NULL REFERENCES summaries(id),
  text TEXT NOT NULL,
  previous_version_id INTEGER REFERENCES summary_versions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relation TEXT NOT NULL CHECK (relation IN ('contains', 'related_to', 'supersedes', 'conflicts_with')),
  from_type TEXT NOT NULL CHECK (from_type IN ('memory', 'summary')),
  from_id INTEGER NOT NULL,
  to_type TEXT NOT NULL CHECK (to_type IN ('memory', 'summary')),
  to_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (relation, from_type, from_id, to_type, to_id)
);

CREATE TABLE recall_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type TEXT NOT NULL CHECK (node_type IN ('memory', 'summary')),
  node_id INTEGER NOT NULL,
  activity_generation INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('startup', 'search', 'open')),
  pi_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE search_documents (
  node_type TEXT NOT NULL CHECK (node_type IN ('memory', 'summary')),
  node_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (node_type, node_id)
);

-- FTS5 index of active memory/summary text for BM25 ranking.
CREATE VIRTUAL TABLE search_fts USING fts5(
  text,
  node_type UNINDEXED,
  node_id UNINDEXED,
  kind UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE embeddings (
  node_type TEXT NOT NULL CHECK (node_type IN ('memory', 'summary')),
  node_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (node_type, node_id, model_id)
);

CREATE INDEX idx_memories_state ON memories(state);
CREATE INDEX idx_summaries_state ON summaries(state);
CREATE INDEX idx_observations_source ON observations(source_session_id);
CREATE INDEX idx_memory_observations_obs ON memory_observations(observation_id);
CREATE INDEX idx_graph_from ON graph_edges(from_type, from_id);
CREATE INDEX idx_graph_to ON graph_edges(to_type, to_id);
CREATE INDEX idx_recall_node ON recall_events(node_type, node_id);
CREATE INDEX idx_learning_runs_status ON learning_runs(status, reported_to_parent);
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

function ensureSchema(db: DatabaseSync): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (
    version === MEMORY_SCHEMA_VERSION &&
    tableExists(db, "workspace_state") &&
    tableExists(db, "memories")
  ) {
    return;
  }
  if (version === 0 && !tableExists(db, "workspace_state")) {
    createFreshSchema(db);
    return;
  }
  throw new Error(
    `Unsupported memory database schema version ${version}; expected ${MEMORY_SCHEMA_VERSION}`,
  );
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

/** Clear and rebuild the standalone FTS index from search_documents. */
export function rebuildMemorySearchFts(db: DatabaseSync): void {
  db.exec("DELETE FROM search_fts");
  const rows = db
    .prepare(
      `SELECT node_type, node_id, text, kind FROM search_documents WHERE state = 'active'`,
    )
    .all() as Array<{
    node_type: string;
    node_id: number;
    text: string;
    kind: string;
  }>;
  const insert = db.prepare(
    `INSERT INTO search_fts (text, node_type, node_id, kind) VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.text, row.node_type, row.node_id, row.kind);
  }
}

/** Upsert one search document and keep the FTS row in sync. */
export function upsertMemorySearchDocument(
  db: DatabaseSync,
  doc: {
    nodeType: "memory" | "summary";
    nodeId: number;
    text: string;
    kind: string;
    state: string;
  },
): void {
  db.prepare(
    "DELETE FROM search_fts WHERE node_type = ? AND node_id = ?",
  ).run(doc.nodeType, doc.nodeId);
  db.prepare(
    "DELETE FROM search_documents WHERE node_type = ? AND node_id = ?",
  ).run(doc.nodeType, doc.nodeId);
  db.prepare(
    `INSERT INTO search_documents (node_type, node_id, text, kind, state, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(doc.nodeType, doc.nodeId, doc.text, doc.kind, doc.state);
  if (doc.state === "active") {
    db.prepare(
      `INSERT INTO search_fts (text, node_type, node_id, kind) VALUES (?, ?, ?, ?)`,
    ).run(doc.text, doc.nodeType, doc.nodeId, doc.kind);
  }
}

/** Remove a node from the derived search index. */
export function deleteMemorySearchDocument(
  db: DatabaseSync,
  nodeType: "memory" | "summary",
  nodeId: number,
): void {
  db.prepare(
    "DELETE FROM search_fts WHERE node_type = ? AND node_id = ?",
  ).run(nodeType, nodeId);
  db.prepare(
    "DELETE FROM search_documents WHERE node_type = ? AND node_id = ?",
  ).run(nodeType, nodeId);
}

/**
 * Rebuild all active search documents from current memory/summary versions.
 * Also rebuilds the FTS index.
 */
export function rebuildMemorySearchDocuments(db: DatabaseSync): void {
  db.exec("DELETE FROM search_documents");
  const memories = db
    .prepare(
      `SELECT m.id, m.kind, m.state, v.text
       FROM memories m
       JOIN memory_versions v ON v.id = m.current_version_id
       WHERE m.state = 'active'`,
    )
    .all() as Array<{ id: number; kind: string; state: string; text: string }>;
  const summaries = db
    .prepare(
      `SELECT s.id, s.state, v.text
       FROM summaries s
       JOIN summary_versions v ON v.id = s.current_version_id
       WHERE s.state = 'active'`,
    )
    .all() as Array<{ id: number; state: string; text: string }>;

  const insert = db.prepare(
    `INSERT INTO search_documents (node_type, node_id, text, kind, state, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );
  for (const row of memories) {
    insert.run("memory", row.id, row.text, row.kind, row.state);
  }
  for (const row of summaries) {
    insert.run("summary", row.id, row.text, "summary", row.state);
  }
  rebuildMemorySearchFts(db);
}
