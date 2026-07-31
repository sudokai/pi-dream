/**
 * Discover eligible workspace sessions for learning.
 * Re-exports workspace listing helpers and builds run manifests.
 *
 * Each manifest entry carries an immutable byte snapshot of the session taken
 * at discovery time plus its sha256. The detached learner reads only the
 * snapshot, so live appends made while the learner runs are never mined and
 * identical content is never re-processed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  listMemoryWorkspaceSessionFiles,
  maxMemoryWorkspaceSessionMtimeMs,
  type MemorySessionFileInfo,
} from "./memory-workspace-id.ts";
import { getSourceSessionCheckpoint } from "./memory-repository.ts";
import { parseMemoryJsonlLine } from "./memory-session-decode.ts";
import type { SourceSessionRow } from "./memory-types.ts";

export {
  listMemoryWorkspaceSessionFiles,
  maxMemoryWorkspaceSessionMtimeMs,
  type MemorySessionFileInfo,
};

export interface MemoryLearningManifestEntry {
  sessionId: string;
  /** Live session file path (recorded in the checkpoint for provenance). */
  sessionPath: string;
  /** Immutable snapshot of the session file taken at manifest creation. */
  snapshotPath: string;
  cwd: string;
  mtimeMs: number;
  /** sha256 of the snapshot bytes at discovery time. */
  contentHash: string;
}

/** Copy a session file into the run dir as an immutable snapshot. */
function snapshotSessionFile(
  filePath: string,
  snapshotDir: string,
  index: number,
  sessionId: string,
): { snapshotPath: string; contentHash: string } | null {
  const safeId =
    sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64) || "session";
  const snapshotPath = path.join(
    snapshotDir,
    `session-${index}-${safeId}.jsonl`,
  );
  try {
    const bytes = fs.readFileSync(filePath);
    fs.writeFileSync(snapshotPath, bytes);
    return {
      snapshotPath,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

/** sha256 of a session file's bytes, or null when unreadable. */
function hashSessionFile(filePath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Whether a session still needs learning, judged by checkpoint state.
 * A newer mtime wins without hashing (the common append case). When the
 * mtime is not newer, the stored content hash is the tiebreaker: changed
 * bytes with a preserved mtime must still be discovered, while identical
 * bytes stay skipped. Legacy checkpoints without a content hash fall back
 * to the mtime gate alone.
 */
function isSessionCheckpointCurrent(
  checkpoint: SourceSessionRow | null,
  file: MemorySessionFileInfo,
): boolean {
  if (!checkpoint) return false;
  if (checkpoint.processedMtimeMs < file.mtimeMs) return false;
  if (checkpoint.contentHash === null) return true;
  const currentHash = hashSessionFile(file.path);
  return currentHash !== null && currentHash === checkpoint.contentHash;
}

/**
 * Build a list of sessions eligible for mining: missing checkpoint, newer mtime,
 * or content that differs from the checkpoint hash (even under a preserved mtime).
 * Each entry carries an immutable byte snapshot + content hash taken now, so the
 * learner processes exactly this point-in-time content (never live appends).
 * Files that cannot be snapshotted are skipped.
 */
export function buildMemoryLearningManifest(
  db: DatabaseSync,
  cwd: string,
  workspaceId: string,
  opts: { cap?: number; snapshotDir: string },
): MemoryLearningManifestEntry[] {
  const cap = opts.cap ?? 30;
  const files = listMemoryWorkspaceSessionFiles(cwd, workspaceId, {
    includeForeignClones: true,
  });
  const eligible: MemoryLearningManifestEntry[] = [];

  for (const file of files) {
    if (eligible.length >= cap) break;
    const sessionId = resolveMemoryLearningSessionId(file);
    const checkpoint = getSourceSessionCheckpoint(db, sessionId);
    if (isSessionCheckpointCurrent(checkpoint, file)) {
      continue;
    }
    const snap = snapshotSessionFile(
      file.path,
      opts.snapshotDir,
      eligible.length,
      sessionId,
    );
    if (!snap) continue;
    eligible.push({
      sessionId,
      sessionPath: file.path,
      snapshotPath: snap.snapshotPath,
      cwd: file.cwd,
      mtimeMs: file.mtimeMs,
      contentHash: snap.contentHash,
    });
  }
  return eligible;
}

/** Resolve the source-session id used consistently for eligibility and checkpoints. */
function resolveMemoryLearningSessionId(file: MemorySessionFileInfo): string {
  return (
    file.sessionId ??
    deriveSessionIdFromPath(file.path) ??
    path.basename(file.path, ".jsonl")
  );
}

/**
 * Return whether any workspace transcript still needs a learning checkpoint.
 * This examines every eligible source, not just the newest mtime, so capped runs
 * cannot strand older transcripts behind a global watermark. Content changes
 * under a preserved mtime are detected via the checkpoint content hash.
 */
export function hasMemoryLearningEligibleSession(
  db: DatabaseSync,
  cwd: string,
  workspaceId: string,
): boolean {
  const files = listMemoryWorkspaceSessionFiles(cwd, workspaceId, {
    includeForeignClones: true,
  });
  return files.some((file) => {
    const checkpoint = getSourceSessionCheckpoint(
      db,
      resolveMemoryLearningSessionId(file),
    );
    return !isSessionCheckpointCurrent(checkpoint, file);
  });
}

function deriveSessionIdFromPath(filePath: string): string | null {
  // Try reading header id if not already present
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString("utf8");
      for (const line of text.split("\n")) {
        const entry = parseMemoryJsonlLine(line);
        if (entry?.type === "session" && typeof entry.id === "string") {
          return entry.id;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable session files are treated as missing ids.
  }
  return null;
}

/** Write a run manifest JSON file. */
export function writeMemoryLearningManifest(
  manifestPath: string,
  entries: MemoryLearningManifestEntry[],
): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ version: 2, sessions: entries }, null, 2)}\n`,
    "utf-8",
  );
}

/** Read a run manifest JSON file. */
export function readMemoryLearningManifest(
  manifestPath: string,
): MemoryLearningManifestEntry[] {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    version?: number;
    sessions?: Array<Partial<MemoryLearningManifestEntry>>;
  };
  if (!Array.isArray(parsed.sessions)) {
    throw new Error(`Invalid memory learning manifest: ${manifestPath}`);
  }
  for (const s of parsed.sessions) {
    if (typeof s.snapshotPath !== "string" || typeof s.contentHash !== "string") {
      throw new Error(
        `Invalid memory learning manifest (missing snapshot): ${manifestPath}`,
      );
    }
  }
  return parsed.sessions as MemoryLearningManifestEntry[];
}
