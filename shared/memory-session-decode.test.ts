import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  countMemorySessionEvidence,
  decodeMemorySession,
  loadDecodedMemorySession,
  loadVerifiedMemorySessionSnapshot,
  parseMemoryJsonlLine,
  segmentMemorySessionEvidence,
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
    assert.equal(countMemorySessionEvidence(session), 3);
    // A generous budget yields one segment covering every visible message.
    const segments = segmentMemorySessionEvidence(session, {
      maxChars: 10_000,
    });
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.startIndex, 0);
    assert.equal(segments[0]!.endIndex, 3);
    assert.match(segments[0]!.text, /\[0\] user:/);
    assert.match(segments[0]!.text, /\[2\] user:/);
    // A tiny budget splits deterministically; resuming at a segment boundary
    // regenerates the exact same tail.
    const small = segmentMemorySessionEvidence(session, {
      maxChars: 20,
    });
    assert.ok(small.length > 1, "tiny budget must split into several segments");
    const tail = segmentMemorySessionEvidence(session, {
      startOffset: small[1]!.startIndex,
      maxChars: 20,
    });
    assert.equal(tail[0]!.startIndex, small[1]!.startIndex);
    assert.equal(tail[0]!.endIndex, small[1]!.endIndex);
    assert.equal(tail[0]!.text, small[1]!.text, "resume must be deterministic");
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

  const segments = segmentMemorySessionEvidence(decoded);
  assert.equal(
    countMemorySessionEvidence(decoded),
    1,
    "briefing excluded from dreamer input",
  );
  assert.equal(segments.length, 1);
  assert.match(segments[0]!.text, /\[0\] user:/);
  assert.match(segments[0]!.text, /I like tabs/);
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
  const segments = segmentMemorySessionEvidence(decoded);
  assert.equal(countMemorySessionEvidence(decoded), 3);
  assert.equal(segments.length, 1);
  const text = segments[0]!.text;
  assert.match(text, /\[0\] assistant:/);
  assert.match(text, /I found the relevant preference\./);
  assert.match(text, /\[1\] assistant:/);
  assert.match(text, /I will remember that\./);
  assert.match(text, /\[2\] toolResult:/);
  assert.match(text, /\[toolResult bash done\]/);

  // Decoded provenance remains available for consumers that want it.
  assert.equal(decoded.messages[0]!.role, "assistant");
  assert.equal(decoded.messages[0]!.parts[1]!.tool, "memory_search");
  assert.equal(decoded.messages[1]!.role, "toolResult");
  assert.equal(decoded.messages[1]!.parts[0]!.tool, "memory_search");
});
