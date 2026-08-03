import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  MEMORY_SCHEMA_VERSION,
  openMemoryDatabaseAtPath,
  upsertMemorySearchDocument,
} from "./memory-database.ts";
import { retireGraphEdge } from "./memory-graph.ts";
import { getMemoryWorkspaceState } from "./memory-repository.ts";

function insertEdgeForTest(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  relation: string,
  fromId: number,
  toId: number,
): void {
  db.prepare(
    `INSERT INTO graph_edges (relation, from_type, from_id, to_type, to_id)
     VALUES (?, 'memory', ?, 'memory', ?)`,
  ).run(relation, fromId, toId);
}

test("openMemoryDatabaseAtPath migrates fresh schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-db-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    const db = openMemoryDatabaseAtPath(dbPath);
    const version = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION);
    const state = db
      .prepare("SELECT activity_generation FROM workspace_state WHERE id = 1")
      .get() as { activity_generation: number };
    assert.equal(state.activity_generation, 0);
    closeMemoryDatabase(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema v5: no summaries, no containment, no recall_events; FTS5 present", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const edges = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'graph_edges'`)
      .get() as { sql: string };
    assert.match(edges.sql, /state TEXT NOT NULL DEFAULT 'active'/);
    assert.match(
      edges.sql,
      /relation IN \('related_to', 'supersedes', 'conflicts_with'\)/,
      "contains is no longer a relation",
    );
    assert.doesNotMatch(edges.sql, /'summary'/, "summary node type is gone");
    const index = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE name = 'idx_graph_edges_active_unique'`,
      )
      .get() as { sql: string };
    assert.ok(index.sql.includes("WHERE state = 'active'"));

    const fts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'memory_fts%'`,
      )
      .get() as { n: number };
    assert.ok(Number(fts.n) >= 1, "FTS5 table exists in the fresh schema");
    for (const retired of [
      "summaries",
      "summary_versions",
      "consolidation_attempts",
      "recall_events",
    ]) {
      const n = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`)
          .get(retired) as { n: number }
      ).n;
      assert.equal(Number(n), 0, `${retired} must not exist in v5`);
    }
    const citations = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'citation_events'`,
        )
        .get() as { n: number }
    ).n;
    assert.equal(Number(citations), 1, "citation_events exists");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("retire-then-relink the same pair succeeds (partial unique index)", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    insertEdgeForTest(db, "related_to", 1, 2);
    retireGraphEdge(db, "related_to", "memory", 1, "memory", 2);
    insertEdgeForTest(db, "related_to", 1, 2);
    const rows = db.prepare(`SELECT state FROM graph_edges`).all() as Array<{
      state: string;
    }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.state).sort(), ["active", "retired"]);
    // Duplicate active edge is still rejected.
    assert.throws(() => insertEdgeForTest(db, "related_to", 1, 2));
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a legacy v3-shaped DB with rows opens as an empty fresh store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-db-legacy-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    // Build a v3-shaped store by hand: stamp version 3 and insert a memory row.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        current_version_id INTEGER,
        creation_generation INTEGER NOT NULL,
        novelty_until_generation INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE memory_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        previous_version_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL,
        current_version_id INTEGER,
        creation_generation INTEGER NOT NULL,
        label_source TEXT NOT NULL DEFAULT 'model',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE recall_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_type TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        activity_generation INTEGER NOT NULL,
        source TEXT NOT NULL,
        pi_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO memories (kind, state, current_version_id, creation_generation)
        VALUES ('fact', 'active', 1, 0);
      INSERT INTO memory_versions (memory_id, text) VALUES (1, 'legacy fact');
      INSERT INTO summaries (state, current_version_id, creation_generation)
        VALUES ('active', 1, 0);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const db = openMemoryDatabaseAtPath(dbPath);
    const version = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    assert.equal(version, MEMORY_SCHEMA_VERSION);
    const memoryCount = db
      .prepare(`SELECT COUNT(*) AS n FROM memories`)
      .get() as { n: number };
    assert.equal(
      Number(memoryCount.n),
      0,
      "legacy rows must be discarded on wipe",
    );
    // Retired v3 tables are gone; FTS5 exists.
    const fts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'memory_fts%'`,
      )
      .get() as { n: number };
    assert.ok(Number(fts.n) >= 1);
    const summaries = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'summaries'`,
      )
      .get() as { n: number };
    assert.equal(Number(summaries.n), 0, "summaries wiped, not migrated");
    closeMemoryDatabase(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy v2 store with retired table names wipes to the fresh schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-db-v2-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    // Build the v2 store by hand with its historical table names: a tracked
    // dream and a consolidation attempt counter row.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE learning_runs (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_text TEXT,
        reported_to_parent INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE maintenance_attempts (
        key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO learning_runs (id, trigger, status, started_at)
        VALUES ('run-1', 'auto', 'completed', datetime('now'));
      INSERT INTO maintenance_attempts (key, attempts, last_generation)
        VALUES ('merge:memory:1+memory:2', 2, 5);
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const db = openMemoryDatabaseAtPath(dbPath);
    try {
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        MEMORY_SCHEMA_VERSION,
      );
      const dreamRuns = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'dream_runs'`,
        )
        .get() as { n: number };
      assert.equal(Number(dreamRuns.n), 1, "dream_runs exists after wipe");
      const oldRuns = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'learning_runs'`,
        )
        .get() as { n: number };
      assert.equal(
        Number(oldRuns.n),
        0,
        "retired learning_runs must be wiped, not migrated",
      );
      const oldAttempts = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'maintenance_attempts'`,
        )
        .get() as { n: number };
      assert.equal(
        Number(oldAttempts.n),
        0,
        "retired maintenance_attempts must be wiped, not migrated",
      );
    } finally {
      closeMemoryDatabase(db);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy v4-shaped DB (pre-embedding-degradation shape) wipes to the fresh schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-db-v4-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    // Build the immediately-previous build's v4 store by hand: the shape the
    // round-2 build wrote (workspace_state WITHOUT embedding_degraded_error).
    // The wipe-on-bump contract says user_version uniquely determines shape,
    // so this store must never open against the v5 shape — it is discarded
    // and re-mined instead of throwing `no such column` on first read.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE workspace_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        activity_generation INTEGER NOT NULL DEFAULT 0,
        turns_since_last_run INTEGER NOT NULL DEFAULT 0,
        last_successful_run_at_ms INTEGER NOT NULL DEFAULT 0,
        last_observed_transcript_mtime_ms INTEGER,
        recall_capacity_error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        current_version_id INTEGER,
        creation_generation INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO workspace_state (id) VALUES (1);
      INSERT INTO memories (kind, state, creation_generation)
        VALUES ('fact', 'active', 0);
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const db = openMemoryDatabaseAtPath(dbPath);
    try {
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        MEMORY_SCHEMA_VERSION,
        "the stale v4 store is wiped and recreated at the current version",
      );
      const cols = db
        .prepare(`PRAGMA table_info(workspace_state)`)
        .all() as Array<{ name: string }>;
      assert.ok(
        cols.some((c) => c.name === "embedding_degraded_error"),
        "the new shape (embedding_degraded_error) is created",
      );
      const memories = db
        .prepare(`SELECT COUNT(*) AS n FROM memories`)
        .get() as { n: number };
      assert.equal(Number(memories.n), 0, "legacy rows are discarded on wipe");
      // The upgrade-path read that used to throw `no such column` now works.
      assert.equal(getMemoryWorkspaceState(db).embeddingDegradedError, null);
    } finally {
      closeMemoryDatabase(db);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a newer user_version still refuses to open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-db-newer-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION + 1}`);
    legacy.close();
    assert.throws(
      () => openMemoryDatabaseAtPath(dbPath),
      /newer than this extension/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search document upsert maintains the FTS row", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    upsertMemorySearchDocument(db, {
      nodeType: "memory",
      nodeId: 1,
      text: "prefer tabs over spaces",
      kind: "preference",
      state: "active",
    });
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM search_documents").get() as {
        n: number;
      }
    ).n;
    assert.equal(n, 1);
    const hit = db
      .prepare(`SELECT rowid FROM memory_fts WHERE memory_fts MATCH '"tabs"'`)
      .all() as Array<{ rowid: number }>;
    assert.deepEqual(
      hit.map((r) => Number(r.rowid)),
      [1],
    );
    // Re-upsert replaces the FTS row (single row, new text searchable).
    upsertMemorySearchDocument(db, {
      nodeType: "memory",
      nodeId: 1,
      text: "prefer spaces over tabs",
      kind: "preference",
      state: "active",
    });
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM memory_fts`).get() as {
      n: number;
    };
    assert.equal(Number(rows.n), 1, "re-upsert must not duplicate FTS rows");
    const miss = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH '"spaces"'`,
      )
      .get() as { n: number };
    assert.equal(Number(miss.n), 1);
  } finally {
    closeMemoryDatabase(db);
  }
});
