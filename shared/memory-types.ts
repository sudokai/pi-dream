/**
 * Domain types for adaptive workspace memory.
 * Memory ids (`M:<n>`) are the public API surface; internal rows use integers.
 */

/** Stable memory node id as rendered at API boundaries (`M:<n>`). */
export type MemoryNodeId = `M:${number}`;

/** Lifecycle state for memories. */
export type MemoryLifecycleState = "active" | "retired";

/** Kind of durable knowledge stored in a memory. */
export type MemoryKnowledgeKind =
  "preference" | "fact" | "correction" | "other";

/** Where a citation event originated. */
export type MemoryCitationSource = "briefing" | "search";

/** Node types that participate in search, retrieval, and citation. */
export type MemorySearchableNodeType = "memory";

/** Maximum characters for one memory body or evidence quote. */
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

export interface MemoryVersionRow {
  id: number;
  memoryId: number;
  /** Distilled durable wording (the memory's current text when this is the latest version). */
  text: string;
  /** Verbatim evidence quote from the source session that produced this version. */
  evidenceText: string;
  sourceSessionId: string;
  creationGeneration: number;
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
  /** Derived: distinct source sessions that produced a version of this memory. */
  recurrence: number;
  /** Session that retired the memory via forget, or null. */
  retiredBySessionId: string | null;
  /** Verbatim evidence of the retirement statement, or null. */
  retiredEvidenceText: string | null;
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
  /** Number of visible session messages already mined; incremental mining resumes here. */
  minedMessageOffset: number;
  completedAt: string;
}

export type DreamRunStatus = "claimed" | "running" | "completed" | "failed";

export type DreamRunTrigger = "auto" | "manual";

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
      kind: MemoryKnowledgeKind;
      /** Verbatim evidence quote from the session. */
      evidenceText: string;
      memoryText: string;
    }
  | {
      op: "update";
      memoryId: MemoryNodeId;
      /** Verbatim evidence quote from the session. */
      evidenceText: string;
      /** New wording; appends a version in place. Omit to record a restatement (recurrence) without changing the text. */
      memoryText?: string;
    }
  | {
      op: "forget";
      memoryId: MemoryNodeId;
      /** Verbatim evidence of the negating statement; kept for audit. */
      evidenceText: string;
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
  /** Visible-message count of the snapshot mined by this commit (advances the incremental cursor). */
  minedMessageOffset: number;
  plan: MemoryDreamSessionPlan;
}

/** Parse a public memory node id into type + integer. Observation ids are retired. */
export function parseMemoryNodeId(
  raw: string,
):
  | { ok: true; type: "memory"; id: number; prefixed: MemoryNodeId }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  const match = /^M:(\d+)$/.exec(trimmed);
  if (!match) {
    if (/^O:/.test(trimmed)) {
      return {
        ok: false,
        error: `Observation ids are retired; expected M:<n>, got "${raw}"`,
      };
    }
    return {
      ok: false,
      error: `Invalid memory node id "${raw}"; expected M:<n>`,
    };
  }
  const id = Number(match[1]);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: `Invalid memory node id number in "${raw}"` };
  }
  return { ok: true, type: "memory", id, prefixed: `M:${id}` };
}

/** Format an integer memory id as `M:<n>`. */
export function formatMemoryNodeId(id: number): MemoryNodeId {
  return `M:${id}`;
}

/**
 * Normalize one-line memory body text for uniqueness comparisons: trim,
 * collapse whitespace, lowercase. The active-memory dedupe backstop keys on
 * it (two active memories can never share normalized body text).
 */
export function normalizeMemoryBodyText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Validate one-line atomic memory/evidence text shape. */
export function validateMemoryBodyText(
  text: string,
  maxChars: number = MEMORY_MAX_TEXT_CHARS,
  subject: string = "Memory text",
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return `${subject} must be non-empty`;
  if (trimmed.includes("\n")) return `${subject} must be a single line`;
  if (trimmed.length > maxChars) {
    return `${subject} exceeds ${maxChars} characters`;
  }
  return null;
}
