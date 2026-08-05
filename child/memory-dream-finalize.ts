/**
 * Child-owned bookkeeping after a memory dream.
 * Per-session commits own checkpoints. Finalization verifies every manifest
 * session was checkpointed from its exact immutable snapshot, then releases
 * the claim and removes temporary run state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensureMemoryEmbeddings } from "../shared/memory-embedding.ts";
import {
  getSourceSessionCheckpoint,
  setMemoryEmbeddingDegradedError,
} from "../shared/memory-repository.ts";
import { finalizeMemoryRun } from "../shared/memory-run-claim.ts";
import {
  readMemoryDreamManifest,
  type MemoryDreamManifestEntry,
} from "../shared/memory-session-discovery.ts";

export interface FinalizeMemoryDreamRunInput {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  /** When set, mark failed with this error instead of completed. */
  errorText?: string | null;
  /**
   * Local embedding model id for the embeddings projection pass. The plan
   * forbids the parent's interactive first turn from loading the embedder,
   * so the dreamer child owns this pass; when unset (tests), the pass is
   * skipped entirely.
   */
  embeddingModel?: string;
}

export interface FinalizeMemoryDreamRunResult {
  finalized: boolean;
  status: "completed" | "failed" | "unchanged";
  errorText?: string | null;
  runDirRetained: boolean;
}

/**
 * Manifest sessions not yet checkpointed from their exact immutable snapshot.
 * Shared by the agent_end completion nudge (so the dreamer gets another chance
 * to finish them) and by finalize (so a genuinely incomplete run fails loudly
 * with the culprits named). An empty manifest is valid (a zero-session run).
 */
export function findUncheckpointedSessions(
  db: DatabaseSync,
  manifestPath: string,
): MemoryDreamManifestEntry[] {
  const entries = readMemoryDreamManifest(manifestPath);
  if (entries.length === 0) {
    return [];
  }
  return entries.filter((entry) => {
    const checkpoint = getSourceSessionCheckpoint(db, entry.sessionId);
    return (
      !checkpoint ||
      checkpoint.contentHash !== entry.contentHash ||
      checkpoint.processedMtimeMs < entry.mtimeMs
    );
  });
}

/** Finalize error text naming the sessions that were never checkpointed. */
export function formatMemoryDreamCheckpointError(
  uncheckpointed: MemoryDreamManifestEntry[],
): string | null {
  if (uncheckpointed.length === 0) return null;
  const ids = uncheckpointed.map((entry) => entry.sessionId).join(", ");
  return `Memory dream left ${uncheckpointed.length} manifest session(s) uncheckpointed: ${ids}`;
}

/**
 * Finalize a dreamer: checkpoint coverage, the embeddings projection pass
 * (child-owned; the parent's interactive first turn must never load the
 * embedder), then release the claim. The embedding pass is incremental
 * (unchanged content hashes are skipped) and never fails the run: an
 * unavailable embedder degrades semantic retrieval to lexical-only.
 * Retains the run directory when terminal bookkeeping cannot be written.
 */
export async function finalizeMemoryDreamRun(
  input: FinalizeMemoryDreamRunInput,
): Promise<FinalizeMemoryDreamRunResult> {
  let errorText = input.errorText ?? null;
  if (!errorText) {
    try {
      errorText = formatMemoryDreamCheckpointError(
        findUncheckpointedSessions(input.db, input.manifestPath),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory dream manifest verification failed: ${detail}`;
    }
  }

  // Embeddings projection: runs for completed and failed runs alike (memories
  // committed before a failure still need semantic indexing). Degraded or
  // failed passes are never fatal — the outcome is persisted to workspace_state
  // (embedding_degraded_error) so /memory status and the startup notice can
  // surface a silently-off semantic retriever; a later successful pass clears
  // it. The stderr log alone is not a surface: the run dir (and its
  // child.stderr.log) is deleted at finalize.
  if (input.embeddingModel) {
    try {
      const result = await ensureMemoryEmbeddings(input.db, {
        modelId: input.embeddingModel,
      });
      if (result.degraded) {
        const detail = result.error ?? "Semantic embedder unavailable";
        setMemoryEmbeddingDegradedError(input.db, detail);
        console.error(`Memory dream embedding pass degraded: ${detail}`);
      } else {
        setMemoryEmbeddingDegradedError(input.db, null);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setMemoryEmbeddingDegradedError(input.db, detail);
      console.error(`Memory dream embedding pass failed: ${detail}`);
    }
  }

  const status = errorText ? "failed" : "completed";
  const runDir = path.dirname(input.manifestPath);

  // On failure, retain the run dir (manifest + trace.jsonl + child.stderr.log)
  // so the dream is diagnosable after the fact, and point the error text at it
  // before the terminal row is written — the DB row is what the user sees. The
  // bulky session-snapshot bodies are dropped: they are copies of transcripts
  // that still live in the pi sessions dir, and retaining up to 30 per failed
  // run would leak.
  if (status === "failed") {
    for (const entry of readMemoryDreamManifest(input.manifestPath)) {
      try {
        fs.rmSync(entry.snapshotPath, { force: true });
      } catch {
        // Snapshot cleanup is best-effort; the run dir is retained regardless.
      }
    }
    if (errorText && !errorText.includes("run dir retained")) {
      errorText = `${errorText} (run dir retained for diagnosis: ${runDir})`;
    }
  }

  let finalized = false;
  try {
    finalized = finalizeMemoryRun(input.db, input.runId, {
      status,
      errorText: errorText ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `Memory dream finalizeMemoryRun failed for run ${input.runId}: ${detail}`,
    );
    finalized = false;
    if (!errorText) {
      errorText = `Memory dream finalization failed: ${detail}`;
    }
  }

  if (!finalized) {
    return {
      finalized: false,
      status: "unchanged",
      errorText: errorText ?? "Memory dream finalization failed",
      runDirRetained: true,
    };
  }

  // Completed runs delete the run dir; failed runs retained it above.
  if (status === "completed") {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
      return { finalized: true, status, errorText, runDirRetained: false };
    } catch {
      return { finalized: true, status, errorText, runDirRetained: true };
    }
  }
  return { finalized: true, status, errorText, runDirRetained: true };
}
