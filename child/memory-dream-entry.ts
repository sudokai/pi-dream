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
import {
  MEMORY_DREAM_MAX_NUDGES,
  MEMORY_EMBEDDING_MODEL_ID,
} from "../shared/memory-types.ts";
import { registerMemoryDreamTools } from "./memory-dream-tools.ts";
import {
  finalizeMemoryDreamRun,
  findUncheckpointedSessions,
} from "./memory-dream-finalize.ts";

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

  // Server-side completion: the dreamer sometimes settles before committing
  // every manifest session (most often the tail of a large batch). agent_end
  // is the seam where a queued follow-up is still drained by the post-run
  // loop — agent_settled fires only after that drain, so it is too late to
  // keep the run alive. Queue a targeted nudge so the model finishes the
  // remaining sessions; the budget caps the loop so a stuck run still fails
  // loudly at finalize instead of spinning forever.
  let nudgeCount = 0;
  pi.on("agent_end", () => {
    if (finalized) return;
    try {
      const uncommitted = findUncheckpointedSessions(db, manifestPath);
      if (uncommitted.length === 0) return;
      if (nudgeCount >= MEMORY_DREAM_MAX_NUDGES) return;
      nudgeCount += 1;
      const ids = uncommitted.map((entry) => entry.sessionId).join(", ");
      pi.sendUserMessage(
        `You are not finished. ${uncommitted.length} manifest session(s) are still uncommitted: ${ids}. For each one, call memory_read_session (if not yet read) then memory_commit_session — use a no_op operation when nothing durable was found. You must commit every session before stopping; do not summarize or end early.`,
        { deliverAs: "followUp" },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Memory dreamer completion nudge failed: ${detail}`);
    }
  });

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
