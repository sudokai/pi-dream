import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import {
  commitMemoryDreamOps,
  commitMemoryDreamSession,
} from "./memory-repository.ts";
import {
  buildMemoryFallbackSummaryText,
  clearMemoryConsolidationAttempt,
  describeMemoryOverBudgetRecovery,
  getMemoryConsolidationAttempts,
  hasMemoryConsolidationCandidates,
  incrementMemoryConsolidationAttempt,
  memoryConsolidationMergeKey,
  planMemoryConsolidation,
} from "./memory-consolidation.ts";
import {
  getMemoryActivityGeneration,
  incrementMemoryActivityGeneration,
  recordMemoryRecallEvent,
} from "./memory-graph.ts";
import { computeMemoryRowHeat } from "./memory-heat.ts";
import { estimateMemoryTextTokens, MEMORY_HEAT_DECAY } from "./memory-types.ts";
import { defaultMemoryWorkspaceConfig } from "./memory-config.ts";

const VOCAB = [
  "tabs",
  "emoji",
  "ci",
  "ubuntu",
  "rest",
  "graphql",
  "pnpm",
  "fly",
  "deploy",
  "commit",
  "message",
];

/** Keyword-overlap embedder: cosine reflects shared vocabulary. */
function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Float32Array(VOCAB.length);
      const lower = t.toLowerCase();
      for (let i = 0; i < VOCAB.length; i++) {
        if (lower.includes(VOCAB[i]!)) v[i] = 1;
      }
      const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0)) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    }),
  );
}

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

function createMemory(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
  sessionId: string,
  text: string,
): string {
  commitMemoryDreamSession(db, {
    runId,
    sourceSessionId: sessionId,
    sessionPath: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp",
    processedMtimeMs: 1,
    contentHash: `h-${sessionId}`,
    plan: {
      operations: [
        {
          op: "create",
          tempRef: "m",
          kind: "fact",
          observationText: text,
          memoryText: text,
        },
      ],
    },
  });
  const id = (
    db.prepare(`SELECT MAX(id) AS id FROM memories`).get() as {
      id: number;
    }
  ).id;
  return `M:${id}`;
}

/** Merge key in the canonical planner format. */
function mergeKey(a: number, b: number): string {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `merge:memory:${lo}+memory:${hi}`;
}

function makeHot(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  nodeType: "memory" | "summary",
  nodeId: number,
): void {
  // One recall per generation at the two most recent generations:
  // 1.0 + 0.85 = 1.85, above the 1.5 hot threshold. Same-generation repeats
  // would count once — heat tracks distinct use, not call volume.
  const gen = getMemoryActivityGeneration(db);
  recordMemoryRecallEvent(db, {
    nodeType,
    nodeId,
    source: "open",
    activityGeneration: gen - 1,
  });
  recordMemoryRecallEvent(db, {
    nodeType,
    nodeId,
    source: "open",
    activityGeneration: gen,
  });
}

test("repeated recalls within one activity generation heat once", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const id = Number(m1.slice(2));
    // Three recalls in the same generation: one event's worth of heat.
    recordMemoryRecallEvent(db, {
      nodeType: "memory",
      nodeId: id,
      source: "open",
    });
    recordMemoryRecallEvent(db, {
      nodeType: "memory",
      nodeId: id,
      source: "open",
    });
    recordMemoryRecallEvent(db, {
      nodeType: "memory",
      nodeId: id,
      source: "open",
    });
    assert.equal(
      computeMemoryRowHeat(db, id, getMemoryActivityGeneration(db), null),
      1,
      "same-generation repeats count once",
    );
    // A recall in the next generation adds a decayed event: 1 + 0.85.
    incrementMemoryActivityGeneration(db);
    recordMemoryRecallEvent(db, {
      nodeType: "memory",
      nodeId: id,
      source: "open",
    });
    assert.equal(
      computeMemoryRowHeat(db, id, getMemoryActivityGeneration(db), null),
      1 + MEMORY_HEAT_DECAY,
      "recalls across generations each count",
    );
  });
});

function config(
  overrides: Partial<ReturnType<typeof defaultMemoryWorkspaceConfig>> = {},
) {
  return { ...defaultMemoryWorkspaceConfig(), ...overrides };
}

test("over-budget cold roots pair by nearest neighbor, deterministically, with no floor", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    createMemory(db, runId, "s3", "CI runs on Ubuntu");
    createMemory(db, runId, "s4", "Prefer tabs everywhere");

    const plan = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 8 }),
      embed: fakeEmbed,
    });
    assert.deepEqual(
      plan.merges.map((m) => m.key).sort(),
      [mergeKey(1, 4), mergeKey(2, 3)].sort(),
      "M:1 pairs with its nearest neighbor M:4 (shared 'tabs'); M:2 with M:3 (score 0, still pairable)",
    );
    const first = plan.merges.find((m) => m.key === mergeKey(1, 4))!;
    assert.equal(first.kind, "create");
    assert.ok(first.similarity > 0.9);
    assert.equal(first.outputCapTokens, first.baselineTokens - 1);

    const again = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 8 }),
      embed: fakeEmbed,
    });
    assert.deepEqual(
      again.merges.map((m) => m.key),
      plan.merges.map((m) => m.key),
      "planning is deterministic",
    );
  });
});

test("under budget no roots merge; over budget the coldest roots pair regardless of warmth", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    const m3 = createMemory(db, runId, "s3", "CI runs on Ubuntu");
    const m4 = createMemory(db, runId, "s4", "Prefer tabs everywhere");
    makeHot(db, "memory", Number(m3.slice(2)));
    makeHot(db, "memory", Number(m4.slice(2)));

    const plan = await planMemoryConsolidation(db, {
      config: config(),
      embed: fakeEmbed,
    });
    assert.deepEqual(
      plan.merges,
      [],
      "under budget, even cold roots never produce merge candidates",
    );

    // Tiny budget: the over-budget pool pairs coldest first and merges warm
    // roots too; every root lands in exactly one pair.
    const forced = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 10 }),
      embed: fakeEmbed,
    });
    const keys = forced.merges.map((m) => m.key);
    assert.equal(
      forced.merges.length,
      2,
      "all four roots pair while over budget",
    );
    assert.ok(
      keys.some((k) => k.includes(`memory:${m3.slice(2)}`)),
      "over budget merges warm roots",
    );
    assert.ok(
      keys.some((k) => k.includes(`memory:${m4.slice(2)}`)),
      "over budget merges warm roots",
    );
  });
});

test("over-budget pairing is not capped by a merge bound", async () => {
  await withClaimedDb(async (db, runId) => {
    for (let i = 1; i <= 6; i++) {
      createMemory(db, runId, `s${i}`, `Fact number ${i} about pnpm builds`);
    }
    const plan = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 10 }),
      embed: fakeEmbed,
    });
    assert.equal(plan.merges.length, 3, "all pairable pairs are planned");
    assert.ok(plan.overBudget, "pairs exhausted before the projection fits");
  });
});

test("fresh summaries are merge-ineligible during the grace window", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    createMemory(db, runId, "s3", "CI runs on Ubuntu");
    createMemory(db, runId, "s4", "Prefer tabs everywhere");
    // Wrap m1+m2 into a summary (created at generation 0, in grace).
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s5",
      sessionPath: "/tmp/s5.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s5",
      plan: {
        operations: [
          {
            op: "summarize",
            text: "Tooling",
            memberIds: [m1, m2],
          },
        ],
      },
    });
    const summaryText = (
      db
        .prepare(`SELECT text FROM summary_versions WHERE summary_id = 1`)
        .get() as {
        text: string;
      }
    ).text;
    void summaryText;

    const g0 = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 5 }),
      embed: fakeEmbed,
    });
    assert.ok(
      g0.merges.every((m) => !m.key.includes("S:1")),
      "fresh summary must not merge during grace",
    );
    assert.deepEqual(
      g0.merges.map((m) => m.key).sort(),
      [mergeKey(3, 4)].sort(),
    );

    // Past the grace window (creation_generation 0 + 3), S:1 is eligible.
    incrementMemoryActivityGeneration(db);
    incrementMemoryActivityGeneration(db);
    incrementMemoryActivityGeneration(db);
    const g3 = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 5 }),
      embed: fakeEmbed,
    });
    assert.ok(
      g3.merges.some(
        (m) => m.key === mergeKey(1, 2) || m.key.includes("summary:1"),
      ),
      "grace-passed summary participates in merging",
    );
  });
});

test("promote candidates require hot children; at most one per parent; no ancestor/descendant pairs", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    const m3 = createMemory(db, runId, "s3", "CI runs on Ubuntu");
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s4",
      sessionPath: "/tmp/s4.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s4",
      plan: {
        operations: [
          {
            op: "summarize",
            text: "Tooling",
            memberIds: [m1, m2, m3],
          },
        ],
      },
    });
    // Two hot children of the same parent: at most one promote per parent.
    makeHot(db, "memory", 1);
    makeHot(db, "memory", 2);
    let plan = await planMemoryConsolidation(db, {
      config: config(),
      embed: fakeEmbed,
    });
    assert.equal(plan.promotes.length, 1);
    assert.equal(
      plan.promotes[0]!.childId,
      1,
      "highest heat then lowest id wins",
    );
    assert.equal(plan.promotes[0]!.remainingMembersAfter, 2);
    assert.equal(plan.promotes[0]!.parentVersionId, 1);

    // Nested: S:2 contains M:4; S:1 contains S:2. A hot S:2 beats a hot M:4
    // (M:4 is a descendant of the promoted S:2).
    const m4 = createMemory(db, runId, "s5", "Prefer tabs everywhere");
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s6",
      sessionPath: "/tmp/s6.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s6",
      plan: {
        operations: [
          {
            op: "summarize",
            text: "Nested",
            memberIds: [m4],
          },
        ],
      },
    });
    // Attach S:2 under S:1 via extend.
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s7",
      sessionPath: "/tmp/s7.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s7",
      plan: {
        operations: [
          {
            op: "summarize",
            summaryId: "S:1",
            expectedVersionId: 1,
            text: "Tool+nest",
            memberIds: ["S:2"],
          },
        ],
      },
    });
    // Three opens at the three most recent generations keep S:2 hot:
    // 0.85^2 + 0.85 + 1 = 2.57, comfortably above its descendant M:4 (1.85).
    const gen = getMemoryActivityGeneration(db);
    recordMemoryRecallEvent(db, {
      nodeType: "summary",
      nodeId: 2,
      source: "open",
      activityGeneration: gen - 2,
    });
    recordMemoryRecallEvent(db, {
      nodeType: "summary",
      nodeId: 2,
      source: "open",
      activityGeneration: gen - 1,
    });
    recordMemoryRecallEvent(db, {
      nodeType: "summary",
      nodeId: 2,
      source: "open",
      activityGeneration: gen,
    });
    makeHot(db, "memory", 4);
    plan = await planMemoryConsolidation(db, {
      config: config(),
      embed: fakeEmbed,
    });
    const promoteKeys = plan.promotes.map((p) => p.key);
    assert.ok(
      promoteKeys.includes("promote:summary:2:1"),
      "the ancestor (hot summary S:2) wins over its hot descendant M:4",
    );
    assert.ok(
      !promoteKeys.includes("promote:memory:4:2"),
      "descendant defers to the next run",
    );
  });
});

test("conflicted and retired nodes never appear in consolidation", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    const m3 = createMemory(db, runId, "s3", "CI runs on Ubuntu");
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s4",
      sessionPath: "/tmp/s4.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s4",
      plan: { operations: [{ op: "conflict", memoryIds: [m1 as never] }] },
    });
    const plan = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 8 }),
      embed: fakeEmbed,
    });
    assert.ok(plan.merges.every((m) => !m.key.includes("M:1")));
    assert.equal(
      plan.merges.length,
      1,
      "the conflicted root is excluded; the remaining roots pair",
    );
    // Retire the rest: no candidates at all.
    for (const id of [m2, m3]) {
      db.prepare(`UPDATE memories SET state = 'retired' WHERE id = ?`).run(
        Number(id.slice(2)),
      );
    }
    const empty = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 8 }),
      embed: fakeEmbed,
    });
    assert.equal(empty.merges.length, 0);
    assert.equal(empty.promotes.length, 0);
  });
});

test("commit rejects non-compacting merges alone without vetoing the batch", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    createMemory(db, runId, "s3", "CI runs on Ubuntu");
    createMemory(db, runId, "s4", "Prefer tabs everywhere");
    createMemory(db, runId, "s5", "Build uses pnpm");
    createMemory(db, runId, "s6", "Deploys to Fly.io");
    // Budget 12: only genuinely compacting merges fit. All three texts pass
    // the per-op strict-compaction rule, but together the layer stays over.
    const cfg = config({ briefingTokenBudget: 12 });
    const result = commitMemoryDreamOps(db, {
      runId,
      operations: [
        {
          op: "summarize",
          text: "Use tabs + no emoji in commits", // barely compacts (savings 2)
          memberIds: ["M:1", "M:4"],
        },
        {
          op: "summarize",
          text: "Tabs", // compacts hard (savings 9)
          memberIds: ["M:2", "M:3"],
        },
        {
          op: "summarize",
          text: "CI ubuntu fly", // compacts well (savings 5)
          memberIds: ["M:5", "M:6"],
        },
      ],
      config: cfg,
    });
    assert.equal(result.applied, true);
    assert.equal(result.coveredKeys.length, 2);
    assert.equal(result.rejectedKeys.length, 1);
    assert.equal(result.fallbackKeys.length, 0);
    assert.ok(
      result.coveredKeys.includes(mergeKey(2, 3)),
      "the hard-compacting merge stays",
    );
    const rejectedKey = result.rejectedKeys[0]!.key;
    assert.equal(rejectedKey, mergeKey(1, 4));
    assert.equal(getMemoryConsolidationAttempts(db, rejectedKey), 1);
    const summaries = db
      .prepare(`SELECT id, state FROM summaries`)
      .all() as Array<{ id: number; state: string }>;
    assert.equal(
      summaries.length,
      2,
      "partial progress: rejected op not applied",
    );
    // The rejected candidate applies on the next run (attempts < K).
    const retry = commitMemoryDreamOps(db, {
      runId,
      operations: [
        {
          op: "summarize",
          text: "Tabs + emoji",
          memberIds: ["M:1", "M:4"],
        },
      ],
      config: cfg,
    });
    assert.equal(retry.coveredKeys.length, 1);
    assert.equal(getMemoryConsolidationAttempts(db, rejectedKey), 0);
  });
});

test("K consecutive rejections apply the deterministic fallback with an audit entry", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    const cfg = config({ briefingTokenBudget: 5 });
    const key = memoryConsolidationMergeKey(
      { nodeType: "memory", nodeId: 1 },
      { nodeType: "memory", nodeId: 2 },
    );
    // Two prior rejections (attempts 2); the next rejection is the K-th.
    incrementMemoryConsolidationAttempt(db, key, 0);
    incrementMemoryConsolidationAttempt(db, key, 0);
    const result = commitMemoryDreamOps(db, {
      runId,
      operations: [
        {
          op: "summarize",
          text: "Tabs and emoji policy", // too long: 23 chars ~ 6 tokens >= baseline
          memberIds: ["M:1", "M:2"],
        },
      ],
      config: cfg,
    });
    assert.equal(result.fallbackKeys.length, 1);
    assert.deepEqual(result.fallbackKeys, [key]);
    assert.equal(getMemoryConsolidationAttempts(db, key), 0, "counter resets");
    const fallbackAudit = result.auditEntries.find((a) =>
      a.text.includes("fallback merge"),
    );
    assert.ok(fallbackAudit, "fallback merge audit entry");
    assert.ok(fallbackAudit!.text.includes(key), "audit names the pair");
    const summary = db
      .prepare(
        `SELECT s.id, s.label_source, v.text
         FROM summaries s JOIN summary_versions v ON v.id = s.current_version_id`,
      )
      .get() as { id: number; label_source: string; text: string };
    assert.equal(summary.label_source, "fallback");
    assert.ok(
      summary.text.includes("M:1"),
      "fallback text is a labeled concatenation",
    );
    assert.ok(summary.text.includes("M:2"));
    assert.equal(
      estimateMemoryTextTokens(summary.text) <
        estimateMemoryTextTokens("Use tabs for indentation") +
          estimateMemoryTextTokens("No emoji in commits"),
      true,
      "fallback satisfies strict compaction",
    );
  });
});

test("commitMemoryDreamOps rejects session-bound ops", async () => {
  await withClaimedDb((db, runId) => {
    assert.throws(
      () =>
        commitMemoryDreamOps(db, {
          runId,
          operations: [
            {
              op: "create",
              tempRef: "x",
              kind: "fact",
              observationText: "x",
              memoryText: "x",
            },
          ],
          config: config(),
        }),
      /only summarize, promote, and no_op are allowed/,
    );
    assert.throws(
      () =>
        commitMemoryDreamOps(db, {
          runId,
          operations: [
            { op: "link", relation: "related_to", fromId: "M:1", toId: "M:2" },
          ],
          config: config(),
        }),
      /only summarize, promote, and no_op are allowed/,
    );
  });
});

test("a rewritten summary is re-embedded before the next pairing pass", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    createMemory(db, runId, "s3", "CI runs on Ubuntu");
    const s1 = (() => {
      commitMemoryDreamSession(db, {
        runId,
        sourceSessionId: "s4",
        sessionPath: "/tmp/s4.jsonl",
        cwd: "/tmp",
        processedMtimeMs: 1,
        contentHash: "h-s4",
        plan: {
          operations: [
            {
              op: "summarize",
              text: "Tooling",
              memberIds: [m2],
            },
          ],
        },
      });
      return "S:1";
    })();
    void s1;
    // Rewrite S:1 via extend (new text -> stale embedding content hash).
    commitMemoryDreamOps(db, {
      runId,
      operations: [
        {
          op: "summarize",
          summaryId: "S:1",
          expectedVersionId: 1,
          text: "Tooling + CI",
          memberIds: ["M:3"],
        },
      ],
      config: config(),
    });
    const embedded: string[] = [];
    await planMemoryConsolidation(db, {
      config: config(),
      embed: async (texts) => {
        embedded.push(...texts);
        return fakeEmbed(texts);
      },
    });
    assert.ok(
      embedded.some((t) => t === "Tooling + CI"),
      "the rewritten summary text must be re-embedded",
    );
  });
});

test("hasMemoryConsolidationCandidates is pure SQL and covers the over-budget state", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    // Warm roots (no cold roots at all) + a tiny budget -> the over-budget
    // clause fires without any embedder involvement.
    makeHot(db, "memory", 1);
    makeHot(db, "memory", 2);
    assert.equal(
      hasMemoryConsolidationCandidates(db, { config: config() }),
      false,
    );
    assert.equal(
      hasMemoryConsolidationCandidates(db, {
        config: config({ briefingTokenBudget: 5 }),
      }),
      true,
      "over-budget top layer with warm roots reports candidates",
    );

    // And the planner (child side) actually merges those warm roots.
    const plan = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 5 }),
      embed: fakeEmbed,
    });
    assert.ok(plan.overBudget);
    assert.ok(
      plan.merges.some((m) => m.key.includes(`memory:${m1.slice(2)}`)),
      "the planner pairs the over-budget warm roots too",
    );
    assert.ok(plan.merges.some((m) => m.key.includes(`memory:${m2.slice(2)}`)));
  });
});

test("describeMemoryOverBudgetRecovery promises urgent consolidation only when it will run", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    const key = memoryConsolidationMergeKey(
      { nodeType: "memory", nodeId: 1 },
      { nodeType: "memory", nodeId: 2 },
    );
    // Block the only pairable pair at the attempt bound: over budget, but no
    // candidate can be planned, so no next-settle run is promised.
    for (let i = 0; i < 3; i++) {
      incrementMemoryConsolidationAttempt(db, key, 0);
    }
    assert.equal(
      describeMemoryOverBudgetRecovery(db, {
        config: config({ briefingTokenBudget: 5 }),
      }),
      "consolidation has not yet compacted it",
      "over budget without candidates: never claims a next-settle run",
    );
    clearMemoryConsolidationAttempt(db, key);
    assert.equal(
      describeMemoryOverBudgetRecovery(db, {
        config: config({ briefingTokenBudget: 5 }),
      }),
      "urgent consolidation runs at the next agent settle",
      "over budget with candidates: names the urgent run",
    );
    assert.equal(
      describeMemoryOverBudgetRecovery(db, {
        config: { ...config({ briefingTokenBudget: 5 }), enabled: false },
      }),
      "consolidation has not yet compacted it",
      "paused memory: the cadence will not launch a run",
    );
  });
});

test("candidates at the attempt bound no longer spawn doomed runs", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    const key = memoryConsolidationMergeKey(
      { nodeType: "memory", nodeId: 1 },
      { nodeType: "memory", nodeId: 2 },
    );
    for (let i = 0; i < 3; i++) {
      incrementMemoryConsolidationAttempt(db, key, 0);
    }
    assert.equal(
      hasMemoryConsolidationCandidates(db, {
        config: config({ briefingTokenBudget: 1 }),
      }),
      false,
      "the only pairable pair is at the attempt bound",
    );
    // The planner skips the pair too.
    const plan = await planMemoryConsolidation(db, {
      config: config({ briefingTokenBudget: 1 }),
      embed: fakeEmbed,
    });
    assert.equal(plan.merges.length, 0);
  });
});

test("promote tips the layer over budget and the pass compensates with budget merges", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    createMemory(db, runId, "s3", "CI runs on Ubuntu");
    createMemory(db, runId, "s4", "Prefer tabs everywhere");
    createMemory(db, runId, "s5", "Build uses pnpm");
    // S:1 wraps m1+m2 (compacting text).
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s6",
      sessionPath: "/tmp/s6.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s6",
      plan: {
        operations: [
          {
            op: "summarize",
            text: "Tooling",
            memberIds: [m1, m2],
          },
        ],
      },
    });
    // Advance past the summary grace window so S:1 can participate in the
    // budget override; then re-heat the child at the current generation.
    incrementMemoryActivityGeneration(db);
    incrementMemoryActivityGeneration(db);
    incrementMemoryActivityGeneration(db);
    makeHot(db, "memory", 1);
    const cfg = config({ briefingTokenBudget: 6 });
    const plan = await planMemoryConsolidation(db, {
      config: cfg,
      embed: fakeEmbed,
    });
    assert.equal(plan.promotes.length, 1, "hot child is promoted");
    assert.ok(
      plan.merges.length > 0,
      "the promote's layer growth is compensated by budget-forced merges",
    );
  });
});

test("fallback text satisfies strict compaction by construction", () => {
  const members = [
    { prefixedId: "M:1", text: "Use tabs for indentation" },
    { prefixedId: "M:2", text: "No emoji in commits" },
  ];
  const baseline =
    estimateMemoryTextTokens("Use tabs for indentation") +
    estimateMemoryTextTokens("No emoji in commits");
  const text = buildMemoryFallbackSummaryText(null, members);
  assert.ok(
    estimateMemoryTextTokens(text) < baseline,
    `fallback (${estimateMemoryTextTokens(text)}) must be strictly smaller than baseline (${baseline})`,
  );
  // Extend form preserves the old condensation.
  const extended = buildMemoryFallbackSummaryText("Tooling", [
    { prefixedId: "M:3", text: "CI runs on Ubuntu" },
  ]);
  assert.ok(extended.startsWith("Tooling"));
  const extBaseline =
    estimateMemoryTextTokens("Tooling") +
    estimateMemoryTextTokens("CI runs on Ubuntu");
  assert.ok(estimateMemoryTextTokens(extended) < extBaseline);
});

test("consolidation commits require claim ownership", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    assert.throws(
      () =>
        commitMemoryDreamOps(db, {
          runId: "no-such-run",
          operations: [],
          config: config(),
        }),
      /no longer owns the workspace claim/,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("promote rewrite failure accumulates attempts and falls back to the old text at K", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    const m3 = createMemory(db, runId, "s3", "CI runs on Ubuntu");
    const m4 = createMemory(db, runId, "s4", "Prefer tabs everywhere");
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s5",
      sessionPath: "/tmp/s5.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s5",
      plan: {
        operations: [
          {
            op: "summarize",
            text: "Tooling",
            memberIds: [m2, m3, m4],
          },
        ],
      },
    });
    const promoteKey = "promote:memory:2:1";
    clearMemoryConsolidationAttempt(db, promoteKey);
    incrementMemoryConsolidationAttempt(db, promoteKey, 0);
    incrementMemoryConsolidationAttempt(db, promoteKey, 0);
    const badText =
      "A very long tooling overview that grows the parent summary";
    const result = commitMemoryDreamOps(db, {
      runId,
      operations: [
        {
          op: "promote",
          nodeId: m2 as never,
          summaryId: "S:1",
          expectedSummaryVersionId: 1,
          newSummaryText: badText,
        },
      ],
      config: config(),
    });
    assert.equal(
      result.coveredKeys.length,
      1,
      "K-th failure applies the promote",
    );
    assert.ok(
      result.auditEntries.some(
        (a) => a.text.includes("fallback") || a.text.includes("promote M:2"),
      ),
    );
    assert.equal(getMemoryConsolidationAttempts(db, promoteKey), 0);
    const parent = db
      .prepare(
        `SELECT v.text FROM summaries s
         JOIN summary_versions v ON v.id = s.current_version_id WHERE s.id = 1`,
      )
      .get() as { text: string };
    assert.equal(
      parent.text,
      "Tooling",
      "old summary text kept at the K-th fallback",
    );
  });
});

test("a model-authored extend rewrite resets label_source to 'model'", async () => {
  await withClaimedDb(async (db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    createMemory(db, runId, "s2", "No emoji in commits");
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s3",
      sessionPath: "/tmp/s3.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s3",
      plan: {
        operations: [
          {
            op: "summarize",
            text: "Tooling",
            memberIds: [m1],
          },
        ],
      },
    });
    // Simulate a fallback-merged summary (mechanical label).
    db.prepare(
      `UPDATE summaries SET label_source = 'fallback' WHERE id = 1`,
    ).run();
    const result = commitMemoryDreamOps(db, {
      runId,
      operations: [
        {
          op: "summarize",
          summaryId: "S:1",
          expectedVersionId: 1,
          text: "Tooling + emoji",
          memberIds: ["M:2"],
        },
      ],
      config: config(),
    });
    assert.equal(result.coveredKeys.length, 1);
    const row = db
      .prepare(`SELECT label_source FROM summaries WHERE id = 1`)
      .get() as { label_source: string };
    assert.equal(
      row.label_source,
      "model",
      "a model-authored extend clears the fallback marker",
    );
  });
});
