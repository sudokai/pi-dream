import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import {
  commitMemoryLearningSession,
  getSourceSessionCheckpoint,
  listMemoryGraphSnapshot,
} from "./memory-repository.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  incrementMemoryActivityGeneration,
  listActiveMemories,
  listObservationsForMemory,
  openMemoryNodeExact,
  retireMemoryNode,
  wouldMemoryContainsEdgeCycle,
} from "./memory-graph.ts";
import { computeMemoryNodeHeat } from "./memory-heat.ts";
import {
  isMemoryRoot,
  listMemoryNodeChildren,
  listMemoryTreeRoots,
} from "./memory-tree.ts";
import {
  MEMORY_NOVELTY_GENERATIONS,
  MEMORY_NOVELTY_MAX_SOURCE_AGE_DAYS,
  MEMORY_NOVELTY_MAX_SOURCE_AGE_MS,
} from "./memory-types.ts";

async function withClaimedDb(
  fn: (
    db: ReturnType<typeof openMemoryDatabaseAtPath>,
    runId: string,
  ) => void | Promise<void>,
) {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    await fn(db, claim.runId!);
  } finally {
    closeMemoryDatabase(db);
  }
}

test("commitMemoryLearningSession create + reinforce is idempotent per session", async () => {
  await withClaimedDb((db, runId) => {
    const r1 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "sess-1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp/proj",
      processedMtimeMs: 1000,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "tmp:1",
            kind: "preference",
            observationText: "User prefers TypeScript strict mode",
            memoryText: "Prefer TypeScript strict mode",
          },
        ],
      },
    });
    assert.equal(r1.applied, true);
    const memories = listActiveMemories(db);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.recurrence, 1);

    // Replay same session checkpoint → no-op
    const r2 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "sess-1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp/proj",
      processedMtimeMs: 1000,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "tmp:1",
            kind: "preference",
            observationText: "User prefers TypeScript strict mode",
            memoryText: "Prefer TypeScript strict mode",
          },
        ],
      },
    });
    assert.equal(r2.applied, false);

    // New session reinforces
    const r3 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "sess-2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp/proj",
      processedMtimeMs: 2000,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "reinforce",
            memoryId: `M:${memories[0]!.id}`,
            observationText: "Again prefers TypeScript strict mode",
          },
        ],
      },
    });
    assert.equal(r3.applied, true);
    const updated = getMemoryById(db, memories[0]!.id)!;
    assert.equal(updated.recurrence, 2);
    assert.equal(listObservationsForMemory(db, updated.id).length, 2);
  });
});

test("duplicate observation creates keep support: no orphan active memories", async () => {
  await withClaimedDb((db, runId) => {
    const r = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "a",
            kind: "preference",
            observationText: "User likes tabs",
            memoryText: "Prefer tabs",
          },
          {
            op: "create",
            tempRef: "b",
            kind: "preference",
            observationText: "user likes tabs",
            memoryText: "Prefer tabs too",
          },
        ],
      },
    });
    assert.equal(r.applied, true);
    const memories = listActiveMemories(db);
    assert.equal(memories.length, 2);
    // Every memory must carry support (recurrence >= 1) and provenance.
    for (const m of memories) {
      assert.ok(m.recurrence >= 1, `M:${m.id} must not be an orphan`);
      assert.ok(listObservationsForMemory(db, m.id).length >= 1);
    }
    // Both duplicate-backed creates share the single deduped observation row.
    const obsA = listObservationsForMemory(db, memories[0]!.id);
    const obsB = listObservationsForMemory(db, memories[1]!.id);
    assert.equal(obsA.length, 1);
    assert.equal(obsA[0]!.id, obsB[0]!.id);
  });
});

test("supersede excludes old memory from active search", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "tmp:old",
            kind: "preference",
            observationText: "Use spaces",
            memoryText: "Use spaces for indentation",
          },
        ],
      },
    });
    const old = listActiveMemories(db)[0]!;
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "supersede",
            oldMemoryId: `M:${old.id}`,
            newTempRef: "tmp:new",
            kind: "correction",
            observationText: "Actually use tabs",
            memoryText: "Use tabs for indentation",
          },
        ],
      },
    });
    const active = listActiveMemories(db);
    assert.equal(active.length, 1);
    assert.match(active[0]!.text, /tabs/i);
    const oldRow = getMemoryById(db, old.id)!;
    assert.equal(oldRow.state, "superseded");
    // open still shows history
    const opened = openMemoryNodeExact(db, `M:${old.id}`);
    assert.equal(opened.target.state, "superseded");
    assert.ok((opened.versions?.length ?? 0) >= 1);
  });
});

test("openMemoryNodeExact exposes summary revision history", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Build uses pnpm",
            memberIds: ["m1"],
          },
        ],
      },
    });
    // The extend path absorbs a NEW root (strict-tree: members must be roots);
    // compaction is measured against the old summary text + the listed members.
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "Deploys to Fly.io",
            memoryText: "Deploys to Fly.io",
          },
          {
            op: "summarize",
            summaryId: "S:1",
            expectedVersionId: 1,
            text: "Build + deploy",
            memberIds: ["M:2"],
          },
        ],
      },
    });

    const opened = openMemoryNodeExact(db, "S:1");
    assert.deepEqual(
      opened.versions?.map((version) => version.text),
      ["Build + deploy", "Build uses pnpm"],
    );
    assert.equal(isMemoryRoot(db, "memory", 2), false, "m2 is absorbed");
    assert.equal(isMemoryRoot(db, "memory", 1), false);
  });
});

test("conflict marks both memories conflicted", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "a",
            kind: "fact",
            observationText: "API is REST",
            memoryText: "API style is REST",
          },
          {
            op: "create",
            tempRef: "b",
            kind: "fact",
            observationText: "API is GraphQL",
            memoryText: "API style is GraphQL",
          },
        ],
      },
    });
    const [m1, m2] = listActiveMemories(db);
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "conflict",
            memoryIds: [`M:${m1!.id}`, `M:${m2!.id}`],
          },
        ],
      },
    });
    assert.equal(listActiveMemories(db).length, 0);
    assert.equal(getMemoryById(db, m1!.id)!.state, "conflicted");
    assert.equal(getMemoryById(db, m2!.id)!.state, "conflicted");
  });
});

test("contains edges stay acyclic", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
          {
            op: "summarize",
            tempRef: "sum1",
            text: "Tooling preferences",
            memberIds: ["m1"],
          },
        ],
      },
    });
    // try to make memory contain its parent summary via link would need memory->summary contains
    // wouldMemoryContainsEdgeCycle for self
    assert.equal(
      wouldMemoryContainsEdgeCycle(db, "summary", 1, "summary", 1),
      true,
    );
  });
});

test("forget soft-retires and preserves observations", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "preference",
            observationText: "No emoji",
            memoryText: "Do not use emoji in commits",
          },
        ],
      },
    });
    const m = listActiveMemories(db)[0]!;
    assert.ok(
      listMemoryTreeRoots(db).some((r) => r.prefixedId === `M:${m.id}`),
      "active memory appears in the top layer",
    );
    retireMemoryNode(db, `M:${m.id}`);
    assert.equal(getMemoryById(db, m.id)!.state, "retired");
    assert.equal(listActiveMemories(db).length, 0);
    assert.ok(listObservationsForMemory(db, m.id).length >= 1);
    assert.equal(getSourceSessionCheckpoint(db, "s1")?.sessionId, "s1");
    assert.equal(
      listMemoryTreeRoots(db).some((r) => r.prefixedId === `M:${m.id}`),
      false,
      "retired memory never appears in the top layer",
    );
  });
});

test("heat warms with novelty and cools without recall", () => {
  const hot = computeMemoryNodeHeat({
    currentGeneration: 1,
    noveltyUntilGeneration: 3,
    recallGenerations: [],
  });
  assert.ok(hot > 0);
  const cold = computeMemoryNodeHeat({
    currentGeneration: 20,
    noveltyUntilGeneration: 3,
    recallGenerations: [1],
  });
  const reheated = computeMemoryNodeHeat({
    currentGeneration: 20,
    noveltyUntilGeneration: null,
    recallGenerations: [1, 20],
  });
  assert.ok(reheated > cold);
});

test("top layer lists active root memories", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Deploy target is Fly.io",
            memoryText: "Production deploys to Fly.io",
          },
        ],
      },
    });
    const roots = listMemoryTreeRoots(db);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.nodeType, "memory");
    assert.match(roots[0]!.text, /Fly\.io/);
  });
});

test("summarize with a non-root member is rejected", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["m1"],
          },
        ],
      },
    });
    // M:1 is now a child of S:1 — re-listing it in a new summary must fail.
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "summarize",
                tempRef: "s2",
                text: "Duplicate",
                memberIds: ["M:1"],
              },
            ],
          },
        }),
      /not a root/,
    );
  });
});

test("summarize with non-compacting text is rejected", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "summarize",
                text: "Package manager is pnpm (longer than the member)",
                memberIds: ["M:1"],
              },
            ],
          },
        }),
      /does not compact the top layer/,
    );
  });
});

test("link with contains is rejected at the repository boundary", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "link",
                relation: "contains" as never,
                fromId: "M:1",
                toId: "M:1",
              },
            ],
          },
        }),
      /link cannot create contains edges/,
    );
  });
});

test("single-flight claim rejects second acquirer", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const a = acquireMemoryRunClaim(db, "auto");
    const b = acquireMemoryRunClaim(db, "auto");
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, false);
    assert.equal(b.reason, "running");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("summarize never resurrects a forgotten summary", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling overview",
            memberIds: ["m1"],
          },
        ],
      },
    });
    retireMemoryNode(db, "S:1");

    // A later learner run updating the forgotten summary must fail closed.
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "summarize",
                summaryId: "S:1",
                expectedVersionId: 1,
                text: "Updated tooling overview",
                memberIds: ["M:1"],
              },
            ],
          },
        }),
      /only active summaries can be updated/,
    );
    assert.equal(getMemoryById(db, 1)!.state, "active");
    // The summary stays retired and its text is untouched.
    const opened = openMemoryNodeExact(db, "S:1");
    assert.equal(opened.target.state, "retired");
    assert.equal(opened.target.text, "Tooling overview");
  });
});

test("summarize update honors the expectedVersionId CAS guard", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["m1"],
          },
        ],
      },
    });
    const snapshot = listMemoryGraphSnapshot(db);
    assert.deepEqual(snapshot.summaries, [
      {
        id: "S:1",
        state: "active",
        currentVersionId: 1,
        text: "Tooling",
      },
    ]);

    // Runtime validation still rejects untyped tool input that omits CAS.
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "s-missing-version",
          sessionPath: "/tmp/s-missing-version.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h-missing-version",
          plan: {
            operations: [
              {
                op: "summarize",
                summaryId: "S:1",
                text: "Missing CAS update",
                memberIds: ["M:1"],
              },
            ] as never,
          },
        }),
      /update requires a positive expectedVersionId/,
    );

    // Version 1 exists; a stale expectedVersionId must fail closed.
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "summarize",
                summaryId: "S:1",
                expectedVersionId: 999,
                text: "Stale update",
                memberIds: ["M:1"],
              },
            ],
          },
        }),
      /version is stale/,
    );
    // A matching CAS version succeeds with a NEW root member (strict-tree:
    // an extend absorbs roots only; members are not re-listed).
    const applied = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s3",
      sessionPath: "/tmp/s3.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 3,
      contentHash: "h3",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "Deploys to Fly.io",
            memoryText: "Deploys to Fly.io",
          },
          {
            op: "summarize",
            summaryId: "S:1",
            expectedVersionId: 1,
            text: "Tooling + deploy",
            memberIds: ["M:2"],
          },
        ],
      },
    });
    assert.equal(applied.applied, true);
    const opened = openMemoryNodeExact(db, "S:1");
    assert.equal(opened.target.state, "active");
    assert.equal(opened.target.text, "Tooling + deploy");
  });
});

test("changed content with a preserved mtime is reprocessed, not skipped", async () => {
  await withClaimedDb((db, runId) => {
    const r1 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1000,
      contentHash: "hash-v1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "t",
            kind: "fact",
            observationText: "X is 1",
            memoryText: "X is 1",
          },
        ],
      },
    });
    assert.equal(r1.applied, true);
    assert.equal(listActiveMemories(db).length, 1);

    // Same mtime (preserved), different content hash: must re-process.
    const r2 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1000,
      contentHash: "hash-v2",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "t",
            kind: "fact",
            observationText: "X is 2",
            memoryText: "X is 2",
          },
        ],
      },
    });
    assert.equal(r2.applied, true);
    assert.equal(listActiveMemories(db).length, 2);

    // Identical content hash + non-newer mtime remains a no-op.
    const r3 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 900,
      contentHash: "hash-v2",
      plan: { operations: [] },
    });
    assert.equal(r3.applied, false);
    assert.equal(r3.reason, "already checkpointed");

    // Legacy checkpoints without a stored hash still honor the mtime gate.
    const legacy = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "legacy",
      sessionPath: "/tmp/legacy.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 500,
      contentHash: null,
      plan: { operations: [{ op: "no_op", reason: "seed" }] },
    });
    assert.equal(legacy.applied, true);
    const r4 = commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "legacy",
      sessionPath: "/tmp/legacy.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 400,
      contentHash: null,
      plan: { operations: [{ op: "no_op", reason: "again" }] },
    });
    assert.equal(r4.applied, false);
    assert.equal(r4.reason, "already checkpointed");
  });
});

test("source session exactly at the age cutoff still receives novelty", async () => {
  await withClaimedDb((db, runId) => {
    // One second inside the cutoff so wall-clock drift cannot flip the branch.
    const boundaryMtime = Date.now() - MEMORY_NOVELTY_MAX_SOURCE_AGE_MS + 1000;
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "boundary-sess",
      sessionPath: "/tmp/boundary.jsonl",
      cwd: "/tmp",
      processedMtimeMs: boundaryMtime,
      contentHash: "h-b",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    const mem = listActiveMemories(db)[0]!;
    assert.equal(
      mem.noveltyUntilGeneration,
      getMemoryActivityGeneration(db) + MEMORY_NOVELTY_GENERATIONS,
    );
  });
});

test("fresh session reinforcing a cold memory warms it", async () => {
  await withClaimedDb((db, runId) => {
    const oldMtime =
      Date.now() - (MEMORY_NOVELTY_MAX_SOURCE_AGE_DAYS + 1) * 86_400_000;
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "old-sess",
      sessionPath: "/tmp/old.jsonl",
      cwd: "/tmp",
      processedMtimeMs: oldMtime,
      contentHash: "h-old",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    const cold = listActiveMemories(db)[0]!;
    assert.equal(cold.noveltyUntilGeneration, null);

    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "fresh-sess",
      sessionPath: "/tmp/fresh.jsonl",
      cwd: "/tmp",
      processedMtimeMs: Date.now(),
      contentHash: "h-fresh",
      plan: {
        operations: [
          {
            op: "reinforce",
            memoryId: `M:${cold.id}`,
            observationText: "Still uses pnpm",
          },
        ],
      },
    });
    const warmed = getMemoryById(db, cold.id)!;
    assert.equal(
      warmed.noveltyUntilGeneration,
      getMemoryActivityGeneration(db) + MEMORY_NOVELTY_GENERATIONS,
    );
  });
});

test("fresh reinforce of an already-warm memory does not extend novelty", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: Date.now(),
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    const created = listActiveMemories(db)[0]!;
    const firstWindow = created.noveltyUntilGeneration!;
    // Advance a generation so a naive window extension would be observable.
    incrementMemoryActivityGeneration(db);

    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: Date.now(),
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "reinforce",
            memoryId: `M:${created.id}`,
            observationText: "Still uses pnpm",
          },
        ],
      },
    });
    assert.equal(
      getMemoryById(db, created.id)!.noveltyUntilGeneration,
      firstWindow,
    );
  });
});

test("backfilled old sessions create cold memories (no novelty boost)", async () => {
  await withClaimedDb((db, runId) => {
    // Source session last touched past the source-age cutoff → cold entry.
    const oldMtime =
      Date.now() - (MEMORY_NOVELTY_MAX_SOURCE_AGE_DAYS + 1) * 86_400_000;
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "old-sess",
      sessionPath: "/tmp/old.jsonl",
      cwd: "/tmp",
      processedMtimeMs: oldMtime,
      contentHash: "h-old",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    const cold = listActiveMemories(db)[0]!;
    assert.equal(cold.noveltyUntilGeneration, null);
    assert.equal(
      computeMemoryNodeHeat({
        currentGeneration: getMemoryActivityGeneration(db),
        noveltyUntilGeneration: cold.noveltyUntilGeneration,
        recallGenerations: [],
      }),
      0,
    );

    // Fresh source session → novelty granted as before.
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "fresh-sess",
      sessionPath: "/tmp/fresh.jsonl",
      cwd: "/tmp",
      processedMtimeMs: Date.now(),
      contentHash: "h-fresh",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    const fresh = listActiveMemories(db)[1]!;
    assert.equal(
      fresh.noveltyUntilGeneration,
      getMemoryActivityGeneration(db) + MEMORY_NOVELTY_GENERATIONS,
    );
  });
});

// ─── Step 4: promote + lifecycle reconciliation ─────────────────────────────

function seedSummaryWithMembers(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
  memberTexts: string[],
): { memoryIds: string[]; summaryId: string } {
  const operations = memberTexts.map((text, i) => ({
    op: "create" as const,
    tempRef: `m${i}`,
    kind: "fact" as const,
    observationText: text,
    memoryText: text,
  }));
  commitMemoryLearningSession(db, {
    runId,
    sourceSessionId: `seed-${Math.random().toString(36).slice(2)}`,
    sessionPath: "/tmp/seed.jsonl",
    cwd: "/tmp",
    processedMtimeMs: 1,
    contentHash: `h-${Math.random().toString(36).slice(2)}`,
    plan: {
      operations: [
        ...operations,
        {
          op: "summarize",
          tempRef: "s1",
          text: "Tooling",
          memberIds: memberTexts.map((_, i) => `m${i}`),
        },
      ],
    },
  });
  const memoryIds = memberTexts.map((_, i) => `M:${i + 1}`);
  return { memoryIds, summaryId: "S:1" };
}

test("promote happy path: edge retired and parent rewritten (>= 2 members)", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
      "No emoji in commits",
      "CI runs on Ubuntu",
    ]);
    const before = listMemoryTreeRoots(db);
    assert.deepEqual(
      before.map((r) => r.prefixedId),
      [summaryId],
    );
    assert.deepEqual(
      listMemoryNodeChildren(db, "summary", 1).map((c) => c.prefixedId),
      memoryIds,
    );

    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "promote-1",
      sessionPath: "/tmp/p.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h-p1",
      plan: {
        operations: [
          {
            op: "promote",
            nodeId: memoryIds[0] as never,
            summaryId: summaryId as never,
            expectedSummaryVersionId: 1,
            newSummaryText: "Tooling",
          },
        ],
      },
    });

    // The promoted memory is a root again; the parent was rewritten.
    assert.equal(isMemoryRoot(db, "memory", 1), true);
    const children = listMemoryNodeChildren(db, "summary", 1);
    assert.deepEqual(
      children.map((c) => c.prefixedId),
      memoryIds.slice(1),
    );
    const opened = openMemoryNodeExact(db, summaryId);
    assert.equal(opened.target.text, "Tooling");
    assert.equal(opened.target.state, "active");
    assert.equal(opened.versions?.length ?? 0, 2);
    const roots = listMemoryTreeRoots(db).map((r) => r.prefixedId);
    assert.deepEqual(roots, [memoryIds[0], summaryId]);
  });
});

test("promote to 1 member retires the parent and resurfaced the orphan", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
      "No emoji in commits",
    ]);
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "promote-1",
      sessionPath: "/tmp/p.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h-p1",
      plan: {
        operations: [
          {
            op: "promote",
            nodeId: memoryIds[0] as never,
            summaryId: summaryId as never,
            expectedSummaryVersionId: 1,
          },
        ],
      },
    });
    assert.equal(isMemoryRoot(db, "memory", 1), true);
    assert.equal(isMemoryRoot(db, "memory", 2), true, "orphan resurfaced");
    const opened = openMemoryNodeExact(db, summaryId);
    assert.equal(opened.target.state, "retired");
  });
});

test("promote to 0 members retires the parent", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
    ]);
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "promote-1",
      sessionPath: "/tmp/p.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h-p1",
      plan: {
        operations: [
          {
            op: "promote",
            nodeId: memoryIds[0] as never,
            summaryId: summaryId as never,
            expectedSummaryVersionId: 1,
          },
        ],
      },
    });
    assert.equal(isMemoryRoot(db, "memory", 1), true);
    const opened = openMemoryNodeExact(db, summaryId);
    assert.equal(opened.target.state, "retired");
  });
});

test("promote CAS mismatch, conflicted target, and non-child are rejected", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
      "No emoji in commits",
    ]);
    const commit = (op: Record<string, unknown>) =>
      commitMemoryLearningSession(db, {
        runId,
        sourceSessionId: `x-${Math.random().toString(36).slice(2)}`,
        sessionPath: "/tmp/x.jsonl",
        cwd: "/tmp",
        processedMtimeMs: 2,
        contentHash: `h-${Math.random().toString(36).slice(2)}`,
        plan: { operations: [op as never] },
      });
    assert.throws(
      () =>
        commit({
          op: "promote",
          nodeId: memoryIds[0],
          summaryId,
          expectedSummaryVersionId: 999,
          newSummaryText: "Tooling",
        }),
      /version is stale/,
    );
    // Conflicted target: mark M:2 conflicted, then try to promote it.
    commit({
      op: "conflict",
      memoryIds: [memoryIds[1]],
    });
    assert.throws(
      () =>
        commit({
          op: "promote",
          nodeId: memoryIds[1],
          summaryId,
          expectedSummaryVersionId: 1,
        }),
      /is conflicted/,
    );
    // Non-child: M:1 is an active child of S:1, so a promote naming a
    // different parent must fail.
    assert.throws(
      () =>
        commit({
          op: "promote",
          nodeId: memoryIds[0],
          summaryId: "S:999",
          expectedSummaryVersionId: 1,
          newSummaryText: "Tooling",
        }),
      /not a child/,
    );
  });
});

test("promote rewrite must not grow; newSummaryText required for >= 2 members", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
      "No emoji in commits",
      "CI runs on Ubuntu",
    ]);
    const commit = (op: Record<string, unknown>) =>
      commitMemoryLearningSession(db, {
        runId,
        sourceSessionId: `x-${Math.random().toString(36).slice(2)}`,
        sessionPath: "/tmp/x.jsonl",
        cwd: "/tmp",
        processedMtimeMs: 2,
        contentHash: `h-${Math.random().toString(36).slice(2)}`,
        plan: { operations: [op as never] },
      });
    assert.throws(
      () =>
        commit({
          op: "promote",
          nodeId: memoryIds[0],
          summaryId,
          expectedSummaryVersionId: 1,
        }),
      /newSummaryText is required/,
    );
    assert.throws(
      () =>
        commit({
          op: "promote",
          nodeId: memoryIds[0],
          summaryId,
          expectedSummaryVersionId: 1,
          newSummaryText:
            "A much longer tooling overview text that grows the parent",
        }),
      /must not grow/,
    );
  });
});

test("supersede of a child retires its edge and resurfaced the ancestor summary", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use spaces for indentation",
      "No emoji in commits",
    ]);
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "sup-1",
      sessionPath: "/tmp/s.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h-sup1",
      plan: {
        operations: [
          {
            op: "supersede",
            oldMemoryId: memoryIds[0] as never,
            newTempRef: "new1",
            kind: "correction",
            observationText: "Actually use tabs",
            memoryText: "Use tabs for indentation",
          },
        ],
      },
    });
    // The superseded memory's edge is retired; the parent summary contains an
    // inactive node and is retired; the remaining child resurfaced as a root.
    assert.equal(isMemoryRoot(db, "memory", 2), true);
    const opened = openMemoryNodeExact(db, summaryId);
    assert.equal(opened.target.state, "retired");
    const roots = listMemoryTreeRoots(db).map((r) => r.prefixedId);
    assert.ok(roots.includes("M:2"));
    assert.ok(roots.includes("M:3"));
    // The supersedes edge itself is intact (audit).
    const edges = db
      .prepare(
        `SELECT relation, state FROM graph_edges WHERE relation = 'supersedes'`,
      )
      .all() as Array<{ relation: string; state: string }>;
    assert.equal(edges.length, 1);
  });
});

test("conflict of a child retires the ancestor summary and resurfaced siblings", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "API is REST",
      "API is GraphQL",
      "CI runs on Ubuntu",
    ]);
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "conf-1",
      sessionPath: "/tmp/c.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h-conf1",
      plan: {
        operations: [
          {
            op: "conflict",
            memoryIds: [memoryIds[0] as never, memoryIds[1] as never],
          },
        ],
      },
    });
    const opened = openMemoryNodeExact(db, summaryId);
    assert.equal(
      opened.target.state,
      "retired",
      "summary with conflicted members retires",
    );
    const roots = listMemoryTreeRoots(db).map((r) => r.prefixedId);
    assert.ok(roots.includes("M:3"), "unaffected sibling resurfaced");
    assert.ok(!roots.includes("M:1") && !roots.includes("M:2"));
  });
});

test("forget of a summary resurfaced its active children", async () => {
  await withClaimedDb((db, runId) => {
    const { memoryIds, summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
      "No emoji in commits",
    ]);
    retireMemoryNode(db, summaryId);
    const roots = listMemoryTreeRoots(db).map((r) => r.prefixedId);
    assert.deepEqual(roots.sort(), memoryIds.sort());
    const edges = db
      .prepare(`SELECT state FROM graph_edges WHERE relation = 'contains'`)
      .all() as Array<{ state: string }>;
    assert.ok(edges.every((e) => e.state === "retired"));
  });
});

test("extend merge that would grow the layer is rejected", async () => {
  await withClaimedDb((db, runId) => {
    const { summaryId } = seedSummaryWithMembers(db, runId, [
      "Use tabs for indentation",
    ]);
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "ext-1",
      sessionPath: "/tmp/e.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h-ext1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "No emoji in commits",
            memoryText: "No emoji in commits",
          },
        ],
      },
    });
    // Old summary "Tooling" (2 tokens) + new member "No emoji in commits"
    // (5 tokens) = 7; a longer rewrite that does not stay below it is rejected.
    assert.throws(
      () =>
        commitMemoryLearningSession(db, {
          runId,
          sourceSessionId: "ext-2",
          sessionPath: "/tmp/e2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 3,
          contentHash: "h-ext2",
          plan: {
            operations: [
              {
                op: "summarize",
                summaryId: summaryId as never,
                expectedVersionId: 1,
                text: "Tooling plus emoji plus more text that is far too long",
                memberIds: ["M:2"],
              },
            ],
          },
        }),
      /does not compact the top layer/,
    );
  });
});
