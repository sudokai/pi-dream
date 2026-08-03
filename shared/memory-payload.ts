/**
 * Payload builder: assembles the bounded synthesizer input from ranked
 * retrieval candidates. Whole memory units only — never split mid-text —
 * accumulated in fused-rank order until the next unit would exceed the char
 * budget or the unit cap.
 *
 * When the candidate set exceeds the input budget, the payload is truncated
 * by fused rank (strict prefix) and the Phase 2 trigger is logged with the
 * observed char count: compaction exists so that low-relevance mass is
 * represented cheaply instead of dropped, and Phase 2 activates only when
 * this trigger fires.
 */

import {
  MEMORY_SYNTHESIS_INPUT_CHARS,
  MEMORY_SYNTHESIS_INPUT_MAX_UNITS,
  type MemoryKnowledgeKind,
  type MemoryLifecycleState,
  type MemoryNodeId,
} from "./memory-types.ts";
import type { MemoryRetrievalCandidate } from "./memory-retrieval.ts";

/** One whole unit rendered into the synthesizer payload. */
export interface MemoryPayloadUnit {
  nodeType: "memory";
  nodeId: number;
  prefixedId: MemoryNodeId;
  kind: MemoryKnowledgeKind;
  state: MemoryLifecycleState;
  text: string;
  recurrence: number;
  /** Fused RRF score from retrieval (kept for Phase 2 collapse rules). */
  score: number;
}

export interface MemoryPayloadOptions {
  maxChars?: number;
  maxUnits?: number;
  /**
   * Diagnostic sink for the Phase 2 trigger (and other payload events).
   * Receives { event, ... } entries; the trigger entry is
   * { event: "phase2_trigger", retrievedChars, retrievedUnits, inputCapChars }.
   */
  log?: (entry: Record<string, unknown>) => void;
}

export interface MemoryPayloadBuildResult {
  /** Selected units in fused-rank order (strict prefix of the candidates). */
  units: MemoryPayloadUnit[];
  /** Rendered payload text (one unit per line). */
  text: string;
  totalChars: number;
  /**
   * True when the retrieved candidate set exceeded the input budget and was
   * truncated by fused rank — the measured condition that activates Phase 2.
   */
  truncated: boolean;
  /** Total chars of the retrieved candidate set (pre-truncation). */
  retrievedChars: number;
}

/** Render one payload unit as a line in the synthesizer input. */
export function renderMemoryPayloadUnit(unit: MemoryPayloadUnit): string {
  return `- ${unit.prefixedId} (${unit.kind}${unit.state !== "active" ? `, ${unit.state}` : ""}, r=${unit.recurrence}): ${unit.text}`;
}

/**
 * Build the bounded synthesizer payload from ranked candidates:
 * accumulate whole units until the next would exceed `maxChars` or the unit
 * cap; when the candidate set itself exceeds the budget, truncate by fused
 * rank and log the Phase 2 trigger with the observed char count.
 *
 * Accounting measures the RENDERED payload (each unit's line including its
 * id/kind prefix), so `totalChars`/`truncated` describe the real prompt size
 * the model receives, not just the raw memory text.
 */
export function buildMemorySynthesisPayload(
  candidates: MemoryRetrievalCandidate[],
  opts: MemoryPayloadOptions = {},
): MemoryPayloadBuildResult {
  const maxChars = opts.maxChars ?? MEMORY_SYNTHESIS_INPUT_CHARS;
  const maxUnits = opts.maxUnits ?? MEMORY_SYNTHESIS_INPUT_MAX_UNITS;

  const units: MemoryPayloadUnit[] = [];
  let totalChars = 0;
  let retrievedChars = 0;
  for (const c of candidates) {
    retrievedChars += renderMemoryPayloadUnit({
      nodeType: c.nodeType,
      nodeId: c.nodeId,
      prefixedId: c.prefixedId,
      kind: c.kind,
      state: c.state,
      text: c.text,
      recurrence: c.recurrence,
      score: c.score,
    }).length;
  }
  const truncated = retrievedChars > maxChars || candidates.length > maxUnits;

  for (const c of candidates) {
    if (units.length >= maxUnits) break;
    const unit: MemoryPayloadUnit = {
      nodeType: c.nodeType,
      nodeId: c.nodeId,
      prefixedId: c.prefixedId,
      kind: c.kind,
      state: c.state,
      text: c.text,
      recurrence: c.recurrence,
      score: c.score,
    };
    const lineLength = renderMemoryPayloadUnit(unit).length;
    if (totalChars + lineLength > maxChars) break;
    units.push(unit);
    totalChars += lineLength;
  }

  if (truncated) {
    opts.log?.({
      event: "phase2_trigger",
      retrievedChars,
      retrievedUnits: candidates.length,
      inputCapChars: maxChars,
      inputCapUnits: maxUnits,
    });
  }

  const text = units.map(renderMemoryPayloadUnit).join("\n");
  return { units, text, totalChars, truncated, retrievedChars };
}
