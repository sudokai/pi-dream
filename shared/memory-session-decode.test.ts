import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decodeMemorySession,
  formatMemorySessionPage,
  loadDecodedMemorySession,
  loadVerifiedMemorySessionSnapshot,
  parseMemoryJsonlLine,
} from "./memory-session-decode.ts";

test("parseMemoryJsonlLine tolerates junk", () => {
  assert.equal(parseMemoryJsonlLine(""), null);
  assert.equal(parseMemoryJsonlLine("{"), null);
  assert.equal(parseMemoryJsonlLine('{"type":"model_change"}'), null);
  assert.equal(parseMemoryJsonlLine("null"), null);
  assert.equal(parseMemoryJsonlLine("[1,2]"), null);
  assert.equal(parseMemoryJsonlLine('"hello"'), null);
  assert.equal(parseMemoryJsonlLine("42"), null);
  const s = parseMemoryJsonlLine('{"type":"session","id":"abc","cwd":"/tmp"}');
  assert.equal(s?.type, "session");
  assert.equal(s?.id, "abc");
});

test("decodeMemorySession pages messages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-sess-"));
  try {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "sid", cwd: "/tmp/p" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "second" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const session = loadDecodedMemorySession(file);
    assert.equal(session.sessionId, "sid");
    assert.equal(session.messages.length, 3);
    const page = formatMemorySessionPage(session, { offset: 0, limit: 2 });
    assert.equal(page.messages.length, 2);
    assert.equal(page.nextOffset, 2);
    const page2 = formatMemorySessionPage(session, { offset: 2, limit: 2 });
    assert.equal(page2.nextOffset, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadVerifiedMemorySessionSnapshot fails closed on missing or modified snapshots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-snapshot-"));
  try {
    const file = path.join(dir, "session.jsonl");
    const bytes = Buffer.from(
      `${JSON.stringify({ type: "session", id: "sid", cwd: "/tmp" })}\n`,
      "utf-8",
    );
    fs.writeFileSync(file, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      loadVerifiedMemorySessionSnapshot(file, hash).sessionId,
      "sid",
    );

    fs.appendFileSync(file, "corrupted\n", "utf-8");
    assert.throws(
      () => loadVerifiedMemorySessionSnapshot(file, hash),
      /Memory snapshot hash mismatch/,
    );

    fs.rmSync(file);
    assert.throws(
      () => loadVerifiedMemorySessionSnapshot(file, hash),
      /Memory snapshot read failed/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("decodeMemorySession maps tool results", () => {
  const decoded = decodeMemorySession([
    { type: "session", id: "1", cwd: "/x" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: "ok",
      },
    },
  ]);
  assert.equal(decoded.messages[1]!.parts[0]!.type, "toolResult");
  assert.equal(decoded.messages[1]!.parts[0]!.tool, "bash");
});

test("generated briefings keep provenance and are not dreamer evidence", () => {
  const decoded = decodeMemorySession([
    { type: "session", id: "1", cwd: "/x" },
    {
      type: "custom_message",
      customType: "pi-dream-briefing",
      content:
        "# Workspace memory briefing\n- **M:1** (preference): Do not use emoji",
    },
    {
      type: "message",
      message: { role: "user", content: "I like tabs" },
    },
  ]);
  const briefing = decoded.messages[0]!;
  assert.equal(briefing.role, "custom", "briefings are not user speech");
  assert.equal(
    briefing.customType,
    "pi-dream-briefing",
    "provenance is preserved on the decoded message",
  );
  assert.equal(briefing.parts[0]!.type, "text");

  const page = formatMemorySessionPage(decoded);
  assert.equal(page.totalMessages, 1, "briefing excluded from dreamer input");
  assert.equal(page.messages[0]!.role, "user");
  assert.equal(page.messages[0]!.text, "I like tabs");
});

test("memory-tool parts are excluded without discarding mixed messages", () => {
  const decoded = decodeMemorySession([
    { type: "session", id: "1", cwd: "/x" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I found the relevant preference." },
          {
            type: "toolCall",
            id: "tc1",
            name: "memory_search",
            arguments: { query: "emoji" },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "memory_search",
        content: "**M:1** (preference): Do not use emoji",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will remember that." }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "bash",
        content: "done",
      },
    },
  ]);
  // Ordinary tool results and text alongside a memory call stay visible;
  // only the memory-tool parts are removed.
  const page = formatMemorySessionPage(decoded);
  assert.equal(page.totalMessages, 3);
  assert.equal(page.messages[0]!.role, "assistant");
  assert.equal(page.messages[0]!.text, "I found the relevant preference.");
  assert.equal(page.messages[1]!.role, "assistant");
  assert.equal(page.messages[1]!.text, "I will remember that.");
  assert.equal(page.messages[2]!.role, "toolResult");
  assert.equal(page.messages[2]!.text, "[toolResult bash done]");

  // Decoded provenance remains available for consumers that want it.
  assert.equal(decoded.messages[0]!.role, "assistant");
  assert.equal(decoded.messages[0]!.parts[1]!.tool, "memory_search");
  assert.equal(decoded.messages[1]!.role, "toolResult");
  assert.equal(decoded.messages[1]!.parts[0]!.tool, "memory_search");
});
