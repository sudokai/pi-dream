import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  MEMORY_SCHEMA_VERSION,
  openMemoryDatabaseAtPath,
  rebuildMemorySearchDocuments,
  upsertMemorySearchDocument,
} from "./memory-database.ts";

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

test("search document upsert and rebuild", () => {
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
    const fts = (
      db.prepare("SELECT COUNT(*) AS n FROM search_fts").get() as { n: number }
    ).n;
    assert.equal(fts, 1);
    rebuildMemorySearchDocuments(db);
    // no active memories yet → empty after rebuild from tables
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM search_documents").get() as {
        n: number;
      }
    ).n;
    assert.equal(after, 0);
  } finally {
    closeMemoryDatabase(db);
  }
});
