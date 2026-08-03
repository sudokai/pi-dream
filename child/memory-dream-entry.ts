/**
 * Detached memory dreamer child extension entry.
 * Registers internal dreamer tools (ingestion only) and finalizes the run on
 * agent_settled after the dreamer has finished committing sessions.
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
import { MEMORY_EMBEDDING_MODEL_ID } from "../shared/memory-types.ts";
import { registerMemoryDreamTools } from "./memory-dream-tools.ts";
import { finalizeMemoryDreamRun } from "./memory-dream-finalize.ts";

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

  registerMemoryDreamTools(pi, {
    db,
    runId,
    manifestPath,
    cwd,
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
          // The launcher always sets the embedding model; the default here is
          // defensive for manually invoked children.
          embeddingModel:
            process.env.PI_DREAM_EMBEDDING_MODEL?.trim() ||
            MEMORY_EMBEDDING_MODEL_ID,
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
