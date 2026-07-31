/**
 * Agent tools: memory_search and memory_open.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { searchMemoryHybrid } from "../shared/memory-search-index.ts";
import {
  planRelevantMemoryBriefing,
  refreshMemoryBriefingPlanNodes,
} from "../shared/memory-recall-planner.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import { completeMemoryModelCall } from "../shared/memory-completion.ts";
import {
  openMemoryNodeExact,
  recordMemoryRecallEvent,
} from "../shared/memory-graph.ts";
import { loadBriefingPlannerPrompt } from "../shared/memory-prompts.ts";
import {
  composeMemoryAbortSignal,
  isMemoryQueryBlank,
  throwIfMemoryAborted,
} from "../shared/memory-abort.ts";
import { MEMORY_RECALL_OPERATION_TIMEOUT_MS } from "../shared/memory-types.ts";

export interface MemoryToolsContext {
  getDb: () => DatabaseSync;
  getConfig: () => MemoryWorkspaceConfig;
  getModelRegistry: () => MemoryModelRegistryLike;
  getSessionModel: () => { provider?: string; id?: string } | null | undefined;
  getPiSessionId: () => string | null | undefined;
}

function formatOpenResult(result: ReturnType<typeof openMemoryNodeExact>): string {
  const lines: string[] = [];
  const t = result.target;
  lines.push(`# ${t.prefixedId} (${t.nodeType}${t.state ? `, ${t.state}` : ""})`);
  if (t.kind) lines.push(`kind: ${t.kind}`);
  if (t.heat !== undefined) lines.push(`heat: ${t.heat.toFixed(3)}`);
  if (t.recurrence !== undefined) lines.push(`recurrence: ${t.recurrence}`);
  lines.push("");
  lines.push(t.text);
  if (result.versions && result.versions.length > 1) {
    lines.push("");
    lines.push("## Version history");
    for (const v of result.versions) {
      lines.push(`- v${v.id} (${v.createdAt}): ${v.text}`);
    }
  }
  if (result.children.length) {
    lines.push("");
    lines.push("## Children");
    for (const c of result.children) {
      lines.push(
        `- **${c.prefixedId}** (${c.kind}${c.state ? `, ${c.state}` : ""}): ${c.text}`,
      );
    }
  }
  if (result.lateral.length) {
    lines.push("");
    lines.push("## Lateral links");
    for (const l of result.lateral) {
      lines.push(`- ${l.relation} ${l.direction} ${l.prefixedId}`);
    }
  }
  if (result.continuationCursor) {
    lines.push("");
    lines.push(
      `More children available. Call memory_open with cursor=${result.continuationCursor}`,
    );
  }
  return lines.join("\n");
}

/**
 * Register memory_search and memory_open on the parent extension.
 */
export function registerMemoryAgentTools(
  pi: ExtensionAPI,
  ctx: MemoryToolsContext,
): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search workspace memory with hybrid retrieval and LLM filtering. Returns only complete, planner-approved nodes (never raw BM25 hits).",
    promptSnippet: "Search durable workspace memory with memory_search",
    promptGuidelines: [
      "Use memory_search when you need preferences or workspace facts beyond the opening briefing.",
      "Use memory_open to drill into a specific M:/S:/O: id from search or the briefing.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query" }),
    }),
    async execute(_toolCallId, params, signal) {
      const effectiveSignal = composeMemoryAbortSignal(
        signal ?? undefined,
        MEMORY_RECALL_OPERATION_TIMEOUT_MS,
      );
      throwIfMemoryAborted(effectiveSignal);
      if (isMemoryQueryBlank(params.query)) {
        return {
          content: [{ type: "text" as const, text: "No matching memories." }],
          details: {
            count: 0,
            semanticDegraded: false,
            semanticError: null,
            usage: undefined as unknown,
            selectedIds: [] as string[],
          },
        };
      }

      const db = ctx.getDb();
      const config = ctx.getConfig();
      const hybrid = await searchMemoryHybrid(db, params.query, {
        limit: config.hybridPoolSize,
        rrfK: config.rrfK,
        modelId: config.embeddingModel,
        semanticFloor: config.semanticFloor,
        signal: effectiveSignal,
      });
      throwIfMemoryAborted(effectiveSignal);

      if (hybrid.candidates.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching memories." }],
          details: {
            count: 0,
            semanticDegraded: hybrid.semanticDegraded,
            semanticError: hybrid.semanticError ?? null,
            usage: undefined as unknown,
            selectedIds: [] as string[],
          },
        };
      }

      const sessionModelId = formatSessionModelId(ctx.getSessionModel());
      const resolved = resolveMemoryModel(
        "recallModel",
        config.recallModel,
        sessionModelId,
        ctx.getModelRegistry(),
        config.recallThinking,
      );
      if (!resolved.ok) {
        throw new Error(`memory_search: ${resolved.error}`);
      }

      const registry = ctx.getModelRegistry();
      const planned = await planRelevantMemoryBriefing({
        query: params.query,
        candidates: hybrid.candidates,
        tokenBudget: config.briefingTokenBudget,
        signal: effectiveSignal,
        db,
        plannerPrompt: loadBriefingPlannerPrompt(),
        complete: ({ system, user, signal: s }) =>
          completeMemoryModelCall(registry, resolved.resolved, {
            system,
            user,
            signal: s,
          }),
      });
      throwIfMemoryAborted(effectiveSignal);

      if (!planned.ok) {
        throw new Error(`memory_search planner failed: ${planned.error}`);
      }

      // Re-read selected nodes before rendering; drop any that are no longer
      // active or whose text changed since planning.
      const refreshed = refreshMemoryBriefingPlanNodes(db, planned.plan);
      throwIfMemoryAborted(effectiveSignal);

      if (refreshed.selectedIds.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No relevant memories after filtering.",
            },
          ],
          details: {
            count: 0,
            usage: planned.usage as unknown,
            selectedIds: [] as string[],
            semanticDegraded: hybrid.semanticDegraded,
            semanticError: hybrid.semanticError ?? null,
          },
        };
      }

      const lines: string[] = ["# Memory search results", ""];
      for (const section of refreshed.sections) {
        lines.push(`## ${section.label}`);
        for (const node of section.nodes) {
          lines.push(
            `- **${node.prefixedId}** (${node.kind}): ${node.text}`,
          );
          recordMemoryRecallEvent(db, {
            nodeType: node.nodeType,
            nodeId: Number(node.prefixedId.slice(2)),
            source: "search",
            piSessionId: ctx.getPiSessionId(),
          });
        }
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n").trim() }],
        details: {
          count: refreshed.selectedIds.length,
          selectedIds: refreshed.selectedIds as string[],
          usage: planned.usage as unknown,
          semanticDegraded: hybrid.semanticDegraded,
          semanticError: hybrid.semanticError ?? null,
        },
      };
    },
  });

  pi.registerTool({
    name: "memory_open",
    label: "Memory Open",
    description:
      "Open a memory/summary/observation by id (M:/S:/O:). Returns the complete target plus one deeper level and lateral link ids.",
    promptSnippet: "Open a memory node with memory_open",
    promptGuidelines: [
      "Use memory_open with an id from the briefing or memory_search to see supporting observations or summary members.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Node id such as M:12, S:3, or O:7",
      }),
      cursor: Type.Optional(
        Type.String({
          description: "Continuation cursor from a previous memory_open",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const db = ctx.getDb();
      const result = openMemoryNodeExact(db, params.id, {
        cursor: params.cursor,
      });
      const parsedType = result.target.nodeType;
      if (parsedType === "memory" || parsedType === "summary") {
        recordMemoryRecallEvent(db, {
          nodeType: parsedType,
          nodeId: Number(result.target.prefixedId.slice(2)),
          source: "open",
          piSessionId: ctx.getPiSessionId(),
        });
      }
      return {
        content: [
          { type: "text" as const, text: formatOpenResult(result) },
        ],
        details: {
          id: result.target.prefixedId,
          childCount: result.children.length,
          continuationCursor: result.continuationCursor,
        },
      };
    },
  });
}
