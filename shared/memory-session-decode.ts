/**
 * Single typed decoder for pi session JSONL used by the memory dreamer.
 * Observations store only extracted assertions + source-session identity —
 * never transcript excerpts — but the dreamer may page the full logical session.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MEMORY_SESSION_MAX_BYTES,
  MEMORY_SESSION_PAGE_DEFAULT,
  MEMORY_SESSION_PAGE_MAX,
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
const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "memory_search",
  "memory_list_sessions",
  "memory_read_session",
  "memory_commit_session",
]);

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
 * Format a page of decoded messages as plain text for the dreamer.
 * Only user evidence passes: generated briefings and memory-tool output are
 * excluded, so the dreamer cannot mine its own generated memory.
 */
export function formatMemorySessionPage(
  session: MemoryDecodedSession,
  opts?: { offset?: number; limit?: number },
): {
  totalMessages: number;
  offset: number;
  messages: Array<{ index: number; role: string; text: string }>;
  nextOffset: number | null;
} {
  const offset = Math.max(0, opts?.offset ?? 0);
  const rawLimit = opts?.limit ?? MEMORY_SESSION_PAGE_DEFAULT;
  const limit = Math.min(Math.max(1, rawLimit), MEMORY_SESSION_PAGE_MAX);
  const visible = session.messages
    .map((message) => {
      const parts = filterMemoryDreamerEvidenceParts(message);
      return parts.length > 0 ? { ...message, parts } : null;
    })
    .filter((message): message is MemoryDecodedMessage => message !== null);
  const total = visible.length;
  const slice = visible.slice(offset, offset + limit);
  const messages = slice.map((m, i) => {
    const text = redactMemorySensitiveText(
      m.parts
        .map((p) => {
          if (p.type === "text") return p.text ?? "";
          if (p.type === "toolCall") {
            return `[toolCall ${p.tool ?? "?"} ${p.input ?? ""}]`;
          }
          return `[toolResult ${p.tool ?? "?"} ${p.isError ? "ERROR " : ""}${p.text ?? ""}]`;
        })
        .join("\n")
        .trim(),
    );
    return {
      index: offset + i,
      role: String(m.role),
      text,
    };
  });
  const next = offset + limit < total ? offset + limit : null;
  return {
    totalMessages: total,
    offset,
    messages,
    nextOffset: next,
  };
}
