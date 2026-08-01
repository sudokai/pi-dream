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
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  finalizeMemoryLearningRun,
  findMemoryMaintenanceCoverageError,
} from "./memory-learning-finalize.ts";
import { persistMemoryMaintenanceInspect } from "./memory-learning-tools.ts";
import { incrementMemoryMaintenanceAttempt } from "../shared/memory-maintenance.ts";

const TEST_WORKSPACE = "finalize-test-workspace";

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

test("finalizeMemoryLearningRun fails when a manifest session was not checkpointed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    await finalizeMemoryLearningRun({
      db,
      runId: claim.runId,
      workspaceId: TEST_WORKSPACE,
      config: defaultMemoryWorkspaceConfig(),
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

test("finalizeMemoryLearningRun completes only after every manifest checkpoint", async () => {
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

    await finalizeMemoryLearningRun({
      db,
      runId: claim.runId,
      workspaceId: TEST_WORKSPACE,
      config: defaultMemoryWorkspaceConfig(),
      manifestPath,
    });

    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "completed");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty manifest is a valid maintenance-only run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryLearningManifest(manifestPath, []);

    await finalizeMemoryLearningRun({
      db,
      runId: claim.runId,
      workspaceId: TEST_WORKSPACE,
      config: defaultMemoryWorkspaceConfig(),
      manifestPath,
    });
    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "completed", "zero-session manifest is valid");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize fails loudly when the last inspect batch has outstanding candidates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryLearningManifest(manifestPath, []);
    // Two cold memories -> a merge candidate in the plan.
    commitMemoryLearningSession(db, {
      runId: claim.runId,
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
            observationText: "Use tabs",
            memoryText: "Use tabs for indentation",
          },
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "No emoji",
            memoryText: "No emoji in commits",
          },
        ],
      },
    });
    // The learner inspected (persisting the batch) but committed nothing.
    const plan = await planMemoryMaintenanceForTest(db, claim.runId);
    persistMemoryMaintenanceInspect(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config: defaultMemoryWorkspaceConfig(),
      },
      plan,
    );
    const error = await findMemoryMaintenanceCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      defaultMemoryWorkspaceConfig(),
    );
    assert.match(error ?? "", /outstanding/);
    assert.match(error ?? "", /merge:memory:1\+memory:2/);

    // At the attempt bound the same outstanding candidate is not a failure.
    incrementMemoryMaintenanceAttempt(db, "merge:memory:1+memory:2", 0);
    incrementMemoryMaintenanceAttempt(db, "merge:memory:1+memory:2", 0);
    incrementMemoryMaintenanceAttempt(db, "merge:memory:1+memory:2", 0);
    const bound = await findMemoryMaintenanceCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      defaultMemoryWorkspaceConfig(),
    );
    assert.equal(bound, null);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a supersede that dissolves a merge candidate completes (dissolution)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryLearningManifest(manifestPath, []);
    commitMemoryLearningSession(db, {
      runId: claim.runId,
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
            observationText: "Use tabs",
            memoryText: "Use tabs for indentation",
          },
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "No emoji",
            memoryText: "No emoji in commits",
          },
        ],
      },
    });
    const plan = await planMemoryMaintenanceForTest(db, claim.runId);
    persistMemoryMaintenanceInspect(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config: defaultMemoryWorkspaceConfig(),
      },
      plan,
    );
    // The final commit supersedes one of the merge-eligible roots.
    commitMemoryLearningSession(db, {
      runId: claim.runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "supersede",
            oldMemoryId: "M:1",
            newTempRef: "new1",
            kind: "correction",
            observationText: "Use spaces",
            memoryText: "Use spaces for indentation",
          },
        ],
      },
    });
    const error = await findMemoryMaintenanceCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      defaultMemoryWorkspaceConfig(),
    );
    assert.equal(error, null, "dissolved candidates are not a failure");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Recompute helper matching the child's planner invocation. */
async function planMemoryMaintenanceForTest(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
): Promise<
  import("../shared/memory-maintenance.ts").PersistedMemoryMaintenanceInspect
> {
  const plan = await import("../shared/memory-maintenance.ts").then((m) =>
    m.planMemoryMaintenance(db, {
      config: defaultMemoryWorkspaceConfig(),
      embed: async (texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(4))),
    }),
  );
  return {
    runId,
    plannedAt: new Date().toISOString(),
    generation: plan.generation,
    promotes: plan.promotes.map((p) => ({
      key: p.key,
      child: p.childPrefixedId,
      parent: p.parentPrefixedId,
      childHeat: p.childHeat,
      remainingMembersAfter: p.remainingMembersAfter,
    })),
    merges: plan.merges.map((m) => ({
      key: m.key,
      kind: m.kind,
      reason: m.reason,
      similarity: m.similarity,
      members: m.members.map((x) => x.prefixedId),
      baselineTokens: m.baselineTokens,
      outputCapTokens: m.outputCapTokens,
      summaryId: m.summaryId,
    })),
    layerTokens: plan.layerTokensAfterProjected,
    overBudget: plan.overBudget,
    budget: plan.budget,
  };
}
