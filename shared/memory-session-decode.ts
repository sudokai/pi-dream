/**
 * Single typed decoder for pi session JSONL used by the memory learner.
 * Observations store only extracted assertions + source-session identity —
 * never transcript excerpts — but the learner may page the full logical session.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";

export interface MemoryRawMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: unknown;
}

export type MemoryRawEntryType =
  | "session"
  | "message"
  | "branch_summary"
  | "compaction"
  | "custom_message";

export interface MemoryRawEntry {
  type: MemoryRawEntryType;
  timestamp?: unknown;
  id?: string;
  cwd?: string;
  message?: MemoryRawMessage;
  summary?: string;
  content?: string;
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
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = obj.type;
  if (typeof type !== "string" || !RECOGNIZED_TYPES.has(type)) return null;
  return obj as unknown as MemoryRawEntry;
}

/** Parse a full session JSONL file (malformed lines skipped). */
export function parseMemorySessionJsonl(filePath: string): MemoryRawEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const entries: MemoryRawEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseMemoryJsonlLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export type MemoryDecodedRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "branch"
  | "compaction"
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
    default:
      return role;
  }
}

function buildToolCallIdMap(
  messages: MemoryRawMessage[],
): Map<string, string> {
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
 * Decode raw entries into a logical session for learner paging.
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
      rawMessages.push({ role: "user", content: String(entry.content) });
      messageMeta.push({
        role: "user",
        ts: memoryTimestampToEpochMs(entry.timestamp),
      });
    }
  }

  const toolMap = buildToolCallIdMap(rawMessages);
  const messages: MemoryDecodedMessage[] = rawMessages.map((m, i) => ({
    role: mapRole(messageMeta[i]?.role ?? m.role),
    ts: messageMeta[i]?.ts ?? null,
    parts: decodeParts(m, toolMap),
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
 * Load an immutable learning snapshot only when its bytes match the manifest hash.
 * Unlike live-session decoding, unreadable or modified snapshots fail closed.
 */
export function loadVerifiedMemorySessionSnapshot(
  snapshotPath: string,
  expectedContentHash: string,
): MemoryDecodedSession {
  let bytes: Buffer;
  try {
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
 * Format a page of decoded messages as plain text for the learner.
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
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 40;
  const total = session.messages.length;
  const slice = session.messages.slice(offset, offset + limit);
  const messages = slice.map((m, i) => {
    const text = m.parts
      .map((p) => {
        if (p.type === "text") return p.text ?? "";
        if (p.type === "toolCall") {
          return `[toolCall ${p.tool ?? "?"} ${p.input ?? ""}]`;
        }
        return `[toolResult ${p.tool ?? "?"} ${p.isError ? "ERROR " : ""}${p.text ?? ""}]`;
      })
      .join("\n")
      .trim();
    return {
      index: offset + i,
      role: String(m.role),
      text,
    };
  });
  const next =
    offset + limit < total ? offset + limit : null;
  return {
    totalMessages: total,
    offset,
    messages,
    nextOffset: next,
  };
}
