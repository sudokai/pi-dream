import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildMemoryListText,
  buildMemoryStatusText,
  getMemoryCommandArgumentCompletions,
  parseMemoryCommandArgs,
} from "./memory-command.ts";
import { buildMemoryDreamerSpawnArgs } from "../shared/pi-process-invocation.ts";
import { evaluateMemoryDreamCadence } from "./memory-cadence.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  loadMemoryEmbedder,
  resetMemoryEmbedderForTests,
  setMemoryEmbedderFactoryForTests,
} from "../shared/memory-embedding.ts";
import {
  commitMemoryDreamSession,
  getMemoryWorkspaceState,
  updateMemoryCadenceState,
} from "../shared/memory-repository.ts";
import {
  acquireMemoryRunClaim,
  consumeOneUnreportedMemoryRun,
  finalizeMemoryRun,
} from "../shared/memory-run-claim.ts";
import { consumeMemoryRunNotification } from "./memory-session-lifecycle.ts";
import {
  setMemoryEmbeddingDegradedError,
  setMemoryRecallCapacityError,
} from "../shared/memory-repository.ts";

test("parseMemoryCommandArgs", () => {
  assert.deepEqual(parseMemoryCommandArgs(""), { action: "status" });
  assert.deepEqual(parseMemoryCommandArgs("status --verbose"), {
    action: "status",
    verbose: true,
  });
  assert.deepEqual(parseMemoryCommandArgs("show --verbose"), {
    action: "status",
    verbose: true,
  });
  assert.equal(parseMemoryCommandArgs("status --bogus").action, "error");
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
  assert.deepEqual(parseMemoryCommandArgs("dream"), { action: "dream" });
  assert.deepEqual(parseMemoryCommandArgs("pause"), { action: "pause" });
  assert.deepEqual(parseMemoryCommandArgs("resume"), { action: "resume" });
  assert.deepEqual(parseMemoryCommandArgs("forget M:2"), {
    action: "forget",
    id: "M:2",
  });
  assert.equal(parseMemoryCommandArgs("nope").action, "error");
});

test("getMemoryCommandArgumentCompletions", () => {
  const items = getMemoryCommandArgumentCompletions("pa");
  assert.ok(items?.some((i) => i.value === "pause"));
  assert.equal(getMemoryCommandArgumentCompletions("list x"), null);
});

test("buildMemoryDreamerSpawnArgs is stable and isolated", () => {
  const { args, env } = buildMemoryDreamerSpawnArgs({
    cwd: "/tmp/proj",
    workspaceId: "abc_widget",
    dbPath: "/tmp/memory.db",
    manifestPath: "/tmp/manifest.json",
    runId: "run-1",
    dreamModel: "anthropic/claude-sonnet-4-5",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
  });
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-extensions"));
  // The dreamer is a deterministic batch pipeline: no agent prompt and no
  // tools. The extension body runs the mining driver at session_start.
  assert.ok(
    !args.includes("--tools"),
    "the dreamer child has no tool allowlist",
  );
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("anthropic/claude-sonnet-4-5"));
  // The spawn carries no positional task prompt (the driver runs in the extension).
  assert.ok(!args.some((a) => /dream pass/i.test(a)));
  assert.equal(env.PI_DREAM_CHILD, "1");
  assert.equal(env.PI_DREAM_RUN_ID, "run-1");
  assert.equal(env.PI_DREAM_WORKSPACE_ID, "abc_widget");
  assert.equal(env.PI_DREAM_EMBEDDING_MODEL, "Xenova/all-MiniLM-L6-v2");
});

test("evaluateMemoryDreamCadence requires turns, minutes, and transcripts", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const config = {
      ...defaultMemoryWorkspaceConfig(),
      minTurns: 2,
      minMinutes: 1,
    };
    // First settle: turns=1, not enough
    const e1 = evaluateMemoryDreamCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 1_000_000,
    });
    assert.equal(e1.shouldDream, false);
    assert.equal(e1.turnsSinceLastRun, 1);

    // Still no transcript advancement (no sessions)
    updateMemoryCadenceState(db, { lastSuccessfulRunAtMs: 0 });
    const e2 = evaluateMemoryDreamCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 1_000_000 + 120_000,
    });
    assert.equal(e2.shouldDream, false);
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
    const e1 = evaluateMemoryDreamCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      enabled: false,
      nowMs: 2_000_000,
    });
    assert.equal(e1.shouldDream, false);
    assert.equal(
      getMemoryWorkspaceState(db).lastObservedTranscriptMtimeMs,
      100,
    );

    // Gates fail (turns unmet): watermark still untouched.
    const e2 = evaluateMemoryDreamCadence(db, {
      cwd: "/nonexistent-dream-path",
      workspaceId: "ws",
      config,
      nowMs: 3_000_000,
    });
    assert.equal(e2.shouldDream, false);
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
      .prepare(`SELECT finished_at FROM dream_runs WHERE id = ?`)
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
      .prepare(`SELECT reported_to_parent, status FROM dream_runs WHERE id = ?`)
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

test("buildMemoryStatusText shows essentials; verbose adds internals", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "Use tabs for indentation",
            memoryText: "Use tabs for indentation",
          },
          {
            op: "create",
            kind: "fact",
            evidenceText: "No emoji in commits",
            memoryText: "No emoji in commits",
          },
        ],
      },
    });
    const text = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: defaultMemoryWorkspaceConfig(),
    });
    assert.match(text, /memories:\s+2 active \(0 retired\)/);
    assert.match(text, /citations:\s+0/);
    assert.match(text, /active dream:/);
    assert.doesNotMatch(text, /summaries/);
    assert.doesNotMatch(text, /top layer/);
    assert.doesNotMatch(text, /pending attempts/);
    assert.doesNotMatch(text, /workspace id/);
    assert.doesNotMatch(text, /unreported dreams/);
    assert.doesNotMatch(text, /config:/);
    assert.doesNotMatch(text, /cadence turns/);
    assert.doesNotMatch(text, /dream model:/);
    const verbose = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: defaultMemoryWorkspaceConfig(),
      verbose: true,
    });
    assert.match(verbose, /workspace id:\s+ws-test/);
    assert.match(verbose, /database:\s+\S+memory\.db/);
    assert.match(verbose, /activity gen:\s+0/);
    assert.match(verbose, /unreported dreams: 0/);
    assert.match(verbose, /config:\s+\S+ws-test/);
    assert.match(verbose, /cadence turns:\s+0 \(min 10\)/);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("status surfaces a persisted recall-capacity failure", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    setMemoryRecallCapacityError(
      db,
      "recall model x/y context (100 tokens) cannot hold the complete request (4000 tokens)",
    );
    const text = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: defaultMemoryWorkspaceConfig(),
    });
    assert.match(text, /recall capacity:\s+FAILED CLOSED/);
    assert.match(text, /4000 tokens/);
    setMemoryRecallCapacityError(db, null);
    const cleared = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: defaultMemoryWorkspaceConfig(),
    });
    assert.doesNotMatch(cleared, /recall capacity/);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("status surfaces a persisted embedding-pass degradation", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    setMemoryEmbeddingDegradedError(
      db,
      "Semantic embedder unavailable: model download failed",
    );
    const text = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: defaultMemoryWorkspaceConfig(),
    });
    assert.match(text, /semantic index:\s+DEGRADED/);
    assert.match(text, /model download failed/);
    // Cleared on a later successful pass: the line disappears.
    setMemoryEmbeddingDegradedError(db, null);
    const cleared = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config: defaultMemoryWorkspaceConfig(),
    });
    assert.doesNotMatch(cleared, /semantic index/);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("status surfaces a failed in-process embedder load", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  const modelId = "test/status-embedder";
  setMemoryEmbedderFactoryForTests(async () => {
    throw new Error("model download failed");
  });
  try {
    assert.equal(await loadMemoryEmbedder(modelId), null);
    const config = {
      ...defaultMemoryWorkspaceConfig(),
      embeddingModel: modelId,
    };
    const text = buildMemoryStatusText({ workspaceId: "ws-test", db, config });
    assert.match(
      text,
      /embedder:\s+FAILED \(this process\): model download failed/,
    );
    const verbose = buildMemoryStatusText({
      workspaceId: "ws-test",
      db,
      config,
      verbose: true,
    });
    assert.match(verbose, /embedder:\s+failed/);
    // A fresh process (no load attempt) stays quiet in non-verbose status.
    resetMemoryEmbedderForTests();
    const fresh = buildMemoryStatusText({ workspaceId: "ws-test", db, config });
    assert.doesNotMatch(fresh, /embedder:/);
  } finally {
    resetMemoryEmbedderForTests();
    closeMemoryDatabase(db);
  }
});

test("buildMemoryListText renders memories flat; non-active states stay visible", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "Use tabs",
            memoryText: "Use tabs for indentation",
          },
          {
            op: "create",
            kind: "fact",
            evidenceText: "No emoji",
            memoryText: "No emoji in commits",
          },
        ],
      },
    });
    // Retire one so the "Other states" section renders.
    db.prepare(`UPDATE memories SET state = 'retired' WHERE id = 2`).run();
    const text = buildMemoryListText(db);
    assert.match(text, /^## Active/m);
    assert.match(
      text,
      /- \*\*M:1\*\* \[fact\] \(r=1\): Use tabs for indentation/,
    );
    assert.match(text, /## Other states/);
    assert.match(
      text,
      /- \*\*M:2\*\* \[retired\/fact\] \(r=1\): No emoji in commits/,
    );
    assert.doesNotMatch(text, /summary/, "no summaries exist in the list");
    // Query filtering works.
    const filtered = buildMemoryListText(db, "tabs");
    assert.ok(filtered.includes("M:1"));
    assert.ok(!filtered.includes("M:2"));
  } finally {
    closeMemoryDatabase(db);
  }
});
