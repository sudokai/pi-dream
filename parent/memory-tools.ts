/**
 * Agent tools: memory_search and memory_open.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  renderPartialSynthesizerMarker,
  synthesizeMemoryAnswer,
} from "../shared/memory-synthesizer.ts";
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
import { listMemoryTreeRoots } from "../shared/memory-tree.ts";
import {
  composeMemoryAbortSignal,
  isMemoryQueryBlank,
  throwIfMemoryAborted,
} from "../shared/memory-abort.ts";
import { describeMemoryOverBudgetRecovery } from "../shared/memory-consolidation.ts";
import { parsePrefixedNodeId } from "../shared/memory-types.ts";

export interface MemoryToolsContext {
  getDb: () => DatabaseSync;
  getConfig: () => MemoryWorkspaceConfig;
  getModelRegistry: () => MemoryModelRegistryLike;
  getSessionModel: () => { provider?: string; id?: string } | null | undefined;
  getPiSessionId: () => string | null | undefined;
}

function formatOpenResult(
  result: ReturnType<typeof openMemoryNodeExact>,
): string {
  const lines: string[] = [];
  const t = result.target;
  lines.push(
    `# ${t.prefixedId} (${t.nodeType}${t.state ? `, ${t.state}` : ""})`,
  );
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
      "Search workspace memory with the memory synthesizer. Returns a synthesized answer grounded in the memory tree, never raw hits. If the synthesis is interrupted, returns a best-effort answer marked partial.",
    promptSnippet: "Search durable workspace memory with memory_search",
    promptGuidelines: [
      "Use memory_search when you need preferences or workspace facts beyond the opening briefing.",
      "The answer is self-contained: the synthesizer reads the top layer and opens summaries internally as needed, so one call already carries the detail beneath it.",
      "Use memory_open only when you need the raw text of a specific id — to quote exact wording or inspect the observations behind a claim.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query" }),
    }),
    async execute(
      _toolCallId: string,
      params: { query: string },
      signal?: AbortSignal,
    ): Promise<
      AgentToolResult<{
        sources: string[];
        partial?: boolean;
        reason?: string;
      }>
    > {
      // No separate timeout: pi's tool signal is the only cancellation.
      const effectiveSignal = composeMemoryAbortSignal(signal ?? undefined);
      throwIfMemoryAborted(effectiveSignal);
      if (isMemoryQueryBlank(params.query)) {
        return {
          content: [
            { type: "text" as const, text: "No relevant memories found." },
          ],
          details: {
            sources: [] as string[],
          },
        };
      }

      const db = ctx.getDb();
      const config = ctx.getConfig();
      if (listMemoryTreeRoots(db).length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No relevant memories found." },
          ],
          details: {
            sources: [] as string[],
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

      const result = await synthesizeMemoryAnswer({
        db,
        request: params.query,
        config,
        modelRegistry: ctx.getModelRegistry(),
        sessionModel: resolved.resolved,
        signal: effectiveSignal,
        complete: ({ system, user, signal: s }) =>
          completeMemoryModelCall(ctx.getModelRegistry(), resolved.resolved, {
            system,
            user,
            signal: s,
          }),
      });
      throwIfMemoryAborted(effectiveSignal);

      if (!result.ok) {
        if (result.error === "top_layer_over_budget") {
          throw new Error(
            `top layer over budget (${result.layerTokens}/${result.budget} tokens); ${describeMemoryOverBudgetRecovery(db, { config })}`,
          );
        }
        throw new Error(`memory_search synthesizer failed: ${result.error}`);
      }

      if (result.partial) {
        // Interrupted synthesis that still finalized: return the best-effort
        // answer with an explicit marker; no recall events on partial runs.
        return {
          content: [
            {
              type: "text" as const,
              text: `${renderPartialSynthesizerMarker(result.partial.reason)}\n\n${result.answer}`,
            },
          ],
          details: {
            sources: result.sources as string[],
            partial: true,
            reason: result.partial.reason,
          },
        };
      }

      // Record recall events: sources are selection (search); opened summaries
      // are browse (open). A node that is both gets exactly one event.
      const recorded = new Set<string>();
      for (const sourceId of result.sources) {
        const parsed = parsePrefixedNodeId(sourceId);
        if (!parsed.ok || parsed.type === "observation") continue;
        recordMemoryRecallEvent(db, {
          nodeType: parsed.type,
          nodeId: parsed.id,
          source: "search",
          piSessionId: ctx.getPiSessionId(),
        });
        recorded.add(`${parsed.type}:${parsed.id}`);
      }
      for (const openedId of result.openedSummaryIds) {
        const parsed = parsePrefixedNodeId(openedId);
        if (!parsed.ok || parsed.type !== "summary") continue;
        if (recorded.has(`summary:${parsed.id}`)) continue;
        recordMemoryRecallEvent(db, {
          nodeType: "summary",
          nodeId: parsed.id,
          source: "open",
          piSessionId: ctx.getPiSessionId(),
        });
        recorded.add(`summary:${parsed.id}`);
      }

      return {
        content: [{ type: "text" as const, text: result.answer }],
        // Agent-facing provenance only: sources name the nodes the answer
        // relies on. Navigation internals (opened summaries, steps, usage)
        // are harness bookkeeping and stay out of the tool result.
        details: {
          sources: result.sources as string[],
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
      "Use memory_open with an id from the briefing or a search answer to see supporting observations or summary members.",
      "Descend for more detail: the result lists children under `## Children` — open a summary or memory from there to reveal the level below, and repeat until the task has enough detail.",
      "A summary condenses its children: opening one shows the raw memories its text compresses. Observations are leaves — they hold no children.",
      "When a result holds more children than it displays, it prints a cursor — call again with cursor=<cursor> to continue.",
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
        content: [{ type: "text" as const, text: formatOpenResult(result) }],
        // The content carries the node, its children, and the paging hint;
        // the structured cursor is the only detail the agent needs to
        // continue a drill-down.
        details: {
          continuationCursor: result.continuationCursor,
        },
      };
    },
  });
}
