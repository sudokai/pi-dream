/**
 * Detached memory learner child extension entry.
 * Registers internal learning tools and finalizes the run on agent_settled
 * (after retries and compaction have finished).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabaseAtPath, closeMemoryDatabase } from "../shared/memory-database.ts";
import {
  markMemoryRunRunning,
  releaseMemoryRunClaim,
} from "../shared/memory-run-claim.ts";
import { registerMemoryLearningTools } from "./memory-learning-tools.ts";
import { finalizeMemoryLearningRun } from "./memory-learning-finalize.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Memory learner missing required env ${name}`);
  }
  return v.trim();
}

export default function memoryLearningChildExtension(pi: ExtensionAPI) {
  if (process.env.PI_DREAM_CHILD !== "1") {
    return;
  }

  const workspaceId = requireEnv("PI_DREAM_WORKSPACE_ID");
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
    console.error(`Memory learner failed to open DB: ${detail}`);
    const failureReason = `Memory learner failed to open DB: ${detail}`;
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
        `Memory learner could not release claim ${runId}: ${releaseDetail}`,
      );
    }
    return;
  }

  registerMemoryLearningTools(pi, {
    db,
    runId,
    workspaceId,
    manifestPath,
    cwd,
  });

  let finalized = false;
  pi.on("agent_settled", () => {
    if (finalized) return;
    finalized = true;
    finalizeMemoryLearningRun({
      db,
      runId,
      manifestPath,
    });
    closeMemoryDatabase(db);
  });
}
