/**
 * Detached memory dreamer child extension entry.
 *
 * The child is spawned with no prompt and no tools; print mode fires
 * session_start unconditionally, and at that seam the extension runs the
 * deterministic mining driver (shared/memory-miner.ts), finalizes the run
 * (checkpoint coverage, the embeddings projection, claim release), and shuts
 * the process down. The driver owns the cursor and the budgets, so the model
 * is a pure function of bounded segments.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { completeMemoryModelCall } from "../shared/memory-completion.ts";
import { loadMemoryConfigForWorkspace } from "../shared/memory-config.ts";
import {
  openMemoryDatabaseAtPath,
  closeMemoryDatabase,
} from "../shared/memory-database.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
} from "../shared/memory-model.ts";
import { runMemoryDreamMining } from "../shared/memory-miner.ts";
import {
  markMemoryRunRunning,
  releaseMemoryRunClaim,
} from "../shared/memory-run-claim.ts";
import { MEMORY_EMBEDDING_MODEL_ID } from "../shared/memory-types.ts";
import { resolveMemoryWorkspaceId } from "../shared/memory-workspace-id.ts";
import { finalizeMemoryDreamRun } from "./memory-dream-finalize.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Memory dreamer missing required env ${name}`);
  }
  return v.trim();
}

/**
 * Best-effort append-only audit log of dreamer steps, written to
 * `<runDir>/trace.jsonl` (the run dir is retained on failure, so this is what
 * makes a failed dream diagnosable). Never throws; a trace write must never
 * fail a pass.
 */
function createDreamerTrace(manifestPath: string) {
  const tracePath = path.join(path.dirname(manifestPath), "trace.jsonl");
  return (event: Record<string, unknown>): void => {
    try {
      fs.appendFileSync(
        tracePath,
        JSON.stringify({ ts: Date.now(), ...event }) + "\n",
        { encoding: "utf-8", flag: "a", mode: 0o600 },
      );
    } catch {
      // Tracing is best-effort.
    }
  };
}

/** Run the deterministic mining pass, then finalize (embeddings + claim). */
async function runDetachedMemoryDream(input: {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  cwd: string;
  ctx: ExtensionContext;
}): Promise<void> {
  const { db, runId, manifestPath, cwd, ctx } = input;
  const workspaceId =
    process.env.PI_DREAM_WORKSPACE_ID?.trim() || resolveMemoryWorkspaceId(cwd);
  const configResult = loadMemoryConfigForWorkspace(workspaceId);
  if (!configResult.ok) {
    throw new Error(configResult.error);
  }
  const config = configResult.config;
  const sessionModelId = formatSessionModelId(ctx.model);
  const resolved = resolveMemoryModel(
    "dreamModel",
    config.dreamModel,
    sessionModelId,
    ctx.modelRegistry as never,
    config.dreamThinking,
  );
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  const complete = (call: {
    system: string;
    user: string;
    signal?: AbortSignal;
  }) =>
    completeMemoryModelCall(
      ctx.modelRegistry as never,
      resolved.resolved,
      call,
    );

  const result = await runMemoryDreamMining({
    db,
    runId,
    manifestPath,
    complete,
    signal: ctx.signal,
    log: createDreamerTrace(manifestPath),
  });

  const embeddingModel =
    process.env.PI_DREAM_EMBEDDING_MODEL?.trim() || MEMORY_EMBEDDING_MODEL_ID;
  const finalized = await finalizeMemoryDreamRun({
    db,
    runId,
    manifestPath,
    // The driver reports its own failure (budgets, malformed output); when
    // it succeeded, finalize verifies checkpoint coverage independently.
    errorText: result.ok ? null : result.errorText,
    embeddingModel,
  });
  if (!result.ok) {
    console.error(`Memory dream failed: ${result.errorText}`);
  } else if (!finalized.finalized) {
    console.error(
      `Memory dream finalized with status ${finalized.status}: ${finalized.errorText ?? "unknown"}`,
    );
  }
}

export default function memoryDreamChildExtension(pi: ExtensionAPI) {
  if (process.env.PI_DREAM_CHILD !== "1") {
    return;
  }

  const runId = requireEnv("PI_DREAM_RUN_ID");
  const manifestPath = requireEnv("PI_DREAM_MANIFEST");
  const dbPath = requireEnv("PI_DREAM_DB");
  const cwd = process.env.PI_DREAM_CWD ?? process.cwd();

  let db: DatabaseSync | null = null;
  try {
    db = openMemoryDatabaseAtPath(dbPath);
    markMemoryRunRunning(db, runId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Memory dreamer failed to open DB: ${detail}`);
    const failureReason = `Memory dreamer failed to open DB: ${detail}`;
    try {
      if (db) {
        releaseMemoryRunClaim(db, runId, failureReason);
        closeMemoryDatabase(db);
      } else {
        const failDb = openMemoryDatabaseAtPath(dbPath);
        try {
          releaseMemoryRunClaim(failDb, runId, failureReason);
        } finally {
          closeMemoryDatabase(failDb);
        }
      }
    } catch (releaseErr) {
      const releaseDetail =
        releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      console.error(
        `Memory dreamer could not release claim ${runId}: ${releaseDetail}`,
      );
    }
    return;
  }

  let started = false;
  const start = (ctx: ExtensionContext): void => {
    if (started) return;
    started = true;
    void (async () => {
      try {
        await runDetachedMemoryDream({
          db: db!,
          runId,
          manifestPath,
          cwd,
          ctx,
        });
      } catch (err) {
        // A driver throw (model resolution, config, infrastructure) still
        // finalizes so bookkeeping stays consistent: failure backoff, the
        // embeddings projection, and the retained run dir for diagnosis.
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`Memory dream failed: ${detail}`);
        const embeddingModel =
          process.env.PI_DREAM_EMBEDDING_MODEL?.trim() ||
          MEMORY_EMBEDDING_MODEL_ID;
        try {
          await finalizeMemoryDreamRun({
            db: db!,
            runId,
            manifestPath,
            errorText: detail,
            embeddingModel,
          });
        } catch (finalizeErr) {
          const releaseDetail =
            finalizeErr instanceof Error
              ? finalizeErr.message
              : String(finalizeErr);
          console.error(`Memory dream finalization failed: ${releaseDetail}`);
          try {
            releaseMemoryRunClaim(db!, runId, detail);
          } catch {
            // Claim release is best-effort after finalization failure.
          }
        }
      } finally {
        try {
          closeMemoryDatabase(db);
        } catch {
          // Close failures are non-fatal at shutdown.
        }
        try {
          ctx.shutdown();
        } catch {
          process.exit(0);
        }
      }
    })();
  };

  // Print mode fires session_start unconditionally even with no prompt; the
  // ctx there carries the model registry and shutdown. agent_settled is a
  // backstop for runtimes that only deliver a registry ctx at the agent seam.
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("agent_settled", (_event, ctx) => start(ctx));
}
