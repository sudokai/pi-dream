/**
 * Detached memory dreamer child extension entry.
 * Registers internal dreamer tools and finalizes the run on agent_settled
 * (after retries and compaction have finished). Finalization is async and
 * awaited: the DB closes only after the post-ingestion consolidation recompute
 * settles.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import {
  openMemoryDatabaseAtPath,
  closeMemoryDatabase,
} from "../shared/memory-database.ts";
import {
  markMemoryRunRunning,
  releaseMemoryRunClaim,
} from "../shared/memory-run-claim.ts";
import { registerMemoryDreamTools } from "./memory-dream-tools.ts";
import { finalizeMemoryDreamRun } from "./memory-dream-finalize.ts";
import {
  defaultMemoryWorkspaceConfig,
  loadMemoryWorkspaceConfig,
} from "../shared/memory-config.ts";
import { memoryWorkspaceConfigPath } from "../shared/memory-workspace-id.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Memory dreamer missing required env ${name}`);
  }
  return v.trim();
}

export default function memoryDreamChildExtension(pi: ExtensionAPI) {
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

  // The parent never launches a run with an invalid config (fail-closed), so
  // defaults here are purely defensive.
  const loaded = loadMemoryWorkspaceConfig(
    memoryWorkspaceConfigPath(workspaceId),
  );
  const config = loaded.ok ? loaded.config : defaultMemoryWorkspaceConfig();

  registerMemoryDreamTools(pi, {
    db,
    runId,
    workspaceId,
    manifestPath,
    cwd,
    config,
  });

  let finalized = false;
  pi.on("agent_settled", () => {
    if (finalized) return;
    finalized = true;
    void (async () => {
      try {
        await finalizeMemoryDreamRun({
          db,
          runId,
          manifestPath,
          workspaceId,
          config,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`Memory dreamer finalization failed: ${detail}`);
        try {
          releaseMemoryRunClaim(db, runId, detail);
        } catch {
          // Claim release is best-effort after finalization failure.
        }
      } finally {
        closeMemoryDatabase(db);
      }
    })();
  });
}
