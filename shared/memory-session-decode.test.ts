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
  const s = parseMemoryJsonlLine(
    '{"type":"session","id":"abc","cwd":"/tmp"}',
  );
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
    assert.equal(loadVerifiedMemorySessionSnapshot(file, hash).sessionId, "sid");

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
