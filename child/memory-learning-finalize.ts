/**
 * Child-owned bookkeeping after a memory learning run.
 * Per-session commits own checkpoints. Finalization releases the claim and
 * removes temporary run state; successful sessions remain committed after later failure.
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
 * Finalize a learner only after every manifest session is checkpointed; failures release retryable claims.
 */
export function finalizeMemoryLearningRun(
  input: FinalizeMemoryLearningRunInput,
): void {
  let errorText = input.errorText ?? null;
  if (!errorText) {
    try {
      errorText = findMemoryLearningCompletionError(input.db, input.manifestPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory learning manifest verification failed: ${detail}`;
    }
  }
  try {
    if (errorText) {
      finalizeMemoryRun(input.db, input.runId, {
        status: "failed",
        errorText,
      });
    } else {
      finalizeMemoryRun(input.db, input.runId, { status: "completed" });
    }
  } catch {
    // Finalization is best-effort so agent_end always returns.
  }
  try {
    fs.rmSync(path.dirname(input.manifestPath), {
      recursive: true,
      force: true,
    });
  } catch {
    // Finalization is best-effort so agent_end always returns.
  }
}
