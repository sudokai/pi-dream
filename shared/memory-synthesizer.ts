/**
 * Memory synthesizer: a single shared LLM loop serving both the first-turn
 * briefing and memory_search. It reads the top layer, opens summaries only
 * when it needs more detail (navigation is unbounded: the loop ends on
 * finalize; an open that adds no new context draws one corrective hint and
 * fails closed if repeated), and
 * returns {answer, sources, openedSummaryIds}. Only the synthesized answer is
 * shown; the sources and opened summaries are reheated by the callers.
 *
 * Interruption handling: a user cancel (aborted signal) or a staleness
 * failure (the dreamer mutated the tree mid-loop, so the gathered context
 * is provably invalid) hard-fails with no answer; anything else that ends
 * the loop without a finalize — a recoverable failure, or the caller's
 * finalizeNowSignal (the briefing's "answer now" key) — draws exactly one
 * forced-finalize call against the context gathered so far, returning
 * { ok: true, partial } or the original hard failure.
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryWorkspaceConfig } from "./memory-config.ts";
import {
  estimateMemoryTextTokens,
  MEMORY_BRIEFING_TOKEN_BUDGET,
  MEMORY_SYNTHESIZER_ANSWER_BUDGET,
  MEMORY_SYNTHESIZER_CONTEXT_BUDGET,
  MEMORY_SYNTHESIZER_FRAMING_BUDGET,
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
import { completeMemoryModelCall } from "./memory-completion.ts";
import type {
  MemoryModelRegistryLike,
  ResolvedMemoryModel,
} from "./memory-model.ts";
import { loadMemorySynthesizerPrompt } from "./memory-prompts.ts";

/** Inputs to the injected model-call seam: system, user, abort signal. */
export interface MemorySynthesizerCompleteInput {
  system: string;
  user: string;
  signal?: AbortSignal;
}

/** Injected completion seam; defaults to completeMemoryModelCall. */
export type MemorySynthesizerCompleteFn = (
  input: MemorySynthesizerCompleteInput,
) => Promise<{ text: string; usage?: unknown }>;

/** Inputs to synthesizeMemoryAnswer: db, request, config, model seams. */
export interface MemorySynthesizerInput {
  db: DatabaseSync;
  request: string;
  config: MemoryWorkspaceConfig;
  modelRegistry: MemoryModelRegistryLike;
  sessionModel: ResolvedMemoryModel;
  signal?: AbortSignal;
  /**
   * When fired, stop navigating and force one finalize from the context
   * gathered so far (the briefing's "answer now" key). Also composes into
   * in-flight model calls so the key interrupts them promptly.
   */
  finalizeNowSignal?: AbortSignal;
  /** Injected complete for tests; defaults to completeMemoryModelCall. */
  complete?: MemorySynthesizerCompleteFn;
  /** System prompt override (tests); defaults to prompts/memory-synthesizer.md. */
  systemPrompt?: string;
}

/** Synthesizer outcome: ok with answer/sources/opened summaries, or fail-closed error. */
export type MemorySynthesizerResult =
  | {
      ok: true;
      answer: string;
      sources: Array<MemoryNodeId | SummaryNodeId>;
      openedSummaryIds: SummaryNodeId[];
      steps: number;
      usage?: unknown;
      /**
       * Set when the answer came from the single forced-finalize call after
       * an interruption (reason: the failure, or "answer requested" for the
       * answer-now key). Partial answers never heat and callers prefix them
       * with renderPartialSynthesizerMarker.
       */
      partial?: { reason: string };
    }
  | {
      ok: false;
      error: string;
      layerTokens?: number;
      budget?: number;
      usage?: unknown;
    };

/**
 * Marker line prefixing an interrupted answer in caller output (briefing and
 * memory_search), naming why the synthesis stopped.
 */
export function renderPartialSynthesizerMarker(reason: string): string {
  return reason === "answer requested"
    ? "Answered on request from partial context:"
    : `Synthesis interrupted (${reason}) — best answer from gathered context:`;
}

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
 * Re-verify every context node against the current DB (the dreamer can mutate
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
  note?: string | null,
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
  lines.push("", `User request: ${request.trim() || "(empty)"}`, "");
  if (note) {
    lines.push(note, "");
  }
  lines.push(
    "Open a summary only when its content is not yet visible and you need it for the answer; finalize as soon as the visible context is sufficient.",
    "Never re-open a summary or open one that adds no new context — you get one hint, then the synthesis fails.",
    "Respond with strict JSON only:",
    '{"action":"open","id":"S:n"} — open a summary visible above for more detail',
    '{"action":"finalize","answer":"...","sources":["M:1","S:2"]} — final answer citing every node your answer relies on',
  );
  return lines.join("\n");
}

/** Loop outcome before the forced-finalize fallback: finalized, or the error that ended the loop. */
type SynthesisLoopOutcome =
  | {
      kind: "finalized";
      answer: string;
      sources: Array<MemoryNodeId | SummaryNodeId>;
      openedSummaryIds: SummaryNodeId[];
      steps: number;
      usage?: unknown;
    }
  | {
      kind: "failed";
      error: string;
      /**
       * Set when the loop's context refresh detected a mid-loop tree
       * mutation (a node retired, changed version/text, or moved). The
       * gathered context is provably invalid, so the caller fails closed
       * instead of drawing a forced finalize against stale rows.
       */
      stale?: boolean;
      openedSummaryIds: SummaryNodeId[];
      steps: number;
      usage?: unknown;
    };

/** Validate a finalize action exactly as the loop's finalize arm does (used by both paths). */
function validateSynthesizerFinalize(
  action: ParsedAction,
  context: SynthesizerContextNode[],
  answerBudget: number,
):
  | {
      ok: true;
      answer: string;
      sources: Array<MemoryNodeId | SummaryNodeId>;
    }
  | { ok: false; error: string } {
  if (typeof action.answer !== "string" || !action.answer.trim()) {
    return { ok: false, error: "finalize requires a non-empty answer" };
  }
  if (estimateMemoryTextTokens(action.answer) > answerBudget) {
    return {
      ok: false,
      error: `answer exceeds the ${answerBudget}-token answer budget`,
    };
  }
  if (action.sources === undefined) {
    return { ok: false, error: "finalize requires a sources array" };
  }
  if (!Array.isArray(action.sources)) {
    return { ok: false, error: "finalize sources must be an array" };
  }
  const sources: Array<MemoryNodeId | SummaryNodeId> = [];
  const knownKeys = new Set(
    context.map((n) => contextKey(n.nodeType, n.nodeId)),
  );
  for (const raw of action.sources) {
    if (typeof raw !== "string") {
      return { ok: false, error: "finalize sources must be id strings" };
    }
    const parsed = parsePrefixedNodeId(raw);
    if (!parsed.ok || parsed.type === "observation") {
      return { ok: false, error: `invalid source id ${raw}` };
    }
    if (!knownKeys.has(contextKey(parsed.type, parsed.id))) {
      return {
        ok: false,
        error: `source ${raw} is not visible in the current context`,
      };
    }
    sources.push(parsed.prefixed as MemoryNodeId | SummaryNodeId);
  }
  return { ok: true, answer: action.answer.trim(), sources };
}

/**
 * Run the synthesizer loop, then resolve its outcome: a finalized answer, the
 * original hard failure for a user cancel or a staleness failure (the dreamer
 * mutated the tree mid-loop, so the gathered context is provably invalid),
 * or — for any other interruption (a recoverable loop failure or the caller's
 * answer-now request) — one forced-finalize call against the context gathered
 * so far. Never truncates the top layer: an over-budget layer fails closed.
 */
export async function synthesizeMemoryAnswer(
  input: MemorySynthesizerInput,
): Promise<MemorySynthesizerResult> {
  const { db, config } = input;
  const signal = input.signal;
  const finalizeNowSignal = input.finalizeNowSignal;
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
  const answerBudget =
    config.synthesizerAnswerBudget ?? MEMORY_SYNTHESIZER_ANSWER_BUDGET;

  const outcome = await runMemorySynthesisLoop({
    db,
    request: input.request,
    context,
    system,
    complete,
    signal,
    finalizeNowSignal,
    answerBudget,
    availableForNodes,
    requestTokens,
  });

  if (outcome.kind === "finalized") {
    return {
      ok: true,
      answer: outcome.answer,
      sources: outcome.sources,
      openedSummaryIds: outcome.openedSummaryIds,
      steps: outcome.steps,
      usage: outcome.usage,
    };
  }

  // A user cancel or a staleness failure (the dreamer mutated the tree
  // mid-loop, so the gathered context is provably invalid) hard-fails with
  // no forced call; every other interruption draws exactly one forced-finalize
  // call with the context gathered so far.
  if (signal?.aborted || outcome.stale) {
    return { ok: false, error: outcome.error, usage: outcome.usage };
  }
  const reason = finalizeNowSignal?.aborted
    ? "answer requested"
    : outcome.error;
  return attemptForcedFinalize({
    request: input.request,
    context,
    openedSummaryIds: outcome.openedSummaryIds,
    system,
    complete,
    signal,
    answerBudget,
    steps: outcome.steps,
    usage: outcome.usage,
    reason,
  });
}

/**
 * The navigation loop: open/finalize iterations against the recall model,
 * refreshing the context after every model result. Returns the finalized
 * answer or the error that ended the loop; the caller decides whether that
 * failure draws a forced finalize. An open that adds no new context nodes
 * draws one corrective hint to the model; the second consecutive such open
 * fails closed.
 */
async function runMemorySynthesisLoop(input: {
  db: DatabaseSync;
  request: string;
  context: SynthesizerContextNode[];
  system: string;
  complete: MemorySynthesizerCompleteFn;
  signal?: AbortSignal;
  finalizeNowSignal?: AbortSignal;
  answerBudget: number;
  /** Envelope room for nodes: framing/answer/nav are already subtracted. */
  availableForNodes: number;
  requestTokens: number;
}): Promise<SynthesisLoopOutcome> {
  const { db, signal, finalizeNowSignal } = input;
  const context = input.context;
  const answerBudget = input.answerBudget;
  const contextTokens = (): number =>
    context.reduce((sum, node) => sum + node.tokens, 0);
  const openedSummaryIds: SummaryNodeId[] = [];
  let usage: unknown;
  let noNewContextOpens = 0;
  let noNewContextNote: string | null = null;

  // Navigation is unbounded: the tree is finite, so the loop always ends —
  // on finalize, on a cancel, on an answer-now request, or fail-closed on
  // the second consecutive open that adds no new context; the first such
  // open returns a corrective hint.
  for (let step = 0; ; step++) {
    const fail = (error: string): SynthesisLoopOutcome => ({
      kind: "failed",
      error,
      steps: step + 1,
      openedSummaryIds,
      usage,
    });
    // A cancel between calls is a returned failure, exactly like a cancel
    // mid-call — never an exception out of the synthesizer.
    if (signal?.aborted) {
      return {
        kind: "failed",
        error: "aborted",
        steps: step,
        openedSummaryIds,
        usage,
      };
    }
    if (finalizeNowSignal?.aborted) {
      return {
        kind: "failed",
        error: "answer requested",
        steps: step,
        openedSummaryIds,
        usage,
      };
    }
    const user = renderSynthesizerContext(
      input.request,
      context,
      noNewContextNote,
    );
    let resultText: string;
    try {
      const result = await input.complete({
        system: input.system,
        user,
        signal: finalizeNowSignal
          ? AbortSignal.any(
              [signal, finalizeNowSignal].filter((s): s is AbortSignal =>
                Boolean(s),
              ),
            )
          : signal,
      });
      usage = result.usage;
      resultText = result.text;
    } catch (err) {
      if (signal?.aborted) {
        return {
          kind: "failed",
          error: "aborted",
          steps: step + 1,
          openedSummaryIds,
          usage,
        };
      }
      if (finalizeNowSignal?.aborted) {
        return {
          kind: "failed",
          error: "answer requested",
          steps: step + 1,
          openedSummaryIds,
          usage,
        };
      }
      const detail = err instanceof Error ? err.message : String(err);
      return fail(`model call failed: ${detail}`);
    }
    if (!resultText || !resultText.trim()) {
      return fail("Synthesizer returned empty output");
    }

    let action: ParsedAction;
    try {
      action = parseSynthesizerAction(resultText);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return fail(`malformed synthesizer output: ${detail}`);
    }

    // Refresh after every awaited model result. A refresh failure means the
    // dreamer mutated the tree mid-loop (a context node was retired, changed
    // version/text, or moved): the gathered context is provably invalid, so
    // mark the outcome stale — the caller fails closed rather than drawing a
    // forced finalize against stale rows.
    const refreshed = refreshSynthesizerContext(db, context);
    if (!refreshed.ok) {
      return {
        kind: "failed",
        stale: true,
        error: refreshed.error,
        steps: step + 1,
        openedSummaryIds,
        usage,
      };
    }

    if (action.action === "open") {
      if (typeof action.id !== "string") {
        return fail("open requires an id string");
      }
      const parsed = parsePrefixedNodeId(action.id);
      if (!parsed.ok || parsed.type !== "summary") {
        return fail(
          `open target must be an active summary id, got ${String(action.id)}`,
        );
      }
      const target = context.find(
        (n) =>
          n.nodeType === "summary" &&
          n.nodeId === parsed.id &&
          n.prefixedId === parsed.prefixed,
      );
      if (!target) {
        return fail(
          `open target ${parsed.prefixed} is not visible in the current context`,
        );
      }
      // Append the target's active children and enforce the cumulative
      // envelope. The tree is finite, so every successful open grows the
      // context; an open that adds no new nodes makes no progress and
      // fails closed.
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
      const knownKeys = new Set(
        context.map((n) => contextKey(n.nodeType, n.nodeId)),
      );
      const newNodes = childNodes.filter(
        (c) => !knownKeys.has(contextKey(c.nodeType, c.nodeId)),
      );
      if (newNodes.length === 0) {
        // No new context: the first such open returns a corrective hint
        // (the model may open an unopened summary or finalize); the second
        // consecutive such open fails closed.
        if (noNewContextOpens > 0) {
          return fail(
            `open target ${parsed.prefixed} adds no new context nodes after a prior hint; refusing to loop without new context`,
          );
        }
        noNewContextOpens = 1;
        const reason = openedSummaryIds.includes(
          parsed.prefixed as SummaryNodeId,
        )
          ? "it is already open and its children are listed above"
          : children.length === 0
            ? "it has no active children"
            : "its children are already listed above";
        noNewContextNote = `Note: your previous open of ${parsed.prefixed} added no new context nodes — everything it contains is already visible above (${reason}). If the visible context is sufficient for the request, finalize now; otherwise open a summary whose content is not yet visible.`;
        continue;
      }
      noNewContextOpens = 0;
      noNewContextNote = null;
      const addedTokens = newNodes.reduce((sum, c) => sum + c.tokens, 0);
      // The cumulative envelope covers framing + request + top layer +
      // opened children payloads + navigation + answer: the request tokens
      // count here too, exactly as in the initial check.
      if (
        input.requestTokens + contextTokens() + addedTokens >
        input.availableForNodes
      ) {
        return fail(
          `opening ${parsed.prefixed} would exceed the context envelope`,
        );
      }
      context.push(...newNodes);
      openedSummaryIds.push(parsed.prefixed as SummaryNodeId);
      continue;
    }

    if (action.action === "finalize") {
      const validated = validateSynthesizerFinalize(
        action,
        context,
        answerBudget,
      );
      if (!validated.ok) {
        return fail(validated.error);
      }
      // Every validated source is credited: the context envelope and the
      // visibility check already bound what the model can cite.
      return {
        kind: "finalized",
        answer: validated.answer,
        sources: validated.sources,
        openedSummaryIds,
        steps: step + 1,
        usage,
      };
    }

    return fail(`unknown synthesizer action: ${action.action}`);
  }
}

/**
 * One finalize-only call after an interruption, against the context gathered
 * so far. Only a clean finalize (validated exactly like the loop's) produces
 * { ok: true, partial }; anything else returns the interruption's original
 * failure — or "aborted" when the caller cancels mid-call.
 *
 * Runs under the caller's cancel signal only: the answer-now signal has
 * already served its purpose (stopping navigation) and stays aborted, so
 * composing it here would reject the forced call before the model is
 * invoked. Escape still cancels the call.
 */
async function attemptForcedFinalize(input: {
  request: string;
  context: SynthesizerContextNode[];
  openedSummaryIds: SummaryNodeId[];
  system: string;
  complete: MemorySynthesizerCompleteFn;
  signal?: AbortSignal;
  answerBudget: number;
  steps: number;
  usage?: unknown;
  /** "answer requested" for the answer-now key; otherwise the loop failure. */
  reason: string;
}): Promise<MemorySynthesizerResult> {
  const user = renderSynthesizerContext(
    input.request,
    input.context,
    'You may not open any more summaries. Finalize now with the best answer the visible context supports; if nothing is relevant, finalize with "No relevant memories found" and sources []. Respond with strict JSON only.',
  );
  let resultText: string;
  let forcedUsage: unknown;
  try {
    const result = await input.complete({
      system: input.system,
      user,
      signal: input.signal,
    });
    forcedUsage = result.usage;
    resultText = result.text;
  } catch (err) {
    // A cancel during the forced call hard-fails exactly like a cancel in
    // the navigation loop; any other failure keeps the original interruption.
    if (input.signal?.aborted) {
      return { ok: false, error: "aborted", usage: input.usage };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: forcedFinalizeError(input.reason, `model call failed: ${detail}`),
      usage: input.usage,
    };
  }
  if (!resultText || !resultText.trim()) {
    return {
      ok: false,
      error: forcedFinalizeError(input.reason, "empty output"),
      usage: input.usage,
    };
  }
  let action: ParsedAction;
  try {
    action = parseSynthesizerAction(resultText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: forcedFinalizeError(input.reason, `malformed output: ${detail}`),
      usage: input.usage,
    };
  }
  if (action.action !== "finalize") {
    return {
      ok: false,
      error: forcedFinalizeError(input.reason, `action was ${action.action}`),
      usage: input.usage,
    };
  }
  const validated = validateSynthesizerFinalize(
    action,
    input.context,
    input.answerBudget,
  );
  if (!validated.ok) {
    return {
      ok: false,
      error: forcedFinalizeError(input.reason, validated.error),
      usage: input.usage,
    };
  }
  // A partial result is a real model answer, but the run was interrupted:
  // callers mark it visibly and never heat from it.
  return {
    ok: true,
    partial: { reason: input.reason },
    answer: validated.answer,
    sources: validated.sources,
    openedSummaryIds: input.openedSummaryIds,
    steps: input.steps + 1,
    usage: input.usage ?? forcedUsage,
  };
}

/**
 * Hard-failure error after a failed forced finalize: keep the original
 * interruption as the primary error, but also surface the forced call's own
 * failure so the audit records both.
 */
function forcedFinalizeError(reason: string, detail: string): string {
  return reason === "answer requested"
    ? `answer requested but the finalize call failed: ${detail}`
    : `${reason} (forced finalize also failed: ${detail})`;
}

/** Default system prompt (used when prompts/memory-synthesizer.md is missing). */
export function defaultMemorySynthesizerSystemPrompt(): string {
  return [
    "You are the memory synthesizer for a coding agent.",
    "Given the user's request and the workspace memory tree, produce a concise grounded answer.",
    "The request filters the memories: judge relevance yourself.",
    "Open a summary only when its content is not yet visible and its condensation is insufficient; finalize as soon as the visible context suffices.",
    "Never invent facts; base the answer only on the context.",
    "List in sources every node whose content your answer relies on — not everything you read — most important first; a well-supported answer may cite many.",
    "Never re-open a summary or open one that adds no new context nodes (a repeated no-op ends the synthesis).",
    'If nothing is relevant, finalize with answer "No relevant memories found" and sources [].',
    "Output strict JSON only — no markdown fences.",
  ].join(" ");
}
