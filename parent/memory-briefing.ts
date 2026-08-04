/**
 * First-turn visible memory briefing: activity generation advance → retrieval
 * → payload → one synthesis call → deterministic user-preferences section
 * rendered ahead of the call and preserved on cancel.
 *
 * The activity generation advances on every first-turn recall opportunity
 * (after the abort guard, before model resolution) whether synthesis succeeds
 * or fails; only a pre-aborted attempt does not advance. The deterministic
 * user-preferences section is rendered before the model call and survives a
 * cancel or a synthesis failure, so the first turn never leaves the user
 * empty when user preferences exist.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { synthesizeMemoryContext } from "../shared/memory-synthesizer.ts";
import {
  incrementMemoryActivityGeneration,
  listActiveMemories,
  recordMemoryCitation,
} from "../shared/memory-graph.ts";
import { findMemoryCandidates } from "../shared/memory-retrieval.ts";
import { buildMemorySynthesisPayload } from "../shared/memory-payload.ts";
import {
  formatSessionModelId,
  resolveMemoryModel,
  type MemoryModelRegistryLike,
} from "../shared/memory-model.ts";
import { setMemoryRecallCapacityError } from "../shared/memory-repository.ts";
import {
  MEMORY_BRIEFING_CUSTOM_TYPE,
  MEMORY_BRIEFING_MAX_CHARS,
  parseMemoryNodeId,
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
  /** Injected complete for tests; defaults to the pi-ai provider adapter. */
  complete?: (input: {
    system: string;
    user: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string; usage?: unknown }>;
  /** Diagnostic sink (Phase 2 trigger, capacity failures, retries). */
  log?: (entry: Record<string, unknown>) => void;
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
 * Render the deterministic user-preferences section: active preference
 * memories, id-ascending, whole units, capped at MEMORY_BRIEFING_MAX_CHARS
 * (the same ceiling as the synthesized section). This section is the
 * deterministic fallback shown on cancel/failure and on every no-source first
 * turn, so it must stay bounded as the store grows; truncation is by id
 * (deterministic, never by score) and is noted in the rendered text so the
 * agent knows the list is partial. Rendered before the model call and
 * preserved on cancel or synthesis failure.
 */
export function renderMemoryUserPreferences(db: DatabaseSync): string {
  const preferences = listActiveMemories(db).filter(
    (m) => m.kind === "preference",
  );
  if (preferences.length === 0) return "";
  const lines: string[] = [];
  let totalChars = 0;
  let skipped = 0;
  for (const m of preferences) {
    const line = `- M:${m.id} (preference): ${m.text}`;
    if (totalChars + line.length > MEMORY_BRIEFING_MAX_CHARS) {
      skipped++;
      continue;
    }
    lines.push(line);
    totalChars += line.length;
  }
  if (skipped > 0) {
    lines.push(`… and ${skipped} more (see /memory list for all)`);
  }
  return lines.join("\n");
}

/**
 * Render the visible briefing message: task-relevant section first (when the
 * synthesis produced one), then the user preferences section.
 */
export function renderMemoryBriefingMessage(
  userPreferences: string,
  answer: string | null,
): string {
  const sections: string[] = [];
  if (answer !== null && answer.trim()) {
    sections.push(`## Context relevant to this session\n\n${answer.trim()}`);
  }
  if (userPreferences.trim()) {
    sections.push(`## User preferences\n\n${userPreferences.trim()}`);
  }
  sections.push(
    "`memory_search` — ask a question in your own words; the synthesizer answers from workspace memory.",
  );
  return sections.join("\n\n");
}

/**
 * Run the first-turn recall pipeline once: advance the activity generation,
 * render the deterministic user preferences, retrieve candidates, build
 * the bounded payload, and make exactly one synthesis call. Validated sources
 * are recorded as citation events (source `briefing`). Failures preserve the
 * user-preferences section and record no citations.
 */
export async function buildMemorySessionBriefing(
  input: BuildMemoryBriefingInput,
): Promise<BuildMemoryBriefingResult> {
  const signal = input.signal;
  throwIfMemoryAborted(signal);

  // Every first-turn recall opportunity advances the generation — on success
  // and failure alike. The advance deliberately runs BEFORE model resolution:
  // activityGeneration is audit only (displayed in /memory status, stamped as
  // creation_generation on new versions and memories) and never a ranking
  // input, so a workspace with an unresolvable recall model burning one
  // generation per turn corrupts nothing.
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
    // The deterministic section is the only non-model path to durable
    // context; render it even when the recall model cannot be resolved.
    const userPreferences = renderMemoryUserPreferences(input.db);
    return {
      ok: true,
      message: userPreferences
        ? {
            customType: MEMORY_BRIEFING_CUSTOM_TYPE,
            content: renderMemoryBriefingMessage(userPreferences, null),
            display: true,
            details: { status: "no_recall_model", error: resolved.error },
          }
        : null,
      audit: { status: "synthesizer_failed", error: resolved.error },
    };
  }

  const userPreferences = renderMemoryUserPreferences(input.db);
  if (listActiveMemories(input.db).length === 0) {
    return { ok: true, message: null, audit: null };
  }

  // Failure helper: preserve the preference section, audit, never cite.
  const fail = (
    status: string,
    error: string,
    extra: Record<string, unknown> = {},
  ): BuildMemoryBriefingResult => ({
    ok: true,
    message: userPreferences
      ? {
          customType: MEMORY_BRIEFING_CUSTOM_TYPE,
          content: renderMemoryBriefingMessage(userPreferences, null),
          display: true,
          details: { status, error, ...extra },
        }
      : null,
    audit: { status, error, ...extra },
  });

  const retrieval = await findMemoryCandidates(input.db, input.query, {
    modelId: input.config.embeddingModel,
    signal,
  });
  const payload = buildMemorySynthesisPayload(retrieval.candidates, {
    log: input.log,
  });
  if (payload.units.length === 0) {
    // No memory above the relevance floor: no task-relevant section, but the
    // user preferences still render. No model call, no citations.
    return {
      ok: true,
      message: userPreferences
        ? {
            customType: MEMORY_BRIEFING_CUSTOM_TYPE,
            content: renderMemoryBriefingMessage(userPreferences, null),
            display: true,
            details: { status: "no_relevant_memories" },
          }
        : null,
      audit: null,
    };
  }

  const result = await synthesizeMemoryContext({
    db: input.db,
    purpose: "briefing",
    request: input.query,
    payload,
    config: input.config,
    modelRegistry: input.modelRegistry,
    sessionModel: resolved.resolved,
    signal,
    complete: input.complete,
    log: input.log,
  });

  if (!result.ok) {
    if (result.error === "provider_context_insufficient") {
      // Report the condition in /memory status; cleared on the next success.
      setMemoryRecallCapacityError(input.db, result.detail ?? result.error);
      return fail(
        "provider_context_insufficient",
        result.detail ?? result.error,
      );
    }
    if (result.error === "aborted") {
      return {
        ok: true,
        message: userPreferences
          ? {
              customType: MEMORY_BRIEFING_CUSTOM_TYPE,
              content: renderMemoryBriefingMessage(userPreferences, null),
              display: true,
              details: { status: "aborted" },
            }
          : null,
        audit: { status: "aborted" },
      };
    }
    return fail(
      result.error === "no_memories"
        ? "no_relevant_memories"
        : "synthesizer_failed",
      result.detail ?? result.error,
    );
  }

  // Success clears any persisted capacity failure.
  setMemoryRecallCapacityError(input.db, null);

  // Record citation events for validated sources only.
  for (const sourceId of result.sources) {
    const parsed = parseMemoryNodeId(sourceId);
    if (!parsed.ok || parsed.type !== "memory") continue;
    recordMemoryCitation(input.db, {
      nodeType: "memory",
      nodeId: parsed.id,
      source: "briefing",
      piSessionId: input.piSessionId,
    });
  }

  return {
    ok: true,
    message: {
      customType: MEMORY_BRIEFING_CUSTOM_TYPE,
      content: renderMemoryBriefingMessage(userPreferences, result.content),
      display: true,
      details: {
        status: "ok",
        sources: result.sources,
      },
    },
    audit: null,
  };
}
