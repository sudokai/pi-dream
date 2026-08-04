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
  listMemoryVersions,
  openMemoryNodeExact,
  recordMemoryCitation,
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

test("commitMemoryDreamSession create + update is idempotent per session", async () => {
  await withClaimedDb((db, runId) => {
    const r1 = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "sess-1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp/proj",
      processedMtimeMs: 1000,
      contentHash: "h1",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "User prefers TypeScript strict mode",
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
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "User prefers TypeScript strict mode",
            memoryText: "Prefer TypeScript strict mode",
          },
        ],
      },
    });
    assert.equal(r2.applied, false);

    // New session restates the preference: evidence + recurrence, same node.
    const r3 = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "sess-2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp/proj",
      processedMtimeMs: 2000,
      contentHash: "h2",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "update",
            memoryId: `M:${memories[0]!.id}`,
            evidenceText: "Again prefers TypeScript strict mode",
          },
        ],
      },
    });
    assert.equal(r3.applied, true);
    const updated = getMemoryById(db, memories[0]!.id)!;
    assert.equal(updated.recurrence, 2);
    assert.equal(listMemoryVersions(db, updated.id).length, 2);
  });
});

test("duplicate evidence creates keep support: no orphan active memories", async () => {
  await withClaimedDb((db, runId) => {
    const r = commitMemoryDreamSession(db, {
      runId,
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
            kind: "preference",
            evidenceText: "User likes tabs",
            memoryText: "Prefer tabs",
          },
          {
            op: "create",
            kind: "preference",
            evidenceText: "user likes tabs",
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
      assert.ok(listMemoryVersions(db, m.id).length >= 1);
    }
    // Each memory records its own evidence version with the source session.
    const versionsA = listMemoryVersions(db, memories[0]!.id);
    const versionsB = listMemoryVersions(db, memories[1]!.id);
    assert.equal(versionsA.length, 1);
    assert.equal(versionsA[0]!.sourceSessionId, "s1");
    assert.ok(versionsA[0]!.evidenceText.length > 0);
    assert.equal(versionsB.length, 1);
  });
});

test("update keeps identity: old wording stays in the version chain, projections refresh", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "Use spaces",
            memoryText: "Use spaces for indentation",
          },
        ],
      },
    });
    const mem = listActiveMemories(db)[0]!;
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: null,
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "update",
            memoryId: `M:${mem.id}`,
            evidenceText: "Actually use tabs",
            memoryText: "Use tabs for indentation",
          },
        ],
      },
    });
    const active = listActiveMemories(db);
    assert.equal(active.length, 1, "update keeps one stable memory node");
    assert.equal(active[0]!.id, mem.id, "identity is kept");
    assert.match(active[0]!.text, /tabs/i);
    // The old wording is not in any retrieval projection, only in the chain.
    assert.deepEqual(ftsRowids(db), [mem.id]);
    const docs = db
      .prepare(`SELECT COUNT(*) AS n FROM search_documents`)
      .get() as { n: number };
    assert.equal(Number(docs.n), 1);
    // The version chain preserves both wordings with their evidence.
    const versions = listMemoryVersions(db, mem.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.text, "Use tabs for indentation");
    assert.equal(versions[1]!.text, "Use spaces for indentation");
    assert.equal(versions[0]!.sourceSessionId, "s2");
    // open still shows the full history
    const opened = openMemoryNodeExact(db, `M:${mem.id}`);
    assert.equal(opened.target.state, "active");
    assert.equal(opened.versions.length, 2);
  });
});

test("update with memoryText appends a version in place and refreshes projections", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
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
            evidenceText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
          },
        ],
      },
    });
    const m = listActiveMemories(db)[0]!;
    const applied = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "update",
            memoryId: `M:${m.id}`,
            evidenceText: "Build uses pnpm",
            memoryText: "The build uses pnpm and pnpm-lock.yaml",
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

test("update text change invalidates the embeddings row only when the text changes", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
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
            evidenceText: "Build uses pnpm",
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

    // An update that keeps the text identical must preserve the embedding
    // (the content hash still matches the search document).
    const sameText = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "update",
            memoryId: `M:${m.id}`,
            evidenceText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
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
    const changed = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s3",
      sessionPath: "/tmp/s3.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 3,
      contentHash: "h3",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "update",
            memoryId: `M:${m.id}`,
            evidenceText: "Build uses pnpm",
            memoryText: "The build uses pnpm and pnpm-lock.yaml",
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

test("update and forget reject non-active targets", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "API is REST",
            memoryText: "API style is REST",
          },
        ],
      },
    });
    const m1 = listActiveMemories(db)[0]!;
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: null,
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "forget",
            memoryId: `M:${m1.id}`,
            evidenceText: "API moved to GraphQL",
          },
        ],
      },
    });
    assert.equal(getMemoryById(db, m1.id)!.state, "retired");
    assert.equal(listActiveMemories(db).length, 0);
    // Updating or forgetting a retired memory is a category error.
    assert.throws(
      () =>
        commitMemoryDreamSession(db, {
          runId,
          sourceSessionId: "s3",
          sessionPath: "/tmp/s3.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 3,
          contentHash: null,
          minedMessageOffset: 1,
          plan: {
            operations: [
              {
                op: "update",
                memoryId: `M:${m1.id}`,
                evidenceText: "API is REST again",
              },
            ],
          },
        }),
      /retired/,
    );
    assert.throws(
      () =>
        commitMemoryDreamSession(db, {
          runId,
          sourceSessionId: "s4",
          sessionPath: "/tmp/s4.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 4,
          contentHash: null,
          minedMessageOffset: 1,
          plan: {
            operations: [
              {
                op: "forget",
                memoryId: `M:${m1.id}`,
                evidenceText: "drop it",
              },
            ],
          },
        }),
      /retired/,
    );
  });
});

test("forget op soft-retires and preserves the negating evidence", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: null,
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "No emoji",
            memoryText: "Do not use emoji in commits",
          },
        ],
      },
    });
    const m = listActiveMemories(db)[0]!;
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: null,
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "forget",
            memoryId: `M:${m.id}`,
            evidenceText: "Emoji are fine actually",
          },
        ],
      },
    });
    assert.equal(getMemoryById(db, m.id)!.state, "retired");
    assert.equal(listActiveMemories(db).length, 0);
    assert.deepEqual(ftsRowids(db), [], "retired memory leaves FTS");
    // The negating evidence is recorded on the memory row: audit records why
    // it was retired, and the version chain is untouched.
    const row = getMemoryById(db, m.id)!;
    assert.equal(row.retiredBySessionId, "s2");
    assert.equal(row.retiredEvidenceText, "Emoji are fine actually");
    assert.equal(listMemoryVersions(db, m.id).length, 1, "versions preserved");
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
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "X is 1",
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
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "X is 2",
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
      minedMessageOffset: 1,
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
      minedMessageOffset: 1,
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
      minedMessageOffset: 1,
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
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "Uses pnpm",
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
        minedMessageOffset: 1,
        plan: {
          operations: [
            {
              op: "create",
              kind: "fact",
              evidenceText: "Uses pnpm",
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
        minedMessageOffset: 1,
        plan: {
          operations: [
            {
              op: "create",
              kind: "fact",
              evidenceText: "CI caches the pnpm store",
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

test("create auto-merges into an existing active memory with identical normalized text", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
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
            kind: "preference",
            evidenceText: "I prefer tabs",
            memoryText: "Prefer tabs over spaces",
          },
        ],
      },
    });
    const first = listActiveMemories(db)[0]!;
    assert.equal(first.text, "Prefer tabs over spaces");

    // A later session restates the same preference with drifted case and
    // spacing: the normalized text collides, so the create must append a
    // restatement version to the existing memory instead of a new node.
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "Tabs, please",
            memoryText: "  Prefer   TABS over spaces ",
          },
        ],
      },
    });

    const active = listActiveMemories(db);
    assert.equal(active.length, 1, "no near-duplicate memory node is created");
    assert.equal(active[0]!.id, first.id);
    assert.equal(
      active[0]!.recurrence,
      2,
      "recurrence counts the two sessions",
    );
    assert.equal(
      listMemoryVersions(db, first.id).length,
      2,
      "both sessions' evidence lands on the existing memory",
    );
  });
});

test("two creates with identical text in one commit collapse to one memory", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
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
            evidenceText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
          },
          {
            op: "create",
            kind: "fact",
            evidenceText: "CI uses pnpm",
            memoryText: "THE BUILD USES Pnpm",
          },
        ],
      },
    });
    const active = listActiveMemories(db);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.recurrence, 1, "one session, one counted source");
    assert.equal(listMemoryVersions(db, active[0]!.id).length, 2);
  });
});

test("update into another active memory's normalized text fails closed", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
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
            kind: "preference",
            evidenceText: "Use tabs",
            memoryText: "Use tabs for indentation",
          },
        ],
      },
    });
    const tabs = listActiveMemories(db)[0]!;
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2,
      contentHash: "h2",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "Use spaces",
            memoryText: "Use spaces for indentation",
          },
        ],
      },
    });

    // Reinforcing the tabs memory into the spaces memory's text collides
    // with an active memory and must fail the commit loudly, not merge
    // silently.
    assert.throws(
      () =>
        commitMemoryDreamSession(db, {
          runId,
          sourceSessionId: "s3",
          sessionPath: "/tmp/s3.jsonl",
          cwd: "/tmp",
          processedMtimeMs: 3,
          contentHash: "h3",
          minedMessageOffset: 1,
          plan: {
            operations: [
              {
                op: "update",
                memoryId: `M:${tabs.id}`,
                evidenceText: "Actually spaces",
                memoryText: "Use spaces for indentation",
              },
            ],
          },
        }),
      /UNIQUE/,
    );
    const active = listActiveMemories(db);
    assert.equal(active.length, 2);
    const tabsAfter = listActiveMemories(db).find((m) => m.id === tabs.id)!;
    assert.equal(tabsAfter.text, "Use tabs for indentation");
  });
});

test("commit advances the incremental cursor; a same-hash replay leaves it untouched", async () => {
  await withClaimedDb((db, runId) => {
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "sess-grow",
      sessionPath: "/tmp/sess-grow.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1000,
      contentHash: "h1",
      minedMessageOffset: 7,
      plan: { operations: [{ op: "no_op", reason: "checkpoint" }] },
    });
    assert.equal(
      getSourceSessionCheckpoint(db, "sess-grow")!.minedMessageOffset,
      7,
    );

    // Same bytes replayed later (identical content hash) is a no-op that
    // must not move the cursor, even if the caller claims a bigger offset.
    const replay = commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "sess-grow",
      sessionPath: "/tmp/sess-grow.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2000,
      contentHash: "h1",
      minedMessageOffset: 99,
      plan: { operations: [{ op: "no_op", reason: "replay" }] },
    });
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, "already checkpointed");
    assert.equal(
      getSourceSessionCheckpoint(db, "sess-grow")!.minedMessageOffset,
      7,
    );
  });
});
