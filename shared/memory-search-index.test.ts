import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import {
  memoryEmbeddingStatus,
  resetMemoryEmbedderForTests,
  searchMemorySemantic,
  setMemoryEmbedderForTests,
} from "./memory-embedding.ts";
import { searchMemoryHybrid } from "./memory-search-index.ts";

async function withEmptyDb(
  fn: (db: ReturnType<typeof openMemoryDatabaseAtPath>) => void | Promise<void>,
): Promise<void> {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    await fn(db);
  } finally {
    closeMemoryDatabase(db);
    resetMemoryEmbedderForTests();
  }
}

test("semantic search short-circuits an empty index without loading the embedder", async () => {
  await withEmptyDb(async (db) => {
    const result = await searchMemorySemantic(db, "anything", {});
    assert.equal(result.hits.length, 0);
    assert.equal(result.degraded, false);
    const status = memoryEmbeddingStatus();
    assert.equal(status.available, false);
    assert.equal(status.state, "not_loaded");
    assert.equal(
      status.error,
      null,
      "the embedder must never be loaded for an empty index",
    );
  });
});

test("searchMemoryHybrid on an empty workspace never touches the embedder", async () => {
  await withEmptyDb(async (db) => {
    const hybrid = await searchMemoryHybrid(db, "anything", {});
    assert.equal(hybrid.candidates.length, 0);
    assert.equal(hybrid.semanticDegraded, false);
    assert.equal(memoryEmbeddingStatus().error, null);
    assert.equal(memoryEmbeddingStatus().state, "not_loaded");
  });
});

test("an already-aborted first turn never starts the embedder load", async () => {
  await withEmptyDb(async (db) => {
    const controller = new AbortController();
    controller.abort();
    const result = await searchMemorySemantic(db, "anything", {
      signal: controller.signal,
    });
    assert.equal(result.hits.length, 0);
    assert.equal(result.degraded, true);
    assert.equal(result.error, "aborted");
    assert.equal(memoryEmbeddingStatus().error, null);
    assert.equal(memoryEmbeddingStatus().state, "not_loaded");
  });
});

test("blank hybrid queries never invoke the embedder", async () => {
  await withEmptyDb(async (db) => {
    let embedCalled = false;
    const hybrid = await searchMemoryHybrid(db, "   ", {
      embed: async () => {
        embedCalled = true;
        return [];
      },
    });
    assert.equal(hybrid.candidates.length, 0);
    assert.equal(embedCalled, false);
  });
});

test("a non-abort embedder error propagates from hybrid search instead of silent degradation", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    // One active search document (in both the row table and the FTS index) so
    // the semantic path cannot short-circuit on an empty workspace.
    db.prepare(
      `INSERT INTO search_documents (node_type, node_id, text, kind, state, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run("memory", 1, "Production deploys to Fly.io", "fact", "active");
    db.prepare(
      `INSERT INTO search_fts (text, node_type, node_id, kind) VALUES (?, ?, ?, ?)`,
    ).run("Production deploys to Fly.io", "memory", 1, "fact");

    setMemoryEmbedderForTests(async () => {
      throw new Error("embedder exploded");
    });

    // The unexpected embedder error must surface as a throw (so the boundary
    // handlers can report "Memory retrieval unavailable"), never be reduced
    // to an indistinguishable empty/degraded result.
    await assert.rejects(
      () => searchMemoryHybrid(db, "deploy target", {}),
      /embedder exploded/,
    );
  } finally {
    closeMemoryDatabase(db);
    resetMemoryEmbedderForTests();
  }
});
