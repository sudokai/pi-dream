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

function insertEdgeForTest(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  relation: string,
  fromType: string,
  fromId: number,
  toType: string,
  toId: number,
): void {
  db.prepare(
    `INSERT INTO graph_edges (relation, from_type, from_id, to_type, to_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(relation, fromType, fromId, toType, toId);
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

test("fresh schema has edge state, the partial unique index, and no FTS tables", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const edges = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'graph_edges'`)
      .get() as { sql: string };
    assert.match(edges.sql, /state TEXT NOT NULL DEFAULT 'active'/);
    const index = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE name = 'idx_graph_edges_active_unique'`,
      )
      .get() as { sql: string };
    assert.ok(index.sql.includes("WHERE state = 'active'"));
    const fts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'search_fts%'`,
      )
      .get() as { n: number };
    assert.equal(Number(fts.n), 0, "no FTS tables in the fresh schema");
    const attempts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'consolidation_attempts'`,
      )
      .get() as { n: number };
    assert.equal(Number(attempts.n), 1);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("retire-then-reattach to the same parent succeeds (partial unique index)", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    // Direct row-level test of the partial unique index: the table-level
    // constraint would reject the second insert after the first is retired.
    insertEdgeForTest(db, "contains", "summary", 1, "memory", 1);
    retireGraphEdge(db, "contains", "summary", 1, "memory", 1);
    insertEdgeForTest(db, "contains", "summary", 1, "memory", 1);
    const rows = db.prepare(`SELECT state FROM graph_edges`).all() as Array<{
      state: string;
    }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.state).sort(), ["active", "retired"]);
    // Duplicate active edge is still rejected.
    assert.throws(() =>
      insertEdgeForTest(db, "contains", "summary", 1, "memory", 1),
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a legacy v1-shaped DB with rows opens as an empty fresh store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-db-legacy-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    // Build a v1-shaped store by hand: stamp version 1 and insert a memory row.
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
      INSERT INTO memories (kind, state, current_version_id, creation_generation)
        VALUES ('fact', 'active', 1, 0);
      INSERT INTO memory_versions (memory_id, text) VALUES (1, 'legacy fact');
      PRAGMA user_version = 1;
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
    // No FTS leftovers and the new tables exist.
    const fts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'search_fts%'`,
      )
      .get() as { n: number };
    assert.equal(Number(fts.n), 0);
    const attempts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'consolidation_attempts'`,
      )
      .get() as { n: number };
    assert.equal(Number(attempts.n), 1);
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

test("search document upsert is FTS-free", () => {
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
  } finally {
    closeMemoryDatabase(db);
  }
});
