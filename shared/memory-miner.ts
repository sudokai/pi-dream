/**
 * Deterministic memory mining driver.
 *
 * The dreamer is a batch pipeline: the LLM is a pure function of a bounded,
 * forward-only segment stream, and every piece of state — cursor, budgets,
 * progress, checkpoints — lives in this driver, never in a conversation.
 * Re-reads and loops are therefore structurally impossible.
 *
 * Per session: decode the immutable snapshot -> filter generated content and
 * memory-tool parts -> truncate long content (edges kept) -> split into
 * char-budgeted segments -> one bounded extract call per segment ->
 * deterministic recall against the store -> one bounded consolidate call ->
 * one atomic commit. The mined-message cursor advances only forward; a
 * segment is never re-read after its extract call succeeds.
 *
 * Budgets are structural: segment chars, run chars, and wall clock are
 * enforced by the driver. When a budget exhausts mid-session, the driver
 * commits a partial checkpoint (cursor < total) so the session stays
 * eligible and the next run resumes exactly where this one stopped.
 */

import type { DatabaseSync } from "node:sqlite";
import { findMemoryCandidates } from "./memory-retrieval.ts";
import { commitMemoryDreamSession } from "./memory-repository.ts";
import {
  countMemorySessionEvidence,
  loadVerifiedMemorySessionSnapshot,
  segmentMemorySessionEvidence,
  type MemorySessionEvidenceSegment,
} from "./memory-session-decode.ts";
import {
  readMemoryDreamManifest,
  type MemoryDreamManifestEntry,
} from "./memory-session-discovery.ts";
import {
  MEMORY_MINE_MAX_CANDIDATES_PER_SEGMENT,
  MEMORY_MINE_RUN_CHARS,
  MEMORY_MINE_SEGMENT_CHARS,
  MEMORY_MINE_WALL_CLOCK_MS,
  parseMemoryNodeId,
  validateMemoryBodyText,
  type MemoryDreamerOperation,
  type MemoryKnowledgeKind,
} from "./memory-types.ts";

/** Completion seam: one bounded LLM call. Wired to completeMemoryModelCall in
 * the child; tests inject a fake. */
export type MemoryMinerCompleteFn = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; usage?: unknown }>;

export interface MemoryMinerInput {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  /** One bounded LLM call (extract or consolidate). */
  complete: MemoryMinerCompleteFn;
  signal?: AbortSignal;
  /** Best-effort audit log (the run trace). */
  log?: (entry: Record<string, unknown>) => void;
  nowMs?: number;
  /** Test overrides; defaults come from memory-types.ts. */
  segmentChars?: number;
  runChars?: number;
  wallClockMs?: number;
}

export interface MemoryMinerRunResult {
  ok: boolean;
  /** Failure reason naming the session/segment and budget; null on success. */
  errorText?: string;
  committedSessions: number;
  committedOps: number;
  /** Sessions left partially mined (cursor < total) because a budget hit. */
  partialSessions: string[];
  segmentsUsed: number;
  charsUsed: number;
}

interface MemoryMineCandidate {
  id: string;
  kind: MemoryKnowledgeKind;
  memoryText: string;
  evidenceText: string;
}

interface MemoryMineRecall {
  candidate: MemoryMineCandidate;
  hits: Array<{
    prefixedId: string;
    kind: string;
    recurrence: number;
    text: string;
  }>;
}

/** Parse strict JSON output, stripping one optional code fence. */
function parseMinerJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  try {
    const raw = JSON.parse(body) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as T;
  } catch {
    return null;
  }
}

/** Validate one extract candidate; null when malformed. */
function validateExtractCandidate(raw: unknown): MemoryMineCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.kind !== "preference" && c.kind !== "fact") return null;
  if (typeof c.memoryText !== "string") return null;
  if (typeof c.evidenceText !== "string") return null;
  if (validateMemoryBodyText(c.memoryText) !== null) return null;
  if (
    validateMemoryBodyText(c.evidenceText, undefined, "Evidence text") !== null
  ) {
    return null;
  }
  return {
    id: "",
    kind: c.kind,
    memoryText: c.memoryText.trim(),
    evidenceText: c.evidenceText.trim(),
  };
}

/** Validate one consolidate operation; null when malformed. */
function validateConsolidateOp(raw: unknown): MemoryDreamerOperation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const op = raw as Record<string, unknown>;
  switch (op.op) {
    case "create": {
      if (op.kind !== "preference" && op.kind !== "fact") return null;
      if (
        typeof op.memoryText !== "string" ||
        typeof op.evidenceText !== "string"
      )
        return null;
      if (validateMemoryBodyText(op.memoryText) !== null) return null;
      if (
        validateMemoryBodyText(op.evidenceText, undefined, "Evidence text") !==
        null
      )
        return null;
      return {
        op: "create",
        kind: op.kind,
        memoryText: op.memoryText.trim(),
        evidenceText: op.evidenceText.trim(),
      };
    }
    case "update": {
      if (typeof op.memoryId !== "string") return null;
      const id = parseMemoryNodeId(op.memoryId);
      if (!id.ok || id.type !== "memory") return null;
      if (typeof op.evidenceText !== "string") return null;
      if (
        validateMemoryBodyText(op.evidenceText, undefined, "Evidence text") !==
        null
      )
        return null;
      if (op.memoryText !== undefined) {
        if (typeof op.memoryText !== "string") return null;
        if (validateMemoryBodyText(op.memoryText) !== null) return null;
        return {
          op: "update",
          memoryId: id.prefixed,
          evidenceText: op.evidenceText.trim(),
          memoryText: op.memoryText.trim(),
        };
      }
      return {
        op: "update",
        memoryId: id.prefixed,
        evidenceText: op.evidenceText.trim(),
      };
    }
    case "forget": {
      if (typeof op.memoryId !== "string") return null;
      const id = parseMemoryNodeId(op.memoryId);
      if (!id.ok || id.type !== "memory") return null;
      if (typeof op.evidenceText !== "string") return null;
      if (
        validateMemoryBodyText(op.evidenceText, undefined, "Evidence text") !==
        null
      )
        return null;
      return {
        op: "forget",
        memoryId: id.prefixed,
        evidenceText: op.evidenceText.trim(),
      };
    }
    case "no_op": {
      if (op.reason !== undefined && typeof op.reason !== "string") return null;
      return {
        op: "no_op",
        reason: typeof op.reason === "string" ? op.reason : undefined,
      };
    }
    default:
      return null;
  }
}

const MINING_EXTRACT_SYSTEM_PROMPT = `You extract durable user preferences and workspace facts from pi coding-agent session transcripts into a memory store.

Extract ONLY:
- Explicitly stated user preferences (including single strong explicit statements)
- Independently recurring inferred behavioral preferences
- Stable workspace facts (architecture, conventions, tooling, ownership)

Exclude: one-off instructions and transient task state, activity logs and status narration, trivia and low-signal chit-chat, secrets and credentials, unsupported inference, implementation details that will change within the current task, and anything already visible only inside tool output.

Rules:
- One real preference or fact = one candidate; consolidate repeats within the segment.
- memoryText: distilled durable wording, one line, atomic, at most 400 characters.
- evidenceText: a verbatim quote from the transcript that supports it, at most 400 characters. Never invent evidence.
- Respond ONLY with strict JSON, no prose: {"candidates":[{"kind":"preference"|"fact","memoryText":"...","evidenceText":"..."}]}
- Emit at most 12 candidates. Empty extraction is valid: {"candidates":[]}`;

const MINING_CONSOLIDATE_SYSTEM_PROMPT = `You finalize memory operations for one source session. The session's extracted candidate memories are listed, each with recall results from the existing memory store.

Decide one operation per candidate:
- create: the candidate is durable and no active memory already captures it.
- update: an active memory (M:n) already captures it — pass that id. Include memoryText only when the wording should change (refinement); omit it to record a restatement with the same wording.
- forget: the candidate shows a stored memory is wrong and nothing replaces it.
- no_op: the candidate is not durable after all.

Rules:
- One user preference or workspace fact = one memory. Never emit two operations that say the same thing.
- Prefer update over create when a recall hit clearly captures the candidate.
- Never invent M:n ids; only use ids listed in the recall results.
- Respond ONLY with strict JSON, no prose:
  {"operations":[{"op":"create","kind":"preference"|"fact","memoryText":"...","evidenceText":"..."} | {"op":"update","memoryId":"M:n","evidenceText":"...","memoryText":"..."?} | {"op":"forget","memoryId":"M:n","evidenceText":"..."} | {"op":"no_op","reason":"..."?}]}
- An empty decision list is valid: {"operations":[]}`;

interface SessionMineContext {
  db: DatabaseSync;
  runId: string;
  complete: MemoryMinerCompleteFn;
  signal?: AbortSignal;
  log?: (entry: Record<string, unknown>) => void;
  entry: MemoryDreamManifestEntry;
  segmentChars: number;
  runChars: number;
  wallClockMs: number;
  startedAt: number;
  /** Chars already consumed by earlier segments in this pass (budget check). */
  charsUsed: number;
}

interface SessionMineOutcome {
  kind: "done" | "partial";
  ops: MemoryDreamerOperation[];
  segmentsUsed: number;
  charsUsed: number;
}

/** Commit input shaped from the manifest entry; `totalMessages` records the
 * snapshot's visible-message count so a cursor below it stays eligible. */
function commitInput(
  ctx: SessionMineContext,
  ops: MemoryDreamerOperation[],
  minedMessageOffset: number,
  totalMessages: number,
) {
  return {
    runId: ctx.runId,
    sourceSessionId: ctx.entry.sessionId,
    sessionPath: ctx.entry.sessionPath,
    cwd: ctx.entry.cwd,
    processedMtimeMs: ctx.entry.mtimeMs,
    contentHash: ctx.entry.contentHash,
    minedMessageOffset,
    totalMessages,
    plan: { operations: ops },
  };
}

function elapsedMs(ctx: SessionMineContext): number {
  return Date.now() - ctx.startedAt;
}

/** One extract LLM call with one corrective retry; throws on persistent
 * malformed output so the run fails with the session/segment named. */
async function extractCandidates(
  ctx: SessionMineContext,
  seg: MemorySessionEvidenceSegment,
  total: number,
): Promise<MemoryMineCandidate[]> {
  const userBase = `Session ${ctx.entry.sessionId}: messages ${seg.startIndex} to ${Math.max(seg.startIndex, seg.endIndex - 1)} of ${total} visible messages.

${seg.text}

Respond with strict JSON: {"candidates":[{"kind":"preference"|"fact","memoryText":"...","evidenceText":"verbatim quote..."}]}`;
  let user = userBase;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ctx.complete({
      system: MINING_EXTRACT_SYSTEM_PROMPT,
      user,
      signal: ctx.signal,
    });
    const parsed = parseMinerJson<{ candidates?: unknown }>(res.text);
    const candidates: MemoryMineCandidate[] = [];
    if (parsed && Array.isArray(parsed.candidates)) {
      for (const raw of parsed.candidates) {
        const c = validateExtractCandidate(raw);
        if (c) {
          c.id = `C${candidates.length + 1}`;
          candidates.push(c);
        }
      }
      if (candidates.length <= MEMORY_MINE_MAX_CANDIDATES_PER_SEGMENT) {
        ctx.log?.({
          step: "extract",
          sessionId: ctx.entry.sessionId,
          segment: seg.startIndex,
          chars: seg.chars,
          candidates: candidates.length,
        });
        return candidates;
      }
    }
    // Malformed or over-cap: one corrective retry, then fail closed.
    user = `${userBase}

Your previous response was not acceptable: it must be strict JSON matching the requested shape, with at most ${MEMORY_MINE_MAX_CANDIDATES_PER_SEGMENT} candidates. Return only the JSON.`;
  }
  throw new Error(
    `extract call returned malformed output for session ${ctx.entry.sessionId} segment ${seg.startIndex}`,
  );
}

/** One consolidate LLM call with one corrective retry; throws on persistent
 * malformed output so the run fails with the session named. */
async function consolidateOps(
  ctx: SessionMineContext,
  candidates: MemoryMineCandidate[],
  recalls: MemoryMineRecall[],
): Promise<MemoryDreamerOperation[]> {
  const recallByCandidate = new Map(
    recalls.map((r) => [r.candidate.id, r.hits] as const),
  );
  const lines = candidates.map((c) => {
    const hits =
      (recallByCandidate.get(c.id) ?? [])
        .slice(0, 3)
        .map(
          (h) =>
            `  - ${h.prefixedId} [${h.kind}] (recurrence ${h.recurrence}): ${h.text.slice(0, 200)}`,
        )
        .join("\n") || "  (no active memory matched)";
    return `C${c.id.slice(1)} [${c.kind}]
memoryText: ${c.memoryText}
evidenceText: ${c.evidenceText}
recall:
${hits}`;
  });
  const userBase = `Session ${ctx.entry.sessionId}.

Candidates:
${lines.join("\n\n")}

Respond with strict JSON: {"operations":[...]} per the system prompt.`;
  let user = userBase;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ctx.complete({
      system: MINING_CONSOLIDATE_SYSTEM_PROMPT,
      user,
      signal: ctx.signal,
    });
    const parsed = parseMinerJson<{ operations?: unknown }>(res.text);
    const ops: MemoryDreamerOperation[] = [];
    if (parsed && Array.isArray(parsed.operations)) {
      let valid = true;
      for (const raw of parsed.operations) {
        const op = validateConsolidateOp(raw);
        if (!op) {
          valid = false;
          break;
        }
        ops.push(op);
      }
      if (valid) {
        ctx.log?.({
          step: "consolidate",
          sessionId: ctx.entry.sessionId,
          operations: ops.length,
        });
        return ops;
      }
    }
    user = `${userBase}

Your previous response was not acceptable: it must be strict JSON matching the operation schema. Return only the JSON.`;
  }
  throw new Error(
    `consolidate call returned malformed output for session ${ctx.entry.sessionId}`,
  );
}

/** Mine one manifest session. Returns "done" (fully mined and committed) or
 * "partial" (a run budget exhausted mid-session; a partial checkpoint was
 * committed so the next run resumes at the cursor). */
async function mineMemorySession(
  ctx: SessionMineContext,
): Promise<SessionMineOutcome> {
  const decoded = loadVerifiedMemorySessionSnapshot(
    ctx.entry.snapshotPath,
    ctx.entry.contentHash,
  );
  const total = countMemorySessionEvidence(decoded);
  const segments = segmentMemorySessionEvidence(decoded, {
    startOffset: ctx.entry.minedMessageOffset,
    maxChars: ctx.segmentChars,
  });

  if (segments.length === 0) {
    // Nothing new to mine (already fully mined, or no visible evidence):
    // checkpoint the session as fully processed with a no-op.
    const ops: MemoryDreamerOperation[] = [
      { op: "no_op", reason: "no new evidence in this session" },
    ];
    commitMemoryDreamSession(ctx.db, commitInput(ctx, ops, total, total));
    return { kind: "done", ops, segmentsUsed: 0, charsUsed: 0 };
  }

  const candidates: MemoryMineCandidate[] = [];
  let segmentsUsed = 0;
  let charsUsed = 0;
  for (const seg of segments) {
    // Budgets are checked structurally, before the call, so a segment is
    // never started that cannot be paid for.
    if (
      ctx.charsUsed + charsUsed + seg.chars > ctx.runChars ||
      elapsedMs(ctx) >= ctx.wallClockMs
    ) {
      // Partial progress point: commit the cursor reached so far (no ops)
      // so a later run resumes exactly here instead of re-reading.
      commitMemoryDreamSession(
        ctx.db,
        commitInput(ctx, [], seg.startIndex, total),
      );
      return { kind: "partial", ops: [], segmentsUsed, charsUsed };
    }
    const out = await extractCandidates(ctx, seg, total);
    candidates.push(...out);
    segmentsUsed += 1;
    charsUsed += seg.chars;
    // Progress checkpoint between segments: a hard failure later in this
    // session must not force a re-read of this segment. Never checkpoint
    // after the LAST segment — the final commit below applies the ops and
    // advances the cursor to the end; a checkpoint already at the end would
    // make that commit look like a replay and drop the operations.
    if (seg.endIndex < total) {
      commitMemoryDreamSession(
        ctx.db,
        commitInput(ctx, [], seg.endIndex, total),
      );
    }
  }

  const recalls: MemoryMineRecall[] = [];
  for (const candidate of candidates) {
    const result = await findMemoryCandidates(ctx.db, candidate.memoryText, {
      maxUnits: 5,
      signal: ctx.signal,
    });
    recalls.push({
      candidate,
      hits: result.candidates.map((c) => ({
        prefixedId: c.prefixedId,
        kind: c.kind,
        recurrence: c.recurrence,
        text: c.text,
      })),
    });
  }

  const ops = await consolidateOps(ctx, candidates, recalls);
  // Final commit applies the real ops and advances the cursor to the end,
  // marking the session fully mined.
  commitMemoryDreamSession(ctx.db, commitInput(ctx, ops, total, total));
  return { kind: "done", ops, segmentsUsed, charsUsed };
}

/**
 * Run one deterministic memory dream pass over a run manifest. Never throws
 * for model, budget, or per-session outcomes: every failure is returned as
 * `ok: false` with an error text naming the session/segment. Throws only for
 * a manifest read failure (the caller marks the run failed).
 */
export async function runMemoryDreamMining(
  input: MemoryMinerInput,
): Promise<MemoryMinerRunResult> {
  const startedAt = input.nowMs ?? Date.now();
  const segmentChars = input.segmentChars ?? MEMORY_MINE_SEGMENT_CHARS;
  const runChars = input.runChars ?? MEMORY_MINE_RUN_CHARS;
  const wallClockMs = input.wallClockMs ?? MEMORY_MINE_WALL_CLOCK_MS;
  const entries = readMemoryDreamManifest(input.manifestPath);
  const result: MemoryMinerRunResult = {
    ok: true,
    committedSessions: 0,
    committedOps: 0,
    partialSessions: [],
    segmentsUsed: 0,
    charsUsed: 0,
  };
  let stopReason: string | undefined;

  for (const entry of entries) {
    const ctx: SessionMineContext = {
      db: input.db,
      runId: input.runId,
      complete: input.complete,
      signal: input.signal,
      log: input.log,
      entry,
      segmentChars,
      runChars,
      wallClockMs,
      startedAt,
      charsUsed: result.charsUsed,
    };
    if (elapsedMs(ctx) >= wallClockMs) {
      stopReason = `wall-clock budget (${wallClockMs} ms) exhausted before session ${entry.sessionId}`;
      break;
    }
    if (result.charsUsed >= runChars) {
      stopReason = `run char budget (${runChars} chars) exhausted before session ${entry.sessionId}`;
      break;
    }
    input.log?.({ step: "session_start", sessionId: entry.sessionId });
    let outcome: SessionMineOutcome;
    try {
      outcome = await mineMemorySession(ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      stopReason = `session ${entry.sessionId}: ${detail}`;
      break;
    }
    result.segmentsUsed += outcome.segmentsUsed;
    result.charsUsed += outcome.charsUsed;
    if (outcome.kind === "partial") {
      result.partialSessions.push(entry.sessionId);
      stopReason = `run budgets exhausted mid-session ${entry.sessionId}; session partially mined (next dream resumes at the cursor)`;
      break;
    }
    result.committedSessions += 1;
    result.committedOps += outcome.ops.length;
    input.log?.({
      step: "session_committed",
      sessionId: entry.sessionId,
      operations: outcome.ops.length,
    });
  }

  if (stopReason) {
    result.ok = false;
    result.errorText = stopReason;
  }
  return result;
}
