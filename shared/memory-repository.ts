/**
 * Repository reads and atomic learning commits with invariant validation.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  formatMemoryNodeId,
  formatSummaryNodeId,
  estimateMemoryTextTokens,
  MEMORY_MAINTENANCE_MAX_ATTEMPTS,
  MEMORY_MAX_SUMMARY_CHARS,
  MEMORY_MAX_TEXT_CHARS,
  MEMORY_NOVELTY_GENERATIONS,
  MEMORY_NOVELTY_MAX_SOURCE_AGE_MS,
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
  upsertMemorySearchDocument,
} from "./memory-database.ts";
import {
  getMemoryActivityGeneration,
  getMemoryById,
  getSummaryById,
  listActiveMemories,
  listActiveSummaries,
  reconcileMemoryTreeExclusion,
  retireGraphEdge,
  wouldMemoryContainsEdgeCycle,
} from "./memory-graph.ts";
import {
  isMemoryRoot,
  listMemoryNodeChildren,
  listMemoryTreeRoots,
} from "./memory-tree.ts";
import {
  buildMemoryFallbackSummaryText,
  clearMemoryMaintenanceAttempt,
  getMemoryMaintenanceAttempts,
  incrementMemoryMaintenanceAttempt,
  memoryMaintenancePromoteKey,
  simulateMemoryPromoteLayer,
} from "./memory-maintenance.ts";
import type { MemoryWorkspaceConfig } from "./memory-config.ts";
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

/**
 * A fresh (non-backfilled) session touching a memory that entered cold grants
 * it the standard novelty window; passive presence never extends an active one.
 */
function grantNoveltyToColdMemory(
  db: DatabaseSync,
  memoryId: number,
  noveltyUntil: number | null,
): void {
  if (noveltyUntil === null) return;
  const mem = getMemoryById(db, memoryId);
  if (!mem || mem.noveltyUntilGeneration !== null) return;
  db.prepare(
    `UPDATE memories SET novelty_until_generation = ? WHERE id = ?`,
  ).run(noveltyUntil, memoryId);
}

function createMemoryWithVersion(
  db: DatabaseSync,
  input: {
    kind: MemoryKnowledgeKind;
    text: string;
    creationGeneration: number;
    noveltyUntilGeneration: number | null;
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
    noveltyUntil: number | null;
    tempRefs: Map<string, number>;
    summaryTempRefs: Map<string, number>;
  },
): { summaryId?: number } | undefined {
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
      grantNoveltyToColdMemory(db, parsed.id, ctx.noveltyUntil);
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
      grantNoveltyToColdMemory(db, parsed.id, ctx.noveltyUntil);
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
      // Lifecycle reconciliation: the excluded node's containment edges are
      // retired and ancestors whose condensation would include it resurface.
      reconcileMemoryTreeExclusion(
        db,
        [{ nodeType: "memory", nodeId: old.id }],
        {
          rewriteParent:
            op.newSummaryText !== undefined
              ? {
                  expectedVersionId: op.expectedSummaryVersionId ?? 0,
                  newSummaryText: op.newSummaryText,
                }
              : null,
        },
      );
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
      // Lifecycle reconciliation: excluded nodes' containment edges are retired
      // and ancestors whose condensation would include them resurface.
      reconcileMemoryTreeExclusion(
        db,
        op.memoryIds.map((mid) => {
          const parsed = parsePrefixedNodeId(mid) as {
            ok: true;
            type: "memory";
            id: number;
          };
          return { nodeType: "memory" as const, nodeId: parsed.id };
        }),
        {
          rewriteParent:
            op.newSummaryText !== undefined
              ? {
                  expectedVersionId: op.expectedSummaryVersionId ?? 0,
                  newSummaryText: op.newSummaryText,
                }
              : null,
        },
      );
      return;
    }

    case "link": {
      if ((op.relation as string) === "contains") {
        throw new Error(
          "link cannot create contains edges; containment is created only by validated summarize/promote/lifecycle operations",
        );
      }
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

      // Update (extend) targets are validated before member resolution so a
      // stale plan fails with the CAS error, not a member error.
      let summaryId: number | null = null;
      let oldSummaryText: string | null = null;
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
        oldSummaryText = existing.text;
      }

      // Resolve members (prefixed ids or in-commit temp refs) so strict-tree
      // and compaction validation run before any version write.
      const members: Array<{
        nodeType: MemorySearchableNodeType;
        nodeId: number;
        text: string;
      }> = [];
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
        // Strict-tree: every listed member must currently be a root.
        if (!isMemoryRoot(db, memberType, memberId)) {
          throw new Error(
            `summarize member ${member} is not a root; only active, non-conflicted nodes without an active parent summary can be summarized`,
          );
        }
        const memberText =
          memberType === "memory"
            ? getMemoryById(db, memberId)!.text
            : getSummaryById(db, memberId)!.text;
        members.push({
          nodeType: memberType,
          nodeId: memberId,
          text: memberText,
        });
      }

      // Strict measured compaction: the summary text must be smaller than the
      // roots removed from the top layer (for extends: old summary text + the
      // listed members; creates are this formula with the old-text term absent).
      const newTokens = estimateMemoryTextTokens(op.text);
      const memberTokens = members.reduce(
        (sum, m) => sum + estimateMemoryTextTokens(m.text),
        0,
      );
      const baseline =
        (oldSummaryText !== null
          ? estimateMemoryTextTokens(oldSummaryText)
          : 0) + memberTokens;
      if (newTokens >= baseline) {
        throw new Error(
          `summarize text does not compact the top layer (${newTokens} >= ${baseline} estimated tokens); summary text must be strictly smaller than the members it replaces`,
        );
      }

      if (op.summaryId) {
        const existing = getSummaryById(db, summaryId!)!;
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
        // A model-authored rewrite supersedes the mechanical fallback label
        // (the maintenance commit re-asserts 'fallback' when it applies the
        // deterministic text itself). An unchanged text keeps the old label.
        if (op.text.trim() !== existing.text) {
          db.prepare(
            `UPDATE summaries SET label_source = 'model' WHERE id = ?`,
          ).run(summaryId);
        }
      } else {
        const sumResult = db
          .prepare(
            `INSERT INTO summaries (state, current_version_id, creation_generation)
             VALUES ('active', NULL, ?)`,
          )
          .run(ctx.generation);
        summaryId = Number(sumResult.lastInsertRowid) as number;
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
        nodeId: summaryId!,
        text: op.text.trim(),
        kind: "summary",
        state: "active",
      });

      for (const member of members) {
        insertEdge(
          db,
          "contains",
          "summary",
          summaryId!,
          member.nodeType,
          member.nodeId,
        );
      }
      return { summaryId: summaryId! };
    }

    case "promote": {
      const child = parsePrefixedNodeId(op.nodeId);
      if (!child.ok || child.type === "observation") {
        throw new Error(`promote requires M:<n> or S:<n>, got ${op.nodeId}`);
      }
      const node =
        child.type === "memory"
          ? getMemoryById(db, child.id)
          : getSummaryById(db, child.id);
      if (!node) {
        throw new Error(`promote target not found: ${op.nodeId}`);
      }
      if (node.state !== "active") {
        throw new Error(
          `promote target ${op.nodeId} is ${node.state}; only active nodes can be promoted`,
        );
      }
      const parentParsed = parsePrefixedNodeId(op.summaryId);
      if (!parentParsed.ok || parentParsed.type !== "summary") {
        throw new Error(`promote summaryId must be S:<n>, got ${op.summaryId}`);
      }
      // Strict tree: the target must be a child of exactly one active summary.
      const children = listMemoryNodeChildren(db, "summary", parentParsed.id);
      const isChild = children.some(
        (c) => c.nodeType === child.type && c.nodeId === child.id,
      );
      if (!isChild) {
        throw new Error(
          `promote target ${op.nodeId} is not a child of ${op.summaryId}`,
        );
      }
      const parent = getSummaryById(db, parentParsed.id);
      if (!parent || parent.state !== "active") {
        throw new Error(`promote parent ${op.summaryId} is not active`);
      }
      if (
        !Number.isSafeInteger(op.expectedSummaryVersionId) ||
        op.expectedSummaryVersionId <= 0
      ) {
        throw new Error(
          `promote on ${op.nodeId} requires a positive expectedSummaryVersionId`,
        );
      }
      if (parent.currentVersionId !== op.expectedSummaryVersionId) {
        throw new Error(
          `promote parent ${op.summaryId} version is stale (expected ${op.expectedSummaryVersionId}, have ${parent.currentVersionId})`,
        );
      }

      retireGraphEdge(
        db,
        "contains",
        "summary",
        parentParsed.id,
        child.type,
        child.id,
      );
      const remaining = listMemoryNodeChildren(db, "summary", parentParsed.id);

      if (remaining.length >= 2) {
        // Parent keeps >= 2 members: rewrite it without the promoted child.
        if (!op.newSummaryText || !op.newSummaryText.trim()) {
          throw new Error(
            `promote of ${op.nodeId} from ${op.summaryId} keeps ${remaining.length} members; newSummaryText is required`,
          );
        }
        const textErr = validateMemoryBodyText(
          op.newSummaryText,
          MEMORY_MAX_SUMMARY_CHARS,
        );
        if (textErr) throw new Error(textErr);
        // Promote is deliberate layer growth: non-strict shrink only.
        if (
          estimateMemoryTextTokens(op.newSummaryText) >
          estimateMemoryTextTokens(parent.text)
        ) {
          throw new Error(
            `promote rewrite must not grow the parent summary (${estimateMemoryTextTokens(op.newSummaryText)} > ${estimateMemoryTextTokens(parent.text)} tokens)`,
          );
        }
        const verResult = db
          .prepare(
            `INSERT INTO summary_versions (summary_id, text, previous_version_id)
             VALUES (?, ?, ?)`,
          )
          .run(
            parentParsed.id,
            op.newSummaryText.trim(),
            parent.currentVersionId,
          );
        const versionId = Number(verResult.lastInsertRowid);
        const updated = db
          .prepare(
            `UPDATE summaries
             SET current_version_id = ?, updated_at = datetime('now')
             WHERE id = ? AND state = 'active' AND current_version_id = ?`,
          )
          .run(versionId, parentParsed.id, op.expectedSummaryVersionId);
        if (Number(updated.changes) !== 1) {
          throw new Error(
            `Summary ${op.summaryId} changed while its promote rewrite was committing`,
          );
        }
        // Model-authored rewrite supersedes the fallback label; the promote
        // fallback (old text kept, equality) preserves the existing label.
        if (op.newSummaryText.trim() !== parent.text) {
          db.prepare(
            `UPDATE summaries SET label_source = 'model' WHERE id = ?`,
          ).run(parentParsed.id);
        }
        upsertMemorySearchDocument(db, {
          nodeType: "summary",
          nodeId: parentParsed.id,
          text: op.newSummaryText.trim(),
          kind: "summary",
          state: "active",
        });
      } else {
        // Parent drops to <= 1 member: retire it; the remaining member's edge
        // is retired by the reconciliation so it resurfaced as a root.
        if (op.newSummaryText !== undefined && op.newSummaryText.trim()) {
          throw new Error(
            `promote of ${op.nodeId} retires ${op.summaryId} (${remaining.length} member(s) remain); newSummaryText is not allowed`,
          );
        }
        db.prepare(
          `UPDATE summaries SET state = 'retired', updated_at = datetime('now') WHERE id = ?`,
        ).run(parentParsed.id);
        deleteMemorySearchDocument(db, "summary", parentParsed.id);
        // Retires the parent's remaining contains edges (orphan resurfaced)
        // and any ancestor summaries whose condensation would now include the
        // retired parent (strict-tree invariant).
        reconcileMemoryTreeExclusion(db, [
          { nodeType: "summary", nodeId: parentParsed.id },
        ]);
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
  // Novelty is a freshness grant for recent evidence. Memories mined from
  // backfilled sessions older than the source-age cutoff enter cold so old
  // knowledge cannot masquerade as new regardless of mining order.
  const sourceFresh =
    Date.now() - input.processedMtimeMs <= MEMORY_NOVELTY_MAX_SOURCE_AGE_MS;
  const noveltyUntil = sourceFresh
    ? generation + MEMORY_NOVELTY_GENERATIONS
    : null;

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

export interface MemoryMaintenanceCommitInput {
  runId: string;
  operations: MemoryLearnerOperation[];
  config: MemoryWorkspaceConfig;
}

export interface MemoryMaintenanceCommitResult {
  applied: boolean;
  /** Candidate keys covered by applied ops (incl. fallback merges). */
  coveredKeys: string[];
  /** Candidate keys rejected for compaction; attempts incremented. */
  rejectedKeys: Array<{ key: string; attempts: number }>;
  /** Candidate keys merged via the deterministic fallback text. */
  fallbackKeys: string[];
  /** Audit entries for the call site to append (pi.appendEntry). */
  auditEntries: Array<{ kind: string; text: string }>;
  layerTokensBefore: number;
  layerTokensAfter: number;
  layerOverBudget: boolean;
}

interface MaintenanceOpAnalysis {
  index: number;
  op: MemoryLearnerOperation;
  kind: "merge-create" | "merge-extend" | "promote";
  key: string;
  /** Estimated tokens removed from the top layer (baseline - est(text)). */
  savings: number;
  /** Post-promote simulation input (promotes). */
  sim?: {
    childType: MemorySearchableNodeType;
    childId: number;
    parentId: number;
    newSummaryText: string | null;
  };
  /** Merge member keys (validated against the post-promote root set). */
  memberKeys?: string[];
  /** Extend target summary id. */
  summaryId?: number;
  /** Fallback text applied instead of rejection (K-th consecutive failure). */
  fallbackText?: string | null;
  /** Promote rewrite rejected for non-shrink (kept out of the batch). */
  rejected?: boolean;
  childPrefixedId?: string;
  parentId?: number;
  reason?: "cold" | "budget";
}

function maintenanceMergeKeyForOps(
  summary: { nodeType: MemorySearchableNodeType; nodeId: number } | null,
  members: Array<{ nodeType: MemorySearchableNodeType; nodeId: number }>,
): string {
  const parts = [...(summary ? [summary] : []), ...members].map(
    (m) => `${m.nodeType}:${m.nodeId}`,
  );
  parts.sort();
  return `merge:${parts.join("+")}`;
}

/**
 * Pre-apply analysis of a maintenance batch: validates every op against the
 * strict-tree and strict-compaction rules, resolves promote attempt counters,
 * and projects the resulting top layer from the actual written texts.
 */
function analyzeMemoryMaintenanceOps(
  db: DatabaseSync,
  operations: MemoryLearnerOperation[],
  generation: number,
): MaintenanceOpAnalysis[] {
  const analyses: MaintenanceOpAnalysis[] = [];

  const promoteAnalyses: MaintenanceOpAnalysis[] = [];
  for (let index = 0; index < operations.length; index++) {
    const op = operations[index]!;
    if (op.op !== "promote") continue;
    const child = parsePrefixedNodeId(op.nodeId);
    if (!child.ok || child.type === "observation") {
      throw new Error(`promote requires M:<n> or S:<n>, got ${op.nodeId}`);
    }
    const node =
      child.type === "memory"
        ? getMemoryById(db, child.id)
        : getSummaryById(db, child.id);
    if (!node) throw new Error(`promote target not found: ${op.nodeId}`);
    if (node.state !== "active") {
      throw new Error(
        `promote target ${op.nodeId} is ${node.state}; only active nodes can be promoted`,
      );
    }
    const parentParsed = parsePrefixedNodeId(op.summaryId);
    if (!parentParsed.ok || parentParsed.type !== "summary") {
      throw new Error(`promote summaryId must be S:<n>, got ${op.summaryId}`);
    }
    const parent = getSummaryById(db, parentParsed.id);
    if (!parent || parent.state !== "active") {
      throw new Error(`promote parent ${op.summaryId} is not active`);
    }
    if (
      !Number.isSafeInteger(op.expectedSummaryVersionId) ||
      op.expectedSummaryVersionId <= 0
    ) {
      throw new Error(
        `promote on ${op.nodeId} requires a positive expectedSummaryVersionId`,
      );
    }
    if (parent.currentVersionId !== op.expectedSummaryVersionId) {
      throw new Error(
        `promote parent ${op.summaryId} version is stale (expected ${op.expectedSummaryVersionId}, have ${parent.currentVersionId})`,
      );
    }
    const children = listMemoryNodeChildren(db, "summary", parentParsed.id);
    if (
      !children.some((c) => c.nodeType === child.type && c.nodeId === child.id)
    ) {
      throw new Error(
        `promote target ${op.nodeId} is not a child of ${op.summaryId}`,
      );
    }
    const remaining = children.filter(
      (c) => !(c.nodeType === child.type && c.nodeId === child.id),
    );
    const key = memoryMaintenancePromoteKey(
      child.type,
      child.id,
      parentParsed.id,
    );
    let newSummaryText: string | null = null;
    let rejected = false;
    if (remaining.length >= 2) {
      if (!op.newSummaryText || !op.newSummaryText.trim()) {
        throw new Error(
          `promote of ${op.nodeId} from ${op.summaryId} keeps ${remaining.length} members; newSummaryText is required`,
        );
      }
      const textErr = validateMemoryBodyText(
        op.newSummaryText,
        MEMORY_MAX_SUMMARY_CHARS,
      );
      if (textErr) throw new Error(textErr);
      if (
        estimateMemoryTextTokens(op.newSummaryText) >
        estimateMemoryTextTokens(parent.text)
      ) {
        // Rewrite fails the non-strict shrink: attempt-counter path. The K-th
        // consecutive failure keeps the old summary text (satisfies <= by equality).
        const attempts = getMemoryMaintenanceAttempts(db, key);
        if (attempts + 1 >= MEMORY_MAINTENANCE_MAX_ATTEMPTS) {
          newSummaryText = parent.text;
          clearMemoryMaintenanceAttempt(db, key);
        } else {
          incrementMemoryMaintenanceAttempt(db, key, generation);
          rejected = true;
        }
      } else {
        clearMemoryMaintenanceAttempt(db, key);
        newSummaryText = op.newSummaryText;
      }
    } else if (op.newSummaryText !== undefined && op.newSummaryText.trim()) {
      throw new Error(
        `promote of ${op.nodeId} retires ${op.summaryId} (${remaining.length} member(s) remain); newSummaryText is not allowed`,
      );
    }
    promoteAnalyses.push({
      index,
      op,
      kind: "promote",
      key,
      savings: 0,
      rejected,
      childPrefixedId:
        child.type === "memory" ? `M:${child.id}` : `S:${child.id}`,
      parentId: parentParsed.id,
      ...(rejected
        ? {}
        : {
            sim: {
              childType: child.type,
              childId: child.id,
              parentId: parentParsed.id,
              newSummaryText,
            },
          }),
    });
  }

  // Post-promote root projection: merge members and extend targets must be
  // roots of the resulting layer, and extend baselines use the post-promote
  // summary text (a promote rewrite may shrink the target).
  const sim = simulateMemoryPromoteLayer(
    db,
    promoteAnalyses.filter((a) => !a.rejected && a.sim).map((a) => a.sim!),
  );
  const simRoots = new Map(
    sim.roots.map((r) => [`${r.nodeType}:${r.nodeId}`, r] as const),
  );
  const isSimRoot = (
    nodeType: MemorySearchableNodeType,
    nodeId: number,
  ): boolean => simRoots.has(`${nodeType}:${nodeId}`);

  for (let index = 0; index < operations.length; index++) {
    const op = operations[index]!;
    if (op.op !== "summarize") continue;
    const textErr = validateMemoryBodyText(op.text, MEMORY_MAX_SUMMARY_CHARS);
    if (textErr) throw new Error(textErr);
    if (!op.memberIds.length) {
      throw new Error("summarize requires at least one member id");
    }
    const members: Array<{
      nodeType: MemorySearchableNodeType;
      nodeId: number;
      text: string;
    }> = [];
    for (const raw of op.memberIds) {
      const parsed = parsePrefixedNodeId(raw);
      if (!parsed.ok || parsed.type === "observation") {
        throw new Error(
          `maintenance summarize member must be M:<n> or S:<n>: ${raw}`,
        );
      }
      const node =
        parsed.type === "memory"
          ? getMemoryById(db, parsed.id)
          : getSummaryById(db, parsed.id);
      if (!node) throw new Error(`summarize member not found: ${raw}`);
      if (node.state !== "active") {
        throw new Error(
          `summarize member ${raw} is ${node.state}; only active nodes can be summarized`,
        );
      }
      if (!isSimRoot(parsed.type, parsed.id)) {
        throw new Error(
          `summarize member ${raw} is not a root of the post-promote top layer; the tree changed since planning`,
        );
      }
      members.push({
        nodeType: parsed.type,
        nodeId: parsed.id,
        text: node.text,
      });
    }
    const textTokens = estimateMemoryTextTokens(op.text);

    if (op.summaryId) {
      const parsed = parsePrefixedNodeId(op.summaryId);
      if (!parsed.ok || parsed.type !== "summary") {
        throw new Error(
          `summarize summaryId must be S:<n>, got ${op.summaryId}`,
        );
      }
      const existing = getSummaryById(db, parsed.id);
      if (!existing) throw new Error(`Summary not found: ${op.summaryId}`);
      if (existing.state !== "active") {
        throw new Error(
          `Summary ${op.summaryId} is ${existing.state}; only active summaries can be updated`,
        );
      }
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
      if (!isSimRoot("summary", parsed.id)) {
        throw new Error(
          `Summary ${op.summaryId} is not a root of the post-promote top layer; only root summaries can be extended`,
        );
      }
      const simTarget = simRoots.get(`summary:${parsed.id}`);
      const oldTokens = simTarget
        ? simTarget.estimatedTokens
        : estimateMemoryTextTokens(existing.text);
      const baseline =
        oldTokens +
        members.reduce((s, m) => s + estimateMemoryTextTokens(m.text), 0);
      if (textTokens >= baseline) {
        throw new Error(
          `summarize text does not compact the top layer (${textTokens} >= ${baseline} estimated tokens)`,
        );
      }
      analyses.push({
        index,
        op,
        kind: "merge-extend",
        key: maintenanceMergeKeyForOps(
          { nodeType: "summary", nodeId: parsed.id },
          members,
        ),
        savings: baseline - textTokens,
        memberKeys: members.map((m) => `${m.nodeType}:${m.nodeId}`),
        summaryId: parsed.id,
        reason: op.reason,
      });
    } else {
      const baseline = members.reduce(
        (s, m) => s + estimateMemoryTextTokens(m.text),
        0,
      );
      if (textTokens >= baseline) {
        throw new Error(
          `summarize text does not compact the top layer (${textTokens} >= ${baseline} estimated tokens)`,
        );
      }
      analyses.push({
        index,
        op,
        kind: "merge-create",
        key: maintenanceMergeKeyForOps(null, members),
        savings: baseline - textTokens,
        memberKeys: members.map((m) => `${m.nodeType}:${m.nodeId}`),
        reason: op.reason,
      });
    }
  }

  // Merge analyses are validated against the simulated (post-promote) state,
  // so they must be projected after the promote analyses.
  const ordered = [
    ...promoteAnalyses,
    ...analyses.sort((a, b) => a.index - b.index),
  ];
  // Ensure promote-first ordering for the apply phase (matches the learner
  // prompt mandate; a wrong order fails loudly at apply time).
  ordered.sort((a, b) => a.index - b.index);
  return ordered;
}

/**
 * Session-less claim-owned maintenance commit: applies only summarize /
 * promote / no_op ops (no source-session write), validates strict-tree and
 * strict-compaction rules per op, projects the resulting top layer from the
 * actual written texts, and rejects non-compacting merges when the batch still
 * exceeds `briefingTokenBudget` (partial progress: ops that pass stay).
 * Consecutive rejections increment per-candidate attempt counters; at
 * MEMORY_MAINTENANCE_MAX_ATTEMPTS the deterministic fallback text applies
 * instead of rejection, making convergence unconditional.
 */
export function commitMemoryLearningOps(
  db: DatabaseSync,
  input: MemoryMaintenanceCommitInput,
): MemoryMaintenanceCommitResult {
  if (!memoryRunOwnsClaim(db, input.runId)) {
    throw new Error("Memory learning run no longer owns the workspace claim");
  }

  const operations = input.operations ?? [];
  const generation = getMemoryActivityGeneration(db);
  const budget = input.config.briefingTokenBudget;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (!memoryRunOwnsClaim(db, input.runId)) {
      throw new Error("Memory learning run no longer owns the workspace claim");
    }
    for (const op of operations) {
      if (op.op !== "summarize" && op.op !== "promote" && op.op !== "no_op") {
        throw new Error(
          `Maintenance commit rejected ${op.op} op; only summarize, promote, and no_op are allowed`,
        );
      }
    }

    const layerTokensBefore = listMemoryTreeRoots(db).reduce(
      (sum, r) => sum + r.estimatedTokens,
      0,
    );

    const analyses = analyzeMemoryMaintenanceOps(db, operations, generation);
    const sim = simulateMemoryPromoteLayer(
      db,
      analyses
        .filter((a) => a.kind === "promote" && !a.rejected && a.sim)
        .map((a) => a.sim!),
    );
    const rootTokens = new Map<string, number>(
      sim.roots.map((r) => [`${r.nodeType}:${r.nodeId}`, r.estimatedTokens]),
    );
    let projected = sim.tokens;
    const mergeAnalyses = analyses.filter(
      (a) => a.kind === "merge-create" || a.kind === "merge-extend",
    );
    for (const a of mergeAnalyses) {
      for (const key of a.memberKeys ?? []) {
        const tokens = rootTokens.get(key);
        if (tokens === undefined) {
          throw new Error(
            `Maintenance merge member ${key} is not in the projected top layer; the tree changed since planning`,
          );
        }
        projected -= tokens;
      }
      const op = a.op as Extract<MemoryLearnerOperation, { op: "summarize" }>;
      if (a.kind === "merge-extend") {
        const targetTokens = rootTokens.get(`summary:${a.summaryId}`);
        if (targetTokens === undefined) {
          throw new Error(
            `Maintenance extend target S:${a.summaryId} is not a root; only root summaries can be extended`,
          );
        }
        projected += estimateMemoryTextTokens(op.text) - targetTokens;
      } else {
        projected += estimateMemoryTextTokens(op.text);
      }
    }

    // Post-rewrite residual policy: when the batch leaves the projected layer
    // over budget, the non-compacting candidates are rejected — a merge is
    // non-compacting when its text is at least half the size of the roots it
    // replaces (savings <= floor(baseline / 2), i.e. the text is at least half
    // the size of the roots it removes). Rejection is a quality gate,
    // never a fitting mechanism (rejecting restores roots, so the layer stays
    // over budget and the next run's budget override extends the candidates);
    // it never vetoes the rest of the batch. Promotes are deliberate layer
    // growth and are never rejected for budget.
    const dropped = new Set<number>();
    if (projected > budget) {
      for (const a of mergeAnalyses) {
        const baseline =
          a.savings +
          estimateMemoryTextTokens(
            (a.op as Extract<MemoryLearnerOperation, { op: "summarize" }>).text,
          );
        if (a.savings <= Math.floor(baseline / 2)) {
          dropped.add(a.index);
        }
      }
    }

    // Attempt counters + fallback decisions for dropped merges.
    const rejectedKeys: Array<{ key: string; attempts: number }> = [];
    const fallbackKeys: string[] = [];
    const coveredKeys: string[] = [];
    const auditEntries: Array<{ kind: string; text: string }> = [];
    for (const a of mergeAnalyses) {
      if (!dropped.has(a.index)) {
        coveredKeys.push(a.key);
        clearMemoryMaintenanceAttempt(db, a.key);
        continue;
      }
      const attempts = incrementMemoryMaintenanceAttempt(db, a.key, generation);
      if (attempts >= MEMORY_MAINTENANCE_MAX_ATTEMPTS) {
        a.fallbackText = buildMemoryFallbackSummaryText(
          a.kind === "merge-extend"
            ? (getSummaryById(db, a.summaryId!)?.text ?? null)
            : null,
          // Fallback member texts are read from the analysis (pre-apply state).
          (
            a.op as Extract<MemoryLearnerOperation, { op: "summarize" }>
          ).memberIds.map((raw) => {
            const parsed = parsePrefixedNodeId(raw);
            if (!parsed.ok || parsed.type === "observation") {
              throw new Error(
                `summarize member must be M:<n> or S:<n>: ${raw}`,
              );
            }
            const node =
              parsed.type === "memory"
                ? getMemoryById(db, parsed.id)
                : getSummaryById(db, parsed.id);
            return {
              prefixedId:
                parsed.type === "memory" ? `M:${parsed.id}` : `S:${parsed.id}`,
              text: node?.text ?? "",
            };
          }),
        );
        clearMemoryMaintenanceAttempt(db, a.key);
        fallbackKeys.push(a.key);
        coveredKeys.push(a.key);
        projected -= 1;
      } else {
        rejectedKeys.push({ key: a.key, attempts });
      }
    }

    // Apply kept ops in original order (promotes first per the learner prompt;
    // applyOperation re-validates every op against the current state).
    const tempRefs = new Map<string, number>();
    const summaryTempRefs = new Map<string, number>();
    const ctx = {
      sourceSessionId: "maintenance",
      generation,
      noveltyUntil: null,
      tempRefs,
      summaryTempRefs,
    };
    const auditEstBefore = layerTokensBefore;
    for (const a of analyses) {
      if (a.kind === "promote") {
        if (a.rejected) {
          auditEntries.push({
            kind: "maintenance",
            text: `maintenance reject promote ${a.childPrefixedId} from S:${a.parentId} (attempts=${getMemoryMaintenanceAttempts(db, a.key)}), est_before=${auditEstBefore}, budget=${budget}`,
          });
          continue;
        }
        // The K-th rewrite failure applies the promote with the parent's old
        // text unchanged (the analysis recorded it as the fallback rewrite).
        const op =
          a.sim?.newSummaryText !== undefined &&
          a.sim.newSummaryText !== null &&
          (a.op as { newSummaryText?: string }).newSummaryText !==
            a.sim.newSummaryText
            ? ({
                ...a.op,
                newSummaryText: a.sim.newSummaryText,
              } as MemoryLearnerOperation)
            : a.op;
        const result = applyOperation(db, op, ctx);
        void result;
        coveredKeys.push(a.key);
        auditEntries.push({
          kind: "maintenance",
          text: `maintenance promote ${a.childPrefixedId} from S:${a.parentId}, reason=hot, est_before=${auditEstBefore}, budget=${budget}`,
        });
        continue;
      }
      if (a.kind === "merge-create" || a.kind === "merge-extend") {
        if (dropped.has(a.index) && !a.fallbackText) {
          auditEntries.push({
            kind: "maintenance",
            text: `maintenance reject merge ${a.key} (attempts=${rejectedKeys.find((r) => r.key === a.key)?.attempts ?? getMemoryMaintenanceAttempts(db, a.key)}), est_before=${auditEstBefore}, budget=${budget}`,
          });
          continue;
        }
        const op =
          a.fallbackText !== undefined && a.fallbackText !== null
            ? ({ ...a.op, text: a.fallbackText } as MemoryLearnerOperation)
            : a.op;
        const result = applyOperation(db, op, ctx);
        const fallbackSummaryId =
          a.kind === "merge-extend" ? a.summaryId : result?.summaryId;
        if (a.fallbackText && fallbackSummaryId !== undefined) {
          // Mark fallback-merged summaries so /memory status can flag them.
          db.prepare(
            `UPDATE summaries SET label_source = 'fallback' WHERE id = ?`,
          ).run(fallbackSummaryId);
        }
        const target =
          a.kind === "merge-extend"
            ? `S:${a.summaryId}`
            : result?.summaryId !== undefined
              ? `S:${result.summaryId}`
              : "S:?";
        if (a.fallbackText) {
          auditEntries.push({
            kind: "maintenance",
            text: `maintenance fallback merge ${a.key} → ${target}, reason=${a.reason ?? "cold"}, est_before=${auditEstBefore}, budget=${budget}`,
          });
        } else {
          auditEntries.push({
            kind: "maintenance",
            text: `maintenance merge ${a.key} → ${target}, reason=${a.reason ?? "cold"}, est_before=${auditEstBefore}, budget=${budget}`,
          });
        }
        continue;
      }
      // no_op: nothing to do.
    }

    const layerTokensAfter = listMemoryTreeRoots(db).reduce(
      (sum, r) => sum + r.estimatedTokens,
      0,
    );

    db.exec("COMMIT");
    return {
      applied: true,
      coveredKeys,
      rejectedKeys,
      fallbackKeys,
      auditEntries,
      layerTokensBefore: auditEstBefore,
      layerTokensAfter,
      layerOverBudget: layerTokensAfter > budget,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nested rollback failure is ignored.
    }
    throw err;
  }
}
