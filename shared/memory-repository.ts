/**
 * Repository reads and atomic dream commits with invariant validation.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  formatMemoryNodeId,
  MEMORY_MAX_TEXT_CHARS,
  normalizeObservationText,
  parsePrefixedNodeId,
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
              embedding_degraded_error, updated_at
       FROM workspace_state WHERE id = 1`,
    )
    .get() as Record<string, unknown>;
  return {
    activityGeneration: Number(r.activity_generation),
    turnsSinceLastRun: Number(r.turns_since_last_run),
    lastSuccessfulRunAtMs: Number(r.last_successful_run_at_ms),
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

/** Patch the cadence counters in the workspace state row: turns since last run, last successful run, last observed transcript mtime. */
export function updateMemoryCadenceState(
  db: DatabaseSync,
  patch: {
    turnsSinceLastRun?: number;
    lastSuccessfulRunAtMs?: number;
    lastObservedTranscriptMtimeMs?: number | null;
  },
): void {
  const current = getMemoryWorkspaceState(db);
  db.prepare(
    `UPDATE workspace_state
     SET turns_since_last_run = ?,
         last_successful_run_at_ms = ?,
         last_observed_transcript_mtime_ms = ?,
         updated_at = datetime('now')
     WHERE id = 1`,
  ).run(
    patch.turnsSinceLastRun ?? current.turnsSinceLastRun,
    patch.lastSuccessfulRunAtMs ?? current.lastSuccessfulRunAtMs,
    patch.lastObservedTranscriptMtimeMs === undefined
      ? current.lastObservedTranscriptMtimeMs
      : patch.lastObservedTranscriptMtimeMs,
  );
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
      `SELECT session_id, session_path, cwd, processed_mtime_ms, content_hash, completed_at
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
    completedAt: String(r.completed_at),
  };
}

function assertActiveOrKnownMemory(
  db: DatabaseSync,
  memoryId: number,
  allowStates: string[] = ["active", "conflicted"],
): void {
  const row = getMemoryById(db, memoryId);
  if (!row)
    throw new Error(`Memory not found: ${formatMemoryNodeId(memoryId)}`);
  if (!allowStates.includes(row.state)) {
    throw new Error(
      `Memory ${formatMemoryNodeId(memoryId)} is ${row.state}; operation not allowed`,
    );
  }
}

/**
 * Insert an observation, or reuse the existing row for the same
 * (source session, normalized text). Returns the observation id
 * (inserted or pre-existing) — never null.
 */
function insertObservation(
  db: DatabaseSync,
  input: {
    kind: MemoryKnowledgeKind;
    text: string;
    sourceSessionId: string;
    creationGeneration: number;
  },
): number {
  const err = validateMemoryBodyText(input.text, MEMORY_MAX_TEXT_CHARS);
  if (err) throw new Error(err);
  const normalized = normalizeObservationText(input.text);
  try {
    const result = db
      .prepare(
        `INSERT INTO observations
           (kind, text, normalized_text, source_session_id, creation_generation)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.text.trim(),
        normalized,
        input.sourceSessionId,
        input.creationGeneration,
      );
    return Number(result.lastInsertRowid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      // Same normalized observation from this session — idempotent dedupe:
      // reuse the existing row so callers always link a real observation.
      const existing = db
        .prepare(
          `SELECT id FROM observations
           WHERE source_session_id = ? AND normalized_text = ?`,
        )
        .get(input.sourceSessionId, normalized) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    throw e;
  }
}

function linkObservation(
  db: DatabaseSync,
  memoryId: number,
  observationId: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_observations (memory_id, observation_id) VALUES (?, ?)`,
  ).run(memoryId, observationId);
}

function createMemoryWithVersion(
  db: DatabaseSync,
  input: {
    kind: MemoryKnowledgeKind;
    text: string;
    creationGeneration: number;
  },
): number {
  const err = validateMemoryBodyText(input.text, MEMORY_MAX_TEXT_CHARS);
  if (err) throw new Error(err);
  const memResult = db
    .prepare(
      `INSERT INTO memories
         (kind, state, current_version_id, creation_generation)
       VALUES (?, 'active', NULL, ?)`,
    )
    .run(input.kind, input.creationGeneration);
  const memoryId = Number(memResult.lastInsertRowid);
  const verResult = db
    .prepare(
      `INSERT INTO memory_versions (memory_id, text, previous_version_id)
       VALUES (?, ?, NULL)`,
    )
    .run(memoryId, input.text.trim());
  const versionId = Number(verResult.lastInsertRowid);
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

function reviseMemoryText(
  db: DatabaseSync,
  memoryId: number,
  text: string,
  expectedVersionId: number,
): void {
  const err = validateMemoryBodyText(text, MEMORY_MAX_TEXT_CHARS);
  if (err) throw new Error(err);
  const mem = getMemoryById(db, memoryId);
  if (!mem)
    throw new Error(`Memory not found: ${formatMemoryNodeId(memoryId)}`);
  if (!Number.isSafeInteger(expectedVersionId) || expectedVersionId <= 0) {
    throw new Error(
      `Memory ${formatMemoryNodeId(memoryId)} revision requires a positive expectedVersionId`,
    );
  }
  if (mem.currentVersionId !== expectedVersionId) {
    throw new Error(
      `Memory ${formatMemoryNodeId(memoryId)} version is stale (expected ${expectedVersionId}, have ${mem.currentVersionId})`,
    );
  }
  const verResult = db
    .prepare(
      `INSERT INTO memory_versions (memory_id, text, previous_version_id)
       VALUES (?, ?, ?)`,
    )
    .run(memoryId, text.trim(), mem.currentVersionId);
  const versionId = Number(verResult.lastInsertRowid);
  const updated = db
    .prepare(
      `UPDATE memories
       SET current_version_id = ?, updated_at = datetime('now')
       WHERE id = ? AND current_version_id = ?`,
    )
    .run(versionId, memoryId, expectedVersionId);
  if (Number(updated.changes) !== 1) {
    throw new Error(
      `Memory ${formatMemoryNodeId(memoryId)} changed while its revision was committing`,
    );
  }
  if (mem.state === "active") {
    upsertMemorySearchDocument(db, {
      nodeType: "memory",
      nodeId: memoryId,
      text: text.trim(),
      kind: mem.kind,
      state: mem.state,
    });
    // A changed text invalidates the stale embedding (all models); the next
    // embedding pass re-embeds from the fresh search_documents row. Identical
    // text keeps the row (the content hash still matches).
    if (mem.text !== text.trim()) {
      deleteMemoryEmbeddings(db, "memory", memoryId);
    }
  }
}

function assertGraphEdgeEndpointsExist(
  db: DatabaseSync,
  fromId: number,
  toId: number,
): void {
  if (!getMemoryById(db, fromId)) {
    throw new Error(
      `Graph edge from memory not found: ${formatMemoryNodeId(fromId)}`,
    );
  }
  if (!getMemoryById(db, toId)) {
    throw new Error(
      `Graph edge to memory not found: ${formatMemoryNodeId(toId)}`,
    );
  }
}

function insertEdge(
  db: DatabaseSync,
  relation: string,
  fromId: number,
  toId: number,
): void {
  if (fromId === toId) {
    throw new Error(`Graph edge cannot link a node to itself: M:${fromId}`);
  }
  assertGraphEdgeEndpointsExist(db, fromId, toId);
  try {
    db.prepare(
      `INSERT INTO graph_edges (relation, from_type, from_id, to_type, to_id)
       VALUES (?, 'memory', ?, 'memory', ?)`,
    ).run(relation, fromId, toId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return; // idempotent link
    }
    throw e;
  }
}

function applyOperation(
  db: DatabaseSync,
  op: MemoryDreamerOperation,
  ctx: {
    sourceSessionId: string;
    generation: number;
    tempRefs: Map<string, number>;
  },
): void {
  switch (op.op) {
    case "no_op":
      return;

    case "create": {
      if (!op.tempRef.trim())
        throw new Error("create tempRef must be non-empty");
      if (ctx.tempRefs.has(op.tempRef)) {
        throw new Error(`Duplicate create tempRef: ${op.tempRef}`);
      }
      const obsId = insertObservation(db, {
        kind: op.kind,
        text: op.observationText,
        sourceSessionId: ctx.sourceSessionId,
        creationGeneration: ctx.generation,
      });
      const memoryId = createMemoryWithVersion(db, {
        kind: op.kind,
        text: op.memoryText,
        creationGeneration: ctx.generation,
      });
      linkObservation(db, memoryId, obsId);
      ctx.tempRefs.set(op.tempRef, memoryId);
      return;
    }

    case "reinforce": {
      const parsed = parsePrefixedNodeId(op.memoryId);
      if (!parsed.ok || parsed.type !== "memory") {
        throw new Error(`reinforce requires memory id, got ${op.memoryId}`);
      }
      assertActiveOrKnownMemory(db, parsed.id);
      const mem = getMemoryById(db, parsed.id)!;
      const obsId = insertObservation(db, {
        kind: mem.kind,
        text: op.observationText,
        sourceSessionId: ctx.sourceSessionId,
        creationGeneration: ctx.generation,
      });
      linkObservation(db, parsed.id, obsId);
      return;
    }

    case "revise": {
      const parsed = parsePrefixedNodeId(op.memoryId);
      if (!parsed.ok || parsed.type !== "memory") {
        throw new Error(`revise requires memory id, got ${op.memoryId}`);
      }
      assertActiveOrKnownMemory(db, parsed.id);
      const mem = getMemoryById(db, parsed.id)!;
      const obsId = insertObservation(db, {
        kind: mem.kind,
        text: op.observationText,
        sourceSessionId: ctx.sourceSessionId,
        creationGeneration: ctx.generation,
      });
      linkObservation(db, parsed.id, obsId);
      if (
        !Number.isSafeInteger(op.expectedVersionId) ||
        op.expectedVersionId <= 0
      ) {
        throw new Error(
          `revise on ${op.memoryId} requires a positive expectedVersionId`,
        );
      }
      reviseMemoryText(db, parsed.id, op.memoryText, op.expectedVersionId);
      return;
    }

    case "supersede": {
      const old = parsePrefixedNodeId(op.oldMemoryId);
      if (!old.ok || old.type !== "memory") {
        throw new Error(`supersede requires memory id, got ${op.oldMemoryId}`);
      }
      assertActiveOrKnownMemory(db, old.id, ["active", "conflicted"]);
      if (!op.newTempRef.trim())
        throw new Error("supersede newTempRef must be non-empty");
      const obsId = insertObservation(db, {
        kind: op.kind,
        text: op.observationText,
        sourceSessionId: ctx.sourceSessionId,
        creationGeneration: ctx.generation,
      });
      const newId = createMemoryWithVersion(db, {
        kind: op.kind,
        text: op.memoryText,
        creationGeneration: ctx.generation,
      });
      linkObservation(db, newId, obsId);
      db.prepare(
        `UPDATE memories SET state = 'superseded', updated_at = datetime('now') WHERE id = ?`,
      ).run(old.id);
      deleteMemorySearchDocument(db, "memory", old.id);
      insertEdge(db, "supersedes", newId, old.id);
      ctx.tempRefs.set(op.newTempRef, newId);
      return;
    }

    case "conflict": {
      if (!op.memoryIds.length)
        throw new Error("conflict requires at least one memory id");
      for (const mid of op.memoryIds) {
        const parsed = parsePrefixedNodeId(mid);
        if (!parsed.ok || parsed.type !== "memory") {
          throw new Error(`conflict requires memory id, got ${mid}`);
        }
        assertActiveOrKnownMemory(db, parsed.id, ["active", "conflicted"]);
        db.prepare(
          `UPDATE memories SET state = 'conflicted', updated_at = datetime('now') WHERE id = ?`,
        ).run(parsed.id);
        deleteMemorySearchDocument(db, "memory", parsed.id);
      }
      // Pairwise conflicts_with edges
      for (let i = 0; i < op.memoryIds.length; i++) {
        for (let j = i + 1; j < op.memoryIds.length; j++) {
          const a = parsePrefixedNodeId(op.memoryIds[i]!) as {
            ok: true;
            type: "memory";
            id: number;
          };
          const b = parsePrefixedNodeId(op.memoryIds[j]!) as {
            ok: true;
            type: "memory";
            id: number;
          };
          insertEdge(db, "conflicts_with", a.id, b.id);
        }
      }
      if (op.observationText) {
        // Attach observation to first memory if provided
        const first = parsePrefixedNodeId(op.memoryIds[0]!) as {
          ok: true;
          type: "memory";
          id: number;
        };
        const mem = getMemoryById(db, first.id);
        if (mem) {
          const obsId = insertObservation(db, {
            kind: mem.kind,
            text: op.observationText,
            sourceSessionId: ctx.sourceSessionId,
            creationGeneration: ctx.generation,
          });
          linkObservation(db, first.id, obsId);
        }
      }
      return;
    }

    case "link": {
      let fromId: number;
      let toId: number;

      if (ctx.tempRefs.has(op.fromId)) {
        fromId = ctx.tempRefs.get(op.fromId)!;
      } else {
        const from = parsePrefixedNodeId(op.fromId);
        if (!from.ok || from.type !== "memory") {
          throw new Error(
            `link fromId must be M:<n> or a temp ref: ${op.fromId}`,
          );
        }
        fromId = from.id;
      }

      if (ctx.tempRefs.has(op.toId)) {
        toId = ctx.tempRefs.get(op.toId)!;
      } else {
        const to = parsePrefixedNodeId(op.toId);
        if (!to.ok || to.type !== "memory") {
          throw new Error(`link toId must be M:<n> or a temp ref: ${op.toId}`);
        }
        toId = to.id;
      }

      insertEdge(db, op.relation, fromId, toId);
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
      if (
        mtimeNotNewer &&
        (input.contentHash === null || existing.contentHash === null)
      ) {
        db.exec("ROLLBACK");
        return { applied: false, reason: "already checkpointed" };
      }
    }

    const tempRefs = new Map<string, number>();

    for (const op of operations) {
      applyOperation(db, op, {
        sourceSessionId: input.sourceSessionId,
        generation,
        tempRefs,
      });
    }

    db.prepare(
      `INSERT INTO source_sessions
         (session_id, session_path, cwd, processed_mtime_ms, content_hash, completed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         session_path = excluded.session_path,
         cwd = excluded.cwd,
         processed_mtime_ms = excluded.processed_mtime_ms,
         content_hash = excluded.content_hash,
         completed_at = datetime('now')`,
    ).run(
      input.sourceSessionId,
      input.sessionPath,
      normalizeMemoryCwd(input.cwd),
      input.processedMtimeMs,
      input.contentHash,
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
