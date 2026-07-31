import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultMemoryWorkspaceConfig,
  loadMemoryWorkspaceConfig,
  parseMemoryWorkspaceConfig,
  saveMemoryWorkspaceConfig,
  splitMemoryModelId,
  validateOptionalMemoryModel,
} from "./memory-config.ts";

test("defaultMemoryWorkspaceConfig is enabled with cadence defaults", () => {
  const c = defaultMemoryWorkspaceConfig();
  assert.equal(c.version, 1);
  assert.equal(c.enabled, true);
  assert.equal(c.minTurns, 10);
  assert.equal(c.minMinutes, 120);
  assert.equal(c.briefingTokenBudget, 8000);
});

test("parseMemoryWorkspaceConfig rejects unknown keys", () => {
  const r = parseMemoryWorkspaceConfig({
    version: 1,
    enabled: true,
    nope: 1,
  });
  assert.equal(r.ok, false);
});

test("parseMemoryWorkspaceConfig accepts optional models", () => {
  const r = parseMemoryWorkspaceConfig({
    version: 1,
    enabled: false,
    learningModel: "anthropic/claude-sonnet-4-5",
    recallModel: "openai/gpt-4.1",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.enabled, false);
    assert.equal(r.config.learningModel, "anthropic/claude-sonnet-4-5");
    assert.equal(r.config.recallModel, "openai/gpt-4.1");
  }
});

test("loadMemoryWorkspaceConfig missing file defaults enabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cfg-"));
  try {
    const p = path.join(dir, "config.json");
    const r = loadMemoryWorkspaceConfig(p);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.enabled, true);
      assert.equal(r.invalidFallback, false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save/load round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cfg-rt-"));
  try {
    const p = path.join(dir, "nested", "config.json");
    const config = { ...defaultMemoryWorkspaceConfig(), enabled: false };
    saveMemoryWorkspaceConfig(p, config);
    const r = loadMemoryWorkspaceConfig(p);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.enabled, false);
      assert.equal(r.invalidFallback, false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("splitMemoryModelId and validateOptionalMemoryModel", () => {
  assert.deepEqual(splitMemoryModelId("anthropic/claude"), {
    provider: "anthropic",
    modelId: "claude",
  });
  assert.equal(splitMemoryModelId("bad"), null);
  assert.equal(
    validateOptionalMemoryModel("learningModel", undefined, () => ({})),
    null,
  );
  assert.match(
    validateOptionalMemoryModel("learningModel", "bad", () => ({})) ?? "",
    /provider\/model/,
  );
  assert.match(
    validateOptionalMemoryModel("learningModel", "a/b", () => null) ?? "",
    /does not resolve/,
  );
  assert.equal(
    validateOptionalMemoryModel("learningModel", "a/b", () => ({ id: "b" })),
    null,
  );
});
