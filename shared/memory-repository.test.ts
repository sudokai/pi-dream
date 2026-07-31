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
  getMemoryById,
  listActiveMemories,
  listObservationsForMemory,
  openMemoryNodeExact,
  retireMemoryNode,
  wouldMemoryContainsEdgeCycle,
} from "./memory-graph.ts";
import { computeMemoryNodeHeat } from "./memory-heat.ts";
import { searchMemoryBm25 } from "./memory-search-index.ts";
import {
  formatMemoryBriefingMessage,
  planRelevantMemoryBriefing,
  validateAndPackMemoryBriefingPlan,
} from "./memory-recall-planner.ts";
import type { MemorySearchCandidate } from "./memory-types.ts";

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
            text: "Original build summary",
            memberIds: ["m1"],
          },
        ],
      },
    });
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
            text: "Updated build summary",
            memberIds: ["M:1"],
          },
        ],
      },
    });

    const opened = openMemoryNodeExact(db, "S:1");
    assert.deepEqual(
      opened.versions?.map((version) => version.text),
      ["Updated build summary", "Original build summary"],
    );
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
    assert.ok(searchMemoryBm25(db, "emoji").length > 0);
    retireMemoryNode(db, `M:${m.id}`);
    assert.equal(getMemoryById(db, m.id)!.state, "retired");
    assert.equal(listActiveMemories(db).length, 0);
    assert.ok(listObservationsForMemory(db, m.id).length >= 1);
    assert.equal(getSourceSessionCheckpoint(db, "s1")?.sessionId, "s1");
    assert.equal(searchMemoryBm25(db, "emoji").length, 0);
    const fts = db.prepare(`SELECT COUNT(*) AS n FROM search_fts`).get() as {
      n: number;
    };
    assert.equal(Number(fts.n), 0);
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

test("BM25 finds indexed memory text", async () => {
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
    const hits = searchMemoryBm25(db, "Fly.io production");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.nodeType, "memory");
  });
});

test("planner validation fail-closed on unknown ids", async () => {
  const candidates: MemorySearchCandidate[] = [
    {
      nodeType: "memory",
      nodeId: 1,
      prefixedId: "M:1",
      kind: "preference",
      text: "Prefer tabs",
      heat: 1,
      estimatedTokens: 3,
      bm25Rank: 1,
      semanticRank: null,
      rrfScore: 0.1,
    },
  ];
  await assert.rejects(async () => {
    validateAndPackMemoryBriefingPlan(candidates, {
      sections: [{ id: "learned_user_preferences", ids: ["M:999"] }],
    });
  }, /unknown|inactive/i);

  const plan = validateAndPackMemoryBriefingPlan(candidates, {
    sections: [{ id: "learned_user_preferences", ids: ["M:1"] }],
  });
  assert.deepEqual(plan.selectedIds, ["M:1"]);
  const msg = formatMemoryBriefingMessage(plan);
  assert.match(msg, /M:1/);
  assert.match(msg, /Prefer tabs/);

  const result = await planRelevantMemoryBriefing({
    query: "indentation",
    candidates,
    complete: async () => ({
      text: JSON.stringify({
        sections: [{ id: "learned_user_preferences", ids: ["M:1"] }],
      }),
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plan.selectedIds.length, 1);

  const bad = await planRelevantMemoryBriefing({
    query: "x",
    candidates,
    complete: async () => ({ text: "not-json" }),
  });
  assert.equal(bad.ok, false);
});

test("atomic budget drops whole nodes", () => {
  const candidates: MemorySearchCandidate[] = [
    {
      nodeType: "memory",
      nodeId: 1,
      prefixedId: "M:1",
      kind: "fact",
      text: "a".repeat(100),
      heat: 1,
      estimatedTokens: 50,
      bm25Rank: 1,
      semanticRank: null,
      rrfScore: 1,
    },
    {
      nodeType: "memory",
      nodeId: 2,
      prefixedId: "M:2",
      kind: "fact",
      text: "b".repeat(100),
      heat: 0.5,
      estimatedTokens: 50,
      bm25Rank: 2,
      semanticRank: null,
      rrfScore: 0.5,
    },
  ];
  const plan = validateAndPackMemoryBriefingPlan(
    candidates,
    {
      sections: [
        {
          id: "workspace_knowledge",
          ids: ["M:1", "M:2"],
        },
      ],
    },
    { tokenBudget: 60 },
  );
  assert.equal(plan.selectedIds.length, 1);
  assert.equal(plan.selectedIds[0], "M:1");
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
            text: "Tooling overview",
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
        text: "Tooling overview",
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
    // A matching CAS version succeeds.
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
            op: "summarize",
            summaryId: "S:1",
            expectedVersionId: 1,
            text: "Tooling overview (revised)",
            memberIds: ["M:1"],
          },
        ],
      },
    });
    assert.equal(applied.applied, true);
    const opened = openMemoryNodeExact(db, "S:1");
    assert.equal(opened.target.state, "active");
    assert.equal(opened.target.text, "Tooling overview (revised)");
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
