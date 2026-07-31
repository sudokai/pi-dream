import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { commitMemoryLearningSession } from "../shared/memory-repository.ts";
import {
  acquireMemoryRunClaim,
  listUnreportedMemoryRuns,
} from "../shared/memory-run-claim.ts";
import { writeMemoryLearningManifest } from "../shared/memory-session-discovery.ts";
import { finalizeMemoryLearningRun } from "./memory-learning-finalize.ts";

function writeLearningManifest(dir: string): string {
  const snapshotPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(snapshotPath, "snapshot bytes\n", "utf-8");
  const manifestPath = path.join(dir, "manifest.json");
  writeMemoryLearningManifest(manifestPath, [
    {
      sessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      snapshotPath,
      cwd: "/tmp",
      mtimeMs: 100,
      contentHash: "snapshot-hash-1",
    },
  ]);
  return manifestPath;
}

test("finalizeMemoryLearningRun fails when a manifest session was not checkpointed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    finalizeMemoryLearningRun({
      db,
      runId: claim.runId,
      manifestPath: writeLearningManifest(dir),
    });

    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.errorText ?? "", /uncheckpointed/);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finalizeMemoryLearningRun completes only after every manifest checkpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = writeLearningManifest(dir);
    const committed = commitMemoryLearningSession(db, {
      runId: claim.runId,
      sourceSessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "snapshot-hash-1",
      plan: { operations: [{ op: "no_op", reason: "nothing durable" }] },
    });
    assert.equal(committed.applied, true);

    finalizeMemoryLearningRun({ db, runId: claim.runId, manifestPath });

    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "completed");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
