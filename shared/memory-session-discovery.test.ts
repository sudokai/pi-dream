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
import {
  buildMemoryDreamManifest,
  hasMemoryDreamEligibleSession,
  readMemoryDreamManifest,
  writeMemoryDreamManifest,
} from "./memory-session-discovery.ts";
import { loadDecodedMemorySession } from "./memory-session-decode.ts";
import {
  commitMemoryDreamSession,
  getSourceSessionCheckpoint,
} from "./memory-repository.ts";
import { listActiveMemories } from "./memory-graph.ts";
import {
  encodeMemorySessionDirName,
  MEMORY_SESSIONS_ROOT_ENV,
  normalizeMemoryCwd,
} from "./memory-workspace-id.ts";

function withSessionRoot(fn: (root: string) => void): void {
  const prev = process.env[MEMORY_SESSIONS_ROOT_ENV];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-sessions-"));
  process.env[MEMORY_SESSIONS_ROOT_ENV] = root;
  try {
    fn(root);
  } finally {
    if (prev === undefined) {
      delete process.env[MEMORY_SESSIONS_ROOT_ENV];
    } else {
      process.env[MEMORY_SESSIONS_ROOT_ENV] = prev;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeSessionFile(
  sessionsRoot: string,
  cwd: string,
  lines: string[],
): string {
  // Discovery encodes the normalized (realpath) cwd as the session dir name.
  const dir = path.join(
    sessionsRoot,
    encodeMemorySessionDirName(normalizeMemoryCwd(cwd)),
  );
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "session.jsonl");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

test("manifest snapshots sessions at discovery; live appends are not mined", () => {
  withSessionRoot((root) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cwd-"));
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-snap-"));
    const db = openMemoryDatabaseAtPath(":memory:");
    try {
      const livePath = writeSessionFile(root, cwd, [
        JSON.stringify({ type: "session", id: "sess-1", cwd }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "first" },
        }),
      ]);

      const manifest = buildMemoryDreamManifest(db, cwd, "ws-any", {
        snapshotDir,
      });
      assert.equal(manifest.length, 1);
      const entry = manifest[0]!;
      assert.equal(entry.sessionId, "sess-1");
      assert.equal(entry.sessionPath, livePath);
      assert.notEqual(entry.snapshotPath, livePath);
      assert.match(entry.contentHash, /^[0-9a-f]{64}$/);

      // Live file keeps being appended while the dreamer would run: the
      // snapshot still reflects exactly the discovery-time content.
      fs.appendFileSync(
        livePath,
        `${JSON.stringify({
          type: "message",
          message: { role: "user", content: "second" },
        })}\n`,
        "utf8",
      );
      const snapshot = loadDecodedMemorySession(entry.snapshotPath);
      assert.equal(snapshot.messages.length, 1);
      const live = loadDecodedMemorySession(livePath);
      assert.equal(live.messages.length, 2);

      // Manifest round-trips with snapshot + hash intact.
      const manifestPath = path.join(snapshotDir, "manifest.json");
      writeMemoryDreamManifest(manifestPath, manifest);
      assert.deepEqual(readMemoryDreamManifest(manifestPath), manifest);
    } finally {
      closeMemoryDatabase(db);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});

test("readMemoryDreamManifest fails closed on entries without snapshots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-manifest-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "sess-1",
            sessionPath: "/tmp/s1.jsonl",
            cwd: "/tmp",
            mtimeMs: 1,
          },
        ],
      }),
      "utf8",
    );
    assert.throws(() => readMemoryDreamManifest(manifestPath), /snapshot/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("capped manifests leave older checkpoint-missing sessions eligible", () => {
  withSessionRoot((root) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cwd-"));
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-snap-"));
    const db = openMemoryDatabaseAtPath(":memory:");
    try {
      const dir = path.join(
        root,
        encodeMemorySessionDirName(normalizeMemoryCwd(cwd)),
      );
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 31; i++) {
        const filePath = path.join(dir, `session-${i}.jsonl`);
        fs.writeFileSync(
          filePath,
          [
            JSON.stringify({ type: "session", id: `session-${i}`, cwd }),
            JSON.stringify({
              type: "message",
              message: { role: "user", content: `message ${i}` },
            }),
          ].join("\n") + "\n",
          "utf8",
        );
        fs.utimesSync(filePath, 1_000 + i, 1_000 + i);
      }

      const manifest = buildMemoryDreamManifest(db, cwd, "ws-any", {
        cap: 30,
        snapshotDir,
      });
      assert.equal(manifest.length, 30);
      const claim = acquireMemoryRunClaim(db, "manual");
      for (const entry of manifest) {
        commitMemoryDreamSession(db, {
          runId: claim.runId!,
          sourceSessionId: entry.sessionId,
          sessionPath: entry.sessionPath,
          cwd: entry.cwd,
          processedMtimeMs: entry.mtimeMs,
          contentHash: entry.contentHash,
          minedMessageOffset: 1,
          plan: { operations: [{ op: "no_op", reason: "batch checkpoint" }] },
        });
      }

      assert.equal(
        hasMemoryDreamEligibleSession(db, cwd, "ws-any"),
        true,
        "the session outside the newest-first cap remains eligible",
      );
    } finally {
      closeMemoryDatabase(db);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});

test("content changes under a preserved mtime are still discovered", () => {
  withSessionRoot((root) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cwd-"));
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-snap-"));
    const db = openMemoryDatabaseAtPath(":memory:");
    try {
      const filePath = writeSessionFile(root, cwd, [
        JSON.stringify({ type: "session", id: "sess-1", cwd }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "first" },
        }),
      ]);
      const mtimeMs = 1234;
      fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

      const claim = acquireMemoryRunClaim(db, "manual");
      const v1Hash = createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
      commitMemoryDreamSession(db, {
        runId: claim.runId!,
        sourceSessionId: "sess-1",
        sessionPath: filePath,
        cwd,
        processedMtimeMs: mtimeMs,
        contentHash: v1Hash,
        minedMessageOffset: 1,
        plan: { operations: [{ op: "no_op", reason: "checkpoint" }] },
      });

      assert.equal(hasMemoryDreamEligibleSession(db, cwd, "ws-any"), false);
      assert.equal(
        buildMemoryDreamManifest(db, cwd, "ws-any", { snapshotDir }).length,
        0,
      );

      // Rewrite the transcript with different bytes but the SAME mtime:
      // the mtime gate alone must not hide the change.
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({ type: "session", id: "sess-1", cwd }),
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "second" },
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

      assert.equal(
        hasMemoryDreamEligibleSession(db, cwd, "ws-any"),
        true,
        "a same-mtime content change must remain eligible",
      );
      const manifest = buildMemoryDreamManifest(db, cwd, "ws-any", {
        snapshotDir,
      });
      assert.equal(manifest.length, 1);
      assert.equal(manifest[0]!.sessionId, "sess-1");
      assert.notEqual(manifest[0]!.contentHash, v1Hash);

      // Identical bytes under the preserved mtime stay skipped.
      commitMemoryDreamSession(db, {
        runId: claim.runId!,
        sourceSessionId: "sess-1",
        sessionPath: filePath,
        cwd,
        processedMtimeMs: mtimeMs,
        contentHash: manifest[0]!.contentHash,
        minedMessageOffset: 1,
        plan: { operations: [{ op: "no_op", reason: "recheckpoint" }] },
      });
      assert.equal(hasMemoryDreamEligibleSession(db, cwd, "ws-any"), false);
      assert.equal(
        buildMemoryDreamManifest(db, cwd, "ws-any", { snapshotDir }).length,
        0,
      );
    } finally {
      closeMemoryDatabase(db);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});

test("same snapshot content is never re-mined even when the live mtime advances", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    const r1 = commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "sess-1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1000,
      contentHash: "h1",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "X is Y",
            memoryText: "X is Y",
          },
        ],
      },
    });
    assert.equal(r1.applied, true);

    // A later run sees the same bytes but a newer live mtime: the snapshot
    // hash is authoritative, so the commit must be a no-op.
    const r2 = commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "sess-1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 2000,
      contentHash: "h1",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "X is Y",
            memoryText: "X is Y",
          },
        ],
      },
    });
    assert.equal(r2.applied, false);
    assert.equal(r2.reason, "already checkpointed");
    assert.equal(
      getSourceSessionCheckpoint(db, "sess-1")!.processedMtimeMs,
      2000,
      "a same-hash replay advances only the source mtime checkpoint",
    );
    assert.equal(listActiveMemories(db).length, 1);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a partial checkpoint stays eligible and the manifest resumes at its cursor", () => {
  withSessionRoot((root) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cwd-"));
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-snap-"));
    const db = openMemoryDatabaseAtPath(":memory:");
    try {
      const livePath = writeSessionFile(root, cwd, [
        JSON.stringify({ type: "session", id: "sess-1", cwd }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "one" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "two" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "three" },
        }),
      ]);
      const claim = acquireMemoryRunClaim(db, "manual");
      const bytes = fs.readFileSync(livePath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const mtime = fs.statSync(livePath).mtimeMs;
      // Partial mine of the same snapshot: cursor 1 of 3 visible messages.
      commitMemoryDreamSession(db, {
        runId: claim.runId!,
        sourceSessionId: "sess-1",
        sessionPath: livePath,
        cwd,
        processedMtimeMs: mtime,
        contentHash: hash,
        minedMessageOffset: 1,
        totalMessages: 3,
        plan: { operations: [{ op: "no_op", reason: "partial progress" }] },
      });

      const manifest = buildMemoryDreamManifest(db, cwd, "ws-any", {
        snapshotDir,
      });
      assert.equal(
        manifest.length,
        1,
        "a partial checkpoint must keep the session eligible",
      );
      assert.equal(
        manifest[0]!.minedMessageOffset,
        1,
        "the next dream resumes at the partial cursor",
      );
      assert.equal(
        hasMemoryDreamEligibleSession(db, cwd, "ws-any"),
        true,
        "eligibility check agrees with the manifest",
      );

      // Finishing the session (cursor reaches the total) retires it from
      // discovery under the same mtime and hash.
      commitMemoryDreamSession(db, {
        runId: claim.runId!,
        sourceSessionId: "sess-1",
        sessionPath: livePath,
        cwd,
        processedMtimeMs: mtime,
        contentHash: hash,
        minedMessageOffset: 3,
        totalMessages: 3,
        plan: { operations: [{ op: "no_op", reason: "done" }] },
      });
      const after = buildMemoryDreamManifest(db, cwd, "ws-any", {
        snapshotDir,
      });
      assert.equal(
        after.length,
        0,
        "fully mined session is no longer eligible",
      );
    } finally {
      closeMemoryDatabase(db);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});

test("manifest entries carry the incremental cursor from the prior checkpoint", () => {
  withSessionRoot((root) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cwd-"));
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-snap-"));
    const db = openMemoryDatabaseAtPath(":memory:");
    try {
      const filePath = writeSessionFile(root, cwd, [
        JSON.stringify({ type: "session", id: "sess-1", cwd }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "first" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "second" },
        }),
      ]);
      const mtimeMs = 1000;
      fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
      const claim = acquireMemoryRunClaim(db, "manual");
      const v1Hash = createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
      commitMemoryDreamSession(db, {
        runId: claim.runId!,
        sourceSessionId: "sess-1",
        sessionPath: filePath,
        cwd,
        processedMtimeMs: mtimeMs,
        contentHash: v1Hash,
        minedMessageOffset: 2,
        plan: { operations: [{ op: "no_op", reason: "checkpoint" }] },
      });

      // The session grows: a new manifest must resume from the stored
      // cursor (message 2), never re-mine the already-mined prefix.
      fs.appendFileSync(
        filePath,
        `${JSON.stringify({
          type: "message",
          message: { role: "user", content: "third" },
        })}\n`,
        "utf8",
      );
      fs.utimesSync(filePath, 2000 / 1000, 2000 / 1000);
      const manifest = buildMemoryDreamManifest(db, cwd, "ws-any", {
        snapshotDir,
      });
      assert.equal(manifest.length, 1);
      assert.equal(manifest[0]!.minedMessageOffset, 2);

      // The cursor survives the manifest round-trip.
      const manifestPath = path.join(snapshotDir, "manifest.json");
      writeMemoryDreamManifest(manifestPath, manifest);
      assert.equal(
        readMemoryDreamManifest(manifestPath)[0]!.minedMessageOffset,
        2,
      );

      // A fresh store (no checkpoint) starts a first-ever mine at message 0.
      const db2 = openMemoryDatabaseAtPath(":memory:", {});
      try {
        const manifest2 = buildMemoryDreamManifest(db2, cwd, "ws-any", {
          snapshotDir,
        });
        assert.equal(manifest2.length, 1);
        assert.equal(manifest2[0]!.minedMessageOffset, 0);
      } finally {
        closeMemoryDatabase(db2);
      }
    } finally {
      closeMemoryDatabase(db);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });
});

test("v2 manifests without a cursor default to a full re-mine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-manifest-v2-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        sessions: [
          {
            sessionId: "sess-1",
            sessionPath: "/tmp/s1.jsonl",
            snapshotPath: "/tmp/snap.jsonl",
            cwd: "/tmp",
            mtimeMs: 1,
            contentHash: "h1",
          },
        ],
      }),
      "utf8",
    );
    assert.equal(
      readMemoryDreamManifest(manifestPath)[0]!.minedMessageOffset,
      0,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
