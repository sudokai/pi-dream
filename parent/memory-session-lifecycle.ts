/**
 * Parent session lifecycle helpers: pin workspace, surface run notifications.
 */

import type { DatabaseSync } from "node:sqlite";
import { consumeOneUnreportedMemoryRun } from "../shared/memory-run-claim.ts";
import { markMemoryLearningCompleted } from "./memory-cadence.ts";

/**
 * Surface at most one compact unreported learning run notification.
 * Consumes the run and (on success) resets cadence in one transaction so a
 * crash cannot leave the run reported without the cooldown watermark.
 */
export function consumeMemoryRunNotification(
  db: DatabaseSync,
): { message: string; level: "info" | "warning" | "error" } | null {
  const run = consumeOneUnreportedMemoryRun(db, {
    beforeCommit: (claimed) => {
      if (claimed.status !== "completed") return;
      const finishedAtMs = claimed.finishedAt
        ? Date.parse(claimed.finishedAt)
        : NaN;
      markMemoryLearningCompleted(db, {
        nowMs: Number.isFinite(finishedAtMs) ? finishedAtMs : Date.now(),
      });
    },
  });
  if (!run) return null;
  if (run.status === "completed") {
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
