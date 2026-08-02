import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildMemorySessionBriefing,
  createMemoryBriefingSignal,
  renderMemoryBriefingMessage,
} from "./memory-briefing.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { acquireMemoryRunClaim } from "../shared/memory-run-claim.ts";
import { commitMemoryDreamSession } from "../shared/memory-repository.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import {
  getMemoryActivityGeneration,
  recordMemoryRecallEvent,
} from "../shared/memory-graph.ts";
import { listMemoryTreeRoots } from "../shared/memory-tree.ts";

test("briefing signal never self-aborts; it fires only with the caller's signal", async () => {
  const signal = createMemoryBriefingSignal();
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal.aborted, false, "briefing must not self-abort");
  const controller = new AbortController();
  const composed = createMemoryBriefingSignal(controller.signal);
  controller.abort();
  assert.equal(composed.aborted, true);
});

function seed(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
): void {
  commitMemoryDreamSession(db, {
    runId,
    sourceSessionId: "s1",
    sessionPath: "/tmp/s1.jsonl",
    cwd: "/tmp",
    processedMtimeMs: 1,
    contentHash: "h1",
    plan: {
      operations: [
        {
          op: "create",
          tempRef: "m1",
          kind: "preference",
          observationText: "User avoids emoji",
          memoryText: "Do not use emoji in commits",
        },
        {
          op: "create",
          tempRef: "m2",
          kind: "fact",
          observationText: "Build uses pnpm",
          memoryText: "The build uses pnpm",
        },
      ],
    },
  });
}

function registry() {
  return {
    find: () => ({ id: "fake-model" }),
    getProvider: () => undefined,
  };
}

function completeWith(response: string) {
  return async () => ({ text: response });
}

test("success renders the synthesized answer + index and records startup/open events", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    // Wrap m1+m2 so the synthesizer can open a summary; M:3 stays a root so
    // the rendered briefing has an "Other memories" index line.
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m3",
            kind: "fact",
            observationText: "CI runs on Ubuntu",
            memoryText: "CI runs on Ubuntu",
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["M:1", "M:2"],
          },
        ],
      },
    });

    const calls: Array<Record<string, unknown>> = [];
    const responses = [
      JSON.stringify({ action: "open", id: "S:1" }),
      JSON.stringify({
        action: "finalize",
        answer: "What should I know? Avoid emoji and use pnpm.",
        sources: ["S:1"],
      }),
    ];
    let callIndex = 0;
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
                    text: responses[
                      Math.min(callIndex++, responses.length - 1)
                    ]!,
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
    assert.ok(result.message, "successful synthesis must render a briefing");
    assert.match(result.message!.content, /What should I know/);
    assert.match(result.message!.content, /Other memories:/);
    assert.match(result.message!.content, /memory_open/);
    assert.equal(result.audit, null);
    assert.equal(callIndex, 2, "open then finalize: two model calls");

    // The default completion path went through provider.streamSimple with
    // recallThinking mapped to SimpleStreamOptions.reasoning.
    const streamCall = calls.find((c) => c.kind === "streamSimple");
    assert.ok(
      streamCall,
      "default completion must use the pi-ai provider adapter",
    );
    const options = streamCall!.options as Record<string, unknown>;
    assert.equal(options.reasoning, "high");
    assert.equal(options.apiKey, "sk-test");

    // S:1 was opened and then cited as the source: exactly one event (startup).
    const events = db
      .prepare(`SELECT node_type, node_id, source FROM recall_events`)
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.source, "startup");
    assert.equal(events[0]!.node_type, "summary");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("sources get startup events; both opened+source summaries get one event", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h2",
      plan: {
        operations: [
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["M:1", "M:2"],
          },
        ],
      },
    });
    const responses = [
      JSON.stringify({ action: "open", id: "S:1" }),
      JSON.stringify({
        action: "finalize",
        answer: "Tooling: no emoji, pnpm.",
        sources: ["S:1"],
      }),
    ];
    let i = 0;
    const result = await buildMemorySessionBriefing({
      db,
      query: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: {
        find: () => ({ id: "fake-model" }),
        getProvider: () => ({
          streamSimple: () => ({
            result: async () => ({
              content: [{ type: "text", text: responses[i++] }],
            }),
          }),
        }),
      } as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message);
    // S:1 was both opened and sourced: exactly one event (startup wins).
    const events = db
      .prepare(`SELECT node_type, node_id, source FROM recall_events`)
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.node_type, "summary");
    assert.equal(events[0]!.source, "startup");
    assert.equal(events[0]!.node_id, 1);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("synthesizer failure skips silently with an audit payload and no events", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith("not-json"),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message, null);
    assert.deepEqual(result.audit, {
      status: "synthesizer_failed",
      error: result.audit?.error,
    });
    const events = db
      .prepare(`SELECT COUNT(*) AS n FROM recall_events`)
      .get() as {
      n: number;
    };
    assert.equal(Number(events.n), 0, "no reheat on failure");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("an over-budget top layer yields the top_layer_over_budget audit", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        briefingTokenBudget: 1,
      },
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: async () => {
        throw new Error("model must not be called for an over-budget layer");
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message, null);
    assert.equal(result.audit?.status, "top_layer_over_budget");
    assert.ok(typeof result.audit?.tokens === "number");
    assert.equal(result.audit?.budget, 1);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("empty top layer yields no message and no model call", async () => {
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
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message, null);
    assert.equal(result.audit, null);
    assert.equal(called, false, "empty workspace must not touch the provider");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("generation advances on model-resolution failure, synthesizer failure, and empty layer", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    // Model-resolution failure (no model anywhere).
    const r1 = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: { find: () => undefined } as never,
      currentSessionModel: undefined,
    });
    assert.equal(r1.ok, true);
    assert.equal(getMemoryActivityGeneration(db), 1);

    // Synthesizer failure with memories present.
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const r2 = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith("garbage"),
    });
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.message, null);
    assert.equal(getMemoryActivityGeneration(db), 2);

    // Empty top layer (everything retired).
    for (const m of listMemoryTreeRoots(db)) {
      db.prepare(
        `UPDATE ${m.nodeType === "memory" ? "memories" : "summaries"} SET state = 'retired' WHERE id = ?`,
      ).run(m.nodeId);
    }
    const r3 = await buildMemorySessionBriefing({
      db,
      query: "anything",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    assert.equal(r3.ok, true);
    assert.equal(getMemoryActivityGeneration(db), 3);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a pre-aborted attempt does not advance the generation", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() =>
      buildMemorySessionBriefing({
        db,
        query: "what should I know?",
        config: defaultMemoryWorkspaceConfig(),
        modelRegistry: registry() as never,
        currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
        signal: controller.signal,
      }),
    );
    assert.equal(getMemoryActivityGeneration(db), 0);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryBriefingMessage groups the index by kind and orders by heat", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    commitMemoryDreamSession(db, {
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
            tempRef: "p1",
            kind: "preference",
            observationText: "obs",
            memoryText: "Prefer tabs over spaces",
          },
          {
            op: "create",
            tempRef: "f1",
            kind: "fact",
            observationText: "obs",
            memoryText: "Build uses pnpm",
          },
          {
            op: "create",
            tempRef: "f2",
            kind: "fact",
            observationText: "obs",
            memoryText: "CI runs on Ubuntu",
          },
          {
            op: "create",
            tempRef: "f3",
            kind: "fact",
            observationText: "obs",
            memoryText: "Use git rebase",
          },
          {
            op: "create",
            tempRef: "f4",
            kind: "fact",
            observationText: "obs",
            memoryText: "Ship on Fridays",
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["M:2", "M:3"],
          },
        ],
      },
    });
    // Reheat M:5 once so it outranks M:4 inside the Facts group.
    recordMemoryRecallEvent(db, {
      nodeType: "memory",
      nodeId: 5,
      source: "search",
      piSessionId: "s-test",
    });
    const content = renderMemoryBriefingMessage(db, "Answer.", []);
    const sections = content
      .split("\n")
      .filter((l) => /^(Preferences|Facts|Summaries):$/.test(l));
    assert.deepEqual(sections, ["Preferences:", "Facts:", "Summaries:"]);
    assert.ok(
      content.indexOf("- M:5 (fact)") < content.indexOf("- M:4 (fact)"),
      "heat-desc ordering within a group",
    );
    assert.match(content, /- M:1 \(preference\): Prefer tabs over spaces/);
    assert.match(content, /- S:1 \(summary\): Tooling/);
    assert.ok(
      content.indexOf("Facts:") < content.indexOf("Summaries:"),
      "summaries are their own last section",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryBriefingMessage caps the index at 50 lines with a tail", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    const ops = Array.from({ length: 60 }, (_, i) => ({
      op: "create" as const,
      tempRef: `m${i}`,
      kind: "fact" as const,
      observationText: `Fact ${i}`,
      memoryText: `Fact ${i}`,
    }));
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: { operations: ops },
    });
    const content = renderMemoryBriefingMessage(db, "Answer.", []);
    const indexLines = content.split("\n").filter((l) => l.startsWith("- M:"));
    assert.equal(indexLines.length, 50);
    assert.match(content, /… and 10 more/);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryBriefingMessage shows full memory text, never truncated", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    const longText = `Long memory text. ${"x".repeat(300)}`;
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      plan: {
        operations: [
          {
            op: "create" as const,
            tempRef: "m0",
            kind: "fact" as const,
            observationText: "obs",
            memoryText: longText,
          },
        ],
      },
    });
    const content = renderMemoryBriefingMessage(db, "Answer.", []);
    assert.ok(content.includes(longText), "long memory text renders in full");
    assert.ok(!content.includes("…"), "no truncation marker in the index");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryBriefingMessage footer points to memory_search and memory_open", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const content = renderMemoryBriefingMessage(db, "Answer.", []);
    const footer = content.trimEnd().split("\n").at(-1)!;
    assert.ok(footer.startsWith("`memory_search`"));
    assert.ok(footer.includes("`memory_open <id>`"));
    assert.ok(!footer.startsWith("_") && !footer.endsWith("_"));
  } finally {
    closeMemoryDatabase(db);
  }
});
