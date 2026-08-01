import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildMemoryStatusText,
  getMemoryCommandArgumentCompletions,
  parseMemoryCommandArgs,
} from "./memory-command.ts";
import {
  buildMemoryLearnerSpawnArgs,
  MEMORY_LEARNER_TASK,
} from "../shared/pi-process-invocation.ts";
import { evaluateMemoryLearningCadence } from "./memory-cadence.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  commitMemoryLearningSession,
  getMemoryWorkspaceState,
  updateMemoryCadenceState,
} from "../shared/memory-repository.ts";
import {
  acquireMemoryRunClaim,
  consumeOneUnreportedMemoryRun,
  finalizeMemoryRun,
} from "../shared/memory-run-claim.ts";
import { consumeMemoryRunNotification } from "./memory-session-lifecycle.ts";

test("parseMemoryCommandArgs", () => {
  assert.deepEqual(parseMemoryCommandArgs(""), { action: "status" });
  assert.deepEqual(parseMemoryCommandArgs("list foo"), {
    action: "list",
    query: "foo",
  });
  assert.deepEqual(parseMemoryCommandArgs("open M:1"), {
    action: "open",
    id: "M:1",
  });
  assert.deepEqual(parseMemoryCommandArgs("open M:1 cursor=20"), {
    action: "open",
    id: "M:1",
    cursor: "20",
  });
  assert.equal(parseMemoryCommandArgs("open M:1 cursor=abc").action, "error");
  assert.equal(parseMemoryCommandArgs("open M:1 bogus").action, "error");
  assert.deepEqual(parseMemoryCommandArgs("learn"), { action: "learn" });
  assert.deepEqual(parseMemoryCommandArgs("pause"), { action: "pause" });
  assert.deepEqual(parseMemoryCommandArgs("resume"), { action: "resume" });
  assert.deepEqual(parseMemoryCommandArgs("forget S:2"), {
    action: "forget",
    id: "S:2",
  });
  assert.equal(parseMemoryCommandArgs("nope").action, "error");
});

test("getMemoryCommandArgumentCompletions", () => {
  const items = getMemoryCommandArgumentCompletions("pa");
  assert.ok(items?.some((i) => i.value === "pause"));
  assert.equal(getMemoryCommandArgumentCompletions("list x"), null);
});

test("buildMemoryLearnerSpawnArgs is stable and isolated", () => {
  const { args, env } = buildMemoryLearnerSpawnArgs({
    cwd: "/tmp/proj",
    workspaceId: "abc_widget",
    dbPath: "/tmp/memory.db",
    manifestPath: "/tmp/manifest.json",
    runId: "run-1",
    learningModel: "anthropic/claude-sonnet-4-5",
  });
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes(MEMORY_LEARNER_TASK));
  assert.equal(env.PI_DREAM_CHILD, "1");
  assert.equal(env.PI_DREAM_RUN_ID, "run-1");
  assert.equal(env.PI_DREAM_WORKSPACE_ID, "abc_widget");
});

test("evaluateMemoryLearningCadence requires three gates", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const config = {
      ...defaultMemoryWorkspaceConfig(),
      minTurns: 2,
      minMinutes: 1,
    };
    // First settle: turns=1, not enough
    const e1 = evaluateMemoryLearningCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 1_000_000,
    });
    assert.equal(e1.shouldLearn, false);
    assert.equal(e1.turnsSinceLastRun, 1);

    // Still no transcript advancement (no sessions)
    updateMemoryCadenceState(db, { lastSuccessfulRunAtMs: 0 });
    const e2 = evaluateMemoryLearningCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 1_000_000 + 120_000,
    });
    assert.equal(e2.shouldLearn, false);
    assert.equal(e2.transcriptAdvanced, false);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("paused or gated evaluations never consume the transcript watermark", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const config = {
      ...defaultMemoryWorkspaceConfig(),
      minTurns: 2,
      minMinutes: 1,
    };
    updateMemoryCadenceState(db, {
      turnsSinceLastRun: 0,
      lastSuccessfulRunAtMs: 1_000_000,
      lastObservedTranscriptMtimeMs: 100,
    });

    // Paused: gates fail, but the watermark must not advance.
    const e1 = evaluateMemoryLearningCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      enabled: false,
      nowMs: 2_000_000,
    });
    assert.equal(e1.shouldLearn, false);
    assert.equal(
      getMemoryWorkspaceState(db).lastObservedTranscriptMtimeMs,
      100,
    );

    // Gates fail (turns unmet): watermark still untouched.
    const e2 = evaluateMemoryLearningCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 3_000_000,
    });
    assert.equal(e2.shouldLearn, false);
    assert.equal(
      getMemoryWorkspaceState(db).lastObservedTranscriptMtimeMs,
      100,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("failed runs leave cadence untouched (retryable)", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.equal(claim.acquired, true);
    finalizeMemoryRun(db, claim.runId!, {
      status: "failed",
      errorText: "boom",
    });
    updateMemoryCadenceState(db, {
      turnsSinceLastRun: 7,
      lastSuccessfulRunAtMs: 111,
      lastObservedTranscriptMtimeMs: 50,
    });

    const notice = consumeMemoryRunNotification(db);
    assert.equal(notice?.level, "warning");
    const state = getMemoryWorkspaceState(db);
    assert.equal(state.turnsSinceLastRun, 7);
    assert.equal(state.lastSuccessfulRunAtMs, 111);
    assert.equal(state.lastObservedTranscriptMtimeMs, 50);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("completed runs reset cadence with success time and processed watermark", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.equal(claim.acquired, true);
    finalizeMemoryRun(db, claim.runId!, { status: "completed" });
    updateMemoryCadenceState(db, {
      turnsSinceLastRun: 3,
      lastSuccessfulRunAtMs: 222,
      lastObservedTranscriptMtimeMs: 60,
    });

    const notice = consumeMemoryRunNotification(db);
    assert.equal(notice?.level, "info");
    const state = getMemoryWorkspaceState(db);
    assert.equal(state.turnsSinceLastRun, 0);
    assert.ok(state.lastSuccessfulRunAtMs >= 222);
    // No processed sessions yet → watermark falls back to null (nothing consumed).
    assert.equal(state.lastObservedTranscriptMtimeMs, null);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("finished_at is stored as ISO-8601 UTC and round-trips through Date.parse", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.equal(claim.acquired, true);
    finalizeMemoryRun(db, claim.runId!, { status: "completed" });

    const row = db
      .prepare(`SELECT finished_at FROM learning_runs WHERE id = ?`)
      .get(claim.runId!) as { finished_at: string | null };
    assert.ok(row.finished_at, "finished_at must be set");
    assert.match(
      row.finished_at,
      /Z$/,
      `finished_at must be ISO-8601 UTC (ends with Z), got ${row.finished_at}`,
    );
    const parsedMs = Date.parse(row.finished_at);
    assert.ok(Number.isFinite(parsedMs), "finished_at must be parseable");
    assert.ok(
      Math.abs(parsedMs - Date.now()) < 1_000,
      `finished_at must round-trip within ~1s of now, got ${row.finished_at}`,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("consume rolls back reported flag when cadence reset throws", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.equal(claim.acquired, true);
    finalizeMemoryRun(db, claim.runId!, { status: "completed" });
    updateMemoryCadenceState(db, {
      turnsSinceLastRun: 9,
      lastSuccessfulRunAtMs: 100,
      lastObservedTranscriptMtimeMs: 40,
    });

    assert.throws(() =>
      consumeOneUnreportedMemoryRun(db, {
        beforeCommit: () => {
          throw new Error("cadence boom");
        },
      }),
    );

    const row = db
      .prepare(
        `SELECT reported_to_parent, status FROM learning_runs WHERE id = ?`,
      )
      .get(claim.runId!) as { reported_to_parent: number; status: string };
    assert.equal(
      row.reported_to_parent,
      0,
      "failed beforeCommit must roll back",
    );
    assert.equal(row.status, "completed");
    const state = getMemoryWorkspaceState(db);
    assert.equal(state.turnsSinceLastRun, 9);
    assert.equal(state.lastSuccessfulRunAtMs, 100);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("buildMemoryStatusText shows the tree section, attempts, and OVER BUDGET flag", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    commitMemoryLearningSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m",
            kind: "fact",
            observationText: "Use tabs for indentation",
            memoryText: "Use tabs for indentation",
          },
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
    db.prepare(
      `INSERT INTO maintenance_attempts (key, attempts, last_generation) VALUES ('merge:memory:1+memory:2', 1, 0)`,
    ).run();
    const cfg = { ...defaultMemoryWorkspaceConfig(), briefingTokenBudget: 1 };
    const text = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: cfg,
    });
    assert.match(text, /tree roots:\s+2/);
    assert.match(text, /OVER BUDGET: \d+\/1 tokens/);
    assert.match(text, /pending attempts: merge:memory:1\+memory:2 \(1\/3\)/);
    assert.match(text, /embedder:\s+tree maintenance \+ learning only/);
    assert.match(text, /last maintenance: none/);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("cadence fires a maintenance-only run with no transcripts when candidates exist", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    commitMemoryLearningSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m",
            kind: "fact",
            observationText: "Use tabs for indentation",
            memoryText: "Use tabs for indentation",
          },
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
    updateMemoryCadenceState(db, {
      turnsSinceLastRun: 0,
      lastSuccessfulRunAtMs: 1_000_000,
    });
    const config = {
      ...defaultMemoryWorkspaceConfig(),
      minTurns: 2,
      minMinutes: 1,
    };
    // Without candidates: transcript gate blocks.
    const noCandidates = evaluateMemoryLearningCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 2_000_000,
    });
    assert.equal(noCandidates.shouldLearn, false);

    // Cold roots -> maintenance candidates -> shouldLearn without transcripts.
    const withCandidates = evaluateMemoryLearningCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 2_000_000 + 120_000,
    });
    assert.equal(withCandidates.shouldLearn, true);
    assert.ok(
      !withCandidates.reasons.some((r) => r.includes("no uncheckpointed")),
      "maintenance candidates replace the transcript gate",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});
