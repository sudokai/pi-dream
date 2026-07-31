/**
 * Child-owned bookkeeping after a memory learning run.
 * Per-session commits own checkpoints. Finalization releases the claim and
 * removes temporary run state only after durable terminal bookkeeping.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getSourceSessionCheckpoint } from "../shared/memory-repository.ts";
import { finalizeMemoryRun } from "../shared/memory-run-claim.ts";
import { readMemoryLearningManifest } from "../shared/memory-session-discovery.ts";

export interface FinalizeMemoryLearningRunInput {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  /** When set, mark failed with this error instead of completed. */
  errorText?: string | null;
}

export interface FinalizeMemoryLearningRunResult {
  finalized: boolean;
  status: "completed" | "failed" | "unchanged";
  errorText?: string | null;
  runDirRetained: boolean;
}

/**
 * Verify every manifest session was checkpointed from its exact immutable snapshot.
 * A learner that exits before all commits is failed so automatic cadence stays retryable.
 */
function findMemoryLearningCompletionError(
  db: DatabaseSync,
  manifestPath: string,
): string | null {
  const entries = readMemoryLearningManifest(manifestPath);
  if (entries.length === 0) {
    return "Memory learning completed without manifest sessions";
  }
  const uncheckpointed = entries.filter((entry) => {
    const checkpoint = getSourceSessionCheckpoint(db, entry.sessionId);
    return (
      !checkpoint ||
      checkpoint.contentHash !== entry.contentHash ||
      checkpoint.processedMtimeMs < entry.mtimeMs
    );
  });
  if (uncheckpointed.length === 0) return null;
  return `Memory learning left ${uncheckpointed.length} manifest session(s) uncheckpointed`;
}

/**
 * Finalize a learner only after every manifest session is checkpointed.
 * Retains the run directory when terminal bookkeeping cannot be written.
 */
export function finalizeMemoryLearningRun(
  input: FinalizeMemoryLearningRunInput,
): FinalizeMemoryLearningRunResult {
  let errorText = input.errorText ?? null;
  if (!errorText) {
    try {
      errorText = findMemoryLearningCompletionError(input.db, input.manifestPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory learning manifest verification failed: ${detail}`;
    }
  }

  const status = errorText ? "failed" : "completed";
  let finalized = false;
  try {
    finalized = finalizeMemoryRun(input.db, input.runId, {
      status,
      errorText: errorText ?? null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `Memory learning finalizeMemoryRun failed for run ${input.runId}: ${detail}`,
    );
    finalized = false;
    if (!errorText) {
      errorText = `Memory learning finalization failed: ${detail}`;
    }
  }

  if (!finalized) {
    return {
      finalized: false,
      status: "unchanged",
      errorText: errorText ?? "Memory learning finalization failed",
      runDirRetained: true,
    };
  }

  try {
    fs.rmSync(path.dirname(input.manifestPath), {
      recursive: true,
      force: true,
    });
    return { finalized: true, status, errorText, runDirRetained: false };
  } catch {
    return { finalized: true, status, errorText, runDirRetained: true };
  }
}
