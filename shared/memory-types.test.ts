import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  formatMemoryNodeId,
  normalizeMemoryBodyText,
  parseMemoryNodeId,
  validateMemoryBodyText,
} from "./memory-types.ts";

test("parseMemoryNodeId accepts M only; O and S ids are retired", () => {
  assert.deepEqual(parseMemoryNodeId("M:12"), {
    ok: true,
    type: "memory",
    id: 12,
    prefixed: "M:12",
  });
  assert.match(
    parseMemoryNodeId("O:1").ok === false
      ? (parseMemoryNodeId("O:1") as { error: string }).error
      : "",
    /retired/,
    "O: ids are retired",
  );
  assert.equal(parseMemoryNodeId("S:3").ok, false, "S: ids are retired");
  assert.equal(parseMemoryNodeId("X:1").ok, false);
  assert.equal(parseMemoryNodeId("M:0").ok, false);
});

test("formatMemoryNodeId and normalizeMemoryBodyText", () => {
  assert.equal(formatMemoryNodeId(7), "M:7");
  assert.equal(normalizeMemoryBodyText("  Prefer   tabs  "), "prefer tabs");
  assert.equal(normalizeMemoryBodyText("Use\n  spaces"), "use spaces");
});

test("validateMemoryBodyText rejects multiline and empty", () => {
  assert.equal(validateMemoryBodyText("ok"), null);
  assert.match(validateMemoryBodyText("") ?? "", /non-empty/);
  assert.match(validateMemoryBodyText("a\nb") ?? "", /single line/);
  assert.match(validateMemoryBodyText("x".repeat(500)) ?? "", /exceeds/);
});
