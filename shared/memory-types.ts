/**
 * Domain types for adaptive workspace memory.
 * Prefixed node IDs (M:/S:/O:) are the public API surface; internal rows use integers.
 */

/** Stable memory node id as rendered at API boundaries (`M:<n>`). */
export type MemoryNodeId = `M:${number}`;

/** Stable summary node id as rendered at API boundaries (`S:<n>`). */
export type SummaryNodeId = `S:${number}`;

/** Immutable observation leaf id as rendered at API boundaries (`O:<n>`). */
export type ObservationNodeId = `O:${number}`;

/** Any public node id with a type prefix. */
export type PrefixedNodeId = MemoryNodeId | SummaryNodeId | ObservationNodeId;

/** Lifecycle state for memories and summaries. */
export type MemoryLifecycleState =
  "active" | "conflicted" | "superseded" | "retired";

/** Kind of durable knowledge stored in an observation or memory. */
export type MemoryKnowledgeKind =
  "preference" | "fact" | "correction" | "other";

/** Typed graph edge relations between memory/summary nodes. */
export type MemoryGraphRelation =
  "contains" | "related_to" | "supersedes" | "conflicts_with";

/** Where a recall event originated. */
export type MemoryRecallSource = "startup" | "search" | "open";

/** Node types that participate in search, heat, and briefing. */
export type MemorySearchableNodeType = "memory" | "summary";

/** Briefing section identifiers the planner may choose. */
export type MemoryBriefingSectionId =
  "learned_user_preferences" | "workspace_knowledge" | "relevant_summaries";

export const MEMORY_BRIEFING_SECTION_LABELS: Record<
  MemoryBriefingSectionId,
  string
> = {
  learned_user_preferences: "Learned user preferences",
  workspace_knowledge: "Workspace knowledge",
  relevant_summaries: "Relevant summaries",
};

/** Maximum characters for one observation or memory body. */
export const MEMORY_MAX_TEXT_CHARS = 400;

/** Maximum characters for one summary body. */
export const MEMORY_MAX_SUMMARY_CHARS = 800;

/** Estimated briefing ceiling in tokens (complete atomic nodes only). */
export const MEMORY_BRIEFING_TOKEN_BUDGET = 8000;

/** Rough chars-per-token estimate used for budget packing. */
export const MEMORY_CHARS_PER_TOKEN_ESTIMATE = 4;

/** Hybrid retrieval pool size before the LLM planner. */
export const MEMORY_HYBRID_POOL_SIZE = 50;

/** Reciprocal-rank-fusion constant (short-list tuned, not textbook 60). */
export const MEMORY_RRF_K = 20;

/** MiniLM cosine floor for semantic candidates. */
export const MEMORY_SEMANTIC_FLOOR = 0.25;

/** Default automatic learning cadence: settled turns. */
export const MEMORY_DEFAULT_MIN_TURNS = 10;

/** Default automatic learning cadence: minutes since last successful run. */
export const MEMORY_DEFAULT_MIN_MINUTES = 120;

/** Novelty heat boost for newly activated memories. */
export const MEMORY_NOVELTY_BOOST = 1.0;

/** Novelty duration in activity generations. */
export const MEMORY_NOVELTY_GENERATIONS = 3;

/** Exponential heat decay base per activity generation. */
export const MEMORY_HEAT_DECAY = 0.85;

/** Weight of one recall event before decay. */
export const MEMORY_RECALL_EVENT_WEIGHT = 1.0;

/** Stale learning-run claim threshold (ms). */
export const MEMORY_STALE_RUN_MS = 60 * 60 * 1000;

/** SQLite busy timeout (ms). */
export const MEMORY_DB_BUSY_TIMEOUT_MS = 3000;

/** Local embedding model id (Xenova MiniLM). */
export const MEMORY_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Custom message type for the visible first-turn briefing. */
export const MEMORY_BRIEFING_CUSTOM_TYPE = "pi-dream-briefing";

/** Custom entry type for human audit list/open output (not LLM context). */
export const MEMORY_AUDIT_CUSTOM_TYPE = "pi-dream-audit";

/** Environment flag set on detached learner children. */
export const MEMORY_CHILD_ENV = "PI_DREAM_CHILD";

/** Test-only override for the storage root under ~/.pi/agent/dream. */
export const MEMORY_STORAGE_ROOT_ENV = "PI_DREAM_STORAGE_ROOT";

/** Pi session-dir override (same env as pi-coding-agent). */
export const MEMORY_PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/** Opening briefing / memory_search operation timeout (ms). */
export const MEMORY_RECALL_OPERATION_TIMEOUT_MS = 15_000;

/** Provider auth resolution timeout (ms). */
export const MEMORY_AUTH_TIMEOUT_MS = 10_000;

/** Planner completion timeout (ms). */
export const MEMORY_COMPLETION_TIMEOUT_MS = 30_000;

/** Maximum session JSONL bytes read for discovery/header checks. */
export const MEMORY_SESSION_MAX_BYTES = 64 * 1024 * 1024;

/** Default page size for learner session paging. */
export const MEMORY_SESSION_PAGE_DEFAULT = 40;

/** Maximum page size for learner session paging. */
export const MEMORY_SESSION_PAGE_MAX = 200;

/** Default page size for memory_open /memory open children. */
export const MEMORY_OPEN_PAGE_DEFAULT = 40;

/** Maximum graph children returned per memory_open page. */
export const MEMORY_OPEN_CHILDREN_MAX = 50;

export interface MemoryObservationRow {
  id: number;
  kind: MemoryKnowledgeKind;
  text: string;
  normalizedText: string;
  sourceSessionId: string;
  creationGeneration: number;
  createdAt: string;
}

export interface MemoryVersionRow {
  id: number;
  memoryId: number;
  text: string;
  previousVersionId: number | null;
  createdAt: string;
}

export interface MemoryRow {
  id: number;
  kind: MemoryKnowledgeKind;
  state: MemoryLifecycleState;
  currentVersionId: number;
  creationGeneration: number;
  noveltyUntilGeneration: number | null;
  createdAt: string;
  updatedAt: string;
  /** Current version text (projection). */
  text: string;
  /** Derived: distinct source sessions via observations. */
  recurrence: number;
}

export interface SummaryVersionRow {
  id: number;
  summaryId: number;
  text: string;
  previousVersionId: number | null;
  createdAt: string;
}

export interface SummaryRow {
  id: number;
  state: MemoryLifecycleState;
  currentVersionId: number;
  creationGeneration: number;
  createdAt: string;
  updatedAt: string;
  text: string;
}

export interface GraphEdgeRow {
  id: number;
  relation: MemoryGraphRelation;
  fromType: MemorySearchableNodeType;
  fromId: number;
  toType: MemorySearchableNodeType;
  toId: number;
  createdAt: string;
}

export interface RecallEventRow {
  id: number;
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  activityGeneration: number;
  source: MemoryRecallSource;
  piSessionId: string | null;
  createdAt: string;
}

export interface SourceSessionRow {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  processedMtimeMs: number;
  contentHash: string | null;
  completedAt: string;
}

export type LearningRunStatus = "claimed" | "running" | "completed" | "failed";

export type LearningRunTrigger = "auto" | "manual";

export interface LearningRunRow {
  id: string;
  trigger: LearningRunTrigger;
  model: string | null;
  status: LearningRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorText: string | null;
  reportedToParent: number;
}

export interface WorkspaceStateRow {
  activityGeneration: number;
  turnsSinceLastRun: number;
  lastSuccessfulRunAtMs: number;
  lastObservedTranscriptMtimeMs: number | null;
  updatedAt: string;
}

/** Transient hybrid search hit before LLM filtering. */
export interface MemorySearchCandidate {
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  prefixedId: MemoryNodeId | SummaryNodeId;
  kind: MemoryKnowledgeKind | "summary";
  text: string;
  heat: number;
  estimatedTokens: number;
  bm25Rank: number | null;
  semanticRank: number | null;
  rrfScore: number;
}

/** One briefing section after planner validation and budget packing. */
export interface MemoryBriefingSection {
  sectionId: MemoryBriefingSectionId;
  label: string;
  nodes: Array<{
    prefixedId: MemoryNodeId | SummaryNodeId;
    nodeType: MemorySearchableNodeType;
    kind: MemoryKnowledgeKind | "summary";
    text: string;
    heat: number;
  }>;
}

export interface MemoryBriefingPlan {
  sections: MemoryBriefingSection[];
  estimatedTokens: number;
  selectedIds: Array<MemoryNodeId | SummaryNodeId>;
}

/** Structured summary create/update operation; updates carry the observed version. */
export type MemoryLearnerSummaryOperation =
  | {
      op: "summarize";
      /** Create a summary and optionally expose it to later in-commit operations. */
      tempRef?: string;
      summaryId?: undefined;
      expectedVersionId?: undefined;
      text: string;
      /** Prefixed M:/S: ids or in-commit temp refs from create/summarize. */
      memberIds: string[];
    }
  | {
      op: "summarize";
      /** Update this active summary only when its observed version still matches. */
      summaryId: SummaryNodeId;
      expectedVersionId: number;
      tempRef?: undefined;
      text: string;
      /** Prefixed M:/S: ids or in-commit temp refs from create/summarize. */
      memberIds: string[];
    };

export type MemoryLearnerOperation =
  | {
      op: "create";
      tempRef: string;
      kind: MemoryKnowledgeKind;
      observationText: string;
      memoryText: string;
    }
  | {
      op: "reinforce";
      memoryId: MemoryNodeId;
      observationText: string;
    }
  | {
      op: "revise";
      memoryId: MemoryNodeId;
      observationText: string;
      memoryText: string;
      expectedVersionId: number;
    }
  | {
      op: "supersede";
      oldMemoryId: MemoryNodeId;
      newTempRef: string;
      kind: MemoryKnowledgeKind;
      observationText: string;
      memoryText: string;
    }
  | {
      op: "conflict";
      memoryIds: MemoryNodeId[];
      observationText?: string;
    }
  | {
      op: "link";
      relation: MemoryGraphRelation;
      /** Prefixed M:/S: ids or in-commit temp refs. */
      fromId: string;
      toId: string;
    }
  | MemoryLearnerSummaryOperation
  | { op: "no_op"; reason?: string };

export interface MemoryLearningSessionPlan {
  operations: MemoryLearnerOperation[];
}

export interface MemoryLearningCommitInput {
  runId: string;
  sourceSessionId: string;
  sessionPath: string;
  cwd: string;
  processedMtimeMs: number;
  contentHash: string | null;
  plan: MemoryLearningSessionPlan;
}

/** Parse a public prefixed node id into type + integer. */
export function parsePrefixedNodeId(
  raw: string,
):
  | { ok: true; type: "memory"; id: number; prefixed: MemoryNodeId }
  | { ok: true; type: "summary"; id: number; prefixed: SummaryNodeId }
  | { ok: true; type: "observation"; id: number; prefixed: ObservationNodeId }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  const match = /^(M|S|O):(\d+)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: `Invalid memory node id "${raw}"; expected M:<n>, S:<n>, or O:<n>`,
    };
  }
  const id = Number(match[2]);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: `Invalid memory node id number in "${raw}"` };
  }
  if (match[1] === "M") {
    return { ok: true, type: "memory", id, prefixed: `M:${id}` };
  }
  if (match[1] === "S") {
    return { ok: true, type: "summary", id, prefixed: `S:${id}` };
  }
  return { ok: true, type: "observation", id, prefixed: `O:${id}` };
}

/** Format an integer memory id as `M:<n>`. */
export function formatMemoryNodeId(id: number): MemoryNodeId {
  return `M:${id}`;
}

/** Format an integer summary id as `S:<n>`. */
export function formatSummaryNodeId(id: number): SummaryNodeId {
  return `S:${id}`;
}

/** Format an integer observation id as `O:<n>`. */
export function formatObservationNodeId(id: number): ObservationNodeId {
  return `O:${id}`;
}

/** Normalize observation text for uniqueness within a source session. */
export function normalizeObservationText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Estimate tokens for budget packing from character length. */
export function estimateMemoryTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / MEMORY_CHARS_PER_TOKEN_ESTIMATE));
}

/** Validate one-line atomic observation/memory text shape. */
export function validateMemoryBodyText(
  text: string,
  maxChars: number = MEMORY_MAX_TEXT_CHARS,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Memory text must be non-empty";
  if (trimmed.includes("\n")) return "Memory text must be a single line";
  if (trimmed.length > maxChars) {
    return `Memory text exceeds ${maxChars} characters`;
  }
  return null;
}
