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
  assert.equal(c.embeddingModel, "Xenova/all-MiniLM-L6-v2");
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
    dreamModel: "anthropic/claude-sonnet-4-5",
    recallModel: "openai/gpt-4.1",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.enabled, false);
    assert.equal(r.config.dreamModel, "anthropic/claude-sonnet-4-5");
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

test("loadMemoryWorkspaceConfig invalid JSON disables memory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cfg-bad-"));
  try {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, "{bad", "utf-8");
    const r = loadMemoryWorkspaceConfig(p);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.enabled, false);
      assert.equal(r.invalidFallback, true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMemoryWorkspaceConfig unreadable file fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cfg-unreadable-"));
  try {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(p, '{"version":1,"enabled":false}', "utf-8");
    fs.chmodSync(p, 0);
    const r = loadMemoryWorkspaceConfig(p);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /Cannot read memory config/);
    }
  } finally {
    try {
      fs.chmodSync(path.join(dir, "config.json"), 0o600);
    } catch {
      // Best-effort restore for cleanup on platforms that ignore chmod.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save/load round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cfg-rt-"));
  try {
    const p = path.join(dir, "nested", "config.json");
    const config = { ...defaultMemoryWorkspaceConfig(), enabled: false };
    saveMemoryWorkspaceConfig(p, config);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
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
    validateOptionalMemoryModel("dreamModel", undefined, () => ({})),
    null,
  );
  assert.match(
    validateOptionalMemoryModel("dreamModel", "bad", () => ({})) ?? "",
    /provider\/model/,
  );
  assert.match(
    validateOptionalMemoryModel("dreamModel", "a/b", () => null) ?? "",
    /does not resolve/,
  );
  assert.equal(
    validateOptionalMemoryModel("dreamModel", "a/b", () => ({ id: "b" })),
    null,
  );
});

test("retired heat and token-capacity keys fail closed like any unknown key", () => {
  for (const key of [
    "hotHeatThreshold",
    "synthesizerContextBudget",
    "synthesizerAnswerBudget",
    "noveltyBoost",
    "noveltyGenerations",
    "heatDecay",
    "briefingTokenBudget",
    "hybridPoolSize",
    "rrfK",
    "semanticFloor",
    "coldHeatThreshold",
    "consolidationMergeBound",
    "synthesizerMaxSteps",
  ]) {
    const r = parseMemoryWorkspaceConfig({
      version: 1,
      enabled: true,
      [key]: 1,
    });
    assert.equal(r.ok, false, `${key} must be rejected`);
    assert.match(r.ok ? "" : r.error, /unknown key/i);
  }
});

test("a config with only version and enabled parses", () => {
  const r = parseMemoryWorkspaceConfig({ version: 1, enabled: true });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.minTurns, 10);
    assert.equal(r.config.minMinutes, 120);
  }
});

test("loadMemoryWorkspaceConfig with legacy heat keys disables memory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-cfg-legacy-"));
  try {
    const p = path.join(dir, "config.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        enabled: true,
        heatDecay: 0.85,
        hotHeatThreshold: 1.5,
      }),
      "utf-8",
    );
    const r = loadMemoryWorkspaceConfig(p);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.config.enabled, false);
      assert.equal(r.invalidFallback, true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
