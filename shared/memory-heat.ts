/**
 * Heat scoring for memory/summary nodes.
 * Temporary novelty boost plus exponentially decayed recall-event weights
 * measured in workspace activity generations.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_HEAT_DECAY,
  MEMORY_NOVELTY_BOOST,
  MEMORY_NOVELTY_GENERATIONS,
  MEMORY_RECALL_EVENT_WEIGHT,
  type MemorySearchableNodeType,
} from "./memory-types.ts";

export interface MemoryHeatOptions {
  noveltyBoost?: number;
  noveltyGenerations?: number;
  heatDecay?: number;
  recallEventWeight?: number;
}

export interface MemoryHeatInput {
  currentGeneration: number;
  noveltyUntilGeneration: number | null;
  /** Activity generations at which this node was recalled/opened. */
  recallGenerations: number[];
}

/**
 * Compute heat for one node from novelty + decayed recall events.
 * Pure function — no I/O.
 */
export function computeMemoryNodeHeat(
  input: MemoryHeatInput,
  opts: MemoryHeatOptions = {},
): number {
  const noveltyBoost = opts.noveltyBoost ?? MEMORY_NOVELTY_BOOST;
  const noveltyGenerations =
    opts.noveltyGenerations ?? MEMORY_NOVELTY_GENERATIONS;
  const heatDecay = opts.heatDecay ?? MEMORY_HEAT_DECAY;
  const recallWeight = opts.recallEventWeight ?? MEMORY_RECALL_EVENT_WEIGHT;

  let heat = 0;

  if (
    input.noveltyUntilGeneration !== null &&
    input.currentGeneration <= input.noveltyUntilGeneration
  ) {
    // Linear fade of novelty over its remaining lifetime window.
    const remaining =
      input.noveltyUntilGeneration - input.currentGeneration + 1;
    const fraction = Math.min(1, Math.max(0, remaining / noveltyGenerations));
    heat += noveltyBoost * fraction;
  }

  for (const gen of input.recallGenerations) {
    const age = Math.max(0, input.currentGeneration - gen);
    heat += recallWeight * Math.pow(heatDecay, age);
  }

  return heat;
}

/**
 * Load recall generations for a node from SQLite.
 */
export function listMemoryRecallGenerations(
  db: DatabaseSync,
  nodeType: MemorySearchableNodeType,
  nodeId: number,
): number[] {
  const rows = db
    .prepare(
      `SELECT activity_generation FROM recall_events
       WHERE node_type = ? AND node_id = ?
       ORDER BY id ASC`,
    )
    .all(nodeType, nodeId) as Array<{ activity_generation: number }>;
  return rows.map((r) => Number(r.activity_generation));
}

/**
 * Compute heat for a memory row given current activity generation.
 */
export function computeMemoryRowHeat(
  db: DatabaseSync,
  memoryId: number,
  currentGeneration: number,
  noveltyUntilGeneration: number | null,
  opts?: MemoryHeatOptions,
): number {
  return computeMemoryNodeHeat(
    {
      currentGeneration,
      noveltyUntilGeneration,
      recallGenerations: listMemoryRecallGenerations(db, "memory", memoryId),
    },
    opts,
  );
}

/**
 * Compute heat for a summary row (no novelty; summaries are not novelty-boosted).
 */
export function computeSummaryRowHeat(
  db: DatabaseSync,
  summaryId: number,
  currentGeneration: number,
  opts?: MemoryHeatOptions,
): number {
  return computeMemoryNodeHeat(
    {
      currentGeneration,
      noveltyUntilGeneration: null,
      recallGenerations: listMemoryRecallGenerations(db, "summary", summaryId),
    },
    opts,
  );
}
