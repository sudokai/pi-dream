import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import { commitMemoryLearningSession } from "./memory-repository.ts";
import { retireMemoryNode } from "./memory-graph.ts";
import {
  estimateTopLayerTokens,
  getMemoryNodeParent,
  isMemoryRoot,
  listMemoryDescendants,
  listMemoryNodeChildren,
  listMemoryTreeRoots,
} from "./memory-tree.ts";

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
  commitMemoryLearningSession(db, {
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

function summarize(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
  sessionId: string,
  text: string,
  memberIds: string[],
): string {
  commitMemoryLearningSession(db, {
    runId,
    sourceSessionId: sessionId,
    sessionPath: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp",
    processedMtimeMs: 1,
    contentHash: `h-${sessionId}`,
    plan: {
      operations: [
        {
          op: "summarize",
          text,
          memberIds,
        },
      ],
    },
  });
  const id = (
    db.prepare(`SELECT MAX(id) AS id FROM summaries`).get() as {
      id: number;
    }
  ).id;
  return `S:${id}`;
}

test("roots exclude non-root and conflicted nodes", async () => {
  await withClaimedDb((db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "CI runs on Ubuntu");
    const s1 = summarize(db, runId, "s3", "Tooling", [m1]);
    assert.deepEqual(
      listMemoryTreeRoots(db)
        .map((r) => r.prefixedId)
        .sort(),
      [m2, s1].sort(),
      "m1 is a child of s1, so only m2 and s1 are roots",
    );
    assert.equal(isMemoryRoot(db, "memory", 1), false);
    assert.equal(isMemoryRoot(db, "summary", 1), true);

    // Conflict the root memory: it must disappear from roots.
    commitMemoryLearningSession(db, {
      runId,
      sourceSessionId: "s4",
      sessionPath: "/tmp/s4.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-s4",
      plan: { operations: [{ op: "conflict", memoryIds: [m2 as never] }] },
    });
    assert.deepEqual(
      listMemoryTreeRoots(db).map((r) => r.prefixedId),
      [s1],
    );
  });
});

test("roots are NOT blocked by edges from retired parents", async () => {
  await withClaimedDb((db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const s1 = summarize(db, runId, "s2", "Tooling", [m1]);
    // Retire the parent summary: its child resurfaced as a root.
    retireMemoryNode(db, s1);
    const roots = listMemoryTreeRoots(db).map((r) => r.prefixedId);
    assert.deepEqual(roots, [m1]);
    assert.equal(isMemoryRoot(db, "memory", 1), true);
  });
});

test("children respect edge state; parent lookup and descendants walk", async () => {
  await withClaimedDb((db, runId) => {
    const m1 = createMemory(db, runId, "s1", "Use tabs for indentation");
    const m2 = createMemory(db, runId, "s2", "No emoji in commits");
    summarize(db, runId, "s3", "Preferences", [m1, m2]);
    const children = listMemoryNodeChildren(db, "summary", 1);
    assert.deepEqual(children.map((c) => c.prefixedId).sort(), [m1, m2].sort());
    assert.deepEqual(getMemoryNodeParent(db, "memory", 1), {
      nodeType: "summary",
      nodeId: 1,
    });
    assert.equal(getMemoryNodeParent(db, "summary", 1), null);
    assert.deepEqual(
      listMemoryDescendants(db, "summary", 1)
        .map((d) => d.prefixedId)
        .sort(),
      [m1, m2].sort(),
    );
  });
});

test("estimateTopLayerTokens sums root texts", async () => {
  await withClaimedDb((db, runId) => {
    createMemory(db, runId, "s1", "a".repeat(100));
    createMemory(db, runId, "s2", "b".repeat(100));
    const roots = listMemoryTreeRoots(db);
    const tokens = estimateTopLayerTokens(db, roots);
    assert.ok(
      tokens >= 50,
      `expected ~50 tokens for two 100-char roots, got ${tokens}`,
    );
  });
});
