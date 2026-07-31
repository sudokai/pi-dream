import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  completeMemoryModelCall,
  memoryThinkingLevelToReasoning,
} from "./memory-completion.ts";
import {
  resolveMemoryModel,
  type MemoryAuthResultLike,
  type MemoryModelRegistryLike,
} from "./memory-model.ts";

function fakeStream(result: () => Promise<unknown>) {
  return { result };
}

function modelRegistry(
  overrides: {
    provider?: unknown;
    /** Set to null to simulate a registry with no provider resolution. */
    noProvider?: boolean;
    auth?: () => Promise<MemoryAuthResultLike>;
    find?: () => unknown;
  } = {},
): MemoryModelRegistryLike & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const registry: MemoryModelRegistryLike & {
    calls: Array<Record<string, unknown>>;
  } = {
    calls,
    find: (overrides.find ??
      (() => ({ id: "fake-model" }))) as MemoryModelRegistryLike["find"],
    getProvider: (providerId: string) => {
      calls.push({ kind: "provider", providerId });
      if (overrides.noProvider) return undefined;
      if (overrides.provider !== undefined) return overrides.provider as never;
      return {
        streamSimple: (model: unknown, context: unknown, options: unknown) => {
          calls.push({ kind: "streamSimple", model, context, options });
          return fakeStream(async () => ({
            content: [{ type: "text", text: "planner output" }],
            usage: { inputTokens: 7, outputTokens: 2 },
          }));
        },
      } as never;
    },
    getApiKeyAndHeaders:
      overrides.auth ??
      (async () => ({
        ok: true,
        apiKey: "sk-test",
        headers: { "X-Test": "1" },
        env: { FOO: "bar" },
      })),
  };
  return registry;
}

test("completeMemoryModelCall routes through provider.streamSimple with reasoning and resolved auth", async () => {
  const registry = modelRegistry();
  const resolved = resolveMemoryModel(
    "recallModel",
    undefined,
    "anthropic/claude-sonnet-4-5",
    registry,
    "high",
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  const out = await completeMemoryModelCall(registry, resolved.resolved, {
    system: "sys",
    user: "user",
  });
  assert.equal(out.text, "planner output");
  assert.deepEqual(out.usage, { inputTokens: 7, outputTokens: 2 });

  const call = registry.calls.find((c) => c.kind === "streamSimple");
  assert.ok(call, "streamSimple must be invoked");
  const options = call!.options as Record<string, unknown>;
  assert.equal(
    options.reasoning,
    "high",
    "recallThinking maps to SimpleStreamOptions.reasoning",
  );
  assert.equal(options.apiKey, "sk-test");
  assert.deepEqual(options.headers, { "X-Test": "1" });
  assert.deepEqual(options.env, { FOO: "bar" });
  const context = call!.context as {
    systemPrompt: string;
    messages: Array<{ role: string; content: string; timestamp?: unknown }>;
  };
  assert.equal(context.systemPrompt, "sys");
  assert.equal(context.messages.length, 1);
  assert.deepEqual(
    { role: context.messages[0]!.role, content: context.messages[0]!.content },
    { role: "user", content: "user" },
  );
  assert.equal(typeof context.messages[0]!.timestamp, "number");
});

test("thinking off or unset omits the reasoning key", async () => {
  for (const thinking of [undefined, "off"] as const) {
    const registry = modelRegistry();
    const resolved = resolveMemoryModel(
      "recallModel",
      undefined,
      "anthropic/claude-sonnet-4-5",
      registry,
      thinking,
    );
    assert.equal(resolved.ok, true);
    if (!resolved.ok) continue;
    await completeMemoryModelCall(registry, resolved.resolved, {
      system: "s",
      user: "u",
    });
    const call = registry.calls.find((c) => c.kind === "streamSimple");
    const options = call!.options as Record<string, unknown>;
    assert.equal(
      "reasoning" in options,
      false,
      `thinking=${String(thinking)} must not set reasoning`,
    );
  }
  assert.equal(memoryThinkingLevelToReasoning("off"), undefined);
  assert.equal(memoryThinkingLevelToReasoning(undefined), undefined);
  assert.equal(memoryThinkingLevelToReasoning("medium"), "medium");
});

test("registry without the provider fails closed", async () => {
  const registry = modelRegistry({ noProvider: true });
  const resolved = resolveMemoryModel(
    "recallModel",
    undefined,
    "anthropic/claude-sonnet-4-5",
    registry,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  await assert.rejects(
    () =>
      completeMemoryModelCall(registry, resolved.resolved, {
        system: "s",
        user: "u",
      }),
    /does not expose provider/,
  );
});

test("unresolved auth fails closed", async () => {
  const registry = modelRegistry({
    auth: async () => ({ ok: false, error: "no key for anthropic" }),
  });
  const resolved = resolveMemoryModel(
    "recallModel",
    undefined,
    "anthropic/claude-sonnet-4-5",
    registry,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  await assert.rejects(
    () =>
      completeMemoryModelCall(registry, resolved.resolved, {
        system: "s",
        user: "u",
      }),
    /No API key for recall model/,
  );
});

test("model errorMessage fails closed and usage surfaces", async () => {
  const registry = modelRegistry({
    provider: {
      streamSimple: () =>
        fakeStream(async () => ({
          content: [],
          usage: undefined,
          errorMessage: "upstream 429",
        })),
    },
  });
  const resolved = resolveMemoryModel(
    "recallModel",
    undefined,
    "anthropic/claude-sonnet-4-5",
    registry,
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  await assert.rejects(
    () =>
      completeMemoryModelCall(registry, resolved.resolved, {
        system: "s",
        user: "u",
      }),
    /upstream 429/,
  );
});

test("abort signal propagates to the provider options", async () => {
  const registry = modelRegistry();
  const resolved = resolveMemoryModel(
    "recallModel",
    undefined,
    "anthropic/claude-sonnet-4-5",
    registry,
    "low",
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const controller = new AbortController();
  await completeMemoryModelCall(registry, resolved.resolved, {
    system: "s",
    user: "u",
    signal: controller.signal,
  });
  const call = registry.calls.find((c) => c.kind === "streamSimple");
  const options = call!.options as { signal: AbortSignal; reasoning?: string };
  assert.equal(options.signal, controller.signal);
  assert.equal(options.reasoning, "low");
});
