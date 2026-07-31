import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ensureMemoryEmbeddings,
  loadMemoryEmbedder,
  memoryEmbeddingStatus,
  resetMemoryEmbedderForTests,
  setMemoryEmbedderFactoryForTests,
  type MemoryEmbedFn,
} from "./memory-embedding.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";

function deferredMemoryEmbedder(): {
  promise: Promise<MemoryEmbedFn>;
  resolve: (embedder: MemoryEmbedFn) => void;
} {
  let resolve!: (embedder: MemoryEmbedFn) => void;
  const promise = new Promise<MemoryEmbedFn>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an aborted embedder load detaches promptly without poisoning the cache", async () => {
  const deferred = deferredMemoryEmbedder();
  const fakeEmbed: MemoryEmbedFn = async (texts) =>
    texts.map(() => new Float32Array([0.25, 0.5, 0.75]));
  setMemoryEmbedderFactoryForTests(() => deferred.promise);

  try {
    const cancelledTurn = new AbortController();
    const cancelledLoad = loadMemoryEmbedder(
      "test/minilm",
      cancelledTurn.signal,
    );
    cancelledTurn.abort();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cancelledResult = await Promise.race([
      cancelledLoad,
      new Promise<"timed out">((resolve) => {
        timeout = setTimeout(() => resolve("timed out"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.equal(
      cancelledResult,
      null,
      "an aborted turn must not wait for the remote embedder load",
    );

    const nextTurn = new AbortController();
    const nextLoad = loadMemoryEmbedder("test/minilm", nextTurn.signal);
    deferred.resolve(fakeEmbed);
    const embedder = await nextLoad;
    assert.ok(
      embedder,
      "a later active turn receives the shared loaded embedder",
    );
    assert.deepEqual(
      Array.from((await embedder(["next turn"]))[0]!),
      [0.25, 0.5, 0.75],
    );

    const cached = await loadMemoryEmbedder("test/minilm");
    assert.ok(cached, "the cached embedder is not bound to the aborted signal");
    assert.deepEqual(
      Array.from((await cached(["future turn"]))[0]!),
      [0.25, 0.5, 0.75],
    );
  } finally {
    resetMemoryEmbedderForTests();
  }
});

test("many cancelled embedder waiters do not block a later active waiter", async () => {
  const deferred = deferredMemoryEmbedder();
  const fakeEmbed: MemoryEmbedFn = async (texts) =>
    texts.map(() => new Float32Array([1]));
  setMemoryEmbedderFactoryForTests(() => deferred.promise);

  try {
    const cancelledLoads: Promise<MemoryEmbedFn | null>[] = [];
    for (let i = 0; i < 100; i++) {
      const turn = new AbortController();
      cancelledLoads.push(loadMemoryEmbedder("test/minilm", turn.signal));
      turn.abort();
    }
    assert.deepEqual(await Promise.all(cancelledLoads), Array(100).fill(null));

    const activeTurn = new AbortController();
    const activeLoad = loadMemoryEmbedder("test/minilm", activeTurn.signal);
    deferred.resolve(fakeEmbed);
    assert.ok(await activeLoad);
  } finally {
    resetMemoryEmbedderForTests();
  }
});

test("distinct embedding model ids keep independent caches", async () => {
  const calls: string[] = [];
  setMemoryEmbedderFactoryForTests(async (modelId) => {
    calls.push(modelId);
    const seed = modelId.endsWith("/a") ? 0.1 : 0.9;
    const embed: MemoryEmbedFn = async (texts) =>
      texts.map(() => new Float32Array([seed]));
    return embed;
  });
  try {
    const a = await loadMemoryEmbedder("model/a");
    const b = await loadMemoryEmbedder("model/b");
    assert.ok(a);
    assert.ok(b);
    assert.deepEqual(calls.sort(), ["model/a", "model/b"]);
    assert.notDeepEqual(
      Array.from((await a!(["x"]))[0]!),
      Array.from((await b!(["x"]))[0]!),
    );
  } finally {
    resetMemoryEmbedderForTests();
  }
});

test("memoryEmbeddingStatus tracks not_loaded, loading, ready, and failed", async () => {
  const modelId = "test/minilm";
  const fakeEmbed: MemoryEmbedFn = async (texts) =>
    texts.map(() => new Float32Array([0.25, 0.5, 0.75]));

  try {
    // not_loaded: fresh cache, never attempted in this process.
    assert.equal(memoryEmbeddingStatus(modelId).state, "not_loaded");
    assert.equal(memoryEmbeddingStatus(modelId).available, false);
    assert.equal(memoryEmbeddingStatus(modelId).error, null);

    // loading: an in-flight shared load (factory resolves later).
    const deferred = deferredMemoryEmbedder();
    setMemoryEmbedderFactoryForTests(() => deferred.promise);
    const loading = loadMemoryEmbedder(modelId);
    assert.equal(memoryEmbeddingStatus(modelId).state, "loading");

    // ready: the shared load settles.
    deferred.resolve(fakeEmbed);
    assert.ok(await loading);
    assert.equal(memoryEmbeddingStatus(modelId).state, "ready");
    assert.equal(memoryEmbeddingStatus(modelId).available, true);
  } finally {
    resetMemoryEmbedderForTests();
  }
});

test("memoryEmbeddingStatus reports failed with the load error", async () => {
  const modelId = "test/minilm";
  setMemoryEmbedderFactoryForTests(async () => {
    throw new Error("model download failed");
  });
  try {
    assert.equal(await loadMemoryEmbedder(modelId), null);
    const status = memoryEmbeddingStatus(modelId);
    assert.equal(status.state, "failed");
    assert.equal(status.available, false);
    assert.match(status.error ?? "", /model download failed/);
  } finally {
    resetMemoryEmbedderForTests();
  }
});

test("failed re-embed deletes the stale vector row", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    db.prepare(
      `INSERT INTO search_documents (node_type, node_id, text, kind, state, updated_at)
       VALUES ('memory', 1, 'new text', 'fact', 'active', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO embeddings (node_type, node_id, model_id, content_hash, vector, updated_at)
       VALUES ('memory', 1, 'test/model', 'old-hash', ?, datetime('now'))`,
    ).run(Buffer.from(new Float32Array([1, 0, 0]).buffer));

    const result = await ensureMemoryEmbeddings(db, {
      modelId: "test/model",
      embed: async () => {
        throw new Error("embed boom");
      },
    });
    assert.equal(result.degraded, true);
    assert.match(result.error ?? "", /embed boom/);
    const row = db
      .prepare(
        `SELECT content_hash FROM embeddings
         WHERE node_type = 'memory' AND node_id = 1 AND model_id = 'test/model'`,
      )
      .get();
    assert.equal(row, undefined, "stale embedding must be deleted after throw");
  } finally {
    closeMemoryDatabase(db);
    resetMemoryEmbedderForTests();
  }
});
