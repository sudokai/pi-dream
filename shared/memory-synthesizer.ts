/**
 * Memory synthesizer: a single shared LLM loop serving both the first-turn
 * briefing and memory_search. It reads the top layer, opens summaries only
 * when it needs more detail (bounded loop, <= synthesizerMaxSteps), and returns
 * {answer, sources, openedSummaryIds}. Only the synthesized answer is shown;
 * the sources and opened summaries are reheated by the callers.
 *
 * Fail-closed: any failure (model error, abort, malformed JSON, budget/step
 * exhaustion, unseen open target, post-refresh mismatch) returns { ok: false }.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "./memory-config.ts";
import {
  estimateMemoryTextTokens,
  MEMORY_BRIEFING_TOKEN_BUDGET,
  MEMORY_SYNTHESIZER_ANSWER_BUDGET,
  MEMORY_SYNTHESIZER_CONTEXT_BUDGET,
  MEMORY_SYNTHESIZER_FRAMING_BUDGET,
  MEMORY_SYNTHESIZER_MAX_SOURCES,
  MEMORY_SYNTHESIZER_MAX_STEPS,
  MEMORY_SYNTHESIZER_NAV_RESERVE,
  parsePrefixedNodeId,
  type MemoryNodeId,
  type MemorySearchableNodeType,
  type SummaryNodeId,
} from "./memory-types.ts";
import {
  getMemoryNodeParent,
  listMemoryNodeActiveChildren,
  listMemoryTreeRoots,
} from "./memory-tree.ts";
import { throwIfMemoryAborted } from "./memory-abort.ts";
import { completeMemoryModelCall } from "./memory-completion.ts";
import type {
  MemoryModelRegistryLike,
  ResolvedMemoryModel,
} from "./memory-model.ts";
import { loadMemorySynthesizerPrompt } from "./memory-prompts.ts";

export interface MemorySynthesizerCompleteInput {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export type MemorySynthesizerCompleteFn = (
  input: MemorySynthesizerCompleteInput,
) => Promise<{ text: string; usage?: unknown }>;

export interface MemorySynthesizerInput {
  db: DatabaseSync;
  request: string;
  config: MemoryWorkspaceConfig;
  modelRegistry: MemoryModelRegistryLike;
  sessionModel: ResolvedMemoryModel;
  signal?: AbortSignal;
  /** Injected complete for tests; defaults to completeMemoryModelCall. */
  complete?: MemorySynthesizerCompleteFn;
  /** System prompt override (tests); defaults to prompts/memory-synthesizer.md. */
  systemPrompt?: string;
}

export type MemorySynthesizerResult =
  | {
      ok: true;
      answer: string;
      sources: Array<MemoryNodeId | SummaryNodeId>;
      openedSummaryIds: SummaryNodeId[];
      steps: number;
      usage?: unknown;
    }
  | {
      ok: false;
      error: string;
      layerTokens?: number;
      budget?: number;
      usage?: unknown;
    };

interface SynthesizerContextNode {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  prefixedId: string;
  kind: string;
  text: string;
  heat: number;
  tokens: number;
  versionId: number;
  /** "root", or the chain of ancestor summary ids: "S:1>S:2". */
  path: string;
}

interface ParsedAction {
  action: string;
  id?: unknown;
  answer?: unknown;
  sources?: unknown;
}

function parseSynthesizerAction(text: string): ParsedAction {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const raw = JSON.parse(body) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Synthesizer output must be a JSON object");
  }
  if (typeof raw.action !== "string") {
    throw new Error("Synthesizer output must include an action");
  }
  return raw as unknown as ParsedAction;
}

function contextKey(
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): string {
  return `${nodeType}:${nodeId}`;
}

function currentParentChain(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): number[] {
  const chain: number[] = [];
  let current: { nodeType: MemorySearchableNodeType; nodeId: number } = {
    nodeType,
    nodeId,
  };
  const seen = new Set<string>();
  for (;;) {
    const parent = getMemoryNodeParent(db, current.nodeType, current.nodeId);
    if (!parent) break;
    const key = `summary:${parent.nodeId}`;
    if (seen.has(key)) break;
    seen.add(key);
    chain.unshift(parent.nodeId);
    current = parent;
  }
  return chain;
}

function recordedPathChain(path: string): number[] {
  if (path === "root") return [];
  return path
    .split(">")
    .map((part) => {
      const parsed = parsePrefixedNodeId(part);
      return parsed.ok && parsed.type === "summary" ? parsed.id : -1;
    })
    .filter((id) => id > 0);
}

/**
 * Re-verify every context node against the current DB (the learner can mutate
 * the tree while a model call is in flight): still active, non-conflicted,
 * unchanged version/text, and still on its recorded containment path.
 */
function refreshSynthesizerContext(
  db: DatabaseSync,
  context: SynthesizerContextNode[],
): { ok: true } | { ok: false; error: string } {
  for (const node of context) {
    const current =
      node.nodeType === "memory"
        ? (db
            .prepare(
              `SELECT m.state, m.current_version_id, v.text
               FROM memories m
               JOIN memory_versions v ON v.id = m.current_version_id
               WHERE m.id = ?`,
            )
            .get(node.nodeId) as
            | { state: string; current_version_id: number; text: string }
            | undefined)
        : (db
            .prepare(
              `SELECT s.state, s.current_version_id, v.text
               FROM summaries s
               JOIN summary_versions v ON v.id = s.current_version_id
               WHERE s.id = ?`,
            )
            .get(node.nodeId) as
            | { state: string; current_version_id: number; text: string }
            | undefined);
    if (!current || current.state !== "active") {
      return {
        ok: false,
        error: `Context node ${node.prefixedId} is no longer active; the tree changed during synthesis`,
      };
    }
    if (
      Number(current.current_version_id) !== node.versionId ||
      current.text !== node.text
    ) {
      return {
        ok: false,
        error: `Context node ${node.prefixedId} changed during synthesis`,
      };
    }
    const chain = currentParentChain(db, node.nodeType, node.nodeId);
    const recorded = recordedPathChain(node.path);
    if (chain.length !== recorded.length) {
      return {
        ok: false,
        error: `Context node ${node.prefixedId} moved in the tree during synthesis`,
      };
    }
    for (let i = 0; i < chain.length; i++) {
      if (chain[i] !== recorded[i]) {
        return {
          ok: false,
          error: `Context node ${node.prefixedId} moved in the tree during synthesis`,
        };
      }
    }
  }
  return { ok: true };
}

function renderSynthesizerContext(
  request: string,
  context: SynthesizerContextNode[],
  stepsLeft: number,
): string {
  const lines: string[] = [
    "Workspace memory tree (top layer, heat descending):",
  ];
  for (const node of context) {
    if (node.path === "root") {
      lines.push(
        `- ${node.prefixedId} kind=${node.kind} heat=${node.heat.toFixed(3)} tokens≈${node.tokens} text: ${node.text}`,
      );
    } else {
      lines.push(
        `- ${node.prefixedId} kind=${node.kind} heat=${node.heat.toFixed(3)} tokens≈${node.tokens} path=${node.path} text: ${node.text}`,
      );
    }
  }
  lines.push(
    "",
    `User request: ${request.trim() || "(empty)"}`,
    "",
    `You may open at most ${stepsLeft} more summaries, then you must finalize.`,
    "Respond with strict JSON only:",
    '{"action":"open","id":"S:n"} — open a summary visible above for more detail',
    '{"action":"finalize","answer":"...","sources":["M:1","S:2"]} — final answer citing every node your answer relies on',
  );
  return lines.join("\n");
}

/**
 * Run the synthesizer loop. Builds the top layer, then iterates open/finalize
 * against the recall model, refreshing the context after every model result.
 * Never truncates the top layer: an over-budget layer fails closed.
 */
export async function synthesizeMemoryAnswer(
  input: MemorySynthesizerInput,
): Promise<MemorySynthesizerResult> {
  const { db, config } = input;
  const signal = input.signal;
  if (signal?.aborted) {
    return { ok: false, error: "aborted" };
  }

  const roots = listMemoryTreeRoots(db);
  const layerTokens = roots.reduce((sum, r) => sum + r.estimatedTokens, 0);
  const budget = config.briefingTokenBudget ?? MEMORY_BRIEFING_TOKEN_BUDGET;
  if (layerTokens > budget) {
    return {
      ok: false,
      error: "top_layer_over_budget",
      layerTokens,
      budget,
    };
  }

  const context: SynthesizerContextNode[] = roots.map((r) => ({
    nodeType: r.nodeType,
    nodeId: r.nodeId,
    prefixedId: r.prefixedId,
    kind: r.kind,
    text: r.text,
    heat: r.heat,
    tokens: r.estimatedTokens,
    versionId: r.currentVersionId,
    path: "root",
  }));

  const availableForNodes =
    (config.synthesizerContextBudget ?? MEMORY_SYNTHESIZER_CONTEXT_BUDGET) -
    MEMORY_SYNTHESIZER_FRAMING_BUDGET -
    (config.synthesizerAnswerBudget ?? MEMORY_SYNTHESIZER_ANSWER_BUDGET) -
    MEMORY_SYNTHESIZER_NAV_RESERVE;
  // The envelope covers framing + request + top layer + navigation + answer:
  // the request tokens are counted explicitly (framing is a fixed reserve).
  const requestTokens = estimateMemoryTextTokens(input.request);
  const contextTokens = (): number =>
    context.reduce((sum, node) => sum + node.tokens, 0);
  if (requestTokens + contextTokens() > availableForNodes) {
    return {
      ok: false,
      error: "context envelope exceeded by the top layer and request",
      layerTokens,
      budget,
    };
  }

  const system =
    input.systemPrompt ??
    loadMemorySynthesizerPrompt() ??
    defaultMemorySynthesizerSystemPrompt();
  const complete =
    input.complete ??
    ((c: MemorySynthesizerCompleteInput) =>
      completeMemoryModelCall(input.modelRegistry, input.sessionModel, {
        system: c.system,
        user: c.user,
        signal: c.signal,
      }));

  const maxSteps = config.synthesizerMaxSteps ?? MEMORY_SYNTHESIZER_MAX_STEPS;
  const openedSummaryIds: SummaryNodeId[] = [];
  const openedKeys = new Set<string>();
  let usage: unknown;
  const answerBudget =
    config.synthesizerAnswerBudget ?? MEMORY_SYNTHESIZER_ANSWER_BUDGET;

  for (let step = 0; step < maxSteps; step++) {
    throwIfMemoryAborted(signal);
    const user = renderSynthesizerContext(
      input.request,
      context,
      maxSteps - step,
    );
    let resultText: string;
    try {
      const result = await complete({ system, user, signal });
      usage = result.usage;
      resultText = result.text;
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, error: "aborted", usage };
      }
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `model call failed: ${detail}`, usage };
    }
    if (!resultText || !resultText.trim()) {
      return { ok: false, error: "Synthesizer returned empty output", usage };
    }

    let action: ParsedAction;
    try {
      action = parseSynthesizerAction(resultText);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `malformed synthesizer output: ${detail}`,
        usage,
      };
    }

    // Refresh after every awaited model result.
    const refreshed = refreshSynthesizerContext(db, context);
    if (!refreshed.ok) {
      return { ok: false, error: refreshed.error, usage };
    }

    if (action.action === "open") {
      if (typeof action.id !== "string") {
        return { ok: false, error: "open requires an id string", usage };
      }
      const parsed = parsePrefixedNodeId(action.id);
      if (!parsed.ok || parsed.type !== "summary") {
        return {
          ok: false,
          error: `open target must be an active summary id, got ${String(action.id)}`,
          usage,
        };
      }
      const target = context.find(
        (n) =>
          n.nodeType === "summary" &&
          n.nodeId === parsed.id &&
          n.prefixedId === parsed.prefixed,
      );
      if (!target) {
        return {
          ok: false,
          error: `open target ${parsed.prefixed} is not visible in the current context`,
          usage,
        };
      }
      if (!openedKeys.has(contextKey("summary", parsed.id))) {
        // First open: append active children and enforce the cumulative
        // envelope. Re-opening an already-open summary is a no-op (its
        // children are already in the context; appending again would
        // double-count their tokens).
        const children = listMemoryNodeActiveChildren(db, "summary", parsed.id);
        const childNodes: SynthesizerContextNode[] = children.map((c) => ({
          nodeType: c.nodeType,
          nodeId: c.nodeId,
          prefixedId: c.prefixedId,
          kind: c.kind,
          text: c.text,
          heat: c.heat,
          tokens: c.estimatedTokens,
          versionId: c.currentVersionId,
          path:
            target.path === "root"
              ? target.prefixedId
              : `${target.path}>${target.prefixedId}`,
        }));
        const addedTokens = childNodes.reduce((sum, c) => sum + c.tokens, 0);
        if (contextTokens() + addedTokens > availableForNodes) {
          return {
            ok: false,
            error: `opening ${parsed.prefixed} would exceed the context envelope`,
            usage,
          };
        }
        context.push(...childNodes);
        openedKeys.add(contextKey("summary", parsed.id));
        openedSummaryIds.push(parsed.prefixed as SummaryNodeId);
      }
      continue;
    }

    if (action.action === "finalize") {
      if (typeof action.answer !== "string" || !action.answer.trim()) {
        return {
          ok: false,
          error: "finalize requires a non-empty answer",
          usage,
        };
      }
      if (estimateMemoryTextTokens(action.answer) > answerBudget) {
        return {
          ok: false,
          error: `answer exceeds the ${answerBudget}-token answer budget`,
          usage,
        };
      }
      if (action.sources === undefined) {
        return { ok: false, error: "finalize requires a sources array", usage };
      }
      if (!Array.isArray(action.sources)) {
        return { ok: false, error: "finalize sources must be an array", usage };
      }
      const sources: Array<MemoryNodeId | SummaryNodeId> = [];
      const knownKeys = new Set(
        context.map((n) => contextKey(n.nodeType, n.nodeId)),
      );
      for (const raw of action.sources) {
        if (typeof raw !== "string") {
          return {
            ok: false,
            error: "finalize sources must be id strings",
            usage,
          };
        }
        const parsed = parsePrefixedNodeId(raw);
        if (!parsed.ok || parsed.type === "observation") {
          return { ok: false, error: `invalid source id ${raw}`, usage };
        }
        if (!knownKeys.has(contextKey(parsed.type, parsed.id))) {
          return {
            ok: false,
            error: `source ${raw} is not visible in the current context`,
            usage,
          };
        }
        sources.push(parsed.prefixed as MemoryNodeId | SummaryNodeId);
      }
      // Sources beyond the cap are truncated, not fatal: the remainder are
      // uncredited and render via the briefing index (which never heats).
      const credited = sources.slice(0, MEMORY_SYNTHESIZER_MAX_SOURCES);
      return {
        ok: true,
        answer: action.answer.trim(),
        sources: credited,
        openedSummaryIds,
        steps: step + 1,
        usage,
      };
    }

    return {
      ok: false,
      error: `unknown synthesizer action: ${action.action}`,
      usage,
    };
  }

  return {
    ok: false,
    error: `step budget exhausted after ${maxSteps} steps without finalize`,
    usage,
  };
}

/** Default system prompt (used when prompts/memory-synthesizer.md is missing). */
export function defaultMemorySynthesizerSystemPrompt(): string {
  return [
    "You are the memory synthesizer for a coding agent.",
    "Given the user's request and the workspace memory tree, produce a concise grounded answer.",
    "The request filters the memories: judge relevance yourself.",
    "Open a summary only when its condensation is insufficient for the request; never open everything.",
    "Never invent facts; base the answer only on the context.",
    "List in sources every node whose content your answer relies on — not everything you read — at most 6, most important first (sources beyond 6 are not credited).",
    'If nothing is relevant, finalize with answer "No relevant memories found" and sources [].',
    "Output strict JSON only — no markdown fences.",
  ].join(" ");
}
