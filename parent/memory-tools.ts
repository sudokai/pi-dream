/**
 * Agent tools: exactly one — memory_search. Memories are capped at 400 chars
 * and rendered in full everywhere the agent sees them, so opening one reveals
 * no new claim; provenance remains an audit question served by /memory open.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { synthesizeMemoryContext } from "../shared/memory-synthesizer.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import { completeMemoryModelCall } from "../shared/memory-completion.ts";
import { recordMemoryCitation } from "../shared/memory-graph.ts";
import { findMemoryCandidates } from "../shared/memory-retrieval.ts";
import { buildMemorySynthesisPayload } from "../shared/memory-payload.ts";
import { setMemoryRecallCapacityError } from "../shared/memory-repository.ts";
import {
  composeMemoryAbortSignal,
  isMemoryQueryBlank,
  throwIfMemoryAborted,
} from "../shared/memory-abort.ts";
import {
  MEMORY_AUDIT_CUSTOM_TYPE,
  parseMemoryNodeId,
} from "../shared/memory-types.ts";

export interface MemoryToolsContext {
  getDb: () => DatabaseSync;
  getConfig: () => MemoryWorkspaceConfig;
  getModelRegistry: () => MemoryModelRegistryLike;
  getSessionModel: () => { provider?: string; id?: string } | null | undefined;
  getPiSessionId: () => string | null | undefined;
}

/**
 * Production sink for synthesis diagnostics (the Phase 2 trigger, parse
 * retries, stale sources): an audit entry via pi.appendEntry, the codebase's
 * existing mechanism for surfacing memory diagnostics. The trigger is the
 * measured event that gates Phase 2 work, so it must be observable in real
 * runs, not only in tests.
 */
export function createMemoryDiagnosticSink(
  pi: ExtensionAPI,
): (entry: Record<string, unknown>) => void {
  return (entry) => {
    try {
      pi.appendEntry(MEMORY_AUDIT_CUSTOM_TYPE, {
        kind: "recall_diagnostic",
        ...entry,
      });
    } catch {
      // appendEntry is optional outside interactive TUI sessions.
    }
  };
}

/**
 * Register memory_search on the parent extension.
 * Disabled configuration rejects without reading the store or recording.
 */
export function registerMemoryAgentTools(
  pi: ExtensionAPI,
  ctx: MemoryToolsContext,
): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search workspace memory with the memory synthesizer. Returns a synthesized answer grounded in retrieved memories, never raw hits.",
    promptSnippet: "Search durable workspace memory with memory_search",
    promptGuidelines: [
      "Use memory_search when you need preferences or workspace facts beyond the opening briefing.",
      "The answer is self-contained: retrieval feeds the synthesizer every candidate above the relevance floor, and one call already carries the detail — no follow-up opens are needed.",
      "Only memories cited as sources are counted; a search that finds nothing returns 'No relevant memories found.' and records no citations.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query" }),
    }),
    async execute(
      _toolCallId: string,
      params: { query: string },
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ sources: string[] }>> {
      // No separate timeout: pi's tool signal is the only cancellation.
      const effectiveSignal = composeMemoryAbortSignal(signal ?? undefined);
      throwIfMemoryAborted(effectiveSignal);

      const config = ctx.getConfig();
      // Master switch: disabled config rejects before reading or recording.
      if (!config.enabled) {
        throw new Error(
          "memory_search is disabled: memory is paused or the workspace config is invalid until repaired.",
        );
      }

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
      const log = createMemoryDiagnosticSink(pi);
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

      const retrieval = await findMemoryCandidates(db, params.query, {
        modelId: config.embeddingModel,
        signal: effectiveSignal,
      });
      const payload = buildMemorySynthesisPayload(retrieval.candidates, {
        log,
      });
      throwIfMemoryAborted(effectiveSignal);
      if (payload.units.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No relevant memories found." },
          ],
          details: {
            sources: [] as string[],
          },
        };
      }

      const result = await synthesizeMemoryContext({
        db,
        purpose: "search",
        request: params.query,
        payload,
        config,
        modelRegistry: ctx.getModelRegistry(),
        sessionModel: resolved.resolved,
        signal: effectiveSignal,
        log,
        complete: ({ system, user, signal: s }) =>
          completeMemoryModelCall(ctx.getModelRegistry(), resolved.resolved, {
            system,
            user,
            signal: s,
          }),
      });
      throwIfMemoryAborted(effectiveSignal);

      if (!result.ok) {
        if (result.error === "provider_context_insufficient") {
          setMemoryRecallCapacityError(db, result.detail ?? result.error);
          throw new Error(
            `memory_search: ${result.detail ?? "the recall model's context cannot hold the complete request"}`,
          );
        }
        throw new Error(
          `memory_search synthesizer failed: ${result.detail ?? result.error}`,
        );
      }

      setMemoryRecallCapacityError(db, null);

      // Record citation events for validated sources only.
      for (const sourceId of result.sources) {
        const parsed = parseMemoryNodeId(sourceId);
        if (!parsed.ok || parsed.type !== "memory") continue;
        recordMemoryCitation(db, {
          nodeType: "memory",
          nodeId: parsed.id,
          source: "search",
          piSessionId: ctx.getPiSessionId(),
        });
      }

      return {
        content: [{ type: "text" as const, text: result.content }],
        // Agent-facing provenance only: sources name the memories the answer
        // relies on.
        details: {
          sources: result.sources as string[],
        },
      };
    },
  });
}
