import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import {
  commitMemoryDreamSession,
  getMemoryWorkspaceState,
} from "../shared/memory-repository.ts";
import {
  acquireMemoryRunClaim,
  listUnreportedMemoryRuns,
} from "../shared/memory-run-claim.ts";
import { writeMemoryDreamManifest } from "../shared/memory-session-discovery.ts";
import { finalizeMemoryDreamRun } from "./memory-dream-finalize.ts";
import {
  findUncheckpointedSessions,
  formatMemoryDreamCheckpointError,
} from "./memory-dream-finalize.ts";
import {
  resetMemoryEmbedderForTests,
  setMemoryEmbedderForTests,
  type MemoryEmbedFn,
} from "../shared/memory-embedding.ts";
import { findMemoryCandidates } from "../shared/memory-retrieval.ts";

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
      minedMessageOffset: 1,
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
      manifestPath: writeDreamManifest(dir),
    });

    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.errorText ?? "", /uncheckpointed/);
    assert.match(run.errorText ?? "", /session-1/);
    assert.match(run.errorText ?? "", /run dir retained/);
    // The failed run dir is kept (manifest + trace) for diagnosis, but the
    // bulky snapshot body is dropped so retention can't leak transcripts.
    assert.equal(fs.existsSync(dir), true, "failed run dir retained");
    assert.equal(
      fs.existsSync(path.join(dir, "session.jsonl")),
      false,
      "bulky snapshot body dropped from a retained failed run",
    );
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findUncheckpointedSessions names exactly the sessions without a current checkpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-unckpt-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const snapshotPath = path.join(dir, "snap.jsonl");
    fs.writeFileSync(snapshotPath, "snapshot bytes\n", "utf-8");
    const manifestPath = path.join(dir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, [
      {
        sessionId: "s1",
        sessionPath: "/tmp/s1.jsonl",
        snapshotPath,
        cwd: "/tmp",
        mtimeMs: 100,
        contentHash: "h1",
        minedMessageOffset: 0,
      },
      {
        sessionId: "s2",
        sessionPath: "/tmp/s2.jsonl",
        snapshotPath,
        cwd: "/tmp",
        mtimeMs: 100,
        contentHash: "h2",
        minedMessageOffset: 0,
      },
      {
        sessionId: "s3",
        sessionPath: "/tmp/s3.jsonl",
        snapshotPath,
        cwd: "/tmp",
        mtimeMs: 100,
        contentHash: "h3",
        minedMessageOffset: 0,
      },
    ]);
    const claim = acquireMemoryRunClaim(db, "auto");
    // Only s2 is committed; s1 and s3 have no checkpoint.
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "h2",
      minedMessageOffset: 0,
      plan: { operations: [{ op: "no_op", reason: "nothing durable" }] },
    });

    const uncommitted = findUncheckpointedSessions(db, manifestPath);
    assert.deepEqual(
      uncommitted.map((e) => e.sessionId),
      ["s1", "s3"],
    );
    assert.equal(
      formatMemoryDreamCheckpointError(uncommitted),
      "Memory dream left 2 manifest session(s) uncheckpointed: s1, s3",
    );
    assert.equal(formatMemoryDreamCheckpointError([]), null);
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
      minedMessageOffset: 1,
      plan: { operations: [{ op: "no_op", reason: "nothing durable" }] },
    });
    assert.equal(committed.applied, true);

    await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      manifestPath,
    });

    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "completed");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty manifest is a valid run (nothing to mine completes cleanly)", async () => {
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
      manifestPath,
    });
    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "completed", "zero-session manifest is valid");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit errorText fails the run without touching checkpoints", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      manifestPath: writeDreamManifest(dir),
      errorText: "dreamer crashed mid-run",
    });
    const run = listUnreportedMemoryRuns(db)[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.errorText ?? "", /dreamer crashed mid-run/);
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize removes the run directory on success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = writeDreamManifest(dir);
    commitMemoryDreamSession(db, {
      runId: claim.runId,
      sourceSessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "snapshot-hash-1",
      minedMessageOffset: 1,
      plan: { operations: [{ op: "no_op", reason: "x" }] },
    });
    const result = await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      manifestPath,
    });
    assert.equal(result.finalized, true);
    assert.equal(result.status, "completed");
    assert.equal(result.runDirRetained, false);
    assert.equal(fs.existsSync(dir), false, "run dir removed at finalize");
  } finally {
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize maintains the embeddings projection end-to-end: committed session → rows → semantic candidates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-embed-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  // Alias embedder: "caching layer" and "abstractions at call sites" share a
  // canonical topic with no surface words in common (the semantic side the
  // lexical retriever cannot see).
  const ALIASES: Record<string, string> = {
    caching: "caching",
    layer: "caching",
    abstractions: "caching",
    call: "caching",
    sites: "caching",
  };
  const aliasEmbed: MemoryEmbedFn = (texts) =>
    Promise.resolve(
      texts.map((t) => {
        const v = new Float32Array(1);
        for (const token of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          if (ALIASES[token]) v[0] = 1;
        }
        const norm =
          Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0)) || 1;
        v[0] = v[0]! / norm;
        return v;
      }),
    );
  try {
    setMemoryEmbedderForTests(aliasEmbed, "test/minilm");
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = writeDreamManifest(dir);
    // The real ingestion path: a committed session creates the search
    // document (no embeddings yet — the parent must never embed).
    const committed = commitMemoryDreamSession(db, {
      runId: claim.runId,
      sourceSessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "snapshot-hash-1",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "user dislikes premature abstractions",
            memoryText:
              "User gets frustrated when abstractions appear before three call sites",
          },
        ],
      },
    });
    assert.equal(committed.applied, true);
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as {
          n: number;
        }
      ).n,
      0,
      "ingestion alone never embeds",
    );

    // The child's finalize runs the embedding pass (the seam production uses).
    const result = await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      manifestPath,
      embeddingModel: "test/minilm",
    });
    assert.equal(result.finalized, true);
    assert.equal(result.status, "completed");
    const rows = db
      .prepare(
        `SELECT node_id, content_hash FROM embeddings WHERE model_id = 'test/minilm'`,
      )
      .all() as Array<{ node_id: number; content_hash: string }>;
    assert.equal(rows.length, 1, "the committed memory is embedded");
    assert.equal(Number(rows[0]!.node_id), 1);

    // The semantic retriever now fires in production conditions (no injected
    // embedder — the shared loader cache serves the fake).
    const retrieval = await findMemoryCandidates(
      db,
      "add a caching layer to the API",
      { modelId: "test/minilm" },
    );
    assert.equal(retrieval.semanticDegraded, false);
    const hit = retrieval.candidates.find((c) => c.nodeId === 1);
    assert.ok(hit, "semantic-only relevance surfaces through the real path");
    assert.equal(hit!.lexicalRank, null, "no shared surface words");
    assert.ok(hit!.semanticRank !== null, "ranked by the semantic retriever");

    // A second finalize is incremental: no new rows, no re-embedding work.
    const claim2 = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim2.runId);
    const manifest2 = path.join(dir, "manifest2.json");
    writeMemoryDreamManifest(manifest2, []);
    const second = await finalizeMemoryDreamRun({
      db,
      runId: claim2.runId,
      manifestPath: manifest2,
      embeddingModel: "test/minilm",
    });
    assert.equal(second.status, "completed");
    const after = (
      db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as {
        n: number;
      }
    ).n;
    assert.equal(Number(after), 1, "unchanged content hashes are skipped");
  } finally {
    resetMemoryEmbedderForTests();
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a degraded embedding pass never fails the run", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "dream-finalize-degraded-"),
  );
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    setMemoryEmbedderForTests(null, "test/degraded");
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = writeDreamManifest(dir);
    // A real memory must exist: an empty store short-circuits the pass
    // without touching the embedder, which would not exercise the degraded
    // path at all.
    commitMemoryDreamSession(db, {
      runId: claim.runId,
      sourceSessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "snapshot-hash-1",
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
    const result = await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      manifestPath,
      embeddingModel: "test/degraded",
    });
    assert.equal(
      result.finalized,
      true,
      "an unavailable embedder must not fail the dream",
    );
    assert.equal(result.status, "completed");
    // The degradation is persisted for /memory status and the startup notice
    // (the run dir and its stderr log are deleted at finalize, so the
    // workspace_state flag is the only durable surface).
    assert.match(
      getMemoryWorkspaceState(db).embeddingDegradedError ?? "",
      /embedder disabled/,
      "the persisted detail names the load failure",
    );
  } finally {
    resetMemoryEmbedderForTests();
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a later successful embedding pass clears the persisted degradation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-finalize-heal-"));
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    // First dream: embedder unavailable → degradation persisted.
    setMemoryEmbedderForTests(null, "test/heal");
    const claim = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim.runId);
    const manifestPath = writeDreamManifest(dir);
    commitMemoryDreamSession(db, {
      runId: claim.runId,
      sourceSessionId: "session-1",
      sessionPath: "/tmp/session-1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 100,
      contentHash: "snapshot-hash-1",
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
    const first = await finalizeMemoryDreamRun({
      db,
      runId: claim.runId,
      manifestPath,
      embeddingModel: "test/heal",
    });
    assert.equal(first.status, "completed");
    assert.ok(getMemoryWorkspaceState(db).embeddingDegradedError);

    // Second dream: embedder available (cache now serves a fake) → the flag
    // self-heals exactly like recall_capacity_error.
    setMemoryEmbedderForTests(
      async (texts) => texts.map(() => new Float32Array([1])),
      "test/heal",
    );
    const claim2 = acquireMemoryRunClaim(db, "auto");
    assert.ok(claim2.runId);
    const manifest2 = path.join(dir, "manifest2.json");
    writeMemoryDreamManifest(manifest2, []);
    const second = await finalizeMemoryDreamRun({
      db,
      runId: claim2.runId,
      manifestPath: manifest2,
      embeddingModel: "test/heal",
    });
    assert.equal(second.status, "completed");
    assert.equal(getMemoryWorkspaceState(db).embeddingDegradedError, null);
  } finally {
    resetMemoryEmbedderForTests();
    closeMemoryDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
