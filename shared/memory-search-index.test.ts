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
  });
});
