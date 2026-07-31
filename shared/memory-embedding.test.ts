import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  loadMemoryEmbedder,
  resetMemoryEmbedderForTests,
  setMemoryEmbedderFactoryForTests,
  type MemoryEmbedFn,
} from "./memory-embedding.ts";

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
    assert.ok(embedder, "a later active turn receives the shared loaded embedder");
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
