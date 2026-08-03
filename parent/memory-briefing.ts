/**
 * First-turn visible memory briefing: activity generation advance → synthesizer
 * → synthesized answer + a preference/fact index of the remaining top layer.
 *
 * The activity generation advances on every first-turn recall opportunity
 * (after the abort guard, before model resolution) whether synthesis succeeds
 * or fails; only a pre-aborted attempt does not advance. Synthesizer failure
 * skips silently (no message, no reheat) with an audit payload for the call
 * site to append via pi.appendEntry.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  renderPartialSynthesizerMarker,
  synthesizeMemoryAnswer,
} from "../shared/memory-synthesizer.ts";
import {
  incrementMemoryActivityGeneration,
  recordMemoryRecallEvent,
} from "../shared/memory-graph.ts";
import { listMemoryTreeRoots } from "../shared/memory-tree.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import { describeMemoryOverBudgetRecovery } from "../shared/memory-consolidation.ts";
import {
  MEMORY_BRIEFING_CUSTOM_TYPE,
  MEMORY_BRIEFING_INDEX_MAX_FACTS,
  MEMORY_BRIEFING_INDEX_MAX_PREFERENCES,
  parsePrefixedNodeId,
  type MemoryNodeId,
  type SummaryNodeId,
} from "../shared/memory-types.ts";
import {
  composeMemoryAbortSignal,
  throwIfMemoryAborted,
} from "../shared/memory-abort.ts";

/**
 * Compose pi's active run signal for the opening briefing. There is no
 * separate timeout: Escape on the loader aborts via the call site's
 * AbortController, and pi's run signal aborts when the lifecycle provides
 * one. The briefing runs until synthesis completes or the user cancels.
 */
export function createMemoryBriefingSignal(signal?: AbortSignal): AbortSignal {
  return composeMemoryAbortSignal(signal);
}

export interface BuildMemoryBriefingInput {
  db: DatabaseSync;
  query: string;
  config: MemoryWorkspaceConfig;
  modelRegistry: MemoryModelRegistryLike;
  currentSessionModel?: { provider?: string; id?: string } | null;
  piSessionId?: string | null;
  signal?: AbortSignal;
  /** Answer-now key: when fired, force a finalize from the context gathered so far. */
  finalizeNowSignal?: AbortSignal;
  /** Injected complete for tests; defaults to the pi-ai provider adapter. */
  complete?: (input: {
    system: string;
    user: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string; usage?: unknown }>;
}

export type BuildMemoryBriefingResult =
  | {
      ok: true;
      message: {
        customType: string;
        content: string;
        display: true;
        details: Record<string, unknown>;
      } | null;
      /** Audit payload for the call site to append (pi.appendEntry). */
      audit: Record<string, unknown> | null;
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

/**
 * Render the visible briefing: the synthesized answer plus a preference/fact
 * index of top-layer roots not among the answer's sources (render-only; never
 * heats). Preferences come first, then facts, heat-desc within each kind, each
 * capped (35 / 15). Summaries and rare kinds are not indexed: the synthesizer
 * opens summaries when relevant, and /memory list shows everything.
 */
export function renderMemoryBriefingMessage(
  db: DatabaseSync,
  answer: string,
  sources: Array<MemoryNodeId | SummaryNodeId>,
): string {
  const sourceKeys = new Set(sources as string[]);
  const lines: string[] = [answer.trim(), ""];
  const roots = listMemoryTreeRoots(db).filter(
    (r) => !sourceKeys.has(r.prefixedId),
  );
  const preferences = roots.filter((r) => r.kind === "preference");
  const facts = roots.filter((r) => r.kind === "fact");
  if (preferences.length > 0 || facts.length > 0) {
    lines.push("Other memories:");
    let shown = 0;
    // Deterministic grouping (render-only, no model call): preferences first,
    // then facts, heat-desc within each kind, each capped (35 preferences,
    // 15 facts). Full text is never truncated — the top layer is already
    // bounded by the briefing token budget.
    const groups: Array<[string, typeof roots, number]> = [
      ["Preferences", preferences, MEMORY_BRIEFING_INDEX_MAX_PREFERENCES],
      ["Facts", facts, MEMORY_BRIEFING_INDEX_MAX_FACTS],
    ];
    for (const [heading, group, cap] of groups) {
      if (group.length === 0) continue;
      lines.push(`${heading}:`);
      const ordered = [...group].sort((a, b) => b.heat - a.heat);
      let inGroup = 0;
      for (const root of ordered) {
        if (inGroup >= cap) break;
        // Full text, never truncated: the index is render-only and the top
        // layer is already bounded by the briefing token budget. Texts are
        // guaranteed single-line by validateMemoryBodyText on every write path.
        lines.push(`- ${root.prefixedId} (${root.kind}): ${root.text}`);
        inGroup++;
        shown++;
      }
    }
    if (roots.length > shown) {
      lines.push(
        `… and ${roots.length - shown} more (see /memory list for all)`,
      );
    }
  }
  lines.push(
    "",
    "`memory_search` — ask a question in your own words; the synthesizer answers from the memory tree. `memory_open <id>` — open a memory to see everything beneath it; a summary opens into the raw memories it compresses, with the detail the compression drops.",
  );
  return lines.join("\n");
}

/**
 * Run the first-turn recall pipeline once: advance the activity generation,
 * synthesize an answer from the top layer, record recall events for sources
 * and opened summaries, and render the answer + index. Failures skip silently
 * with an audit payload.
 */
export async function buildMemorySessionBriefing(
  input: BuildMemoryBriefingInput,
): Promise<BuildMemoryBriefingResult> {
  const signal = input.signal;
  throwIfMemoryAborted(signal);

  // Every first-turn recall opportunity advances the generation — on success
  // and failure alike; heat decays with time, not with success.
  incrementMemoryActivityGeneration(input.db);

  const sessionModelId = formatSessionModelId(input.currentSessionModel);
  const resolved = resolveMemoryModel(
    "recallModel",
    input.config.recallModel,
    sessionModelId,
    input.modelRegistry,
    input.config.recallThinking,
  );
  if (!resolved.ok) {
    return {
      ok: true,
      message: null,
      audit: { status: "synthesizer_failed", error: resolved.error },
    };
  }

  if (listMemoryTreeRoots(input.db).length === 0) {
    return { ok: true, message: null, audit: null };
  }

  const result = await synthesizeMemoryAnswer({
    db: input.db,
    request: input.query,
    config: input.config,
    modelRegistry: input.modelRegistry,
    sessionModel: resolved.resolved,
    signal,
    finalizeNowSignal: input.finalizeNowSignal,
    complete: input.complete,
  });

  if (!result.ok) {
    if (result.error === "top_layer_over_budget") {
      return {
        ok: true,
        message: null,
        audit: {
          status: "top_layer_over_budget",
          tokens: result.layerTokens,
          budget: result.budget,
          note: describeMemoryOverBudgetRecovery(input.db, {
            config: input.config,
          }),
        },
      };
    }
    return {
      ok: true,
      message: null,
      audit: { status: "synthesizer_failed", error: result.error },
    };
  }

  if (result.partial) {
    // Interrupted synthesis that still finalized: show the partial answer
    // with an explicit marker; no recall events (partial runs never heat)
    // and the interruption is audited instead.
    const marker = renderPartialSynthesizerMarker(result.partial.reason);
    return {
      ok: true,
      message: {
        customType: MEMORY_BRIEFING_CUSTOM_TYPE,
        content: renderMemoryBriefingMessage(
          input.db,
          `${marker}\n\n${result.answer}`,
          result.sources,
        ),
        display: true,
        details: {
          status: "partial",
          sources: result.sources,
          reason: result.partial.reason,
        },
      },
      audit: {
        status: "synthesizer_partial",
        error: result.partial.reason,
      },
    };
  }

  // Record recall events: sources are selection (startup); opened summaries
  // are browse (open). A node that is both gets exactly one event.
  const recorded = new Set<string>();
  for (const sourceId of result.sources) {
    const parsed = parsePrefixedNodeId(sourceId);
    if (!parsed.ok || parsed.type === "observation") continue;
    recordMemoryRecallEvent(input.db, {
      nodeType: parsed.type,
      nodeId: parsed.id,
      source: "startup",
      piSessionId: input.piSessionId,
    });
    recorded.add(`${parsed.type}:${parsed.id}`);
  }
  for (const openedId of result.openedSummaryIds) {
    const parsed = parsePrefixedNodeId(openedId);
    if (!parsed.ok || parsed.type !== "summary") continue;
    if (recorded.has(`summary:${parsed.id}`)) continue;
    recordMemoryRecallEvent(input.db, {
      nodeType: "summary",
      nodeId: parsed.id,
      source: "open",
      piSessionId: input.piSessionId,
    });
    recorded.add(`summary:${parsed.id}`);
  }

  const content = renderMemoryBriefingMessage(
    input.db,
    result.answer,
    result.sources,
  );
  return {
    ok: true,
    message: {
      customType: MEMORY_BRIEFING_CUSTOM_TYPE,
      content,
      display: true,
      details: {
        // Agent-facing provenance only: sources name the nodes the briefing
        // answer relies on (drill-down targets). Navigation internals stay
        // out of the visible message.
        status: "ok",
        sources: result.sources,
      },
    },
    audit: null,
  };
}
