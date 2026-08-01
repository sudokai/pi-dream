/**
 * Automatic learning cadence: turns + elapsed time + transcript advancement.
 * Evaluated on agent_settled.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  getMemoryWorkspaceState,
  updateMemoryCadenceState,
} from "../shared/memory-repository.ts";
import { hasMemoryLearningEligibleSession } from "../shared/memory-session-discovery.ts";
import { hasMemoryMaintenanceCandidates } from "../shared/memory-maintenance.ts";

export interface MemoryCadenceEvaluation {
  shouldLearn: boolean;
  turnsSinceLastRun: number;
  minutesSinceLastRun: number;
  transcriptAdvanced: boolean;
  reasons: string[];
}

/**
 * Update turn counter on settle and evaluate the three automatic gates.
 * Does not launch learning — caller decides.
 */
export function evaluateMemoryLearningCadence(
  db: DatabaseSync,
  input: {
    cwd: string;
    workspaceId: string;
    config: MemoryWorkspaceConfig;
    nowMs?: number;
    /** When false, skip auto (paused). */
    enabled?: boolean;
  },
): MemoryCadenceEvaluation {
  const nowMs = input.nowMs ?? Date.now();
  const enabled = input.enabled ?? input.config.enabled;

  const prior = getMemoryWorkspaceState(db);
  const turns = prior.turnsSinceLastRun + 1;
  updateMemoryCadenceState(db, { turnsSinceLastRun: turns });

  const lastRun = prior.lastSuccessfulRunAtMs;
  const minutesSince =
    lastRun > 0 ? (nowMs - lastRun) / 60_000 : Number.POSITIVE_INFINITY;

  // A global mtime watermark cannot represent capped runs: a newer processed
  // transcript would hide older uncheckpointed sessions. Check per-session
  // eligibility instead; the watermark remains diagnostic state only.
  const transcriptAdvanced = hasMemoryLearningEligibleSession(
    db,
    input.cwd,
    input.workspaceId,
  );
  // Maintenance-only mode: deterministic tree candidates replace the transcript
  // gate (pure SQL/heat — no embedder load on the interactive settle path).
  const maintenanceCandidates = hasMemoryMaintenanceCandidates(db, {
    config: input.config,
  });

  const reasons: string[] = [];
  if (!enabled) reasons.push("paused");
  if (turns < input.config.minTurns) {
    reasons.push(`turns ${turns}/${input.config.minTurns}`);
  }
  if (minutesSince < input.config.minMinutes) {
    reasons.push(
      `minutes ${minutesSince === Number.POSITIVE_INFINITY ? "∞" : minutesSince.toFixed(1)}/${input.config.minMinutes}`,
    );
  }
  if (!transcriptAdvanced && !maintenanceCandidates) {
    reasons.push("no uncheckpointed transcripts");
  }

  const shouldLearn =
    enabled &&
    turns >= input.config.minTurns &&
    minutesSince >= input.config.minMinutes &&
    (transcriptAdvanced || maintenanceCandidates);

  return {
    shouldLearn,
    turnsSinceLastRun: turns,
    minutesSinceLastRun:
      minutesSince === Number.POSITIVE_INFINITY ? -1 : minutesSince,
    transcriptAdvanced,
    reasons,
  };
}

/**
 * Reset cadence after a run completed processing: zero the turn counter,
 * record the success time, and move the transcript watermark to the highest
 * processed session mtime so the same transcript content does not retrigger
 * immediately. Failed runs leave cadence state untouched and stay retryable.
 */
export function markMemoryLearningCompleted(
  db: DatabaseSync,
  opts?: { nowMs?: number; transcriptMtimeMs?: number | null },
): void {
  const nowMs = opts?.nowMs ?? Date.now();
  const watermark =
    opts?.transcriptMtimeMs === undefined
      ? maxProcessedMemorySessionMtimeMs(db)
      : opts.transcriptMtimeMs;
  updateMemoryCadenceState(db, {
    turnsSinceLastRun: 0,
    lastSuccessfulRunAtMs: nowMs,
    lastObservedTranscriptMtimeMs: watermark,
  });
}

/** Highest processed mtime across all checkpointed source sessions. */
function maxProcessedMemorySessionMtimeMs(db: DatabaseSync): number | null {
  const row = db
    .prepare(`SELECT MAX(processed_mtime_ms) AS m FROM source_sessions`)
    .get() as { m: number | null } | undefined;
  return row && row.m !== null && row.m !== undefined ? Number(row.m) : null;
}
