/**
 * Single-flight learning-run claims stored in the learning_runs table.
 * Stale claimed/running rows can be recovered after MEMORY_STALE_RUN_MS.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_STALE_RUN_MS,
  type LearningRunStatus,
  type LearningRunTrigger,
} from "./memory-types.ts";

export interface MemoryRunClaimResult {
  acquired: boolean;
  runId: string | null;
  reason?: string;
}

function newRunId(nowMs: number): string {
  return `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Acquire a single-flight claim for this workspace database.
 * Marks any stale claimed/running row as failed, then inserts a new claimed run.
 */
export function acquireMemoryRunClaim(
  db: DatabaseSync,
  trigger: LearningRunTrigger,
  opts?: { nowMs?: number; model?: string | null; staleMs?: number },
): MemoryRunClaimResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? MEMORY_STALE_RUN_MS;

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return { acquired: false, runId: null, reason: "lock busy" };
  }

  try {
    const active = db
      .prepare(
        `SELECT id, started_at, status FROM learning_runs
         WHERE status IN ('claimed', 'running')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as
      | { id: string; started_at: string; status: LearningRunStatus }
      | undefined;

    if (active) {
      const startedAtMs = Date.parse(active.started_at);
      if (Number.isFinite(startedAtMs) && nowMs - startedAtMs < staleMs) {
        db.exec("ROLLBACK");
        return { acquired: false, runId: null, reason: "running" };
      }
      // Stale: mark failed so a new claim can proceed.
      db.prepare(
        `UPDATE learning_runs
         SET status = 'failed',
             finished_at = ?,
             error_text = 'Stale learning run recovered'
         WHERE id = ? AND status IN ('claimed', 'running')`,
      ).run(new Date(nowMs).toISOString(), active.id);
    }

    const runId = newRunId(nowMs);
    db.prepare(
      `INSERT INTO learning_runs (id, trigger, model, status, started_at, reported_to_parent)
       VALUES (?, ?, ?, 'claimed', ?, 0)`,
    ).run(
      runId,
      trigger,
      opts?.model ?? null,
      new Date(nowMs).toISOString(),
    );
    db.exec("COMMIT");
    return { acquired: true, runId };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/** Transition a claimed run to running (child start). */
export function markMemoryRunRunning(
  db: DatabaseSync,
  runId: string,
): void {
  db.prepare(
    `UPDATE learning_runs SET status = 'running' WHERE id = ? AND status = 'claimed'`,
  ).run(runId);
}

/**
 * Finalize a run as completed or failed.
 * Only updates when the run still owns claimed/running status (or force).
 */
export function finalizeMemoryRun(
  db: DatabaseSync,
  runId: string,
  outcome: { status: "completed" | "failed"; errorText?: string | null },
): boolean {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return false;
  }
  try {
    const row = db
      .prepare(`SELECT status FROM learning_runs WHERE id = ?`)
      .get(runId) as { status: string } | undefined;
    if (!row || (row.status !== "claimed" && row.status !== "running")) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(
      `UPDATE learning_runs
       SET status = ?,
           finished_at = ?,
           error_text = ?
       WHERE id = ?`,
    ).run(outcome.status, new Date().toISOString(), outcome.errorText ?? null, runId);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/**
 * Release/fail a claim when spawn fails before the child starts.
 * Matching run id only.
 */
export function releaseMemoryRunClaim(
  db: DatabaseSync,
  runId: string,
  errorText?: string,
): void {
  finalizeMemoryRun(db, runId, {
    status: "failed",
    errorText: errorText ?? "Learning run released before completion",
  });
}

/** Unreported completed/failed runs for parent notification. */
export function listUnreportedMemoryRuns(db: DatabaseSync): Array<{
  id: string;
  status: "completed" | "failed";
  errorText: string | null;
  trigger: LearningRunTrigger;
  finishedAt: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT id, status, error_text, trigger, finished_at
       FROM learning_runs
       WHERE reported_to_parent = 0 AND status IN ('completed', 'failed')
       ORDER BY finished_at ASC, id ASC`,
    )
    .all() as Array<{
    id: string;
    status: "completed" | "failed";
    error_text: string | null;
    trigger: LearningRunTrigger;
    finished_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    errorText: r.error_text,
    trigger: r.trigger,
    finishedAt: r.finished_at,
  }));
}

/** Mark a run as reported to the parent UI. */
export function markMemoryRunReported(db: DatabaseSync, runId: string): void {
  db.prepare(
    `UPDATE learning_runs SET reported_to_parent = 1 WHERE id = ?`,
  ).run(runId);
}

/** Atomically claim one unreported terminal run for parent notification. */
export function consumeOneUnreportedMemoryRun(
  db: DatabaseSync,
  opts?: {
    /**
     * Runs inside the same BEGIN IMMEDIATE transaction after the run is
     * claimed (`reported_to_parent=1`) and before COMMIT. Use for cadence
     * reset so a crash cannot leave the run reported without side effects.
     */
    beforeCommit?: (run: {
      id: string;
      status: "completed" | "failed";
      errorText: string | null;
      trigger: LearningRunTrigger;
      finishedAt: string | null;
    }) => void;
  },
): {
  id: string;
  status: "completed" | "failed";
  errorText: string | null;
  trigger: LearningRunTrigger;
  finishedAt: string | null;
} | null {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    // Lock busy: nothing claimed; caller may retry on a later tick.
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT id, status, error_text, trigger, finished_at
         FROM learning_runs
         WHERE reported_to_parent = 0 AND status IN ('completed', 'failed')
         ORDER BY finished_at ASC, id ASC
         LIMIT 1`,
      )
      .get() as
      | {
          id: string;
          status: "completed" | "failed";
          error_text: string | null;
          trigger: LearningRunTrigger;
          finished_at: string | null;
        }
      | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      return null;
    }
    const updated = db
      .prepare(
        `UPDATE learning_runs SET reported_to_parent = 1
         WHERE id = ? AND reported_to_parent = 0`,
      )
      .run(row.id);
    if (Number(updated.changes) !== 1) {
      db.exec("ROLLBACK");
      return null;
    }
    const run = {
      id: row.id,
      status: row.status,
      errorText: row.error_text,
      trigger: row.trigger,
      finishedAt: row.finished_at,
    };
    opts?.beforeCommit?.(run);
    db.exec("COMMIT");
    return run;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}

/** Whether a run has reached a terminal state. */
export function isMemoryRunTerminal(
  db: DatabaseSync,
  runId: string,
): boolean {
  const row = db
    .prepare(`SELECT status FROM learning_runs WHERE id = ?`)
    .get(runId) as { status: string } | undefined;
  return row?.status === "completed" || row?.status === "failed";
}

/** Active (non-stale) claimed/running run id, if any. */
export function activeMemoryRunId(
  db: DatabaseSync,
  opts?: { nowMs?: number; staleMs?: number },
): string | null {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? MEMORY_STALE_RUN_MS;
  const row = db
    .prepare(
      `SELECT id, started_at FROM learning_runs
       WHERE status IN ('claimed', 'running')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as { id: string; started_at: string } | undefined;
  if (!row) return null;
  const startedAtMs = Date.parse(row.started_at);
  if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs > staleMs) {
    return null;
  }
  return row.id;
}

/** Whether this runId currently owns the workspace claim. */
export function memoryRunOwnsClaim(db: DatabaseSync, runId: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM learning_runs
       WHERE id = ? AND status IN ('claimed', 'running')`,
    )
    .get(runId) as { id: string } | undefined;
  return !!row;
}
