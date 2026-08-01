/**
 * Child-owned bookkeeping after a memory dream.
 * Per-session commits own checkpoints. Finalization releases the claim and
 * removes temporary run state only after durable terminal bookkeeping,
 * including the post-ingestion consolidation recompute: completion coverage is
 * held to the last inspect-time batch (persisted by memory_inspect_graph), so
 * every candidate the dreamer was shown must be covered, dissolved, or
 * rejected for compaction. Candidates born only of the post-ingestion
 * recompute are not a failure — they persist and a dream-only run
 * picks them up at the next agent_settled.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { getSourceSessionCheckpoint } from "../shared/memory-repository.ts";
import { finalizeMemoryRun } from "../shared/memory-run-claim.ts";
import { readMemoryDreamManifest } from "../shared/memory-session-discovery.ts";
import {
  getMemoryConsolidationAttempts,
  planMemoryConsolidation,
  readMemoryLastConsolidationInspect,
} from "../shared/memory-consolidation.ts";
import { MEMORY_CONSOLIDATION_MAX_ATTEMPTS } from "../shared/memory-types.ts";
import { memoryWorkspaceLastInspectPath } from "../shared/memory-workspace-id.ts";

export interface FinalizeMemoryDreamRunInput {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  workspaceId: string;
  config: MemoryWorkspaceConfig;
  /** When set, mark failed with this error instead of completed. */
  errorText?: string | null;
}

export interface FinalizeMemoryDreamRunResult {
  finalized: boolean;
  status: "completed" | "failed" | "unchanged";
  errorText?: string | null;
  runDirRetained: boolean;
}

/**
 * Verify every manifest session was checkpointed from its exact immutable
 * snapshot. An empty manifest is valid only in consolidation mode (zero-session
 * dream-only runs); the consolidation coverage check decides validity.
 */
function findMemoryCheckpointCompletionError(
  db: DatabaseSync,
  manifestPath: string,
): string | null {
  const entries = readMemoryDreamManifest(manifestPath);
  if (entries.length === 0) {
    return null;
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
  return `Memory dream left ${uncheckpointed.length} manifest session(s) uncheckpointed`;
}

/**
 * Post-ingestion consolidation coverage: recompute the plan against the final DB
 * state and hold the dreamer to the last inspect-time batch. A candidate is
 * covered when it is no longer jointly eligible (merged, promoted, or dissolved
 * by a supersede/conflict/retire), or when it was rejected for compaction
 * during this run (recorded by memory_commit_consolidation — partial progress is
 * a pass state). A still-eligible candidate with no covering op and no in-run
 * rejection fails the run loudly while its attempt counter is below the
 * fallback bound (catching a genuinely broken dreamer). Recompute-born
 * candidates (resurfaced cold siblings, post-reset cold creates, reshuffled
 * pairs) are not checked.
 */
export async function findMemoryConsolidationCoverageError(
  db: DatabaseSync,
  runId: string,
  workspaceId: string,
  config: MemoryWorkspaceConfig,
): Promise<string | null> {
  const persisted = readMemoryLastConsolidationInspect(
    memoryWorkspaceLastInspectPath(workspaceId),
  );
  if (!persisted || persisted.runId !== runId) {
    return null; // No inspect happened in this run: no consolidation obligation.
  }

  // Recompute needs the embedder for pairing; an unavailable embedder degrades
  // pairing (score 0) but never aborts the coverage check.
  const plan = await planMemoryConsolidation(db, { config });

  const plannedKeys = new Set<string>([
    ...plan.promotes.map((p) => p.key),
    ...plan.merges.map((m) => m.key),
  ]);
  // Candidates rejected for compaction during THIS run (recorded by
  // memory_commit_consolidation) are an acceptable completion state: the plan's
  // completion rules pass "rejected for compaction (attempt counter
  // incremented; partial progress)". Only candidates with no covering op and
  // no in-run rejection are outstanding — the loud-failure case.
  const rejectedInRun = new Set(persisted.rejectedKeys ?? []);
  const outstanding: string[] = [];
  const persistedKeys = [
    ...persisted.merges.map((m) => m.key),
    ...persisted.promotes.map((p) => p.key),
  ];
  for (const key of persistedKeys) {
    if (!plannedKeys.has(key)) continue; // covered or dissolved
    if (rejectedInRun.has(key)) continue; // compaction-rejected this run
    const attempts = getMemoryConsolidationAttempts(db, key);
    if (attempts >= MEMORY_CONSOLIDATION_MAX_ATTEMPTS) continue; // fallback bound reached
    outstanding.push(key);
  }
  if (outstanding.length === 0) return null;
  return `Memory consolidation left ${outstanding.length} candidate(s) outstanding (no covering op in this run, attempt counters below the fallback bound): ${outstanding.join(", ")}`;
}

/**
 * Finalize a dreamer: checkpoint coverage for non-empty manifests, then the
 * post-ingestion consolidation recompute coverage, then release the claim.
 * Retains the run directory when terminal bookkeeping cannot be written.
 */
export async function finalizeMemoryDreamRun(
  input: FinalizeMemoryDreamRunInput,
): Promise<FinalizeMemoryDreamRunResult> {
  let errorText = input.errorText ?? null;
  if (!errorText) {
    try {
      errorText = findMemoryCheckpointCompletionError(
        input.db,
        input.manifestPath,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory dream manifest verification failed: ${detail}`;
    }
  }
  if (!errorText) {
    try {
      errorText = await findMemoryConsolidationCoverageError(
        input.db,
        input.runId,
        input.workspaceId,
        input.config,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory consolidation coverage check failed: ${detail}`;
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
