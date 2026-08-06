/**
 * Repository reads and atomic dream commits with invariant validation.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  formatMemoryNodeId,
  MEMORY_MAX_TEXT_CHARS,
  normalizeMemoryBodyText,
  parseMemoryNodeId,
  validateMemoryBodyText,
  type MemoryDreamCommitInput,
  type MemoryDreamerOperation,
  type MemoryKnowledgeKind,
  type SourceSessionRow,
  type WorkspaceStateRow,
} from "./memory-types.ts";
import {
  deleteMemoryEmbeddings,
  deleteMemorySearchDocument,
  upsertMemorySearchDocument,
} from "./memory-database.ts";
import { getMemoryActivityGeneration, getMemoryById } from "./memory-graph.ts";
import { memoryRunOwnsClaim } from "./memory-run-claim.ts";
import { normalizeMemoryCwd } from "./memory-workspace-id.ts";

/** Current workspace state row — cadence counters plus recall-capacity and embedding-degradation failures (created at store init). */
export function getMemoryWorkspaceState(db: DatabaseSync): WorkspaceStateRow {
  const r = db
    .prepare(
      `SELECT activity_generation, turns_since_last_run, last_successful_run_at_ms,
              last_observed_transcript_mtime_ms, recall_capacity_error,
              embedding_degraded_error, last_failed_run_at_ms, updated_at
       FROM workspace_state WHERE id = 1`,
    )
    .get() as Record<string, unknown>;
  return {
    activityGeneration: Number(r.activity_generation),
    turnsSinceLastRun: Number(r.turns_since_last_run),
    lastSuccessfulRunAtMs: Number(r.last_successful_run_at_ms),
    lastFailedRunAtMs: Number(r.last_failed_run_at_ms ?? 0),
    lastObservedTranscriptMtimeMs:
      r.last_observed_transcript_mtime_ms === null ||
      r.last_observed_transcript_mtime_ms === undefined
        ? null
        : Number(r.last_observed_transcript_mtime_ms),
    recallCapacityError:
      r.recall_capacity_error === null || r.recall_capacity_error === undefined
        ? null
        : String(r.recall_capacity_error),
    embeddingDegradedError:
      r.embedding_degraded_error === null ||
      r.embedding_degraded_error === undefined
        ? null
        : String(r.embedding_degraded_error),
    updatedAt: String(r.updated_at),
  };
}

/** Patch the cadence counters in the workspace state row: turns since last run, last successful run, last failed run, last observed transcript mtime. */
export function updateMemoryCadenceState(
  db: DatabaseSync,
  patch: {
    turnsSinceLastRun?: number;
    lastSuccessfulRunAtMs?: number;
    lastFailedRunAtMs?: number;
    lastObservedTranscriptMtimeMs?: number | null;
  },
): void {
  const current = getMemoryWorkspaceState(db);
  db.prepare(
    `UPDATE workspace_state
     SET turns_since_last_run = ?,
         last_successful_run_at_ms = ?,
         last_failed_run_at_ms = ?,
         last_observed_transcript_mtime_ms = ?,
         updated_at = datetime('now')
     WHERE id = 1`,
  ).run(
    patch.turnsSinceLastRun ?? current.turnsSinceLastRun,
    patch.lastSuccessfulRunAtMs ?? current.lastSuccessfulRunAtMs,
    patch.lastFailedRunAtMs ?? current.lastFailedRunAtMs,
    patch.lastObservedTranscriptMtimeMs === undefined
      ? current.lastObservedTranscriptMtimeMs
      : patch.lastObservedTranscriptMtimeMs,
  );
}

/** Record a failed dream for cadence backoff (auto dreaming waits minMinutes after the last failure too). */
export function markMemoryDreamFailure(
  db: DatabaseSync,
  nowMs: number = Date.now(),
): void {
  updateMemoryCadenceState(db, { lastFailedRunAtMs: nowMs });
}

/** Persist the provider-context capacity failure for /memory status; null clears it. */
export function setMemoryRecallCapacityError(
  db: DatabaseSync,
  error: string | null,
): void {
  db.prepare(
    `UPDATE workspace_state SET recall_capacity_error = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(error);
}

/**
 * Persist the last dream's embedding-pass degradation for /memory status and
 * the startup notice; null clears it (a later successful pass self-heals).
 * A silently-off semantic retriever must be diagnosable from a user surface.
 */
export function setMemoryEmbeddingDegradedError(
  db: DatabaseSync,
  error: string | null,
): void {
  db.prepare(
    `UPDATE workspace_state SET embedding_degraded_error = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(error);
}

/** Checkpoint row for a mined source session (processed mtime and content hash), or null when the session has not been checkpointed. */
export function getSourceSessionCheckpoint(
  db: DatabaseSync,
  sessionId: string,
): SourceSessionRow | null {
  const r = db
    .prepare(
      `SELECT session_id, session_path, cwd, processed_mtime_ms, content_hash,
              mined_message_offset, total_messages, completed_at
       FROM source_sessions WHERE session_id = ?`,
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    sessionId: String(r.session_id),
    sessionPath: String(r.session_path),
    cwd: String(r.cwd),
    processedMtimeMs: Number(r.processed_mtime_ms),
    contentHash:
      r.content_hash === null || r.content_hash === undefined
        ? null
        : String(r.content_hash),
    minedMessageOffset: Number(r.mined_message_offset),
    totalMessages: Number(r.total_messages ?? 0),
    completedAt: String(r.completed_at),
  };
}

/** Every mutating op targets an active memory; retired memories are audit-only. */
function assertActiveMemory(db: DatabaseSync, memoryId: number): void {
  const row = getMemoryById(db, memoryId);
  if (!row)
    throw new Error(`Memory not found: ${formatMemoryNodeId(memoryId)}`);
  if (row.state !== "active") {
    throw new Error(
      `Memory ${formatMemoryNodeId(memoryId)} is ${row.state}; operation not allowed`,
    );
  }
}

/**
 * Append one immutable version row to a memory: the distilled wording, the
 * verbatim evidence quote, and the source session that produced it. The
 * version chain is the complete append-only life of a memory — nothing is
 * ever deleted or rewritten.
 */
function insertMemoryVersion(
  db: DatabaseSync,
  input: {
    memoryId: number;
    text: string;
    evidenceText: string;
    sourceSessionId: string;
    creationGeneration: number;
    previousVersionId: number | null;
  },
): number {
  const err = validateMemoryBodyText(input.text, MEMORY_MAX_TEXT_CHARS);
  if (err) throw new Error(err);
  const evidenceErr = validateMemoryBodyText(
    input.evidenceText,
    MEMORY_MAX_TEXT_CHARS,
    "Evidence text",
  );
  if (evidenceErr) throw new Error(evidenceErr);
  const result = db
    .prepare(
      `INSERT INTO memory_versions
         (memory_id, text, evidence_text, source_session_id,
          creation_generation, previous_version_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.memoryId,
      input.text.trim(),
      input.evidenceText.trim(),
      input.sourceSessionId,
      input.creationGeneration,
      input.previousVersionId,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Active memory whose normalized body text matches exactly, or null.
 * The dedupe backstop for `create`: identical wording already stored must
 * append a restatement version to the existing memory, never spawn a
 * near-duplicate node. The partial unique index
 * idx_memories_active_normalized_text enforces the invariant at the schema
 * level; this lookup routes the evidence onto the existing node so
 * recurrence stays correct by construction.
 */
function findActiveMemoryByNormalizedText(
  db: DatabaseSync,
  normalized: string,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM memories WHERE state = 'active' AND normalized_text = ?`,
    )
    .get(normalized) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

function createMemoryWithVersion(
  db: DatabaseSync,
  input: {
    kind: MemoryKnowledgeKind;
    text: string;
    evidenceText: string;
    sourceSessionId: string;
    creationGeneration: number;
  },
): number {
  const memResult = db
    .prepare(
      `INSERT INTO memories
         (kind, state, current_version_id, normalized_text, creation_generation)
       VALUES (?, 'active', NULL, ?, ?)`,
    )
    .run(
      input.kind,
      normalizeMemoryBodyText(input.text),
      input.creationGeneration,
    );
  const memoryId = Number(memResult.lastInsertRowid);
  const versionId = insertMemoryVersion(db, {
    memoryId,
    text: input.text,
    evidenceText: input.evidenceText,
    sourceSessionId: input.sourceSessionId,
    creationGeneration: input.creationGeneration,
    previousVersionId: null,
  });
  db.prepare(
    `UPDATE memories SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(versionId, memoryId);
  upsertMemorySearchDocument(db, {
    nodeType: "memory",
    nodeId: memoryId,
    text: input.text.trim(),
    kind: input.kind,
    state: "active",
  });
  return memoryId;
}

/**
 * Append a version in place (identity kept): a restatement (same wording,
 * new evidence) or a refined wording (new text), always with the verbatim
 * evidence quote and source session. The run claim serializes writers, so
 * the commit resolves the current version inside the transaction. Refreshes
 * the normalized-text projection and the search projections; a changed text
 * invalidates stale embeddings for the next projection pass.
 */
function appendMemoryVersion(
  db: DatabaseSync,
  input: {
    memoryId: number;
    text: string;
    evidenceText: string;
    sourceSessionId: string;
    creationGeneration: number;
  },
): void {
  const err = validateMemoryBodyText(input.text, MEMORY_MAX_TEXT_CHARS);
  if (err) throw new Error(err);
  const mem = getMemoryById(db, input.memoryId);
  if (!mem)
    throw new Error(`Memory not found: ${formatMemoryNodeId(input.memoryId)}`);
  const versionId = insertMemoryVersion(db, {
    memoryId: input.memoryId,
    text: input.text,
    evidenceText: input.evidenceText,
    sourceSessionId: input.sourceSessionId,
    creationGeneration: input.creationGeneration,
    previousVersionId: mem.currentVersionId,
  });
  db.prepare(
    `UPDATE memories
     SET current_version_id = ?, normalized_text = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(versionId, normalizeMemoryBodyText(input.text), input.memoryId);
  if (mem.state === "active") {
    upsertMemorySearchDocument(db, {
      nodeType: "memory",
      nodeId: input.memoryId,
      text: input.text.trim(),
      kind: mem.kind,
      state: mem.state,
    });
    // A changed text invalidates the stale embedding (all models); the next
    // embedding pass re-embeds from the fresh search_documents row. Identical
    // text keeps the row (the content hash still matches).
    if (mem.text !== input.text.trim()) {
      deleteMemoryEmbeddings(db, "memory", input.memoryId);
    }
  }
}

function applyOperation(
  db: DatabaseSync,
  op: MemoryDreamerOperation,
  ctx: {
    sourceSessionId: string;
    generation: number;
  },
): void {
  switch (op.op) {
    case "no_op":
      return;

    case "create": {
      // Active-memory dedupe backstop: a create whose normalized body text
      // already exists as an active memory appends a restatement version to
      // that memory (evidence + recurrence) instead of spawning a
      // near-duplicate node. The partial unique index enforces the invariant
      // at the schema level even if this lookup ever misses.
      const existingId = findActiveMemoryByNormalizedText(
        db,
        normalizeMemoryBodyText(op.memoryText),
      );
      if (existingId !== null) {
        appendMemoryVersion(db, {
          memoryId: existingId,
          text: getMemoryById(db, existingId)!.text,
          evidenceText: op.evidenceText,
          sourceSessionId: ctx.sourceSessionId,
          creationGeneration: ctx.generation,
        });
        return;
      }
      createMemoryWithVersion(db, {
        kind: op.kind,
        text: op.memoryText,
        evidenceText: op.evidenceText,
        sourceSessionId: ctx.sourceSessionId,
        creationGeneration: ctx.generation,
      });
      return;
    }

    case "update": {
      const parsed = parseMemoryNodeId(op.memoryId);
      if (!parsed.ok) {
        throw new Error(`update requires memory id, got ${op.memoryId}`);
      }
      assertActiveMemory(db, parsed.id);
      const mem = getMemoryById(db, parsed.id)!;
      // No memoryText = restatement: the evidence records a new session's
      // support while the wording stays put (recurrence grows). With
      // memoryText, a new version carries the refined wording in place
      // (identity kept; the old wording stays in the version chain).
      appendMemoryVersion(db, {
        memoryId: parsed.id,
        text: op.memoryText ?? mem.text,
        evidenceText: op.evidenceText,
        sourceSessionId: ctx.sourceSessionId,
        creationGeneration: ctx.generation,
      });
      return;
    }

    case "forget": {
      const parsed = parseMemoryNodeId(op.memoryId);
      if (!parsed.ok) {
        throw new Error(`forget requires memory id, got ${op.memoryId}`);
      }
      assertActiveMemory(db, parsed.id);
      // The negating evidence is recorded on the memory row: audit keeps who
      // retired it and the verbatim statement. Retirement is retrieval
      // exclusion only — versions, evidence, and the row itself are
      // preserved; only the search projections are dropped.
      const evidenceErr = validateMemoryBodyText(
        op.evidenceText,
        MEMORY_MAX_TEXT_CHARS,
        "Evidence text",
      );
      if (evidenceErr) throw new Error(evidenceErr);
      db.prepare(
        `UPDATE memories
         SET state = 'retired', retired_by_session_id = ?,
             retired_evidence_text = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(ctx.sourceSessionId, op.evidenceText.trim(), parsed.id);
      deleteMemorySearchDocument(db, "memory", parsed.id);
      return;
    }

    default: {
      const _exhaustive: never = op;
      throw new Error(
        `Unknown dreamer operation: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Atomically commit one source session's dream plan.
 * Validates claim ownership, references, text shape; checkpoints the session.
 * Replay of an unchanged checkpoint is a no-op success.
 */
export function commitMemoryDreamSession(
  db: DatabaseSync,
  input: MemoryDreamCommitInput,
): { applied: boolean; reason?: string } {
  if (!memoryRunOwnsClaim(db, input.runId)) {
    throw new Error("Memory dream no longer owns the workspace claim");
  }

  const operations = input.plan.operations ?? [];
  // Legacy commits predate the total column: treat the cursor as fully mined.
  const totalMessages = input.totalMessages ?? input.minedMessageOffset;
  const generation = getMemoryActivityGeneration(db);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!memoryRunOwnsClaim(db, input.runId)) {
      throw new Error("Memory dream no longer owns the workspace claim");
    }

    const existing = getSourceSessionCheckpoint(db, input.sourceSessionId);
    if (existing) {
      const hashMatch =
        input.contentHash !== null &&
        existing.contentHash !== null &&
        existing.contentHash === input.contentHash;
      const mtimeNotNewer = existing.processedMtimeMs >= input.processedMtimeMs;
      if (hashMatch) {
        // A checkpoint whose cursor has not reached its recorded total is a
        // PARTIAL mine of the same snapshot: it must not short-circuit. The
        // miner resumes at the cursor and this commit applies ops and
        // advances the cursor (or records a further partial progress point).
        const fullyMined =
          existing.totalMessages <= 0 ||
          existing.minedMessageOffset >= existing.totalMessages;
        if (fullyMined) {
          db.prepare(
            `UPDATE source_sessions
             SET session_path = ?,
                 cwd = ?,
                 processed_mtime_ms = MAX(processed_mtime_ms, ?),
                 completed_at = datetime('now')
             WHERE session_id = ? AND content_hash = ?`,
          ).run(
            input.sessionPath,
            normalizeMemoryCwd(input.cwd),
            input.processedMtimeMs,
            input.sourceSessionId,
            input.contentHash,
          );
          db.exec("COMMIT");
          return { applied: false, reason: "already checkpointed" };
        }
      }
      if (
        mtimeNotNewer &&
        (input.contentHash === null || existing.contentHash === null)
      ) {
        db.exec("ROLLBACK");
        return { applied: false, reason: "already checkpointed" };
      }
    }

    for (const op of operations) {
      applyOperation(db, op, {
        sourceSessionId: input.sourceSessionId,
        generation,
      });
    }

    db.prepare(
      `INSERT INTO source_sessions
         (session_id, session_path, cwd, processed_mtime_ms, content_hash,
          mined_message_offset, total_messages, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         session_path = excluded.session_path,
         cwd = excluded.cwd,
         processed_mtime_ms = excluded.processed_mtime_ms,
         content_hash = excluded.content_hash,
         mined_message_offset = excluded.mined_message_offset,
         total_messages = excluded.total_messages,
         completed_at = datetime('now')`,
    ).run(
      input.sourceSessionId,
      input.sessionPath,
      normalizeMemoryCwd(input.cwd),
      input.processedMtimeMs,
      input.contentHash,
      input.minedMessageOffset,
      totalMessages,
    );

    db.exec("COMMIT");
    return { applied: true };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}
