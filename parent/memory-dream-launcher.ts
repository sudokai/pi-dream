/**
 * Detached dreamer launch: claim, manifest, spawn, unref.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  acquireMemoryRunClaim,
  isMemoryRunTerminal,
  releaseMemoryRunClaim,
} from "../shared/memory-run-claim.ts";
import {
  buildMemoryDreamManifest,
  writeMemoryDreamManifest,
} from "../shared/memory-session-discovery.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import {
  buildMemoryDreamerSpawnArgs,
  getMemoryPiInvocation,
} from "../shared/pi-process-invocation.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import {
  ensureMemoryWorkspaceDataDir,
  memoryWorkspaceDbPath,
  memoryWorkspaceRunsDir,
} from "../shared/memory-workspace-id.ts";
import { ensureMemorySecureDir } from "../shared/memory-fs.ts";

export interface LaunchMemoryDreamInput {
  db: DatabaseSync;
  cwd: string;
  workspaceId: string;
  config: MemoryWorkspaceConfig;
  trigger: "auto" | "manual";
  modelRegistry: MemoryModelRegistryLike;
  currentSessionModel?: { provider?: string; id?: string } | null;
}

export type LaunchMemoryDreamResult =
  | { ok: true; runId: string; sessionCount: number }
  | { ok: false; reason: string };

/**
 * Acquire claim, snapshot eligible sessions, write manifest, spawn detached dreamer.
 * On child spawn/exit failure, mark the active dream failed and release its claim.
 * Launching never consumes cadence state; it resets only when the run completes.
 */
export function launchMemoryDreamRun(
  input: LaunchMemoryDreamInput,
): LaunchMemoryDreamResult {
  const sessionModelId = formatSessionModelId(input.currentSessionModel);
  const resolved = resolveMemoryModel(
    "dreamModel",
    input.config.dreamModel,
    sessionModelId,
    input.modelRegistry,
    input.config.dreamThinking,
  );
  if (!resolved.ok) {
    return { ok: false, reason: resolved.error };
  }

  const claim = acquireMemoryRunClaim(input.db, input.trigger, {
    model: resolved.resolved.modelId,
  });
  if (!claim.acquired || !claim.runId) {
    return {
      ok: false,
      reason: claim.reason ?? "could not acquire dream claim",
    };
  }
  const runId = claim.runId;

  let runDir: string | undefined;
  try {
    ensureMemoryWorkspaceDataDir(input.workspaceId);
    runDir = path.join(memoryWorkspaceRunsDir(input.workspaceId), runId);
    ensureMemorySecureDir(runDir);
    // Snapshot every eligible session into the run dir at discovery time so
    // the detached dreamer mines immutable bytes, not live appends.
    const manifest = buildMemoryDreamManifest(
      input.db,
      input.cwd,
      input.workspaceId,
      { snapshotDir: runDir },
    );
    if (manifest.length === 0) {
      releaseMemoryRunClaim(input.db, runId, "No eligible sessions to dream");
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Run dir cleanup is best-effort.
      }
      return { ok: false, reason: "no eligible sessions" };
    }

    const manifestPath = path.join(runDir, "manifest.json");
    writeMemoryDreamManifest(manifestPath, manifest);

    const dbPath = memoryWorkspaceDbPath(input.workspaceId);
    const stderrPath = path.join(runDir, "child.stderr.log");
    const { args, env } = buildMemoryDreamerSpawnArgs({
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      dbPath,
      manifestPath,
      runId,
      dreamModel: resolved.resolved.modelId,
      dreamThinking: resolved.resolved.thinking,
      embeddingModel: input.config.embeddingModel,
    });

    const invocation = getMemoryPiInvocation(args);
    const stderrFd = fs.openSync(stderrPath, "a", 0o600);
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
    });
    fs.closeSync(stderrFd);

    const releaseMemoryDreamRunAfterChildExit = (reason: string): void => {
      let freshDb: DatabaseSync | null = null;
      try {
        freshDb = openMemoryDatabaseAtPath(dbPath);
        if (isMemoryRunTerminal(freshDb, runId)) {
          return;
        }
        releaseMemoryRunClaim(freshDb, runId, reason);
      } catch {
        // Claim release is best-effort after child process failure.
      } finally {
        closeMemoryDatabase(freshDb);
      }
    };
    child.once("error", () => {
      releaseMemoryDreamRunAfterChildExit(
        "Failed to spawn memory dreamer process",
      );
    });
    child.once("exit", (code, signal) => {
      releaseMemoryDreamRunAfterChildExit(
        `Memory dreamer exited before finalization (code=${code ?? "null"}, signal=${signal ?? "none"})`,
      );
    });
    child.unref();

    return { ok: true, runId, sessionCount: manifest.length };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      releaseMemoryRunClaim(input.db, runId, detail);
    } catch {
      // Claim release is best-effort after launch failure.
    }
    if (runDir) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Temporary run dir cleanup is best-effort.
      }
    }
    return { ok: false, reason: detail };
  }
}
