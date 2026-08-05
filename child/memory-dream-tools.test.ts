import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { acquireMemoryRunClaim } from "../shared/memory-run-claim.ts";
import { writeMemoryDreamManifest } from "../shared/memory-session-discovery.ts";
import { registerMemoryDreamTools } from "./memory-dream-tools.ts";

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

function captureDreamerTools(ctx: {
  db: ReturnType<typeof openMemoryDatabaseAtPath>;
  runId: string;
  manifestPath: string;
  cwd: string;
}): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  registerMemoryDreamTools(
    {
      registerTool: (t: CapturedTool) => tools.set(t.name, t),
    } as unknown as ExtensionAPI,
    ctx,
  );
  return tools;
}

function writeSnapshot(
  dir: string,
  sessionId: string,
): { snapshotPath: string; contentHash: string } {
  const snapshotPath = path.join(dir, `snapshot-${sessionId}.jsonl`);
  const bytes = `{"type":"session","id":"${sessionId}","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"I prefer tabs over spaces"}}\n`;
  fs.writeFileSync(snapshotPath, bytes, "utf-8");
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  return { snapshotPath, contentHash };
}

test("dreamer tools append a trace.jsonl of every tool call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-tools-trace-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    const { snapshotPath, contentHash } = writeSnapshot(dir, "s1");
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, [
      {
        sessionId: "s1",
        sessionPath: "/tmp/s1.jsonl",
        snapshotPath,
        cwd: "/tmp",
        mtimeMs: 100,
        contentHash,
        minedMessageOffset: 0,
      },
    ]);

    const tools = captureDreamerTools({
      db,
      runId: claim.runId!,
      manifestPath,
      cwd: "/tmp",
    });

    await tools.get("memory_list_sessions")!.execute("1", {});
    await tools.get("memory_read_session")!.execute("2", { sessionId: "s1" });
    await tools.get("memory_commit_session")!.execute("3", {
      sessionId: "s1",
      operations: [{ op: "no_op", reason: "nothing durable" }],
    });

    const tracePath = path.join(dir, "trace.jsonl");
    assert.equal(
      fs.existsSync(tracePath),
      true,
      "trace.jsonl is written into the run dir",
    );
    const lines = fs
      .readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 3, "one trace line per tool call");
    assert.equal(lines[0]!.tool, "memory_list_sessions");
    assert.equal(lines[0]!.count, 1);
    assert.equal(lines[1]!.tool, "memory_read_session");
    assert.equal(lines[1]!.sessionId, "s1");
    assert.equal(lines[1]!.totalMessages, 1);
    assert.equal(lines[2]!.tool, "memory_commit_session");
    assert.equal(lines[2]!.sessionId, "s1");
    assert.equal(lines[2]!.applied, true);
    assert.equal(lines[2]!.operationCount, 1);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the commit trace is the signal that distinguishes a skipped session", async () => {
  // Two sessions in the manifest; the dreamer commits s1 but never commits s2.
  // The trace's absence of a memory_commit_session entry for s2 is exactly the
  // evidence that makes a failed dream diagnosable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-tools-skip-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    const s1 = writeSnapshot(dir, "s1");
    const s2 = writeSnapshot(dir, "s2");
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, [
      {
        sessionId: "s1",
        sessionPath: "/tmp/s1.jsonl",
        snapshotPath: s1.snapshotPath,
        cwd: "/tmp",
        mtimeMs: 100,
        contentHash: s1.contentHash,
        minedMessageOffset: 0,
      },
      {
        sessionId: "s2",
        sessionPath: "/tmp/s2.jsonl",
        snapshotPath: s2.snapshotPath,
        cwd: "/tmp",
        mtimeMs: 100,
        contentHash: s2.contentHash,
        minedMessageOffset: 0,
      },
    ]);

    const tools = captureDreamerTools({
      db,
      runId: claim.runId!,
      manifestPath,
      cwd: "/tmp",
    });

    await tools.get("memory_list_sessions")!.execute("1", {});
    await tools.get("memory_read_session")!.execute("2", { sessionId: "s1" });
    await tools.get("memory_commit_session")!.execute("3", {
      sessionId: "s1",
      operations: [{ op: "no_op", reason: "nothing durable" }],
    });
    // s2 is read but never committed — the skip the trace must reveal.
    await tools.get("memory_read_session")!.execute("4", { sessionId: "s2" });

    const trace = fs
      .readFileSync(path.join(dir, "trace.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const committed = new Set(
      trace
        .filter((e) => e.tool === "memory_commit_session")
        .map((e) => e.sessionId as string),
    );
    assert.deepEqual([...committed], ["s1"], "only s1 was committed");
    assert.equal(
      committed.has("s2"),
      false,
      "the trace shows s2 was never committed",
    );
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
