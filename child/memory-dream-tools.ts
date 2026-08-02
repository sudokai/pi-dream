/**
 * Internal tools for the detached memory dreamer child.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readMemoryDreamManifest,
  type MemoryDreamManifestEntry,
} from "../shared/memory-session-discovery.ts";
import {
  formatMemorySessionPage,
  loadVerifiedMemorySessionSnapshot,
} from "../shared/memory-session-decode.ts";
import {
  commitMemoryDreamOps,
  commitMemoryDreamSession,
  listMemoryGraphSnapshot,
} from "../shared/memory-repository.ts";
import {
  planMemoryConsolidation,
  readMemoryLastConsolidationInspect,
  type PersistedMemoryConsolidationInspect,
} from "../shared/memory-consolidation.ts";
import type {
  MemoryDreamerOperation,
  MemoryDreamSessionPlan,
} from "../shared/memory-types.ts";
import { MEMORY_AUDIT_CUSTOM_TYPE } from "../shared/memory-types.ts";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { memoryWorkspaceLastInspectPath } from "../shared/memory-workspace-id.ts";

export interface MemoryDreamerChildContext {
  db: DatabaseSync;
  runId: string;
  workspaceId: string;
  manifestPath: string;
  cwd: string;
  config: MemoryWorkspaceConfig;
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
 * Persist the last inspect-time consolidation batch so finalize can hold the
 * dreamer to what it was shown and /memory status can surface it.
 */
export function persistMemoryConsolidationInspect(
  ctx: MemoryDreamerChildContext,
  inspect: PersistedMemoryConsolidationInspect,
): void {
  try {
    const target = memoryWorkspaceLastInspectPath(ctx.workspaceId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(inspect, null, 2)}\n`, "utf-8");
  } catch {
    // Persistence is best-effort; the in-tool listing still shows candidates.
  }
}

function inputBudget(ctx: MemoryDreamerChildContext): number {
  return ctx.config.briefingTokenBudget;
}

/**
 * Merge this run's compaction-rejected candidate keys into the persisted last
 * inspect-time batch so finalize can distinguish "rejected for compaction in
 * this run" (partial progress, a pass state per the completion rules) from
 * "omitted by the dreamer" (a loud failure). Best-effort.
 */
export function mergeMemoryConsolidationRejections(
  ctx: MemoryDreamerChildContext,
  rejectedKeys: string[],
): void {
  if (rejectedKeys.length === 0) return;
  try {
    const target = memoryWorkspaceLastInspectPath(ctx.workspaceId);
    const existing = readMemoryLastConsolidationInspect(target);
    if (!existing || existing.runId !== ctx.runId) return;
    const merged = [
      ...new Set([...(existing.rejectedKeys ?? []), ...rejectedKeys]),
    ];
    fs.writeFileSync(
      target,
      `${JSON.stringify({ ...existing, rejectedKeys: merged }, null, 2)}\n`,
      "utf-8",
    );
  } catch {
    // Best-effort: a failed merge degrades to the attempt-counter heuristic.
  }
}

/**
 * Register dreamer-only tools on the child extension.
 */
export function registerMemoryDreamTools(
  pi: ExtensionAPI,
  ctx: MemoryDreamerChildContext,
): void {
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
      "List current active memories and summaries for reconciliation, plus deterministic consolidation candidates (merges to summarize, promotes to emit).",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = listMemoryGraphSnapshot(ctx.db);
      const plan = await planMemoryConsolidation(ctx.db, {
        config: ctx.config,
      });
      const lines = [
        "# Active memories",
        ...snapshot.memories.map(
          (m) => `- ${m.id} [${m.kind}] r=${m.recurrence}: ${m.text}`,
        ),
        "",
        "# Active summaries",
        ...snapshot.summaries.map(
          (s) => `- ${s.id} v=${s.currentVersionId}: ${s.text}`,
        ),
        "",
        "# Consolidation candidates",
        plan.overBudget
          ? `Top layer is OVER BUDGET: ${plan.layerTokensAfterProjected}/${plan.budget} estimated tokens. All merges below are mandatory.`
          : `Top layer: ${plan.layerTokensAfterProjected}/${plan.budget} estimated tokens (projected).`,
        "",
        "## Merges (emit a summarize op per pair, after all promote ops)",
      ];
      if (plan.merges.length === 0) {
        lines.push("(none)");
      }
      for (const m of plan.merges) {
        const members = m.members.map((x) => x.prefixedId).join(" + ");
        const form =
          m.kind === "extend"
            ? `extend S:${m.summaryId} (expectedVersionId=${m.expectedVersionId}) with ${members}`
            : `merge ${members}`;
        lines.push(
          `- ${form} [similarity=${m.similarity.toFixed(3)}, cap=${m.outputCapTokens} tokens]:`,
        );
        for (const member of m.members) {
          lines.push(`    ${member.prefixedId}: ${member.text}`);
        }
        if (m.kind === "extend" && m.summaryText) {
          lines.push(`    current summary text: ${m.summaryText}`);
        }
      }
      lines.push(
        "",
        "## Promotes (emit a promote op per candidate, all before any merge)",
      );
      if (plan.promotes.length === 0) {
        lines.push("(none)");
      }
      for (const p of plan.promotes) {
        lines.push(
          `- promote ${p.childPrefixedId} from S:${p.parentId} [heat=${p.childHeat.toFixed(3)}, expectedSummaryVersionId=${p.parentVersionId}, remainingMembersAfter=${p.remainingMembersAfter}]`,
        );
      }

      persistMemoryConsolidationInspect(ctx, {
        runId: ctx.runId,
        plannedAt: new Date().toISOString(),
        generation: plan.generation,
        rejectedKeys: [],
        promotes: plan.promotes.map((p) => ({
          key: p.key,
          child: p.childPrefixedId,
          parent: p.parentPrefixedId,
          childHeat: p.childHeat,
          remainingMembersAfter: p.remainingMembersAfter,
        })),
        merges: plan.merges.map((m) => ({
          key: m.key,
          kind: m.kind,
          similarity: m.similarity,
          members: m.members.map((x) => x.prefixedId),
          baselineTokens: m.baselineTokens,
          outputCapTokens: m.outputCapTokens,
          summaryId: m.summaryId,
        })),
        layerTokens: plan.layerTokensAfterProjected,
        overBudget: plan.overBudget,
        budget: plan.budget,
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          snapshot,
          consolidation: {
            promotes: plan.promotes.map((p) => p.key),
            merges: plan.merges.map((m) => m.key),
            overBudget: plan.overBudget,
            layerTokens: plan.layerTokensAfterProjected,
            budget: plan.budget,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_commit_consolidation",
    label: "Commit consolidation ops",
    description:
      "Atomically commit consolidation operations (summarize/promote/no_op only) with post-rewrite budget enforcement. Use to cover the Consolidation candidates listing of the latest memory_inspect_graph call; the only commit tool usable when the manifest is empty.",
    parameters: Type.Object({
      operations: Type.Array(Type.Any(), {
        description:
          "Consolidation ops: summarize (create or extend form) and promote only",
      }),
    }),
    async execute(_id, params) {
      const operations = parseOperations(params.operations);
      if (operations.length === 0) {
        operations.push({ op: "no_op", reason: "no consolidation candidates" });
      }
      const result = commitMemoryDreamOps(ctx.db, {
        runId: ctx.runId,
        operations,
        config: ctx.config,
      });
      mergeMemoryConsolidationRejections(
        ctx,
        result.rejectedKeys.map((r) => r.key),
      );
      for (const entry of result.auditEntries) {
        try {
          pi.appendEntry(MEMORY_AUDIT_CUSTOM_TYPE, entry);
        } catch {
          // appendEntry is optional outside interactive TUI sessions.
        }
      }
      let text = result.coveredKeys.length
        ? `Consolidation commit applied (${result.coveredKeys.length} candidate(s) covered).`
        : `Consolidation commit applied (no candidates covered).`;
      if (result.fallbackKeys.length) {
        text += ` Fallback text applied for: ${result.fallbackKeys.join(", ")}.`;
      }
      if (result.rejectedKeys.length) {
        text += ` Rejected for compaction: ${result.rejectedKeys
          .map((r) => `${r.key} (attempt ${r.attempts})`)
          .join(", ")}.`;
      }
      if (result.layerOverBudget) {
        text += ` Top layer still over budget (${result.layerTokensAfter}/${inputBudget(ctx)} tokens); more merges are needed.`;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: {
          coveredKeys: result.coveredKeys,
          rejectedKeys: result.rejectedKeys,
          fallbackKeys: result.fallbackKeys,
          layerTokensBefore: result.layerTokensBefore,
          layerTokensAfter: result.layerTokensAfter,
          layerOverBudget: result.layerOverBudget,
          auditEntries: result.auditEntries,
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
        description:
          "Dreamer operations: create, reinforce, revise, supersede, conflict, link, summarize, or no_op",
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
