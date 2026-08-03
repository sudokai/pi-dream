import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  formatMemoryNodeId,
  normalizeObservationText,
  parsePrefixedNodeId,
  validateMemoryBodyText,
} from "./memory-types.ts";

test("parsePrefixedNodeId accepts M and O only", () => {
  assert.deepEqual(parsePrefixedNodeId("M:12"), {
    ok: true,
    type: "memory",
    id: 12,
    prefixed: "M:12",
  });
  assert.equal(parsePrefixedNodeId("O:1").ok, true);
  assert.equal(parsePrefixedNodeId("S:3").ok, false, "S: ids are retired");
  assert.equal(parsePrefixedNodeId("X:1").ok, false);
  assert.equal(parsePrefixedNodeId("M:0").ok, false);
});

test("formatMemoryNodeId and normalizeObservationText", () => {
  assert.equal(formatMemoryNodeId(7), "M:7");
  assert.equal(normalizeObservationText("  Prefer   tabs  "), "prefer tabs");
});

test("validateMemoryBodyText rejects multiline and empty", () => {
  assert.equal(validateMemoryBodyText("ok"), null);
  assert.match(validateMemoryBodyText("") ?? "", /non-empty/);
  assert.match(validateMemoryBodyText("a\nb") ?? "", /single line/);
  assert.match(validateMemoryBodyText("x".repeat(500)) ?? "", /exceeds/);
});
