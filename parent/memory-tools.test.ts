import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { acquireMemoryRunClaim } from "../shared/memory-run-claim.ts";
import { commitMemoryDreamSession } from "../shared/memory-repository.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { registerMemoryAgentTools } from "./memory-tools.ts";
import type { MemoryToolsContext } from "./memory-tools.ts";

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

function captureTools(): { tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  return { tools };
}

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

function context(db: ReturnType<typeof openMemoryDatabaseAtPath>) {
  return {
    getDb: () => db,
    getConfig: () => defaultMemoryWorkspaceConfig(),
    getModelRegistry: () => ({
      find: () => ({ id: "fake-model" }),
      getProvider: () => undefined,
    }),
    getSessionModel: () => ({ provider: "anthropic", id: "claude-sonnet-4-5" }),
    getPiSessionId: () => "session-1",
  } as unknown as MemoryToolsContext;
}

test("memory_search returns the synthesized answer and records search/open events", async () => {
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
    const { tools } = captureTools();
    const responses = [
      JSON.stringify({ action: "open", id: "S:1" }),
      JSON.stringify({
        action: "finalize",
        answer: "No emoji, pnpm.",
        sources: ["M:1"],
      }),
    ];
    let i = 0;
    const ctx = context(db);
    const withComplete = {
      ...ctx,
      getModelRegistry: () => ({
        find: () => ({ id: "fake-model" }),
        getProvider: () => ({
          streamSimple: () => ({
            result: async () => ({
              content: [{ type: "text", text: responses[i++] }],
            }),
          }),
        }),
      }),
    } as unknown as MemoryToolsContext;
    registerMemoryAgentTools(
      {
        registerTool: (t: CapturedTool) => tools.set(t.name, t),
      } as unknown as ExtensionAPI,
      withComplete,
    );
    const search = tools.get("memory_search");
    assert.ok(search, "memory_search registered");
    const result = await search!.execute("1", { query: "commit style?" });
    assert.equal(result.content[0]!.text, "No emoji, pnpm.");
    assert.deepEqual(result.details?.sources, ["M:1"]);
    assert.equal(
      result.details?.openedSummaryIds,
      undefined,
      "navigation internals stay out of the tool result",
    );
    // M:1 selected (search event); S:1 opened only (open event); dedup: M:1
    // got one event, S:1 got one event.
    const events = db
      .prepare(
        `SELECT node_type, node_id, source FROM recall_events ORDER BY id`,
      )
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 2);
    const byNode = new Map(
      events.map((e) => [`${e.node_type}:${e.node_id}`, e.source]),
    );
    assert.equal(byNode.get("memory:1"), "search");
    assert.equal(byNode.get("summary:1"), "open");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search records no events when nothing relevant is found", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const { tools } = captureTools();
    const ctx = context(db);
    registerMemoryAgentTools(
      {
        registerTool: (t: CapturedTool) => tools.set(t.name, t),
      } as unknown as ExtensionAPI,
      {
        ...ctx,
        getModelRegistry: () => ({
          find: () => ({ id: "fake-model" }),
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      action: "finalize",
                      answer: "No relevant memories found.",
                      sources: [],
                    }),
                  },
                ],
              }),
            }),
          }),
        }),
      } as unknown as MemoryToolsContext,
    );
    const result = await tools
      .get("memory_search")!
      .execute("1", { query: "nothing here" });
    assert.match(result.content[0]!.text, /No relevant memories found/);
    const events = db
      .prepare(`SELECT COUNT(*) AS n FROM recall_events`)
      .get() as {
      n: number;
    };
    assert.equal(Number(events.n), 0);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search surfaces the named tool error for an over-budget top layer", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const { tools } = captureTools();
    const ctx = context(db);
    registerMemoryAgentTools(
      {
        registerTool: (t: CapturedTool) => tools.set(t.name, t),
      } as unknown as ExtensionAPI,
      {
        ...ctx,
        getConfig: () => ({
          ...defaultMemoryWorkspaceConfig(),
          briefingTokenBudget: 1,
        }),
      } as unknown as MemoryToolsContext,
    );
    await assert.rejects(
      () => tools.get("memory_search")!.execute("1", { query: "anything" }),
      /top layer over budget \(\d+\/1 tokens\); consolidation has not yet compacted it/,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_open records an open event for the opened node only", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const { tools } = captureTools();
    registerMemoryAgentTools(
      {
        registerTool: (t: CapturedTool) => tools.set(t.name, t),
      } as unknown as ExtensionAPI,
      context(db),
    );
    const result = await tools.get("memory_open")!.execute("1", { id: "M:1" });
    assert.match(result.content[0]!.text, /M:1/);
    const events = db
      .prepare(`SELECT node_type, node_id, source FROM recall_events`)
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.node_type, "memory");
    assert.equal(events[0]!.source, "open");
  } finally {
    closeMemoryDatabase(db);
  }
});
