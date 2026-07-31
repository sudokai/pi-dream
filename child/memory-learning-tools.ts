/**
 * Internal tools for the detached memory learner child.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readMemoryLearningManifest,
  type MemoryLearningManifestEntry,
} from "../shared/memory-session-discovery.ts";
import {
  formatMemorySessionPage,
  loadVerifiedMemorySessionSnapshot,
} from "../shared/memory-session-decode.ts";
import {
  commitMemoryLearningSession,
  listMemoryGraphSnapshot,
} from "../shared/memory-repository.ts";
import type {
  MemoryLearnerOperation,
  MemoryLearningSessionPlan,
} from "../shared/memory-types.ts";

export interface MemoryLearnerChildContext {
  db: DatabaseSync;
  runId: string;
  workspaceId: string;
  manifestPath: string;
  cwd: string;
}

function loadManifest(
  ctx: MemoryLearnerChildContext,
): MemoryLearningManifestEntry[] {
  return readMemoryLearningManifest(ctx.manifestPath);
}

function parseOperations(raw: unknown): MemoryLearnerOperation[] {
  if (!Array.isArray(raw)) {
    throw new Error("operations must be an array");
  }
  return raw as MemoryLearnerOperation[];
}

/**
 * Register learner-only tools on the child extension.
 */
export function registerMemoryLearningTools(
  pi: ExtensionAPI,
  ctx: MemoryLearnerChildContext,
): void {
  pi.registerTool({
    name: "memory_list_sessions",
    label: "List learning sessions",
    description:
      "List eligible source sessions from the run manifest that should be mined.",
    parameters: Type.Object({}),
    async execute() {
      const sessions = loadManifest(ctx);
      const text = sessions
        .map(
          (s, i) =>
            `${i + 1}. sessionId=${s.sessionId} mtime=${s.mtimeMs} snapshot=${s.snapshotPath}`,
        )
        .join("\n");
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
    label: "Read learning session",
    description:
      "Page a decoded source session for mining. Use offset to continue.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Source session id from the manifest" }),
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
      const page = formatMemorySessionPage(decoded, {
        offset: params.offset ?? 0,
        limit: params.limit ?? 40,
      });
      const body = page.messages
        .map((m) => `[${m.index}] ${m.role}:\n${m.text}`)
        .join("\n\n");
      const footer =
        page.nextOffset !== null
          ? `\n\n---\nMore messages: call memory_read_session with offset=${page.nextOffset}`
          : "\n\n---\nEnd of session.";
      return {
        content: [
          {
            type: "text" as const,
            text: `Session ${params.sessionId} (${page.totalMessages} messages)\n\n${body}${footer}`,
          },
        ],
        details: {
          sessionId: params.sessionId,
          totalMessages: page.totalMessages,
          offset: page.offset,
          nextOffset: page.nextOffset,
          cwd: entry.cwd,
          mtimeMs: entry.mtimeMs,
          sessionPath: entry.sessionPath,
          snapshotPath: entry.snapshotPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_inspect_graph",
    label: "Inspect memory graph",
    description:
      "List current active memories and summaries for reconciliation.",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = listMemoryGraphSnapshot(ctx.db);
      const lines = [
        "# Active memories",
        ...snapshot.memories.map(
          (m) =>
            `- ${m.id} [${m.kind}] r=${m.recurrence}: ${m.text}`,
        ),
        "",
        "# Active summaries",
        ...snapshot.summaries.map((s) => `- ${s.id}: ${s.text}`),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: snapshot,
      };
    },
  });

  pi.registerTool({
    name: "memory_commit_session",
    label: "Commit learning session",
    description:
      "Atomically commit structured operations for one source session and checkpoint it. Use no_op when nothing durable was found.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Source session id from the manifest" }),
      operations: Type.Array(Type.Any(), {
        description:
          "Learner operations: create, reinforce, revise, supersede, conflict, link, summarize, or no_op",
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
      loadVerifiedMemorySessionSnapshot(entry.snapshotPath, entry.contentHash);
      const operations = parseOperations(params.operations);
      const plan: MemoryLearningSessionPlan = { operations };
      // Ensure empty plan still checkpoints via explicit no_op
      if (plan.operations.length === 0) {
        plan.operations = [{ op: "no_op", reason: "no high-signal updates" }];
      }
      const result = commitMemoryLearningSession(ctx.db, {
        runId: ctx.runId,
        sourceSessionId: entry.sessionId,
        sessionPath: entry.sessionPath,
        cwd: entry.cwd,
        processedMtimeMs: entry.mtimeMs,
        contentHash: entry.contentHash,
        plan,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: result.applied
              ? `Committed session ${entry.sessionId} (${operations.length} op(s)).`
              : `Session ${entry.sessionId} already checkpointed (${result.reason}).`,
          },
        ],
        details: {
          sessionId: entry.sessionId,
          applied: result.applied,
          reason: result.reason,
          operationCount: operations.length,
        },
      };
    },
  });
}
