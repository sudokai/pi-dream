import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  estimateMemoryTextTokens,
  formatMemoryNodeId,
  normalizeObservationText,
  parsePrefixedNodeId,
  validateMemoryBodyText,
} from "./memory-types.ts";

test("parsePrefixedNodeId accepts M/S/O", () => {
  assert.deepEqual(parsePrefixedNodeId("M:12"), {
    ok: true,
    type: "memory",
    id: 12,
    prefixed: "M:12",
  });
  assert.equal(parsePrefixedNodeId("S:3").ok, true);
  assert.equal(parsePrefixedNodeId("O:1").ok, true);
  assert.equal(parsePrefixedNodeId("X:1").ok, false);
  assert.equal(parsePrefixedNodeId("M:0").ok, false);
});

test("formatMemoryNodeId and normalizeObservationText", () => {
  assert.equal(formatMemoryNodeId(7), "M:7");
  assert.equal(
    normalizeObservationText("  Prefer   tabs  "),
    "prefer tabs",
  );
});

test("validateMemoryBodyText rejects multiline and empty", () => {
  assert.equal(validateMemoryBodyText("ok"), null);
  assert.match(validateMemoryBodyText("") ?? "", /non-empty/);
  assert.match(validateMemoryBodyText("a\nb") ?? "", /single line/);
  assert.match(validateMemoryBodyText("x".repeat(500)) ?? "", /exceeds/);
});

test("estimateMemoryTextTokens is at least 1", () => {
  assert.equal(estimateMemoryTextTokens(""), 1);
  assert.ok(estimateMemoryTextTokens("abcd") >= 1);
});
