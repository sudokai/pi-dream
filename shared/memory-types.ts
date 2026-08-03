/**
 * Domain types for adaptive workspace memory.
 * Prefixed node IDs (M:/O:) are the public API surface; internal rows use integers.
 */

/** Stable memory node id as rendered at API boundaries (`M:<n>`). */
export type MemoryNodeId = `M:${number}`;

/** Immutable observation leaf id as rendered at API boundaries (`O:<n>`). */
export type ObservationNodeId = `O:${number}`;

/** Any public node id with a type prefix. */
export type PrefixedNodeId = MemoryNodeId | ObservationNodeId;

/** Lifecycle state for memories. */
export type MemoryLifecycleState =
  "active" | "conflicted" | "superseded" | "retired";

/** Kind of durable knowledge stored in an observation or memory. */
export type MemoryKnowledgeKind =
  "preference" | "fact" | "correction" | "other";

/** Typed graph edge relations between memory nodes. */
export type MemoryGraphRelation =
  "related_to" | "supersedes" | "conflicts_with";

/** Relations the dreamer `link` op may create. */
export type MemoryDreamerLinkRelation = MemoryGraphRelation;

/** Lifecycle state of a graph edge (retired edges are append-only history). */
export type MemoryGraphEdgeState = "active" | "retired";

/** Where a citation event originated. */
export type MemoryCitationSource = "briefing" | "search";

/** Node types that participate in search, retrieval, and citation. */
export type MemorySearchableNodeType = "memory";

/** Maximum characters for one observation or memory body. */
export const MEMORY_MAX_TEXT_CHARS = 400;

/** Hard cap on briefing content (chars; no target length); shared by the synthesized section and the standing-preferences section. */
export const MEMORY_BRIEFING_MAX_CHARS = 20_000;

/** Synthesizer input budget: whole memory units only, never split mid-text. */
export const MEMORY_SYNTHESIS_INPUT_CHARS = 40_000;

/** Secondary sanity guard on the number of units in one payload. */
export const MEMORY_SYNTHESIS_INPUT_MAX_UNITS = 150;

/** RRF fusion constant: score = Σ 1/(K + rank). */
export const MEMORY_RETRIEVAL_RRF_K = 60;

/** Semantic-retriever cosine floor: below this a candidate is excluded. */
export const MEMORY_RETRIEVAL_COSINE_FLOOR = 0.15;

/** Upper bound on retrieved candidate units (retrieve more than fits). */
export const MEMORY_RETRIEVAL_MAX_UNITS = 600;

/** Upper bound on retrieved candidate chars. */
export const MEMORY_RETRIEVAL_MAX_CHARS = 240_000;

/** Long queries are segmented; each segment stays under this many chars. */
export const MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS = 800;

/** Queries shorter than this many chars are trivially short (no retrieval). */
export const MEMORY_RETRIEVAL_MIN_QUERY_CHARS = 3;

/** Rough tokens reserved for framing (system prompt + user template) in the
 * provider-context capacity check. */
export const MEMORY_SYNTHESIS_FRAMING_TOKENS = 2000;

/** Output reserve for the provider-context capacity check: covers the full
 * briefing cap (≈5000 tokens at 4 chars/token) plus the JSON wrapper and a
 * repair-payload growth margin. */
export const MEMORY_SYNTHESIS_OUTPUT_RESERVE_TOKENS = 6000;

/** Default automatic dreaming cadence: settled turns. */
export const MEMORY_DEFAULT_MIN_TURNS = 10;

/** Default automatic dreaming cadence: minutes since last successful run. */
export const MEMORY_DEFAULT_MIN_MINUTES = 120;

/** Stale dream-run claim threshold (ms). */
export const MEMORY_STALE_RUN_MS = 60 * 60 * 1000;

/** SQLite busy timeout (ms). */
export const MEMORY_DB_BUSY_TIMEOUT_MS = 5000;

/** Local embedding model id (Xenova MiniLM). */
export const MEMORY_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Custom message type for the visible first-turn briefing. */
export const MEMORY_BRIEFING_CUSTOM_TYPE = "pi-dream-briefing";

/** Custom entry type for human audit list/open output (not LLM context). */
export const MEMORY_AUDIT_CUSTOM_TYPE = "pi-dream-audit";

/** Environment flag set on detached dreamer children. */
export const MEMORY_CHILD_ENV = "PI_DREAM_CHILD";

/** Test-only override for the storage root under ~/.pi/agent/dream. */
export const MEMORY_STORAGE_ROOT_ENV = "PI_DREAM_STORAGE_ROOT";

/** Pi session-dir override (same env as pi-coding-agent). */
export const MEMORY_PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/** Provider auth resolution timeout (ms). */
export const MEMORY_AUTH_TIMEOUT_MS = 10_000;

/** Synthesizer completion backstop (ms); only applies when the caller passes no abort signal. */
export const MEMORY_COMPLETION_TIMEOUT_MS = 30_000;

/** Maximum session JSONL bytes read for discovery/header checks. */
export const MEMORY_SESSION_MAX_BYTES = 64 * 1024 * 1024;

/** Default page size for dreamer session paging. */
export const MEMORY_SESSION_PAGE_DEFAULT = 40;

/** Maximum page size for dreamer session paging. */
export const MEMORY_SESSION_PAGE_MAX = 200;

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
  createdAt: string;
  updatedAt: string;
  /** Current version text (projection). */
  text: string;
  /** Derived: distinct source sessions via observations. */
  recurrence: number;
}

export interface GraphEdgeRow {
  id: number;
  relation: MemoryGraphRelation;
  fromType: MemorySearchableNodeType;
  fromId: number;
  toType: MemorySearchableNodeType;
  toId: number;
  state: MemoryGraphEdgeState;
  createdAt: string;
}

export interface CitationEventRow {
  id: number;
  nodeType: MemorySearchableNodeType;
  nodeId: number;
  source: MemoryCitationSource;
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

export type DreamRunStatus = "claimed" | "running" | "completed" | "failed";

export type DreamRunTrigger = "auto" | "manual";

export interface DreamRunRow {
  id: string;
  trigger: DreamRunTrigger;
  model: string | null;
  status: DreamRunStatus;
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
  /** Set when the last recall capacity check failed (provider context too small). */
  recallCapacityError: string | null;
  /** Set when the last dream's embedding pass degraded (semantic retriever off). */
  embeddingDegradedError: string | null;
  updatedAt: string;
}

export type MemoryDreamerOperation =
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
      relation: MemoryDreamerLinkRelation;
      /** Prefixed M: ids or in-commit temp refs. */
      fromId: string;
      toId: string;
    }
  | { op: "no_op"; reason?: string };

export interface MemoryDreamSessionPlan {
  operations: MemoryDreamerOperation[];
}

export interface MemoryDreamCommitInput {
  runId: string;
  sourceSessionId: string;
  sessionPath: string;
  cwd: string;
  processedMtimeMs: number;
  contentHash: string | null;
  plan: MemoryDreamSessionPlan;
}

/** Parse a public prefixed node id into type + integer. */
export function parsePrefixedNodeId(
  raw: string,
):
  | { ok: true; type: "memory"; id: number; prefixed: MemoryNodeId }
  | { ok: true; type: "observation"; id: number; prefixed: ObservationNodeId }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  const match = /^(M|O):(\d+)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: `Invalid memory node id "${raw}"; expected M:<n> or O:<n>`,
    };
  }
  const id = Number(match[2]);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: `Invalid memory node id number in "${raw}"` };
  }
  if (match[1] === "M") {
    return { ok: true, type: "memory", id, prefixed: `M:${id}` };
  }
  return { ok: true, type: "observation", id, prefixed: `O:${id}` };
}

/** Format an integer memory id as `M:<n>`. */
export function formatMemoryNodeId(id: number): MemoryNodeId {
  return `M:${id}`;
}

/** Format an integer observation id as `O:<n>`. */
export function formatObservationNodeId(id: number): ObservationNodeId {
  return `O:${id}`;
}

/** Normalize observation text for uniqueness within a source session. */
export function normalizeObservationText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
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
