/**
 * Internal tools for the detached memory dreamer child: ingestion only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readMemoryDreamManifest,
  type MemoryDreamManifestEntry,
} from "../shared/memory-session-discovery.ts";
import {
  formatMemorySessionPage,
  loadVerifiedMemorySessionSnapshot,
} from "../shared/memory-session-decode.ts";
import { findMemoryCandidates } from "../shared/memory-retrieval.ts";
import { commitMemoryDreamSession } from "../shared/memory-repository.ts";
import type {
  MemoryDreamerOperation,
  MemoryDreamSessionPlan,
} from "../shared/memory-types.ts";

export interface MemoryDreamerChildContext {
  db: DatabaseSync;
  runId: string;
  manifestPath: string;
  cwd: string;
}

function loadManifest(
  ctx: MemoryDreamerChildContext,
): MemoryDreamManifestEntry[] {
  return readMemoryDreamManifest(ctx.manifestPath);
}

function parseOperations(raw: unknown): MemoryDreamerOperation[] {
  if (!Array.isArray(raw)) {
    throw new Error("operations must be an array");
  }
  return raw as MemoryDreamerOperation[];
}

/**
 * Best-effort append-only trace of dreamer tool calls, written to
 * `<runDir>/trace.jsonl`. The run dir is retained on failure, so this trace is
 * what makes a failed dream diagnosable: it shows which sessions were listed,
 * read, and committed — and, by absence, which were skipped. Never throws; a
 * trace write must never fail a tool call.
 */
function createDreamerTrace(manifestPath: string) {
  const tracePath = path.join(path.dirname(manifestPath), "trace.jsonl");
  return (event: Record<string, unknown>): void => {
    try {
      fs.appendFileSync(
        tracePath,
        JSON.stringify({ ts: Date.now(), ...event }) + "\n",
        { encoding: "utf-8", flag: "a", mode: 0o600 },
      );
    } catch {
      // Tracing is best-effort; never fail a tool because the trace could not be written.
    }
  };
}

/**
 * Register dreamer-only tools on the child extension.
 */
export function registerMemoryDreamTools(
  pi: ExtensionAPI,
  ctx: MemoryDreamerChildContext,
): void {
  // Highest visible-message index each session has been read to in this run.
  // The incremental cursor advances only to where the dreamer actually read,
  // so an unread tail stays eligible for a later dream and is never lost.
  const maxReadMessageOffsetBySession = new Map<string, number>();
  const trace = createDreamerTrace(ctx.manifestPath);

  pi.registerTool({
    name: "memory_list_sessions",
    label: "List dream sessions",
    description:
      "List eligible source sessions from the run manifest that should be mined.",
    parameters: Type.Object({}),
    async execute() {
      const sessions = loadManifest(ctx);
      const text = sessions
        .map(
          (s, i) =>
            `${i + 1}. sessionId=${s.sessionId} minedUntil=${s.minedMessageOffset} mtime=${s.mtimeMs} snapshot=${s.snapshotPath}`,
        )
        .join("\n");
      trace({ tool: "memory_list_sessions", count: sessions.length });
      return {
        content: [
          {
            type: "text" as const,
            text: text || "No sessions in manifest.",
          },
        ],
        details: { count: sessions.length, sessions },
      };
    },
  });

  pi.registerTool({
    name: "memory_read_session",
    label: "Read dream session",
    description:
      "Page a decoded source session for mining. Use offset to continue.",
    parameters: Type.Object({
      sessionId: Type.String({
        description: "Source session id from the manifest",
      }),
      offset: Type.Optional(
        Type.Number({ description: "Message offset (default 0)" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Page size (default 40)" }),
      ),
    }),
    async execute(_id, params) {
      const sessions = loadManifest(ctx);
      const entry = sessions.find((s) => s.sessionId === params.sessionId);
      if (!entry) {
        throw new Error(`Session not in manifest: ${params.sessionId}`);
      }
      const decoded = loadVerifiedMemorySessionSnapshot(
        entry.snapshotPath,
        entry.contentHash,
      );
      const totalMessages = formatMemorySessionPage(decoded, {
        offset: 0,
        limit: 1,
      }).totalMessages;
      // Incremental mining: without an explicit offset, resume where the
      // prior checkpoint stopped. A snapshot shorter than the cursor
      // (rotation or corruption) resets to a full re-mine rather than
      // reading nothing.
      let start = params.offset ?? entry.minedMessageOffset;
      if (start > totalMessages) start = 0;
      const page = formatMemorySessionPage(decoded, {
        offset: start,
        limit: params.limit ?? 40,
      });
      const readTo = page.nextOffset ?? totalMessages;
      const prior =
        maxReadMessageOffsetBySession.get(entry.sessionId) ??
        entry.minedMessageOffset;
      maxReadMessageOffsetBySession.set(
        entry.sessionId,
        Math.max(prior, readTo),
      );
      const body = page.messages
        .map((m) => `[${m.index}] ${m.role}:\n${m.text}`)
        .join("\n\n");
      const footer =
        page.nextOffset !== null
          ? `\n\n---\nMore messages: call memory_read_session with offset=${page.nextOffset}`
          : "\n\n---\nEnd of session.";
      trace({
        tool: "memory_read_session",
        sessionId: entry.sessionId,
        offset: page.offset,
        nextOffset: page.nextOffset,
        totalMessages: page.totalMessages,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Session ${entry.sessionId} (${page.totalMessages} messages, resuming at ${start})\n\n${body}${footer}`,
          },
        ],
        details: {
          sessionId: entry.sessionId,
          totalMessages: page.totalMessages,
          offset: page.offset,
          nextOffset: page.nextOffset,
          minedMessageOffset: entry.minedMessageOffset,
          cwd: entry.cwd,
          mtimeMs: entry.mtimeMs,
          sessionPath: entry.sessionPath,
          snapshotPath: entry.snapshotPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_commit_session",
    label: "Commit dream session",
    description:
      "Atomically commit structured operations for one source session and checkpoint it. Use no_op when nothing durable was found.",
    parameters: Type.Object({
      sessionId: Type.String({
        description: "Source session id from the manifest",
      }),
      operations: Type.Array(Type.Any(), {
        description: "Dreamer operations: create, update, forget, or no_op",
      }),
    }),
    async execute(_id, params) {
      const sessions = loadManifest(ctx);
      const entry = sessions.find((s) => s.sessionId === params.sessionId);
      if (!entry) {
        throw new Error(`Session not in manifest: ${params.sessionId}`);
      }
      // A commit may be called without a preceding read, so validate the
      // manifest snapshot again before checkpointing its source session.
      const decoded = loadVerifiedMemorySessionSnapshot(
        entry.snapshotPath,
        entry.contentHash,
      );
      const totalMessages = formatMemorySessionPage(decoded, {
        offset: 0,
        limit: 1,
      }).totalMessages;
      // The incremental cursor advances only to where the dreamer actually
      // read; an unread tail stays eligible for a later dream. A snapshot
      // shorter than the prior cursor (rotation or corruption) restarts
      // from a full re-mine.
      const base =
        entry.minedMessageOffset <= totalMessages
          ? entry.minedMessageOffset
          : 0;
      const readTo = maxReadMessageOffsetBySession.get(entry.sessionId) ?? 0;
      const minedMessageOffset = Math.max(
        base,
        Math.min(readTo, totalMessages),
      );
      const operations = parseOperations(params.operations);
      const plan: MemoryDreamSessionPlan = { operations };
      // Ensure empty plan still checkpoints via explicit no_op
      if (plan.operations.length === 0) {
        plan.operations = [{ op: "no_op", reason: "no high-signal updates" }];
      }
      const result = commitMemoryDreamSession(ctx.db, {
        runId: ctx.runId,
        sourceSessionId: entry.sessionId,
        sessionPath: entry.sessionPath,
        cwd: entry.cwd,
        processedMtimeMs: entry.mtimeMs,
        contentHash: entry.contentHash,
        minedMessageOffset,
        plan,
      });
      trace({
        tool: "memory_commit_session",
        sessionId: entry.sessionId,
        applied: result.applied,
        reason: result.reason,
        operationCount: operations.length,
        minedMessageOffset,
        totalMessages,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: result.applied
              ? `Committed session ${entry.sessionId} (${operations.length} op(s), mined through message ${minedMessageOffset}/${totalMessages}).`
              : `Session ${entry.sessionId} already checkpointed (${result.reason}).`,
          },
        ],
        details: {
          sessionId: entry.sessionId,
          applied: result.applied,
          reason: result.reason,
          operationCount: operations.length,
          minedMessageOffset,
          totalMessages,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_recall",
    label: "Recall active memories",
    description:
      "Find active memories matching candidate text. Read-only; never records. Call before create so an existing memory can be updated or forgotten instead of duplicated.",
    parameters: Type.Object({
      text: Type.String({
        description: "Candidate text to match against the store",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max candidates to return (default 10)" }),
      ),
    }),
    async execute(_id, params) {
      const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 10)), 50);
      const result = await findMemoryCandidates(ctx.db, params.text, {
        maxUnits: limit,
      });
      const body = result.candidates.length
        ? result.candidates
            .map(
              (c) =>
                `- ${c.prefixedId} [${c.kind}] (recurrence ${c.recurrence}): ${c.text}`,
            )
            .join("\n")
        : "No matching active memories.";
      trace({
        tool: "memory_recall",
        count: result.candidates.length,
        semanticDegraded: result.semanticDegraded,
      });
      return {
        content: [{ type: "text" as const, text: body }],
        details: {
          count: result.candidates.length,
          semanticDegraded: result.semanticDegraded,
          skipped: result.skipped,
        },
      };
    },
  });
}
