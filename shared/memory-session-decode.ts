/**
 * Single typed decoder for pi session JSONL used by the memory dreamer.
 * Observations store only extracted assertions + source-session identity —
 * never transcript excerpts — but the dreamer may page the full logical session.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MEMORY_MINE_MESSAGE_CHARS,
  MEMORY_MINE_SEGMENT_CHARS,
  MEMORY_MINE_SEGMENT_MAX_MESSAGES,
  MEMORY_MINE_TOOL_RESULT_CHARS,
  MEMORY_SESSION_MAX_BYTES,
} from "./memory-types.ts";
import { redactMemorySensitiveText } from "./memory-redaction.ts";

export interface MemoryRawMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: unknown;
  /** Provenance: customType of a custom_message entry, when present. */
  customType?: string;
}

export type MemoryRawEntryType =
  "session" | "message" | "branch_summary" | "compaction" | "custom_message";

export interface MemoryRawEntry {
  type: MemoryRawEntryType;
  timestamp?: unknown;
  id?: string;
  cwd?: string;
  message?: MemoryRawMessage;
  summary?: string;
  content?: string;
  /** Provenance for custom_message entries. */
  customType?: string;
}

const RECOGNIZED_TYPES: ReadonlySet<string> = new Set([
  "session",
  "message",
  "branch_summary",
  "compaction",
  "custom_message",
]);

/** Parse one JSONL line into a recognized entry, or null. */
export function parseMemoryJsonlLine(line: string): MemoryRawEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string" || !RECOGNIZED_TYPES.has(type)) return null;
  return obj as unknown as MemoryRawEntry;
}

/** Parse a full session JSONL file (malformed lines skipped). */
export function parseMemorySessionJsonl(filePath: string): MemoryRawEntry[] {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MEMORY_SESSION_MAX_BYTES) {
      throw new Error(
        `Session file exceeds ${MEMORY_SESSION_MAX_BYTES} bytes: ${filePath}`,
      );
    }
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    if (err instanceof Error && err.message.includes("exceeds")) throw err;
    return [];
  }
  const entries: MemoryRawEntry[] = [];
  for (const line of bytes.toString("utf-8").split("\n")) {
    const entry = parseMemoryJsonlLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Stable fallback source-session id when the header omits an id. */
export function deriveMemorySessionFallbackId(
  sessionPath: string,
  cwd: string | null,
): string {
  const canonical = path.resolve(sessionPath);
  const material = `${canonical}\0${cwd ?? ""}`;
  return `path:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

export type MemoryDecodedRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "branch"
  | "compaction"
  | "custom"
  | string;

export interface MemoryDecodedPart {
  type: "text" | "toolCall" | "toolResult";
  tool?: string;
  toolCallId?: string;
  input?: string;
  text?: string;
  isError?: boolean;
}

export interface MemoryDecodedMessage {
  role: MemoryDecodedRole;
  ts: number | null;
  parts: MemoryDecodedPart[];
  /** Provenance for custom_message entries (e.g. pi-dream-briefing). */
  customType?: string;
}

export interface MemoryDecodedSession {
  sessionId: string | null;
  cwd: string | null;
  messages: MemoryDecodedMessage[];
}

/** Normalize a pi timestamp value to epoch ms, or null. */
export function memoryTimestampToEpochMs(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    const block = p as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

function mapRole(role: string): MemoryDecodedRole {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "toolResult";
    case "branchSummary":
      return "branch";
    case "compactionSummary":
      return "compaction";
    case "custom":
      return "custom";
    default:
      return role;
  }
}

function buildToolCallIdMap(messages: MemoryRawMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{
      type?: string;
      name?: string;
      id?: string;
    }>) {
      if (p && p.type === "toolCall" && p.name && p.id) {
        map.set(p.id, p.name);
      }
    }
  }
  return map;
}

function decodeParts(
  m: MemoryRawMessage,
  toolCallIdToTool: Map<string, string>,
): MemoryDecodedPart[] {
  if (m.role === "toolResult") {
    const tool =
      m.toolName ??
      (m.toolCallId ? toolCallIdToTool.get(m.toolCallId) : undefined);
    return [
      {
        type: "toolResult",
        tool,
        toolCallId: m.toolCallId,
        text: extractText(m.content),
        isError: m.isError === true,
      },
    ];
  }

  const content = m.content;
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: MemoryDecodedPart[] = [];
  for (const p of content as Array<Record<string, unknown>>) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "toolCall") {
      parts.push({
        type: "toolCall",
        tool: typeof p.name === "string" ? p.name : undefined,
        toolCallId: typeof p.id === "string" ? p.id : undefined,
        input: safeStringify(p.arguments ?? p.input),
      });
    }
  }
  return parts;
}

/**
 * Decode raw entries into a logical session for dreamer paging.
 */
export function decodeMemorySession(
  entries: MemoryRawEntry[],
): MemoryDecodedSession {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  const rawMessages: MemoryRawMessage[] = [];
  const messageMeta: Array<{ role: string; ts: number | null }> = [];

  for (const entry of entries) {
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    if (entry.type === "message" && entry.message) {
      rawMessages.push(entry.message);
      messageMeta.push({
        role: entry.message.role,
        ts: memoryTimestampToEpochMs(
          entry.message.timestamp ?? entry.timestamp,
        ),
      });
      continue;
    }
    if (entry.type === "branch_summary" && entry.summary) {
      rawMessages.push({
        role: "branchSummary",
        content: entry.summary,
      });
      messageMeta.push({
        role: "branchSummary",
        ts: memoryTimestampToEpochMs(entry.timestamp),
      });
    }
    if (entry.type === "compaction" && entry.summary) {
      rawMessages.push({
        role: "compactionSummary",
        content: entry.summary,
      });
      messageMeta.push({
        role: "compactionSummary",
        ts: memoryTimestampToEpochMs(entry.timestamp),
      });
    }
    if (entry.type === "custom_message" && entry.content) {
      // Extension-generated messages (briefings, audit entries) are NOT user
      // speech: keep them with their customType provenance and a dedicated
      // role so dreamer input can exclude them.
      rawMessages.push({
        role: "custom",
        content: entry.content,
        customType: entry.customType,
      });
      messageMeta.push({
        role: "custom",
        ts: memoryTimestampToEpochMs(entry.timestamp),
      });
    }
  }

  const toolMap = buildToolCallIdMap(rawMessages);
  const messages: MemoryDecodedMessage[] = rawMessages.map((m, i) => ({
    role: mapRole(messageMeta[i]?.role ?? m.role),
    ts: messageMeta[i]?.ts ?? null,
    parts: decodeParts(m, toolMap),
    customType: m.customType,
  }));

  return { sessionId, cwd, messages };
}

/** Load and decode a session file, treating an unreadable live file as empty. */
export function loadDecodedMemorySession(
  filePath: string,
): MemoryDecodedSession {
  return decodeMemorySession(parseMemorySessionJsonl(filePath));
}

/**
 * Load an immutable dream snapshot only when its bytes match the manifest hash.
 * Unlike live-session decoding, unreadable or modified snapshots fail closed.
 */
export function loadVerifiedMemorySessionSnapshot(
  snapshotPath: string,
  expectedContentHash: string,
): MemoryDecodedSession {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(snapshotPath);
    if (stat.size > MEMORY_SESSION_MAX_BYTES) {
      throw new Error(`Memory snapshot exceeds safe size: ${snapshotPath}`);
    }
    bytes = fs.readFileSync(snapshotPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Memory snapshot read failed: ${snapshotPath}: ${detail}`);
  }
  const actualContentHash = createHash("sha256").update(bytes).digest("hex");
  if (actualContentHash !== expectedContentHash) {
    throw new Error(`Memory snapshot hash mismatch: ${snapshotPath}`);
  }
  const entries: MemoryRawEntry[] = [];
  for (const line of bytes.toString("utf-8").split("\n")) {
    const entry = parseMemoryJsonlLine(line);
    if (entry) entries.push(entry);
  }
  return decodeMemorySession(entries);
}

/**
 * Tool calls/results produced by dream's own memory tools echo stored memory
 * text back into the transcript. They are not user evidence and must not be
 * mined as memory content.
 */
const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(["memory_search"]);

function isMemoryToolPart(part: MemoryDecodedPart): boolean {
  return (
    (part.type === "toolResult" || part.type === "toolCall") &&
    part.tool !== undefined &&
    MEMORY_TOOL_NAMES.has(part.tool)
  );
}

/**
 * Filter one decoded message down to dreamer evidence parts. Generated custom
 * messages and Dream memory-tool parts are removed individually, preserving
 * text and ordinary tool results from a mixed assistant message.
 */
function filterMemoryDreamerEvidenceParts(
  m: MemoryDecodedMessage,
): MemoryDecodedPart[] {
  if (m.role === "custom") return [];
  return m.parts.filter((part) => !isMemoryToolPart(part));
}

/**
 * Whether a decoded message has dreamer evidence after per-part filtering.
 * Ordinary tool results stay visible even when a message also used Dream's
 * memory tools.
 */
export function isMemoryDreamerEvidence(m: MemoryDecodedMessage): boolean {
  return filterMemoryDreamerEvidenceParts(m).length > 0;
}

/**
 * Deterministic truncation that keeps both edges of long content: the head
 * carries the immediate statement, the tail carries conclusions/output
 * endings — the parts of tool output and assistant reasoning that actually
 * hold durable facts. The middle is dropped and its size marked.
 */
function truncateKeepEdges(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const head = Math.ceil(maxChars / 2);
  const tail = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return `${text.slice(0, head)}…[${omitted} chars omitted]…${text.slice(-tail)}`;
}

/** Format one message's evidence parts into a bounded plain-text block. */
function formatEvidenceMessage(m: MemoryDecodedMessage, index: number): string {
  const blocks: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text") {
      blocks.push(
        truncateKeepEdges((p.text ?? "").trim(), MEMORY_MINE_MESSAGE_CHARS),
      );
    } else if (p.type === "toolCall") {
      const input = truncateKeepEdges((p.input ?? "").trim(), 200);
      blocks.push(`[toolCall ${p.tool ?? "?"} ${input}]`);
    } else {
      const body = (p.text ?? "").trim();
      const truncated = truncateKeepEdges(body, MEMORY_MINE_TOOL_RESULT_CHARS);
      blocks.push(
        `[toolResult ${p.tool ?? "?"} ${p.isError ? "ERROR " : ""}${truncated}]`,
      );
    }
  }
  const body = blocks.join("\n").trim();
  const text = redactMemorySensitiveText(body || "(no text)");
  return `[${index}] ${String(m.role)}:\n${text}`;
}

/** The session's dreamer-visible messages (generated content and Dream
 * memory-tool parts excluded), in order. The visible position is the index
 * space the mined-message cursor counts against. */
function visibleEvidenceMessages(
  session: MemoryDecodedSession,
): MemoryDecodedMessage[] {
  const visible: MemoryDecodedMessage[] = [];
  for (const message of session.messages) {
    const parts = filterMemoryDreamerEvidenceParts(message);
    if (parts.length > 0) {
      visible.push({ ...message, parts });
    }
  }
  return visible;
}

/** One deterministic LLM mining segment: a bounded slice of a session's
 * visible evidence, formatted and truncated so its `text` never exceeds the
 * char budget. Cursor semantics: consuming a segment advances the session's
 * mined-message offset to `endIndex`; resuming at `startIndex` regenerates
 * the exact same segment from the same snapshot. */
export interface MemorySessionEvidenceSegment {
  startIndex: number;
  endIndex: number;
  text: string;
  /** chars of `text` — the token-budget metric (≈ chars/4 tokens). */
  chars: number;
}

export interface MemorySegmentOptions {
  /** Resume cursor: absolute visible-message index to start from. */
  startOffset?: number;
  /** Char budget per segment (default MEMORY_MINE_SEGMENT_CHARS). */
  maxChars?: number;
  /** Safety cap on messages per segment (default MEMORY_MINE_SEGMENT_MAX_MESSAGES). */
  maxMessages?: number;
}

/** Number of dreamer-visible messages in a session (the total the mined
 * cursor counts against). */
export function countMemorySessionEvidence(
  session: MemoryDecodedSession,
): number {
  return visibleEvidenceMessages(session).length;
}

/**
 * Deterministically split a session's visible evidence into bounded segments
 * for the mining driver. Segmentation depends only on the snapshot content
 * and the resume offset, so a partial mine resumes to the exact same
 * segments. Per-message truncation (edges kept) bounds every line well under
 * the segment budget, so one message can never overflow a segment.
 */
export function segmentMemorySessionEvidence(
  session: MemoryDecodedSession,
  opts: MemorySegmentOptions = {},
): MemorySessionEvidenceSegment[] {
  const startOffset = Math.max(0, opts.startOffset ?? 0);
  const maxChars = opts.maxChars ?? MEMORY_MINE_SEGMENT_CHARS;
  const maxMessages = opts.maxMessages ?? MEMORY_MINE_SEGMENT_MAX_MESSAGES;
  const visible = visibleEvidenceMessages(session);
  const segments: MemorySessionEvidenceSegment[] = [];
  let current: {
    startIndex: number;
    lines: string[];
    chars: number;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    segments.push({
      startIndex: current.startIndex,
      endIndex: current.startIndex + current.lines.length,
      text: current.lines.join("\n\n"),
      chars: current.chars,
    });
    current = null;
  };

  for (let v = startOffset; v < visible.length; v++) {
    // v is the visible position: the same index space as the mined cursor.
    const line = formatEvidenceMessage(visible[v]!, v);
    if (
      current &&
      (current.chars + line.length > maxChars ||
        current.lines.length >= maxMessages)
    ) {
      flush();
    }
    if (!current) {
      current = { startIndex: v, lines: [], chars: 0 };
    }
    current.lines.push(line);
    current.chars += line.length;
  }
  flush();
  return segments;
}
