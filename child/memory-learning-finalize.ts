/**
 * Child-owned bookkeeping after a memory learning run.
 * Per-session commits own checkpoints. Finalization releases the claim and
 * removes temporary run state only after durable terminal bookkeeping,
 * including the post-ingestion maintenance recompute: completion coverage is
 * held to the last inspect-time batch (persisted by memory_inspect_graph), so
 * every candidate the learner was shown must be covered, dissolved, or
 * rejected for compaction. Candidates born only of the post-ingestion
 * recompute are not a failure — they persist and the maintenance-only launcher
 * picks them up at the next agent_settled.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { getSourceSessionCheckpoint } from "../shared/memory-repository.ts";
import { finalizeMemoryRun } from "../shared/memory-run-claim.ts";
import { readMemoryLearningManifest } from "../shared/memory-session-discovery.ts";
import {
  getMemoryMaintenanceAttempts,
  planMemoryMaintenance,
  readMemoryLastMaintenanceInspect,
} from "../shared/memory-maintenance.ts";
import { MEMORY_MAINTENANCE_MAX_ATTEMPTS } from "../shared/memory-types.ts";
import { memoryWorkspaceLastInspectPath } from "../shared/memory-workspace-id.ts";

export interface FinalizeMemoryLearningRunInput {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  workspaceId: string;
  config: MemoryWorkspaceConfig;
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
 * Verify every manifest session was checkpointed from its exact immutable
 * snapshot. An empty manifest is valid only in maintenance mode (zero-session
 * maintenance-only runs); the maintenance coverage check decides validity.
 */
function findMemoryCheckpointCompletionError(
  db: DatabaseSync,
  manifestPath: string,
): string | null {
  const entries = readMemoryLearningManifest(manifestPath);
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
  return `Memory learning left ${uncheckpointed.length} manifest session(s) uncheckpointed`;
}

/**
 * Post-ingestion maintenance coverage: recompute the plan against the final DB
 * state and hold the learner to the last inspect-time batch. A candidate is
 * covered when it is no longer jointly eligible (merged, promoted, or dissolved
 * by a supersede/conflict/retire); a still-eligible candidate below the
 * fallback bound fails the run loudly. Recompute-born candidates (resurfaced
 * cold siblings, post-reset cold creates, reshuffled pairs) are not checked.
 */
export async function findMemoryMaintenanceCoverageError(
  db: DatabaseSync,
  runId: string,
  workspaceId: string,
  config: MemoryWorkspaceConfig,
): Promise<string | null> {
  const persisted = readMemoryLastMaintenanceInspect(
    memoryWorkspaceLastInspectPath(workspaceId),
  );
  if (!persisted || persisted.runId !== runId) {
    return null; // No inspect happened in this run: no maintenance obligation.
  }

  // Recompute needs the embedder for pairing; an unavailable embedder degrades
  // pairing (score 0) but never aborts the coverage check.
  const plan = await planMemoryMaintenance(db, { config });

  const plannedKeys = new Set<string>([
    ...plan.promotes.map((p) => p.key),
    ...plan.merges.map((m) => m.key),
  ]);
  const outstanding: string[] = [];
  const persistedKeys = [
    ...persisted.merges.map((m) => m.key),
    ...persisted.promotes.map((p) => p.key),
  ];
  for (const key of persistedKeys) {
    if (!plannedKeys.has(key)) continue; // covered or dissolved
    const attempts = getMemoryMaintenanceAttempts(db, key);
    if (attempts >= MEMORY_MAINTENANCE_MAX_ATTEMPTS) continue; // fallback bound reached
    outstanding.push(key);
  }
  if (outstanding.length === 0) return null;
  return `Memory maintenance left ${outstanding.length} candidate(s) outstanding (attempt counters below the fallback bound): ${outstanding.join(", ")}`;
}

/**
 * Finalize a learner: checkpoint coverage for non-empty manifests, then the
 * post-ingestion maintenance recompute coverage, then release the claim.
 * Retains the run directory when terminal bookkeeping cannot be written.
 */
export async function finalizeMemoryLearningRun(
  input: FinalizeMemoryLearningRunInput,
): Promise<FinalizeMemoryLearningRunResult> {
  let errorText = input.errorText ?? null;
  if (!errorText) {
    try {
      errorText = findMemoryCheckpointCompletionError(
        input.db,
        input.manifestPath,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory learning manifest verification failed: ${detail}`;
    }
  }
  if (!errorText) {
    try {
      errorText = await findMemoryMaintenanceCoverageError(
        input.db,
        input.runId,
        input.workspaceId,
        input.config,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      errorText = `Memory maintenance coverage check failed: ${detail}`;
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
