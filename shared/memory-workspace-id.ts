/**
 * Workspace identity and data paths for adaptive memory.
 *
 * Resolve order: canonical `origin` URL → `git rev-parse --git-common-dir` → cwd.
 * Format: `sha256(source)[:12]_safeName`.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  MEMORY_STORAGE_ROOT_ENV,
  MEMORY_PI_SESSION_DIR_ENV,
} from "./memory-types.ts";
import { ensureMemorySecureDir } from "./memory-fs.ts";

/** Environment flag for the pi sessions root (tests only). */
export const MEMORY_SESSIONS_ROOT_ENV = "PI_DREAM_SESSIONS_ROOT";

/** Root of pi session JSONL transcripts. */
export function memorySessionsRoot(): string {
  const testOverride = process.env[MEMORY_SESSIONS_ROOT_ENV];
  if (testOverride && testOverride.trim()) {
    return path.resolve(testOverride.trim());
  }
  const piOverride = process.env[MEMORY_PI_SESSION_DIR_ENV];
  if (piOverride && piOverride.trim()) {
    return path.resolve(
      piOverride.trim().replace(/^~(?=$|[\\/])/, os.homedir()),
    );
  }
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/** Resolve real cwd when possible; never throws. */
export function normalizeMemoryCwd(cwd: string): string {
  try {
    return realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Collapse SSH/HTTPS forge remotes to a stable host/path key.
 * Strips `.git`, trailing slashes; lowercases host + path.
 */
export function canonicalizeMemoryRemote(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let host = "";
  let repoPath = "";

  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  const sshUrl = trimmed.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/i);
  const httpsUrl = trimmed.match(/^https?:\/\/([^/]+)\/(.+)$/i);

  if (httpsUrl) {
    host = httpsUrl[1]!;
    repoPath = httpsUrl[2]!;
  } else if (sshUrl) {
    host = sshUrl[1]!;
    repoPath = sshUrl[2]!;
  } else if (scp && !trimmed.includes("://")) {
    host = scp[1]!;
    repoPath = scp[2]!;
  } else {
    return null;
  }

  repoPath = repoPath.replace(/\/+$/, "").replace(/\.git$/i, "");
  host = host.toLowerCase();
  repoPath = repoPath.toLowerCase();

  if (!host || !repoPath) return null;
  return `${host}/${repoPath}`;
}

function safeNameFromSource(source: string): string {
  const base = path.basename(source.replace(/\/+$/, "")) || "workspace";
  const cleaned = base
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "workspace";
}

function hash12(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

function gitStdout(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Process-lifetime caches — remotes/cwds are stable within an agent session. */
const workspaceIdCache = new Map<string, string>();
const gitRepoCache = new Map<string, boolean>();

/**
 * Resolve a stable workspace id for `cwd`.
 * On total failure, falls back to a cwd-based id (never throws).
 */
export function resolveMemoryWorkspaceId(cwd: string): string {
  const normalized = normalizeMemoryCwd(cwd);
  const cached = workspaceIdCache.get(normalized);
  if (cached) return cached;

  let id: string;
  const origin = gitStdout(normalized, ["remote", "get-url", "origin"]);
  if (origin) {
    const canonical = canonicalizeMemoryRemote(origin);
    if (canonical) {
      id = `${hash12(canonical)}_${safeNameFromSource(canonical)}`;
      workspaceIdCache.set(normalized, id);
      return id;
    }
  }

  const commonDir = gitStdout(normalized, ["rev-parse", "--git-common-dir"]);
  if (commonDir) {
    const absCommon = path.isAbsolute(commonDir)
      ? normalizeMemoryCwd(commonDir)
      : normalizeMemoryCwd(path.resolve(normalized, commonDir));
    id = `${hash12(absCommon)}_${safeNameFromSource(absCommon)}`;
    workspaceIdCache.set(normalized, id);
    return id;
  }

  id = `${hash12(normalized)}_${safeNameFromSource(normalized)}`;
  workspaceIdCache.set(normalized, id);
  return id;
}

/** Whether `cwd` is inside a git working tree. */
export function isMemoryGitRepo(cwd: string): boolean {
  const normalized = normalizeMemoryCwd(cwd);
  const cached = gitRepoCache.get(normalized);
  if (cached !== undefined) return cached;
  const result =
    gitStdout(normalized, ["rev-parse", "--is-inside-work-tree"]) === "true";
  gitRepoCache.set(normalized, result);
  return result;
}

/** Root directory for all Dream workspace stores. */
export function memoryStorageRoot(): string {
  const override = process.env[MEMORY_STORAGE_ROOT_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".pi", "agent", "dream");
}

/** Per-workspace data directory: `.../dream/<workspaceId>/`. */
export function memoryWorkspaceDataDir(workspaceId: string): string {
  return path.join(memoryStorageRoot(), workspaceId);
}

/** Canonical SQLite path for a workspace. */
export function memoryWorkspaceDbPath(workspaceId: string): string {
  return path.join(memoryWorkspaceDataDir(workspaceId), "memory.db");
}

/** Workspace config.json path. */
export function memoryWorkspaceConfigPath(workspaceId: string): string {
  return path.join(memoryWorkspaceDataDir(workspaceId), "config.json");
}

/** Directory for temporary dream-run manifests. */
export function memoryWorkspaceRunsDir(workspaceId: string): string {
  return path.join(memoryWorkspaceDataDir(workspaceId), "runs");
}

/** Ensure the workspace data directory exists with restrictive permissions. */
export function ensureMemoryWorkspaceDataDir(workspaceId: string): string {
  const dir = memoryWorkspaceDataDir(workspaceId);
  ensureMemorySecureDir(dir);
  return dir;
}

/**
 * Encode cwd the way pi names session directories.
 * Matches `getDefaultSessionDirPath`: strip leading `/` or `\`, then `/`, `\`, `:` → `-`.
 */
export function encodeMemorySessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface MemorySessionFileInfo {
  path: string;
  mtimeMs: number;
  cwd: string;
  sessionId: string | null;
}

/** Read the session header `cwd` (and optional id) from the first JSONL lines. */
export function readMemorySessionHeader(
  filePath: string,
): { cwd: string; sessionId: string | null } | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const chunk = Buffer.allocUnsafe(8 * 1024);
    const decoder = new StringDecoder("utf8");
    let buffered = "";

    const bytesRead = readSync(fd, chunk, 0, chunk.length, 0);
    if (bytesRead === 0) return null;
    buffered = decoder.write(chunk.subarray(0, bytesRead)) + decoder.end();

    for (const line of buffered.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as {
          type?: string;
          cwd?: string;
          id?: string;
        };
        if (
          entry.type === "session" &&
          typeof entry.cwd === "string" &&
          entry.cwd
        ) {
          return {
            cwd: entry.cwd,
            sessionId: typeof entry.id === "string" ? entry.id : null,
          };
        }
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // close failures on header reads are non-fatal
      }
    }
  }
}

function collectJsonlFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

/** Worktree paths for the repo containing `cwd` (including main). */
export function listMemoryGitWorktreePaths(cwd: string): string[] {
  const normalized = normalizeMemoryCwd(cwd);
  const out = gitStdout(normalized, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

export interface ListMemorySessionOptions {
  /**
   * When true (default), also scan all session dirs for other checkouts of the
   * same workspace id. When false, only current cwd + worktree encoded dirs.
   */
  includeForeignClones?: boolean;
}

/**
 * List session JSONL files whose header cwd resolves to `workspaceId`.
 */
export function listMemoryWorkspaceSessionFiles(
  cwd: string,
  workspaceId: string,
  opts: ListMemorySessionOptions = {},
): MemorySessionFileInfo[] {
  const includeForeignClones = opts.includeForeignClones !== false;
  const targetId = workspaceId;
  const byPath = new Map<string, MemorySessionFileInfo>();
  const git = isMemoryGitRepo(cwd);
  const normalizedCwd = normalizeMemoryCwd(cwd);

  const addFile = (
    filePath: string,
    headerCwd: string,
    mtimeMs: number,
    sessionId: string | null,
  ): void => {
    if (byPath.has(filePath)) return;
    byPath.set(filePath, {
      path: filePath,
      mtimeMs,
      cwd: headerCwd,
      sessionId,
    });
  };

  const considerFile = (filePath: string): void => {
    if (byPath.has(filePath)) return;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      return;
    }
    const header = readMemorySessionHeader(filePath);
    if (!header) return;

    const sessionDirName = path.basename(path.dirname(filePath));
    const headerCwd = normalizeMemoryCwd(header.cwd);
    if (sessionDirName !== encodeMemorySessionDirName(headerCwd)) {
      return;
    }

    if (!git) {
      if (headerCwd !== normalizedCwd) return;
    } else if (resolveMemoryWorkspaceId(header.cwd) !== targetId) {
      return;
    }

    addFile(filePath, header.cwd, mtimeMs, header.sessionId);
  };

  const hintCwds = new Set<string>([normalizedCwd]);
  if (git) {
    for (const wt of listMemoryGitWorktreePaths(cwd)) {
      hintCwds.add(normalizeMemoryCwd(wt));
    }
  }
  const hintDirNames = new Set<string>();
  const sessionsRoot = memorySessionsRoot();
  for (const hint of hintCwds) {
    const dirName = encodeMemorySessionDirName(hint);
    hintDirNames.add(dirName);
    const dir = path.join(sessionsRoot, dirName);
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    collectJsonlFiles(dir, files);
    for (const f of files) considerFile(f);
  }

  if (includeForeignClones && git && existsSync(sessionsRoot)) {
    let topEntries: import("node:fs").Dirent[] = [];
    try {
      topEntries = readdirSync(sessionsRoot, { withFileTypes: true });
    } catch {
      topEntries = [];
    }
    const allowedForeignCwds = new Set<string>();
    for (const wt of listMemoryGitWorktreePaths(cwd)) {
      allowedForeignCwds.add(normalizeMemoryCwd(wt));
    }
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      if (hintDirNames.has(entry.name)) continue;
      const dir = path.join(sessionsRoot, entry.name);
      const files: string[] = [];
      collectJsonlFiles(dir, files);
      if (files.length === 0) continue;
      let dirMatches = false;
      for (const f of files) {
        const header = readMemorySessionHeader(f);
        if (!header) continue;
        const headerCwd = normalizeMemoryCwd(header.cwd);
        if (entry.name !== encodeMemorySessionDirName(headerCwd)) continue;
        if (!allowedForeignCwds.has(headerCwd)) continue;
        dirMatches = resolveMemoryWorkspaceId(header.cwd) === targetId;
        break;
      }
      if (!dirMatches) continue;
      for (const f of files) considerFile(f);
    }
  }

  return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Max mtime among sessions used for cadence “transcript advanced” checks.
 * Scopes to cwd + worktree session dirs only (cheap on every settle).
 */
export function maxMemoryWorkspaceSessionMtimeMs(
  cwd: string,
  workspaceId: string,
): number | null {
  const files = listMemoryWorkspaceSessionFiles(cwd, workspaceId, {
    includeForeignClones: false,
  });
  if (files.length === 0) return null;
  let max = files[0]!.mtimeMs;
  for (const f of files) {
    if (f.mtimeMs > max) max = f.mtimeMs;
  }
  return max;
}

/** Clear process-lifetime caches (tests only). */
export function clearMemoryWorkspaceIdCaches(): void {
  workspaceIdCache.clear();
  gitRepoCache.clear();
}
