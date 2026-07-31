/**
 * Detached memory learner child extension entry.
 * Registers internal learning tools and finalizes the run on first agent_end.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabaseAtPath, closeMemoryDatabase } from "../shared/memory-database.ts";
import { markMemoryRunRunning } from "../shared/memory-run-claim.ts";
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

  let db: DatabaseSync;
  try {
    db = openMemoryDatabaseAtPath(dbPath);
    markMemoryRunRunning(db, runId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Memory learner failed to open DB: ${detail}`);
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
  pi.on("agent_end", () => {
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
