import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import {
  commitMemoryDreamSession,
  getMemoryWorkspaceState,
  getSourceSessionCheckpoint,
  setMemoryEmbeddingDegradedError,
  setMemoryRecallCapacityError,
} from "./memory-repository.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  incrementMemoryActivityGeneration,
  listActiveMemories,
  listObservationsForMemory,
  openMemoryNodeExact,
  recordMemoryCitation,
  retireMemoryNode,
} from "./memory-graph.ts";

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

function ftsRowids(db: ReturnType<typeof openMemoryDatabaseAtPath>): number[] {
  const rows = db
    .prepare(`SELECT rowid FROM memory_fts ORDER BY rowid ASC`)
    .all() as Array<{ rowid: number }>;
  return rows.map((r) => Number(r.rowid));
}

test("commitMemoryDreamSession create + reinforce is idempotent per session", async () => {
  await withClaimedDb((db, runId) => {
    const r1 = commitMemoryDreamSession(db, {
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
    // The FTS row is maintained on create.
    assert.deepEqual(ftsRowids(db), [memories[0]!.id]);

    // Replay same session checkpoint → no-op
    const r2 = commitMemoryDreamSession(db, {
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
    const r3 = commitMemoryDreamSession(db, {
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
    const r = commitMemoryDreamSession(db, {
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

test("supersede excludes old memory from active search and projections", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
    commitMemoryDreamSession(db, {
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
    // The superseded memory is gone from FTS, search_documents, embeddings.
    assert.deepEqual(ftsRowids(db), [active[0]!.id]);
    const docs = db
      .prepare(`SELECT COUNT(*) AS n FROM search_documents`)
      .get() as { n: number };
    assert.equal(Number(docs.n), 1);
    // The supersedes edge is intact (audit).
    const edges = db
      .prepare(
        `SELECT relation, state FROM graph_edges WHERE relation = 'supersedes'`,
      )
      .all() as Array<{ relation: string; state: string }>;
    assert.equal(edges.length, 1);
    // open still shows history
    const opened = openMemoryNodeExact(db, `M:${old.id}`);
    assert.equal(opened.target.state, "superseded");
    assert.ok((opened.versions?.length ?? 0) >= 1);
  });
});

test("revise keeps identity, CAS-guards, and refreshes projections", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
        ],
      },
    });
    const m = listActiveMemories(db)[0]!;
    // Stale CAS fails closed.
    assert.throws(
      () =>
        commitMemoryDreamSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "revise",
                memoryId: `M:${m.id}`,
                observationText: "Build uses pnpm",
                memoryText: "The build uses pnpm and pnpm-lock.yaml",
                expectedVersionId: 999,
              },
            ],
          },
        }),
      /version is stale/,
    );
    const applied = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s3",
      sessionPath: "/tmp/s3.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 3,
      contentHash: "h3",
      plan: {
        operations: [
          {
            op: "revise",
            memoryId: `M:${m.id}`,
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm and pnpm-lock.yaml",
            expectedVersionId: m.currentVersionId,
          },
        ],
      },
    });
    assert.equal(applied.applied, true);
    assert.equal(
      getMemoryById(db, m.id)!.text,
      "The build uses pnpm and pnpm-lock.yaml",
    );
    // FTS reflects the new text and holds exactly one row for the memory.
    const hit = db
      .prepare(
        `SELECT rowid FROM memory_fts WHERE memory_fts MATCH '"pnpm-lock.yaml"'`,
      )
      .all() as Array<{ rowid: number }>;
    assert.deepEqual(
      hit.map((r) => Number(r.rowid)),
      [m.id],
    );
    const count = db.prepare(`SELECT COUNT(*) AS n FROM memory_fts`).get() as {
      n: number;
    };
    assert.equal(Number(count.n), 1);
  });
});

test("revise invalidates the embeddings row only when the text changes", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
        ],
      },
    });
    const m = listActiveMemories(db)[0]!;
    // Simulate a prior embedding pass for this memory.
    db.prepare(
      `INSERT INTO embeddings (node_type, node_id, model_id, content_hash, vector, updated_at)
       VALUES ('memory', ?, 'test/m', 'hash-1', ?, datetime('now'))`,
    ).run(m.id, Buffer.from(new Float32Array([1, 0]).buffer));

    // A revise that keeps the text identical must preserve the embedding
    // (the content hash still matches the search document).
    const sameText = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "revise",
            memoryId: `M:${m.id}`,
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
            expectedVersionId: m.currentVersionId,
          },
        ],
      },
    });
    assert.equal(sameText.applied, true);
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as {
          n: number;
        }
      ).n,
      1,
      "identical text keeps the embedding row",
    );

    // A text change invalidates the stale embedding (all models); the next
    // embedding pass re-embeds from the fresh search_documents row.
    const current = getMemoryById(db, m.id)!;
    const changed = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s3",
      sessionPath: "/tmp/s3.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 3,
      contentHash: "h3",
      plan: {
        operations: [
          {
            op: "revise",
            memoryId: `M:${m.id}`,
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm and pnpm-lock.yaml",
            expectedVersionId: current.currentVersionId,
          },
        ],
      },
    });
    assert.equal(changed.applied, true);
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as {
          n: number;
        }
      ).n,
      0,
      "a changed text must invalidate the embeddings row",
    );
  });
});

test("conflict marks both memories conflicted and removes them from projections", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
    commitMemoryDreamSession(db, {
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
    assert.deepEqual(ftsRowids(db), [], "conflicted memories leave FTS");
    const docs = db
      .prepare(`SELECT COUNT(*) AS n FROM search_documents`)
      .get() as { n: number };
    assert.equal(Number(docs.n), 0);
    const conflicts = db
      .prepare(
        `SELECT relation FROM graph_edges WHERE relation = 'conflicts_with'`,
      )
      .all() as Array<{ relation: string }>;
    assert.equal(conflicts.length, 1);
  });
});

test("link with the retired contains relation is rejected", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "Uses bun",
            memoryText: "Package manager is bun",
          },
        ],
      },
    });
    assert.throws(
      () =>
        commitMemoryDreamSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "link",
                relation: "contains" as never,
                fromId: "M:1",
                toId: "M:2",
              },
            ],
          },
        }),
      /CHECK/i,
    );
  });
});

test("lateral link relations are accepted and idempotent", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "Uses bun",
            memoryText: "Package manager is bun",
          },
          {
            op: "link",
            relation: "related_to",
            fromId: "m1",
            toId: "m2",
          },
          {
            op: "link",
            relation: "related_to",
            fromId: "M:1",
            toId: "M:2",
          },
        ],
      },
    });
    const edges = db
      .prepare(`SELECT relation, state FROM graph_edges`)
      .all() as Array<{ relation: string; state: string }>;
    assert.equal(edges.length, 1, "duplicate active link is idempotent");
    // Self-link is rejected.
    assert.throws(
      () =>
        commitMemoryDreamSession(db, {
          runId,
          sourceSessionId: "s2",
          sessionPath: "/tmp/s2.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 2,
          contentHash: "h2",
          plan: {
            operations: [
              {
                op: "link",
                relation: "related_to",
                fromId: "M:1",
                toId: "M:1",
              },
            ],
          },
        }),
      /cannot link a node to itself/,
    );
  });
});

test("forget soft-retires and preserves observations", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
    retireMemoryNode(db, `M:${m.id}`);
    assert.equal(getMemoryById(db, m.id)!.state, "retired");
    assert.equal(listActiveMemories(db).length, 0);
    assert.ok(listObservationsForMemory(db, m.id).length >= 1);
    assert.equal(getSourceSessionCheckpoint(db, "s1")?.sessionId, "s1");
    assert.deepEqual(ftsRowids(db), [], "retired memory leaves FTS");
  });
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

test("changed content with a preserved mtime is reprocessed, not skipped", async () => {
  await withClaimedDb((db, runId) => {
    const r1 = commitMemoryDreamSession(db, {
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
    const r2 = commitMemoryDreamSession(db, {
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
    const r3 = commitMemoryDreamSession(db, {
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
    const legacy = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "legacy",
      sessionPath: "/tmp/legacy.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 500,
      contentHash: null,
      plan: { operations: [{ op: "no_op", reason: "seed" }] },
    });
    assert.equal(legacy.applied, true);
    const r4 = commitMemoryDreamSession(db, {
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

test("citation events are recorded and observability-only", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
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
            observationText: "Uses pnpm",
            memoryText: "Package manager is pnpm",
          },
        ],
      },
    });
    const m = listActiveMemories(db)[0]!;
    recordMemoryCitation(db, {
      nodeType: "memory",
      nodeId: m.id,
      source: "briefing",
      piSessionId: "sess-x",
    });
    recordMemoryCitation(db, {
      nodeType: "memory",
      nodeId: m.id,
      source: "search",
    });
    const rows = db
      .prepare(
        `SELECT node_type, node_id, source, pi_session_id FROM citation_events ORDER BY id`,
      )
      .all() as Array<{
      node_type: string;
      node_id: number;
      source: string;
      pi_session_id: string | null;
    }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.source, "briefing");
    assert.equal(rows[0]!.pi_session_id, "sess-x");
    assert.equal(rows[1]!.source, "search");
    assert.equal(rows[1]!.pi_session_id, null);
  });
});

test("recall capacity error is persisted and cleared", async () => {
  await withClaimedDb((db, _runId) => {
    assert.equal(getMemoryWorkspaceState(db).recallCapacityError, null);
    setMemoryRecallCapacityError(db, "recall model context too small (32000)");
    assert.match(
      getMemoryWorkspaceState(db).recallCapacityError ?? "",
      /context too small/,
    );
    setMemoryRecallCapacityError(db, null);
    assert.equal(getMemoryWorkspaceState(db).recallCapacityError, null);
  });
});

test("embedding degradation is persisted and cleared (semantic-retriever diagnosability)", async () => {
  await withClaimedDb((db, _runId) => {
    assert.equal(getMemoryWorkspaceState(db).embeddingDegradedError, null);
    setMemoryEmbeddingDegradedError(
      db,
      "Semantic embedder unavailable: model download failed",
    );
    assert.match(
      getMemoryWorkspaceState(db).embeddingDegradedError ?? "",
      /model download failed/,
    );
    // A later successful pass clears the flag (self-healing).
    setMemoryEmbeddingDegradedError(db, null);
    assert.equal(getMemoryWorkspaceState(db).embeddingDegradedError, null);
    // The two diagnostics are independent columns.
    setMemoryRecallCapacityError(db, "capacity x");
    setMemoryEmbeddingDegradedError(db, "embedder y");
    const state = getMemoryWorkspaceState(db);
    assert.equal(state.recallCapacityError, "capacity x");
    assert.equal(state.embeddingDegradedError, "embedder y");
  });
});

test("two connections: a second reader sees committed writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-two-conn-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    const writer = openMemoryDatabaseAtPath(dbPath);
    const reader = openMemoryDatabaseAtPath(dbPath);
    try {
      const claim = acquireMemoryRunClaim(writer, "manual");
      assert.equal(claim.acquired, true);
      commitMemoryDreamSession(writer, {
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
              tempRef: "m1",
              kind: "fact",
              observationText: "Uses pnpm",
              memoryText: "Package manager is pnpm",
            },
          ],
        },
      });
      const seen = (
        reader.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as {
          n: number;
        }
      ).n;
      assert.equal(
        Number(seen),
        1,
        "committed write is visible on a second connection",
      );
      // Claim ownership is per-database: the reader connection sees the
      // running claim and cannot acquire a second one.
      const second = acquireMemoryRunClaim(reader, "auto");
      assert.equal(second.acquired, false);
      assert.equal(second.reason, "running");
    } finally {
      closeMemoryDatabase(writer);
      closeMemoryDatabase(reader);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a memory created by one connection is searchable via FTS on another", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-two-conn-fts-"));
  const dbPath = path.join(dir, "memory.db");
  try {
    const writer = openMemoryDatabaseAtPath(dbPath);
    const reader = openMemoryDatabaseAtPath(dbPath);
    try {
      const claim = acquireMemoryRunClaim(writer, "manual");
      assert.equal(claim.acquired, true);
      commitMemoryDreamSession(writer, {
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
              tempRef: "m1",
              kind: "fact",
              observationText: "CI caches the pnpm store",
              memoryText: "CI caches the pnpm store",
            },
          ],
        },
      });
      const hit = reader
        .prepare(`SELECT rowid FROM memory_fts WHERE memory_fts MATCH '"pnpm"'`)
        .all() as Array<{ rowid: number }>;
      assert.deepEqual(
        hit.map((r) => Number(r.rowid)),
        [1],
      );
    } finally {
      closeMemoryDatabase(writer);
      closeMemoryDatabase(reader);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generation advances only via incrementMemoryActivityGeneration", async () => {
  await withClaimedDb((db, _runId) => {
    assert.equal(getMemoryActivityGeneration(db), 0);
    incrementMemoryActivityGeneration(db);
    incrementMemoryActivityGeneration(db);
    assert.equal(getMemoryActivityGeneration(db), 2);
  });
});
