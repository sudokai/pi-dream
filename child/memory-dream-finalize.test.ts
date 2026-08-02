import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { commitMemoryDreamSession } from "../shared/memory-repository.ts";
import {
  acquireMemoryRunClaim,
  listUnreportedMemoryRuns,
} from "../shared/memory-run-claim.ts";
import { writeMemoryDreamManifest } from "../shared/memory-session-discovery.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  finalizeMemoryDreamRun,
  findMemoryConsolidationCoverageError,
} from "./memory-dream-finalize.ts";
import { persistMemoryConsolidationInspect } from "./memory-dream-tools.ts";
import { incrementMemoryConsolidationAttempt } from "../shared/memory-consolidation.ts";

const TEST_WORKSPACE = "finalize-test-workspace";

// Small budget so the planner still emits merge candidates under budget
// gating (the default 8000-token budget never plans merges for tiny trees).
const OVER_BUDGET_CONFIG: MemoryWorkspaceConfig = {
  ...defaultMemoryWorkspaceConfig(),
  briefingTokenBudget: 8,
};

function writeDreamManifest(dir: string): string {
  const snapshotPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(snapshotPath, "snapshot bytes\n", "utf-8");
  const manifestPath = path.join(dir, "manifest.json");
  writeMemoryDreamManifest(manifestPath, [
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

test("finalizeMemoryDreamRun fails when a manifest session was not checkpointed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      workspaceId: TEST_WORKSPACE,
      config: defaultMemoryWorkspaceConfig(),
      manifestPath: writeDreamManifest(dir),
    });

    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.errorText ?? "", /uncheckpointed/);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finalizeMemoryDreamRun completes only after every manifest checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = writeDreamManifest(dir);
    const committed = commitMemoryDreamSession(db, {
      runId: claim.runId,
      sourceSessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "snapshot-hash-1",
      plan: { operations: [{ op: "no_op", reason: "nothing durable" }] },
    });
    assert.equal(committed.applied, true);

    await finalizeMemoryDreamRun({
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

test("an empty manifest is a valid dream-only run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, []);

    await finalizeMemoryDreamRun({
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
    writeMemoryDreamManifest(manifestPath, []);
    // Two cold memories -> a merge candidate in the plan.
    commitMemoryDreamSession(db, {
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
    // The dreamer inspected (persisting the batch) but committed nothing.
    const plan = await planMemoryConsolidationForTest(
      db,
      claim.runId,
      OVER_BUDGET_CONFIG,
    );
    persistMemoryConsolidationInspect(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config: OVER_BUDGET_CONFIG,
      },
      plan,
    );
    const error = await findMemoryConsolidationCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      OVER_BUDGET_CONFIG,
    );
    assert.match(error ?? "", /outstanding/);
    assert.match(error ?? "", /merge:memory:1\+memory:2/);

    // At the attempt bound the same outstanding candidate is not a failure.
    incrementMemoryConsolidationAttempt(db, "merge:memory:1+memory:2", 0);
    incrementMemoryConsolidationAttempt(db, "merge:memory:1+memory:2", 0);
    incrementMemoryConsolidationAttempt(db, "merge:memory:1+memory:2", 0);
    const bound = await findMemoryConsolidationCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      OVER_BUDGET_CONFIG,
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
    writeMemoryDreamManifest(manifestPath, []);
    commitMemoryDreamSession(db, {
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
    const plan = await planMemoryConsolidationForTest(
      db,
      claim.runId,
      OVER_BUDGET_CONFIG,
    );
    persistMemoryConsolidationInspect(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config: OVER_BUDGET_CONFIG,
      },
      plan,
    );
    // The final commit supersedes one of the merge-eligible roots.
    commitMemoryDreamSession(db, {
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
    const error = await findMemoryConsolidationCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      OVER_BUDGET_CONFIG,
    );
    assert.equal(error, null, "dissolved candidates are not a failure");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Recompute helper matching the child's planner invocation. */
async function planMemoryConsolidationForTest(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
  config: MemoryWorkspaceConfig = defaultMemoryWorkspaceConfig(),
): Promise<
  import("../shared/memory-consolidation.ts").PersistedMemoryConsolidationInspect
> {
  const plan = await import("../shared/memory-consolidation.ts").then((m) =>
    m.planMemoryConsolidation(db, {
      config,
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

test("a run whose only unresolved candidate was rejected for compaction completes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, []);
    // Six cold memories -> three merge pairs in the inspect batch.
    for (let i = 1; i <= 6; i++) {
      commitMemoryDreamSession(db, {
        runId: claim.runId,
        sourceSessionId: `s${i}`,
        sessionPath: `/tmp/s${i}.jsonl`,
        cwd: "/tmp",
        processedMtimeMs: 1,
        contentHash: `h${i}`,
        plan: {
          operations: [
            {
              op: "create",
              tempRef: "m",
              kind: "fact",
              observationText: `Fact ${i}`,
              memoryText: `Fact ${i} about the build`,
            },
          ],
        },
      });
    }
    // Small budget so the batch of three merges leaves the layer over target
    // and the residual rejection fires (needed to exercise the in-run
    // rejection recording; the defaults would fit and reject nothing).
    const config = {
      ...defaultMemoryWorkspaceConfig(),
      briefingTokenBudget: 12,
    };
    const plan = await planMemoryConsolidationForTest(db, claim.runId, config);
    persistMemoryConsolidationInspect(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config,
      },
      plan,
    );
    // The dreamer emits ops for the PLANNED pairs (read from the persisted
    // inspect batch, so the committed keys are exactly the persisted keys);
    // one text is at the compaction bar and gets rejected alone (attempts=1),
    // the other two apply. On pre-fix code this scenario fails finalize with
    // "outstanding: merge:memory:1+memory:2" — the test only passes with the
    // per-run rejection tracking in place.
    assert.equal(plan.merges.length, 3);
    const planned = plan.merges.map((m) => m.members);
    assert.deepEqual(planned, [
      ["M:1", "M:2"],
      ["M:3", "M:4"],
      ["M:5", "M:6"],
    ]);
    const { commitMemoryDreamOps } =
      await import("../shared/memory-repository.ts");
    const result = commitMemoryDreamOps(db, {
      runId: claim.runId,
      operations: [
        {
          op: "summarize",
          text: "Fact 1 plus fact 2 builds", // passes strict compaction, fails the half-baseline bar -> rejected
          memberIds: planned[0]!,
        },
        {
          op: "summarize",
          text: "Facts 3+4",
          memberIds: planned[1]!,
        },
        {
          op: "summarize",
          text: "Facts 5+6",
          memberIds: planned[2]!,
        },
      ],
      config,
    });
    assert.equal(result.rejectedKeys.length, 1, "one candidate rejected");
    assert.equal(
      result.rejectedKeys[0]!.key,
      plan.merges[0]!.key,
      "the rejected key is one of the persisted planned pairs",
    );
    assert.equal(result.coveredKeys.length, 2, "partial progress applied");
    const { mergeMemoryConsolidationRejections } =
      await import("./memory-dream-tools.ts");
    mergeMemoryConsolidationRejections(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config,
      },
      result.rejectedKeys.map((r) => r.key),
    );

    const error = await findMemoryConsolidationCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      config,
    );
    assert.equal(
      error,
      null,
      "compaction-rejected candidates are a pass state (partial progress)",
    );

    // And the whole run completes.
    await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      workspaceId: TEST_WORKSPACE,
      config,
      manifestPath,
    });
    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "completed");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a candidate rejected in a previous run but omitted now still fails loudly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, []);
    commitMemoryDreamSession(db, {
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
    const plan = await planMemoryConsolidationForTest(
      db,
      claim.runId,
      OVER_BUDGET_CONFIG,
    );
    persistMemoryConsolidationInspect(
      {
        db,
        runId: claim.runId,
        workspaceId: TEST_WORKSPACE,
        manifestPath,
        cwd: "/tmp",
        config: OVER_BUDGET_CONFIG,
      },
      plan,
    );
    // A previous run rejected the pair (counter 1); this run the dreamer
    // omits it entirely — the persisted batch carries no in-run rejection.
    incrementMemoryConsolidationAttempt(db, "merge:memory:1+memory:2", 0);
    const error = await findMemoryConsolidationCoverageError(
      db,
      claim.runId,
      TEST_WORKSPACE,
      OVER_BUDGET_CONFIG,
    );
    assert.match(error ?? "", /outstanding/);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
