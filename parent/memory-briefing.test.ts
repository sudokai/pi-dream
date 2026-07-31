import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildMemorySessionBriefing,
  createMemoryBriefingSignal,
} from "./memory-briefing.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { acquireMemoryRunClaim } from "../shared/memory-run-claim.ts";
import { commitMemoryLearningSession } from "../shared/memory-repository.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  resetMemoryEmbedderForTests,
  setMemoryEmbedderForTests,
} from "../shared/memory-embedding.ts";

function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(
    texts.map(() => new Float32Array([0.25, 0.5, 0.75])),
  );
}

test("briefing signal uses a bounded timeout before pi exposes a run signal", async () => {
  const signal = createMemoryBriefingSignal(undefined, 10);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true);
});

test("buildMemorySessionBriefing completes through the pi-ai provider adapter by default", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  setMemoryEmbedderForTests(fakeEmbed);
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    commitMemoryLearningSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "t",
            kind: "preference",
            observationText: "User avoids emoji",
            memoryText: "Do not use emoji in commits",
          },
        ],
      },
    });

    const calls: Array<Record<string, unknown>> = [];
    const modelRegistry = {
      find: () => ({ id: "fake-model" }),
      getProvider: (providerId: string) => {
        calls.push({ kind: "provider", providerId });
        return {
          streamSimple: (
            _model: unknown,
            context: unknown,
            options: unknown,
          ) => {
            calls.push({ kind: "streamSimple", context, options });
            return {
              result: async () => ({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      sections: [
                        {
                          id: "learned_user_preferences",
                          ids: ["M:1"],
                        },
                      ],
                    }),
                  },
                ],
                usage: { inputTokens: 10, outputTokens: 3 },
              }),
            };
          },
        };
      },
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
    };

    const result = await buildMemorySessionBriefing({
      db,
      query: "what should I know before we start?",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        recallThinking: "high",
      },
      modelRegistry: modelRegistry as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message, "planner-approved memory must render a briefing");
    assert.match(result.message!.content, /Do not use emoji in commits/);
    assert.deepEqual(result.plan.selectedIds, ["M:1"]);

    // The default completion path went through provider.streamSimple with
    // recallThinking mapped to SimpleStreamOptions.reasoning.
    const streamCall = calls.find((c) => c.kind === "streamSimple");
    assert.ok(streamCall, "default completion must use the pi-ai provider adapter");
    const options = streamCall!.options as Record<string, unknown>;
    assert.equal(options.reasoning, "high");
    assert.equal(options.apiKey, "sk-test");
    const context = streamCall!.context as {
      systemPrompt: string;
      messages: Array<{ role: string; content: string; timestamp?: unknown }>;
    };
    assert.equal(typeof context.systemPrompt, "string");
    assert.ok(context.systemPrompt.includes("briefing planner"));
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0]!.role, "user");
    assert.match(context.messages[0]!.content, /Do not use emoji in commits/);
    assert.equal(typeof context.messages[0]!.timestamp, "number");

    // Recalled nodes record startup recall events.
    const events = db
      .prepare(
        `SELECT node_type, node_id, source FROM recall_events`,
      )
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.node_type, "memory");
    assert.equal(events[0]!.source, "startup");
  } finally {
    closeMemoryDatabase(db);
    resetMemoryEmbedderForTests();
  }
});

test("briefing with no candidates renders nothing and never calls the model", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    let called = false;
    const result = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: {
        find: () => ({ id: "fake-model" }),
        getProvider: () => {
          called = true;
          return undefined;
        },
      } as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      embed: fakeEmbed,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message, null);
    assert.equal(called, false, "empty workspace must not touch the provider");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("unresolved recall model fails closed with a visible notice", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    commitMemoryLearningSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "t",
            kind: "fact",
            observationText: "Build uses pnpm",
            memoryText: "The build uses pnpm",
          },
        ],
      },
    });

    const result = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: { find: () => undefined } as never,
      currentSessionModel: undefined,
      embed: fakeEmbed,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /no configured model/);
    assert.equal(result.notice.customType, "pi-dream-briefing");
    assert.match(result.notice.content, /unavailable/i);
    const gen = db
      .prepare(`SELECT activity_generation FROM workspace_state WHERE id = 1`)
      .get() as { activity_generation: number };
    assert.equal(
      gen.activity_generation,
      0,
      "unavailable recall must not cool heat via activity generation",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("empty briefing still advances activity generation once", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const result = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: { find: () => ({ id: "fake-model" }) } as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      embed: fakeEmbed,
    });
    assert.equal(result.ok, true);
    const gen = db
      .prepare(`SELECT activity_generation FROM workspace_state WHERE id = 1`)
      .get() as { activity_generation: number };
    assert.equal(gen.activity_generation, 1);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("aborted briefing before planning does not advance activity generation", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    commitMemoryLearningSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "t",
            kind: "preference",
            observationText: "User avoids emoji",
            memoryText: "Do not use emoji in commits",
          },
        ],
      },
    });

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        buildMemorySessionBriefing({
          db,
          query: "what should I know?",
          config: defaultMemoryWorkspaceConfig(),
          modelRegistry: {
            find: () => ({ id: "fake-model" }),
            getProvider: () => undefined,
          } as never,
          currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
          embed: fakeEmbed,
          signal: controller.signal,
        }),
    );
    const gen = db
      .prepare(`SELECT activity_generation FROM workspace_state WHERE id = 1`)
      .get() as { activity_generation: number };
    assert.equal(gen.activity_generation, 0);
  } finally {
    closeMemoryDatabase(db);
  }
});
