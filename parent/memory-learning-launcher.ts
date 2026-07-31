/**
 * Detached learner launch: claim, manifest, spawn, unref.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  acquireMemoryRunClaim,
  releaseMemoryRunClaim,
} from "../shared/memory-run-claim.ts";
import {
  buildMemoryLearningManifest,
  writeMemoryLearningManifest,
} from "../shared/memory-session-discovery.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import {
  buildMemoryLearnerSpawnArgs,
  getMemoryPiInvocation,
} from "../shared/pi-process-invocation.ts";
import {
  ensureMemoryWorkspaceDataDir,
  memoryWorkspaceDbPath,
  memoryWorkspaceRunsDir,
} from "../shared/memory-workspace-id.ts";

export interface LaunchMemoryLearningInput {
  db: DatabaseSync;
  cwd: string;
  workspaceId: string;
  config: MemoryWorkspaceConfig;
  trigger: "auto" | "manual";
  modelRegistry: MemoryModelRegistryLike;
  currentSessionModel?: { provider?: string; id?: string } | null;
}

export type LaunchMemoryLearningResult =
  | { ok: true; runId: string; sessionCount: number }
  | { ok: false; reason: string };

/**
 * Acquire claim, snapshot eligible sessions, write manifest, spawn detached learner.
 * On child spawn/exit failure, mark the active run failed and release its claim.
 * Launching never consumes cadence state; it resets only when the run completes.
 */
export function launchMemoryLearningRun(
  input: LaunchMemoryLearningInput,
): LaunchMemoryLearningResult {
  const sessionModelId = formatSessionModelId(input.currentSessionModel);
  const resolved = resolveMemoryModel(
    "learningModel",
    input.config.learningModel,
    sessionModelId,
    input.modelRegistry,
    input.config.learningThinking,
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
      reason: claim.reason ?? "could not acquire learning claim",
    };
  }
  const runId = claim.runId;

  let runDir: string | undefined;
  try {
    ensureMemoryWorkspaceDataDir(input.workspaceId);
    runDir = path.join(memoryWorkspaceRunsDir(input.workspaceId), runId);
    fs.mkdirSync(runDir, { recursive: true });
    // Snapshot every eligible session into the run dir at discovery time so
    // the detached learner mines immutable bytes, not live appends.
    const manifest = buildMemoryLearningManifest(
      input.db,
      input.cwd,
      input.workspaceId,
      { snapshotDir: runDir },
    );
    if (manifest.length === 0) {
      releaseMemoryRunClaim(input.db, runId, "No eligible sessions to learn");
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Run dir cleanup is best-effort.
      }
      return { ok: false, reason: "no eligible sessions" };
    }

    const manifestPath = path.join(runDir, "manifest.json");
    writeMemoryLearningManifest(manifestPath, manifest);

    const dbPath = memoryWorkspaceDbPath(input.workspaceId);
    const { args, env } = buildMemoryLearnerSpawnArgs({
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      dbPath,
      manifestPath,
      runId,
      learningModel: resolved.resolved.modelId,
      learningThinking: resolved.resolved.thinking,
    });

    const invocation = getMemoryPiInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const releaseMemoryLearningRunAfterChildExit = (reason: string): void => {
      try {
        // This changes only a still claimed/running run; a child that finalized
        // successfully remains completed when its process exits normally.
        releaseMemoryRunClaim(input.db, runId, reason);
      } catch {
        // Claim release is best-effort after child process failure.
      }
      if (runDir) {
        try {
          fs.rmSync(runDir, { recursive: true, force: true });
        } catch {
          // Temporary run dir cleanup is best-effort.
        }
      }
    };
    child.once("error", () => {
      releaseMemoryLearningRunAfterChildExit(
        "Failed to spawn memory learner process",
      );
    });
    child.once("exit", (code, signal) => {
      releaseMemoryLearningRunAfterChildExit(
        `Memory learner exited before finalization (code=${code ?? "null"}, signal=${signal ?? "none"})`,
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
