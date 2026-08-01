/**
 * Strict per-workspace configuration for adaptive memory.
 * Model fields default to the current session model at execution time.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  MEMORY_BRIEFING_TOKEN_BUDGET,
  MEMORY_CHARS_PER_TOKEN_ESTIMATE,
  MEMORY_COLD_HEAT_THRESHOLD,
  MEMORY_DEFAULT_MIN_MINUTES,
  MEMORY_DEFAULT_MIN_TURNS,
  MEMORY_EMBEDDING_MODEL_ID,
  MEMORY_HEAT_DECAY,
  MEMORY_HOT_HEAT_THRESHOLD,
  MEMORY_MAINTENANCE_MERGE_BOUND,
  MEMORY_MAX_SUMMARY_CHARS,
  MEMORY_NOVELTY_BOOST,
  MEMORY_NOVELTY_GENERATIONS,
  MEMORY_SYNTHESIZER_ANSWER_BUDGET,
  MEMORY_SYNTHESIZER_CONTEXT_BUDGET,
  MEMORY_SYNTHESIZER_FRAMING_BUDGET,
  MEMORY_SYNTHESIZER_MAX_STEPS,
  MEMORY_SYNTHESIZER_NAV_RESERVE,
} from "./memory-types.ts";
import { memoryWorkspaceConfigPath } from "./memory-workspace-id.ts";
import {
  ensureMemorySecureDir,
  writeMemorySecureFileAtomic,
} from "./memory-fs.ts";

export const MEMORY_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type MemoryThinkingLevel = (typeof MEMORY_THINKING_LEVELS)[number];

/** Versioned workspace config stored at `config.json`. */
export interface MemoryWorkspaceConfig {
  version: 1;
  enabled: boolean;
  /** Exact `provider/modelId`, or omit to use current session model. */
  learningModel?: string;
  learningThinking?: MemoryThinkingLevel;
  /** Exact `provider/modelId`, or omit to use current session model. */
  recallModel?: string;
  recallThinking?: MemoryThinkingLevel;
  minTurns: number;
  minMinutes: number;
  briefingTokenBudget: number;
  embeddingModel: string;
  coldHeatThreshold: number;
  hotHeatThreshold: number;
  maintenanceMergeBound: number;
  synthesizerMaxSteps: number;
  synthesizerContextBudget: number;
  synthesizerAnswerBudget: number;
  noveltyBoost: number;
  noveltyGenerations: number;
  heatDecay: number;
}

export type MemoryConfigLoadResult =
  | {
      ok: true;
      config: MemoryWorkspaceConfig;
      invalidFallback: boolean;
      disabledReason?: string;
    }
  | { ok: false; error: string };

/** Safe disabled config used when an on-disk config is invalid or unreadable shape. */
export function disabledMemoryWorkspaceConfig(): MemoryWorkspaceConfig {
  return { ...defaultMemoryWorkspaceConfig(), enabled: false };
}

/** Defaults applied when config is missing or a field is absent. */
export function defaultMemoryWorkspaceConfig(): MemoryWorkspaceConfig {
  return {
    version: 1,
    enabled: true,
    minTurns: MEMORY_DEFAULT_MIN_TURNS,
    minMinutes: MEMORY_DEFAULT_MIN_MINUTES,
    briefingTokenBudget: MEMORY_BRIEFING_TOKEN_BUDGET,
    embeddingModel: MEMORY_EMBEDDING_MODEL_ID,
    coldHeatThreshold: MEMORY_COLD_HEAT_THRESHOLD,
    hotHeatThreshold: MEMORY_HOT_HEAT_THRESHOLD,
    maintenanceMergeBound: MEMORY_MAINTENANCE_MERGE_BOUND,
    synthesizerMaxSteps: MEMORY_SYNTHESIZER_MAX_STEPS,
    synthesizerContextBudget: MEMORY_SYNTHESIZER_CONTEXT_BUDGET,
    synthesizerAnswerBudget: MEMORY_SYNTHESIZER_ANSWER_BUDGET,
    noveltyBoost: MEMORY_NOVELTY_BOOST,
    noveltyGenerations: MEMORY_NOVELTY_GENERATIONS,
    heatDecay: MEMORY_HEAT_DECAY,
  };
}

function isThinkingLevel(value: unknown): value is MemoryThinkingLevel {
  return (
    typeof value === "string" &&
    (MEMORY_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function unitInterval(value: unknown, fallback: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1
  ) {
    return fallback;
  }
  return value;
}

/**
 * Parse workspace config from an unknown JSON value.
 * Unknown keys are rejected; missing optional fields use defaults.
 */
export function parseMemoryWorkspaceConfig(
  value: unknown,
): MemoryConfigLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Memory config must be a JSON object." };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "enabled",
    "learningModel",
    "learningThinking",
    "recallModel",
    "recallThinking",
    "minTurns",
    "minMinutes",
    "briefingTokenBudget",
    "embeddingModel",
    "coldHeatThreshold",
    "hotHeatThreshold",
    "maintenanceMergeBound",
    "synthesizerMaxSteps",
    "synthesizerContextBudget",
    "synthesizerAnswerBudget",
    "noveltyBoost",
    "noveltyGenerations",
    "heatDecay",
  ]);
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length) {
    return {
      ok: false,
      error: `Memory config contains unknown key(s): ${unknown.join(", ")}.`,
    };
  }
  if (obj.version !== 1) {
    return { ok: false, error: "Memory config version must be 1." };
  }
  if (typeof obj.enabled !== "boolean") {
    return { ok: false, error: "Memory config enabled must be a boolean." };
  }
  for (const key of [
    "learningModel",
    "recallModel",
    "embeddingModel",
  ] as const) {
    if (
      obj[key] !== undefined &&
      (typeof obj[key] !== "string" || !(obj[key] as string).trim())
    ) {
      return {
        ok: false,
        error: `Memory config ${key} must be a non-empty string when set.`,
      };
    }
  }
  for (const key of ["learningThinking", "recallThinking"] as const) {
    if (obj[key] !== undefined && !isThinkingLevel(obj[key])) {
      return {
        ok: false,
        error: `Memory config ${key} must be one of: ${MEMORY_THINKING_LEVELS.join(", ")}.`,
      };
    }
  }

  const defaults = defaultMemoryWorkspaceConfig();
  const config: MemoryWorkspaceConfig = {
    version: 1,
    enabled: obj.enabled,
    minTurns: positiveInt(obj.minTurns, defaults.minTurns),
    minMinutes: positiveInt(obj.minMinutes, defaults.minMinutes),
    briefingTokenBudget: positiveInt(
      obj.briefingTokenBudget,
      defaults.briefingTokenBudget,
    ),
    embeddingModel:
      typeof obj.embeddingModel === "string" && obj.embeddingModel.trim()
        ? obj.embeddingModel.trim()
        : defaults.embeddingModel,
    coldHeatThreshold: positiveNumber(
      obj.coldHeatThreshold,
      defaults.coldHeatThreshold,
    ),
    hotHeatThreshold: positiveNumber(
      obj.hotHeatThreshold,
      defaults.hotHeatThreshold,
    ),
    maintenanceMergeBound: positiveInt(
      obj.maintenanceMergeBound,
      defaults.maintenanceMergeBound,
    ),
    synthesizerMaxSteps: positiveInt(
      obj.synthesizerMaxSteps,
      defaults.synthesizerMaxSteps,
    ),
    synthesizerContextBudget: positiveInt(
      obj.synthesizerContextBudget,
      defaults.synthesizerContextBudget,
    ),
    synthesizerAnswerBudget: positiveInt(
      obj.synthesizerAnswerBudget,
      defaults.synthesizerAnswerBudget,
    ),
    noveltyBoost: positiveNumber(obj.noveltyBoost, defaults.noveltyBoost),
    noveltyGenerations: positiveInt(
      obj.noveltyGenerations,
      defaults.noveltyGenerations,
    ),
    heatDecay: unitInterval(obj.heatDecay, defaults.heatDecay),
  };
  if (typeof obj.learningModel === "string" && obj.learningModel.trim()) {
    config.learningModel = obj.learningModel.trim();
  }
  if (isThinkingLevel(obj.learningThinking)) {
    config.learningThinking = obj.learningThinking;
  }
  if (typeof obj.recallModel === "string" && obj.recallModel.trim()) {
    config.recallModel = obj.recallModel.trim();
  }
  if (isThinkingLevel(obj.recallThinking)) {
    config.recallThinking = obj.recallThinking;
  }
  // Cross-key validation: the cold/hot hysteresis gap is load-bearing for
  // anti-flapping, and the top layer must be able to fit a single root.
  if (config.coldHeatThreshold >= config.hotHeatThreshold) {
    return {
      ok: false,
      error: `Memory config coldHeatThreshold (${config.coldHeatThreshold}) must be less than hotHeatThreshold (${config.hotHeatThreshold}); the hysteresis gap prevents promote/merge flapping.`,
    };
  }
  const singleNodeFloor = Math.ceil(
    MEMORY_MAX_SUMMARY_CHARS / MEMORY_CHARS_PER_TOKEN_ESTIMATE,
  );
  if (config.briefingTokenBudget < singleNodeFloor) {
    return {
      ok: false,
      error: `Memory config briefingTokenBudget (${config.briefingTokenBudget}) is below the single-node floor (${singleNodeFloor} tokens); the top layer could never fit.`,
    };
  }
  // The synthesizer envelope must be able to hold framing + request + the full
  // top layer + navigation + the answer; otherwise every briefing/search fails
  // closed permanently with an envelope error, misclassified as a synthesizer
  // failure. Strictly greater: equality leaves no room for a non-empty request.
  const envelopeFloor =
    config.briefingTokenBudget +
    MEMORY_SYNTHESIZER_FRAMING_BUDGET +
    config.synthesizerAnswerBudget +
    MEMORY_SYNTHESIZER_NAV_RESERVE;
  if (config.synthesizerContextBudget <= envelopeFloor) {
    return {
      ok: false,
      error: `Memory config synthesizerContextBudget (${config.synthesizerContextBudget}) must exceed briefingTokenBudget + framing + answer + navigation reserves (${envelopeFloor} tokens); the top layer could never fit the synthesizer envelope.`,
    };
  }
  return { ok: true, config, invalidFallback: false };
}

/**
 * Load workspace config. Missing file ⇒ defaults (enabled).
 * Bad JSON / invalid shape ⇒ safe disabled state until repaired.
 */
export function loadMemoryWorkspaceConfig(
  configPath: string,
): MemoryConfigLoadResult {
  if (!existsSync(configPath)) {
    return {
      ok: true,
      config: defaultMemoryWorkspaceConfig(),
      invalidFallback: false,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Cannot read memory config ${configPath}: ${detail}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: true,
      config: disabledMemoryWorkspaceConfig(),
      invalidFallback: true,
      disabledReason:
        "Memory config contains invalid JSON; memory is disabled until repaired.",
    };
  }
  const result = parseMemoryWorkspaceConfig(parsed);
  if (!result.ok) {
    return {
      ok: true,
      config: disabledMemoryWorkspaceConfig(),
      invalidFallback: true,
      disabledReason: `Memory config is invalid (${result.error}); memory is disabled until repaired.`,
    };
  }
  return result;
}

/** Persist workspace config atomically with restrictive file mode. */
export function saveMemoryWorkspaceConfig(
  configPath: string,
  config: MemoryWorkspaceConfig,
): void {
  ensureMemorySecureDir(path.dirname(configPath));
  writeMemorySecureFileAtomic(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

/** Load config for a workspace id via the standard path. */
export function loadMemoryConfigForWorkspace(
  workspaceId: string,
): MemoryConfigLoadResult {
  return loadMemoryWorkspaceConfig(memoryWorkspaceConfigPath(workspaceId));
}

/** Atomically set only the enabled flag (pause/resume), preserving other fields. */
export function setMemoryWorkspaceEnabled(
  workspaceId: string,
  enabled: boolean,
): MemoryWorkspaceConfig {
  const configPath = memoryWorkspaceConfigPath(workspaceId);
  const loaded = loadMemoryWorkspaceConfig(configPath);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const config = { ...loaded.config, enabled };
  saveMemoryWorkspaceConfig(configPath, config);
  return config;
}

/** Split `provider/modelId` into parts; null if malformed. */
export function splitMemoryModelId(
  id: string,
): { provider: string; modelId: string } | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

export interface MemoryModelFinder {
  find(provider: string, modelId: string): unknown;
}

/**
 * Validate an optional configured model against the registry.
 * Returns an error string when set but invalid; null when ok or unset.
 */
export function validateOptionalMemoryModel(
  fieldName: string,
  modelId: string | undefined,
  find: MemoryModelFinder["find"],
): string | null {
  if (!modelId) return null;
  const parsed = splitMemoryModelId(modelId);
  if (!parsed) {
    return `${fieldName} must use provider/model format: ${modelId}`;
  }
  const model = find(parsed.provider, parsed.modelId);
  if (!model) {
    return `${fieldName} does not resolve to an available model: ${modelId}`;
  }
  return null;
}

/** Resolve effective model id: config override or current session model. */
export function resolveEffectiveMemoryModelId(
  configured: string | undefined,
  currentSessionModelId: string | undefined,
): string | null {
  if (configured && configured.trim()) return configured.trim();
  if (currentSessionModelId && currentSessionModelId.trim()) {
    return currentSessionModelId.trim();
  }
  return null;
}
