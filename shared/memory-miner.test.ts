import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import { getSourceSessionCheckpoint } from "./memory-repository.ts";
import { listActiveMemories } from "./memory-graph.ts";
import {
  runMemoryDreamMining,
  type MemoryMinerCompleteFn,
} from "./memory-miner.ts";
import {
  segmentMemorySessionEvidence,
  type MemoryDecodedSession,
} from "./memory-session-decode.ts";
import { writeMemoryDreamManifest } from "./memory-session-discovery.ts";
import type { MemoryDreamManifestEntry } from "./memory-session-discovery.ts";

interface FakeCtx {
  extractCalls: number;
  consolidateCalls: number;
  /** Per-call extract candidates derived from the segment text. */
  complete: MemoryMinerCompleteFn;
}

/** Fake completion: extract returns one candidate quoting the segment; consolidate returns a create op. */
function fakeCompletion(ctx: FakeCtx): MemoryMinerCompleteFn {
  return async (input) => {
    if (input.system.includes("extract durable user preferences")) {
      ctx.extractCalls += 1;
      const body = input.user.split("\n\n")[1] ?? "";
      const firstLine = body.split("\n")[0] ?? "no text";
      const memoryText = `Fact: ${firstLine.slice(0, 80)}`.trim();
      return {
        text: JSON.stringify({
          candidates: [
            {
              kind: "fact",
              memoryText,
              evidenceText: "verbatim evidence",
            },
          ],
        }),
      };
    }
    if (input.system.includes("finalize memory operations")) {
      ctx.consolidateCalls += 1;
      return {
        text: JSON.stringify({
          operations: [
            {
              op: "create",
              kind: "fact",
              memoryText: "Mined durable fact",
              evidenceText: "evidence from the session",
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected completion: ${input.system.slice(0, 40)}`);
  };
}

/** Build a session snapshot file and its manifest entry. */
function makeSessionEntry(
  dir: string,
  sessionId: string,
  messageCount: number,
  opts?: { minedMessageOffset?: number; messageText?: string },
): MemoryDreamManifestEntry {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", id: sessionId, cwd: "/tmp/ws" }),
  ];
  for (let i = 0; i < messageCount; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: opts?.messageText ?? `user message ${i}`,
        },
      }),
    );
  }
  const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf-8");
  fs.writeFileSync(file, bytes);
  return {
    sessionId,
    sessionPath: file,
    snapshotPath: file,
    cwd: "/tmp/ws",
    mtimeMs: 1_700_000_000_000,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    minedMessageOffset: opts?.minedMessageOffset ?? 0,
  };
}

async function withMinerDb(
  fn: (
    db: ReturnType<typeof openMemoryDatabaseAtPath>,
    dir: string,
  ) => void | Promise<void>,
): Promise<void> {
  const db = openMemoryDatabaseAtPath(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-miner-"));
  acquireMemoryRunClaim(db, "manual", { model: "fake/model" });
  try {
    await fn(db, dir);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runIdFor(db: ReturnType<typeof openMemoryDatabaseAtPath>): string {
  const row = db
    .prepare(
      "SELECT id FROM dream_runs WHERE status = 'claimed' ORDER BY started_at DESC LIMIT 1",
    )
    .get() as { id: string };
  return row.id;
}

function manifestFor(dir: string, entries: MemoryDreamManifestEntry[]): string {
  const manifestPath = path.join(dir, "manifest.json");
  writeMemoryDreamManifest(manifestPath, entries);
  return manifestPath;
}

test("full pass: extract per segment, consolidate once, commits fully mined", async () => {
  await withMinerDb(async (db, dir) => {
    const entry = makeSessionEntry(dir, "sess-1", 3);
    const manifestPath = manifestFor(dir, [entry]);
    const ctx: FakeCtx = {
      extractCalls: 0,
      consolidateCalls: 0,
      complete: () => Promise.reject(new Error("unused")),
    };
    ctx.complete = fakeCompletion(ctx);
    const result = await runMemoryDreamMining({
      db,
      runId: runIdFor(db),
      manifestPath,
      cwd: "/tmp/ws",
      complete: ctx.complete,
      segmentChars: 10_000,
    });
    assert.equal(result.ok, true, result.errorText);
    assert.equal(result.committedSessions, 1);
    assert.equal(result.committedOps, 1);
    assert.equal(ctx.extractCalls, 1, "one segment, one extract call");
    assert.equal(ctx.consolidateCalls, 1);
    const cp = getSourceSessionCheckpoint(db, "sess-1");
    assert.ok(cp, "session checkpointed");
    assert.equal(cp!.minedMessageOffset, 3, "cursor advanced to the end");
    assert.equal(cp!.totalMessages, 3);
    const memories = listActiveMemories(db);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.text, "Mined durable fact");
  });
});

test("budget hit mid-session commits a partial checkpoint; the next run resumes", async () => {
  await withMinerDb(async (db, dir) => {
    // Long messages: with a 1200-char segment budget the session splits into
    // several segments, and a run budget of 1900 chars fits only the first.
    const text = "durable workspace fact candidate ".repeat(40); // ~1300 chars
    const entry = makeSessionEntry(dir, "sess-1", 8, { messageText: text });
    const manifestPath = manifestFor(dir, [entry]);
    const ctx: FakeCtx = {
      extractCalls: 0,
      consolidateCalls: 0,
      complete: () => Promise.reject(new Error("unused")),
    };
    ctx.complete = fakeCompletion(ctx);
    const result = await runMemoryDreamMining({
      db,
      runId: runIdFor(db),
      manifestPath,
      cwd: "/tmp/ws",
      complete: ctx.complete,
      segmentChars: 1_200,
      runChars: 1_900,
    });
    assert.equal(result.ok, false);
    assert.match(result.errorText!, /partially mined/);
    assert.equal(result.partialSessions.length, 1);
    const cp = getSourceSessionCheckpoint(db, "sess-1");
    assert.ok(cp);
    assert.ok(
      cp!.minedMessageOffset < cp!.totalMessages,
      "partial checkpoint keeps cursor below total",
    );

    // Next run: rebuild the manifest with the resumed cursor and finish.
    const resumed = makeSessionEntry(dir, "sess-1", 8, {
      minedMessageOffset: cp!.minedMessageOffset,
    });
    const manifestPath2 = manifestFor(dir, [resumed]);
    const ctx2: FakeCtx = {
      extractCalls: 0,
      consolidateCalls: 0,
      complete: () => Promise.reject(new Error("unused")),
    };
    ctx2.complete = fakeCompletion(ctx2);
    const result2 = await runMemoryDreamMining({
      db,
      runId: runIdFor(db),
      manifestPath: manifestPath2,
      cwd: "/tmp/ws",
      complete: ctx2.complete,
      segmentChars: 1_200,
      runChars: 10_000,
    });
    assert.equal(result2.ok, true, result2.errorText);
    const cp2 = getSourceSessionCheckpoint(db, "sess-1");
    assert.equal(cp2!.minedMessageOffset, 8, "fully mined after resume");
    assert.equal(cp2!.totalMessages, 8);
  });
});

test("wall-clock budget stops the pass before the next session", async () => {
  await withMinerDb(async (db, dir) => {
    const entries = [
      makeSessionEntry(dir, "sess-1", 2),
      makeSessionEntry(dir, "sess-2", 2),
    ];
    const manifestPath = manifestFor(dir, entries);
    const ctx: FakeCtx = {
      extractCalls: 0,
      consolidateCalls: 0,
      complete: () => Promise.reject(new Error("unused")),
    };
    ctx.complete = fakeCompletion(ctx);
    // nowMs far in the past: the wall clock is already exhausted.
    const result = await runMemoryDreamMining({
      db,
      runId: runIdFor(db),
      manifestPath,
      cwd: "/tmp/ws",
      complete: ctx.complete,
      nowMs: Date.now() - 100_000,
      wallClockMs: 1_000,
      segmentChars: 10_000,
    });
    assert.equal(result.ok, false);
    assert.match(result.errorText!, /wall-clock budget/);
    assert.equal(ctx.extractCalls, 0, "no model calls after budget exhaustion");
  });
});

test("malformed extract output retries once then fails the run naming the session", async () => {
  await withMinerDb(async (db, dir) => {
    const entry = makeSessionEntry(dir, "sess-1", 2);
    const manifestPath = manifestFor(dir, [entry]);
    let calls = 0;
    const complete: MemoryMinerCompleteFn = async () => {
      calls += 1;
      return { text: "not json at all" };
    };
    const result = await runMemoryDreamMining({
      db,
      runId: runIdFor(db),
      manifestPath,
      cwd: "/tmp/ws",
      complete,
      segmentChars: 10_000,
    });
    assert.equal(result.ok, false);
    assert.match(result.errorText!, /sess-1/);
    assert.match(result.errorText!, /extract/);
    assert.equal(calls, 2, "exactly one corrective retry");
    // Nothing was committed for the failed session.
    assert.equal(getSourceSessionCheckpoint(db, "sess-1"), null);
  });
});

test("empty session commits a no-op and is fully mined", async () => {
  await withMinerDb(async (db, dir) => {
    const entry = makeSessionEntry(dir, "sess-1", 0);
    const manifestPath = manifestFor(dir, [entry]);
    const ctx: FakeCtx = {
      extractCalls: 0,
      consolidateCalls: 0,
      complete: () => Promise.reject(new Error("unused")),
    };
    ctx.complete = fakeCompletion(ctx);
    const result = await runMemoryDreamMining({
      db,
      runId: runIdFor(db),
      manifestPath,
      cwd: "/tmp/ws",
      complete: ctx.complete,
    });
    assert.equal(result.ok, true, result.errorText);
    assert.equal(result.committedSessions, 1);
    assert.equal(ctx.extractCalls, 0, "no extract call for an empty session");
    const cp = getSourceSessionCheckpoint(db, "sess-1");
    assert.equal(cp!.minedMessageOffset, 0);
    assert.equal(cp!.totalMessages, 0);
  });
});

test("deterministic segmentation truncates long content and keeps both edges", () => {
  // Direct segmentation check: a giant tool result must be bounded and keep
  // its head and tail.
  const session: MemoryDecodedSession = {
    sessionId: "s",
    cwd: "/tmp",
    messages: [
      {
        role: "toolResult",
        ts: null,
        parts: [
          {
            type: "toolResult",
            tool: "bash",
            text: "HEAD".repeat(1_000) + "TAIL",
          },
        ],
      },
      { role: "user", ts: null, parts: [{ type: "text", text: "hello" }] },
    ],
  };
  const segments = segmentMemorySessionEvidence(session, {
    maxChars: 50_000,
  });
  assert.equal(segments.length, 1);
  assert.match(segments[0]!.text, /^\[0\] toolResult:/);
  assert.ok(
    segments[0]!.text.length < 1_000,
    `tool result must be truncated, got ${segments[0]!.text.length}`,
  );
  assert.match(segments[0]!.text, /HEAD/);
  assert.match(segments[0]!.text, /TAIL\]/);
});
