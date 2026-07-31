/**
 * Repository reads and atomic learning commits with invariant validation.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  formatMemoryNodeId,
  formatSummaryNodeId,
  MEMORY_MAX_SUMMARY_CHARS,
  MEMORY_MAX_TEXT_CHARS,
  MEMORY_NOVELTY_GENERATIONS,
  normalizeObservationText,
  parsePrefixedNodeId,
  validateMemoryBodyText,
  type MemoryKnowledgeKind,
  type MemoryLearnerOperation,
  type MemoryLearningCommitInput,
  type MemorySearchableNodeType,
  type SourceSessionRow,
  type WorkspaceStateRow,
} from "./memory-types.ts";
import {
  deleteMemorySearchDocument,
  rebuildMemorySearchFts,
  upsertMemorySearchDocument,
} from "./memory-database.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  getSummaryById,
  listActiveMemories,
  listActiveSummaries,
  wouldMemoryContainsEdgeCycle,
} from "./memory-graph.ts";
import { memoryRunOwnsClaim } from "./memory-run-claim.ts";
import { normalizeMemoryCwd } from "./memory-workspace-id.ts";

export function getMemoryWorkspaceState(db: DatabaseSync): WorkspaceStateRow {
  const r = db
    .prepare(
      `SELECT activity_generation, turns_since_last_run, last_successful_run_at_ms,
              last_observed_transcript_mtime_ms, updated_at
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
    updatedAt: String(r.updated_at),
  };
}

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

function parseSearchableId(raw: string): {
  type: MemorySearchableNodeType;
  id: number;
} {
  const parsed = parsePrefixedNodeId(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.type === "observation") {
    throw new Error(`Expected memory or summary id, got observation ${raw}`);
  }
  return { type: parsed.type, id: parsed.id };
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
    noveltyUntilGeneration: number;
  },
): number {
  const err = validateMemoryBodyText(input.text, MEMORY_MAX_TEXT_CHARS);
  if (err) throw new Error(err);
  const memResult = db
    .prepare(
      `INSERT INTO memories
         (kind, state, current_version_id, creation_generation, novelty_until_generation)
       VALUES (?, 'active', NULL, ?, ?)`,
    )
    .run(input.kind, input.creationGeneration, input.noveltyUntilGeneration);
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
  }
}

function assertGraphEdgeEndpointsExist(
  db: DatabaseSync,
  fromType: MemorySearchableNodeType,
  fromId: number,
  toType: MemorySearchableNodeType,
  toId: number,
): void {
  if (fromType === "memory" && !getMemoryById(db, fromId)) {
    throw new Error(
      `Graph edge from memory not found: ${formatMemoryNodeId(fromId)}`,
    );
  }
  if (fromType === "summary" && !getSummaryById(db, fromId)) {
    throw new Error(
      `Graph edge from summary not found: ${formatSummaryNodeId(fromId)}`,
    );
  }
  if (toType === "memory" && !getMemoryById(db, toId)) {
    throw new Error(
      `Graph edge to memory not found: ${formatMemoryNodeId(toId)}`,
    );
  }
  if (toType === "summary" && !getSummaryById(db, toId)) {
    throw new Error(
      `Graph edge to summary not found: ${formatSummaryNodeId(toId)}`,
    );
  }
}

function insertEdge(
  db: DatabaseSync,
  relation: string,
  fromType: MemorySearchableNodeType,
  fromId: number,
  toType: MemorySearchableNodeType,
  toId: number,
): void {
  if (fromType === toType && fromId === toId) {
    throw new Error(
      `Graph edge cannot link a node to itself: ${fromType}:${fromId}`,
    );
  }
  assertGraphEdgeEndpointsExist(db, fromType, fromId, toType, toId);
  if (relation === "contains") {
    if (wouldMemoryContainsEdgeCycle(db, fromType, fromId, toType, toId)) {
      throw new Error(
        `contains edge would create a cycle: ${fromType}:${fromId} -> ${toType}:${toId}`,
      );
    }
  }
  try {
    db.prepare(
      `INSERT INTO graph_edges (relation, from_type, from_id, to_type, to_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(relation, fromType, fromId, toType, toId);
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
  op: MemoryLearnerOperation,
  ctx: {
    sourceSessionId: string;
    generation: number;
    noveltyUntil: number;
    tempRefs: Map<string, number>;
    summaryTempRefs: Map<string, number>;
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
        noveltyUntilGeneration: ctx.noveltyUntil,
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
        noveltyUntilGeneration: ctx.noveltyUntil,
      });
      linkObservation(db, newId, obsId);
      db.prepare(
        `UPDATE memories SET state = 'superseded', updated_at = datetime('now') WHERE id = ?`,
      ).run(old.id);
      deleteMemorySearchDocument(db, "memory", old.id);
      db.prepare(
        `DELETE FROM embeddings WHERE node_type = 'memory' AND node_id = ?`,
      ).run(old.id);
      insertEdge(db, "supersedes", "memory", newId, "memory", old.id);
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
        db.prepare(
          `DELETE FROM embeddings WHERE node_type = 'memory' AND node_id = ?`,
        ).run(parsed.id);
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
          insertEdge(db, "conflicts_with", "memory", a.id, "memory", b.id);
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
      let fromType: MemorySearchableNodeType;
      let fromId: number;
      let toType: MemorySearchableNodeType;
      let toId: number;

      if (
        op.fromId.startsWith("tmp:") ||
        ctx.tempRefs.has(op.fromId) ||
        ctx.summaryTempRefs.has(op.fromId)
      ) {
        if (ctx.tempRefs.has(op.fromId)) {
          fromType = "memory";
          fromId = ctx.tempRefs.get(op.fromId)!;
        } else if (ctx.summaryTempRefs.has(op.fromId)) {
          fromType = "summary";
          fromId = ctx.summaryTempRefs.get(op.fromId)!;
        } else {
          throw new Error(`link fromId temp ref not resolved: ${op.fromId}`);
        }
      } else {
        const from = parseSearchableId(op.fromId);
        fromType = from.type;
        fromId = from.id;
      }

      if (ctx.tempRefs.has(op.toId)) {
        toType = "memory";
        toId = ctx.tempRefs.get(op.toId)!;
      } else if (ctx.summaryTempRefs.has(op.toId)) {
        toType = "summary";
        toId = ctx.summaryTempRefs.get(op.toId)!;
      } else {
        const to = parseSearchableId(op.toId);
        toType = to.type;
        toId = to.id;
      }

      // Ensure nodes exist
      if (fromType === "memory" && !getMemoryById(db, fromId)) {
        throw new Error(
          `link from memory not found: ${formatMemoryNodeId(fromId)}`,
        );
      }
      if (fromType === "summary" && !getSummaryById(db, fromId)) {
        throw new Error(
          `link from summary not found: ${formatSummaryNodeId(fromId)}`,
        );
      }
      if (toType === "memory" && !getMemoryById(db, toId)) {
        throw new Error(
          `link to memory not found: ${formatMemoryNodeId(toId)}`,
        );
      }
      if (toType === "summary" && !getSummaryById(db, toId)) {
        throw new Error(
          `link to summary not found: ${formatSummaryNodeId(toId)}`,
        );
      }

      insertEdge(db, op.relation, fromType, fromId, toType, toId);
      return;
    }

    case "summarize": {
      const err = validateMemoryBodyText(op.text, MEMORY_MAX_SUMMARY_CHARS);
      if (err) throw new Error(err);
      if (!op.memberIds.length) {
        throw new Error("summarize requires at least one member id");
      }

      let summaryId: number;
      if (op.summaryId) {
        const parsed = parsePrefixedNodeId(op.summaryId);
        if (!parsed.ok || parsed.type !== "summary") {
          throw new Error(
            `summarize summaryId must be S:<n>, got ${op.summaryId}`,
          );
        }
        const existing = getSummaryById(db, parsed.id);
        if (!existing) throw new Error(`Summary not found: ${op.summaryId}`);
        // Updates never resurrect soft-forgotten summaries: only active
        // summaries may receive a new version.
        if (existing.state !== "active") {
          throw new Error(
            `Summary ${op.summaryId} is ${existing.state}; only active summaries can be updated`,
          );
        }
        // Summary updates are compare-and-swap writes: require the version the
        // learner observed so a stale plan cannot replace a newer summary.
        if (
          !Number.isSafeInteger(op.expectedVersionId) ||
          op.expectedVersionId <= 0
        ) {
          throw new Error(
            `Summary ${op.summaryId} update requires a positive expectedVersionId`,
          );
        }
        if (existing.currentVersionId !== op.expectedVersionId) {
          throw new Error(
            `Summary ${op.summaryId} version is stale (expected ${op.expectedVersionId}, have ${existing.currentVersionId})`,
          );
        }
        summaryId = parsed.id;
        const verResult = db
          .prepare(
            `INSERT INTO summary_versions (summary_id, text, previous_version_id)
             VALUES (?, ?, ?)`,
          )
          .run(summaryId, op.text.trim(), existing.currentVersionId);
        const versionId = Number(verResult.lastInsertRowid);
        const updated = db
          .prepare(
            `UPDATE summaries
             SET current_version_id = ?, updated_at = datetime('now')
             WHERE id = ? AND state = 'active' AND current_version_id = ?`,
          )
          .run(versionId, summaryId, op.expectedVersionId);
        if (updated.changes !== 1) {
          throw new Error(
            `Summary ${op.summaryId} changed while its update was committing`,
          );
        }
      } else {
        const sumResult = db
          .prepare(
            `INSERT INTO summaries (state, current_version_id, creation_generation)
             VALUES ('active', NULL, ?)`,
          )
          .run(ctx.generation);
        summaryId = Number(sumResult.lastInsertRowid);
        const verResult = db
          .prepare(
            `INSERT INTO summary_versions (summary_id, text, previous_version_id)
             VALUES (?, ?, NULL)`,
          )
          .run(summaryId, op.text.trim());
        const versionId = Number(verResult.lastInsertRowid);
        db.prepare(
          `UPDATE summaries SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(versionId, summaryId);
        if (op.tempRef) {
          ctx.summaryTempRefs.set(op.tempRef, summaryId);
        }
      }

      upsertMemorySearchDocument(db, {
        nodeType: "summary",
        nodeId: summaryId,
        text: op.text.trim(),
        kind: "summary",
        state: "active",
      });

      for (const member of op.memberIds) {
        let memberType: MemorySearchableNodeType;
        let memberId: number;
        if (ctx.tempRefs.has(member)) {
          memberType = "memory";
          memberId = ctx.tempRefs.get(member)!;
        } else if (ctx.summaryTempRefs.has(member)) {
          memberType = "summary";
          memberId = ctx.summaryTempRefs.get(member)!;
        } else {
          const p = parseSearchableId(member);
          memberType = p.type;
          memberId = p.id;
        }
        if (memberType === "memory" && !getMemoryById(db, memberId)) {
          throw new Error(`summarize member not found: ${member}`);
        }
        if (memberType === "summary" && !getSummaryById(db, memberId)) {
          throw new Error(`summarize member not found: ${member}`);
        }
        insertEdge(db, "contains", "summary", summaryId, memberType, memberId);
      }
      return;
    }

    default: {
      const _exhaustive: never = op;
      throw new Error(
        `Unknown learner operation: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Atomically commit one source session's learning plan.
 * Validates claim ownership, graph invariants, text shape; checkpoints the session.
 * Replay of an unchanged checkpoint is a no-op success.
 */
export function commitMemoryLearningSession(
  db: DatabaseSync,
  input: MemoryLearningCommitInput,
): { applied: boolean; reason?: string } {
  if (!memoryRunOwnsClaim(db, input.runId)) {
    throw new Error("Memory learning run no longer owns the workspace claim");
  }

  const operations = input.plan.operations ?? [];
  const generation = getMemoryActivityGeneration(db);
  const noveltyUntil = generation + MEMORY_NOVELTY_GENERATIONS;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!memoryRunOwnsClaim(db, input.runId)) {
      throw new Error("Memory learning run no longer owns the workspace claim");
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
    const summaryTempRefs = new Map<string, number>();

    for (const op of operations) {
      applyOperation(db, op, {
        sourceSessionId: input.sourceSessionId,
        generation,
        noveltyUntil,
        tempRefs,
        summaryTempRefs,
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

    rebuildMemorySearchFts(db);

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

/** List active memories/summaries for the learner inspection tool. */
export function listMemoryGraphSnapshot(db: DatabaseSync): {
  memories: Array<{
    id: string;
    kind: string;
    state: string;
    text: string;
    recurrence: number;
  }>;
  summaries: Array<{
    id: string;
    state: string;
    currentVersionId: number;
    text: string;
  }>;
} {
  const memories = listActiveMemories(db).map((m) => ({
    id: formatMemoryNodeId(m.id),
    kind: m.kind,
    state: m.state,
    text: m.text,
    recurrence: m.recurrence,
  }));
  const summaries = listActiveSummaries(db).map((s) => ({
    id: formatSummaryNodeId(s.id),
    state: s.state,
    currentVersionId: s.currentVersionId,
    text: s.text,
  }));
  return { memories, summaries };
}
