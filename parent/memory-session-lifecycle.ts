/**
 * Parent session lifecycle helpers: pin workspace, surface run notifications.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  listUnreportedMemoryRuns,
  markMemoryRunReported,
} from "../shared/memory-run-claim.ts";
import { markMemoryLearningCompleted } from "./memory-cadence.ts";

/**
 * Surface at most one compact unreported learning run notification.
 * Marks the run reported so it is not repeated. Cadence resets (turns,
 * success time, transcript watermark) only when the run completed; failed
 * runs leave cadence untouched so the work stays retryable.
 */
export function consumeMemoryRunNotification(
  db: DatabaseSync,
): { message: string; level: "info" | "warning" | "error" } | null {
  const runs = listUnreportedMemoryRuns(db);
  if (runs.length === 0) return null;
  const run = runs[0]!;
  markMemoryRunReported(db, run.id);
  if (run.status === "completed") {
    const finishedAtMs = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
    markMemoryLearningCompleted(db, {
      nowMs: Number.isFinite(finishedAtMs) ? finishedAtMs : Date.now(),
    });
    return {
      message: `Memory learning completed (run ${run.id}, ${run.trigger}).`,
      level: "info",
    };
  }
  return {
    message: `Memory learning failed (run ${run.id}): ${run.errorText ?? "unknown error"}`,
    level: "warning",
  };
}
