/**
 * Parent session lifecycle helpers: pin workspace, surface run notifications.
 */

import type { DatabaseSync } from "node:sqlite";
import { consumeOneUnreportedMemoryRun } from "../shared/memory-run-claim.ts";
import { markMemoryDreamCompleted } from "./memory-cadence.ts";

/**
 * Surface at most one compact unreported dream notification.
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
      markMemoryDreamCompleted(db, {
        nowMs: Number.isFinite(finishedAtMs) ? finishedAtMs : Date.now(),
      });
    },
  });
  if (!run) return null;
  if (run.status === "completed") {
    return {
      message: `Dream completed (run ${run.id}, ${run.trigger}).`,
      level: "info",
    };
  }
  return {
    message: `Dream failed (run ${run.id}): ${run.errorText ?? "unknown error"}`,
    level: "warning",
  };
}
