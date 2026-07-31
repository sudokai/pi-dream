/**
 * First-turn visible memory briefing: hybrid search → LLM planner → custom message.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  formatMemoryBriefingMessage,
  planRelevantMemoryBriefing,
  refreshMemoryBriefingPlanNodes,
} from "../shared/memory-recall-planner.ts";
import { searchMemoryHybrid } from "../shared/memory-search-index.ts";
import { completeMemoryModelCall } from "../shared/memory-completion.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import {
  incrementMemoryActivityGeneration,
  recordMemoryRecallEvent,
} from "../shared/memory-graph.ts";
import {
  MEMORY_BRIEFING_CUSTOM_TYPE,
  type MemoryBriefingPlan,
} from "../shared/memory-types.ts";
import { readFileSync } from "node:fs";
import { memoryExtensionPath } from "../shared/pi-process-invocation.ts";

/** Maximum time the pre-agent opening briefing may wait without a run signal. */
export const MEMORY_BRIEFING_TIMEOUT_MS = 15_000;

/**
 * Use pi's active run signal when available; before_agent_start otherwise has
 * no run signal, so bound opening briefing work with an independent timeout.
 */
export function createMemoryBriefingSignal(
  signal?: AbortSignal,
  timeoutMs: number = MEMORY_BRIEFING_TIMEOUT_MS,
): AbortSignal {
  return signal ?? AbortSignal.timeout(timeoutMs);
}

export interface BuildMemoryBriefingInput {
  db: DatabaseSync;
  query: string;
  config: MemoryWorkspaceConfig;
  modelRegistry: MemoryModelRegistryLike;
  currentSessionModel?: { provider?: string; id?: string } | null;
  piSessionId?: string | null;
  signal?: AbortSignal;
  /** Injected complete for tests; defaults to the pi-ai provider adapter. */
  complete?: (input: {
    system: string;
    user: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string; usage?: unknown }>;
  /** Injected embedder for tests; defaults to the local MiniLM pipeline. */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
}

export type BuildMemoryBriefingResult =
  | {
      ok: true;
      plan: MemoryBriefingPlan;
      message: {
        customType: string;
        content: string;
        display: true;
        details: Record<string, unknown>;
      } | null;
    }
  | {
      ok: false;
      error: string;
      notice: {
        customType: string;
        content: string;
        display: true;
        details: Record<string, unknown>;
      };
    };

function loadBriefingPlannerPrompt(): string | undefined {
  try {
    return readFileSync(
      memoryExtensionPath("prompts", "memory-briefing-planner.md"),
      "utf-8",
    );
  } catch {
    return undefined;
  }
}

/**
 * Run the full first-turn recall pipeline once.
 * Advances activity generation. Records recall only for rendered nodes.
 */
export async function buildMemorySessionBriefing(
  input: BuildMemoryBriefingInput,
): Promise<BuildMemoryBriefingResult> {
  // Advance generation for this first-turn opportunity regardless of hits.
  incrementMemoryActivityGeneration(input.db);

  const sessionModelId = formatSessionModelId(input.currentSessionModel);
  const resolved = resolveMemoryModel(
    "recallModel",
    input.config.recallModel,
    sessionModelId,
    input.modelRegistry,
    input.config.recallThinking,
  );

  const hybrid = await searchMemoryHybrid(input.db, input.query, {
    limit: input.config.hybridPoolSize,
    rrfK: input.config.rrfK,
    modelId: input.config.embeddingModel,
    semanticFloor: input.config.semanticFloor,
    embed: input.embed,
    signal: input.signal,
  });

  if (hybrid.candidates.length === 0) {
    return {
      ok: true,
      plan: { sections: [], estimatedTokens: 0, selectedIds: [] },
      message: null,
    };
  }

  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      notice: {
        customType: MEMORY_BRIEFING_CUSTOM_TYPE,
        content: `Memory retrieval unavailable: ${resolved.error}`,
        display: true,
        details: { status: "unavailable", error: resolved.error },
      },
    };
  }

  const complete =
    input.complete ??
    (({ system, user, signal }) =>
      completeMemoryModelCall(input.modelRegistry, resolved.resolved, {
        system,
        user,
        signal,
      }));

  const planned = await planRelevantMemoryBriefing({
    query: input.query,
    candidates: hybrid.candidates,
    tokenBudget: input.config.briefingTokenBudget,
    complete,
    signal: input.signal,
    db: input.db,
    plannerPrompt: loadBriefingPlannerPrompt(),
  });

  if (!planned.ok) {
    return {
      ok: false,
      error: planned.error,
      notice: {
        customType: MEMORY_BRIEFING_CUSTOM_TYPE,
        content: `Memory retrieval unavailable: ${planned.error}`,
        display: true,
        details: { status: "unavailable", error: planned.error },
      },
    };
  }

  // Re-read selected nodes from the database before rendering: only nodes
  // still active with unchanged text are rendered.
  const refreshed = refreshMemoryBriefingPlanNodes(input.db, planned.plan);
  if (refreshed.selectedIds.length === 0) {
    return { ok: true, plan: refreshed, message: null };
  }

  for (const section of refreshed.sections) {
    for (const node of section.nodes) {
      recordMemoryRecallEvent(input.db, {
        nodeType: node.nodeType,
        nodeId: Number(node.prefixedId.slice(2)),
        source: "startup",
        piSessionId: input.piSessionId,
      });
    }
  }

  const content = formatMemoryBriefingMessage(refreshed);
  return {
    ok: true,
    plan: refreshed,
    message: {
      customType: MEMORY_BRIEFING_CUSTOM_TYPE,
      content,
      display: true,
      details: {
        status: "ok",
        selectedIds: refreshed.selectedIds,
        estimatedTokens: refreshed.estimatedTokens,
        semanticDegraded: hybrid.semanticDegraded,
      },
    },
  };
}
