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
import { createMemoryDiagnosticSink } from "./memory-tools.ts";
import type { MemoryToolsContext } from "./memory-tools.ts";
import { getMemoryWorkspaceState } from "../shared/memory-repository.ts";

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
    minedMessageOffset: 1,
    plan: {
      operations: [
        {
          op: "create",
          kind: "preference",
          evidenceText: "User avoids emoji",
          memoryText: "Do not use emoji in commits",
        },
        {
          op: "create",
          kind: "fact",
          evidenceText: "Build uses pnpm",
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

function registeredNames(ctx: MemoryToolsContext): Map<string, CapturedTool> {
  const { tools } = captureTools();
  registerMemoryAgentTools(
    {
      registerTool: (t: CapturedTool) => tools.set(t.name, t),
    } as unknown as ExtensionAPI,
    ctx,
  );
  return tools;
}

test("registered agent tools are exactly ['memory_search']", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const tools = registeredNames(context(db));
    assert.deepEqual([...tools.keys()], ["memory_search"]);
    assert.equal(tools.has("memory_open"), false, "memory_open is deleted");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search fails closed without a provider (named tool error)", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const tools = registeredNames({
      ...context(db),
      getModelRegistry: () =>
        ({
          find: () => ({
            id: "fake-model",
            contextWindow: 200_000,
            maxTokens: 32_000,
          }),
          getProvider: () => undefined,
        }) as never,
    });
    await assert.rejects(
      () =>
        tools
          .get("memory_search")!
          .execute("1", { query: "emoji commits" }, undefined as never),
      /memory_search synthesizer failed/,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search succeeds through the provider seam and records search events", async () => {
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
          find: () => ({
            id: "fake-model",
            contextWindow: 200_000,
            maxTokens: 32_000,
          }),
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      content: "No emoji, pnpm.",
                      sources: ["M:1"],
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
      .execute("1", { query: "emoji commits" }, undefined as never);
    assert.equal(result.content[0]!.text, "No emoji, pnpm.");
    assert.deepEqual(result.details?.sources, ["M:1"]);
    const events = db
      .prepare(
        `SELECT node_type, node_id, source FROM citation_events ORDER BY id`,
      )
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.node_type, "memory");
    assert.equal(events[0]!.node_id, 1);
    assert.equal(events[0]!.source, "search");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search returns 'No relevant memories found.' with no citation event", async () => {
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
                      content: "No relevant memories found.",
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
      .execute("1", { query: "nothing here" }, undefined as never);
    assert.match(result.content[0]!.text, /No relevant memories found/);
    const events = db
      .prepare(`SELECT COUNT(*) AS n FROM citation_events`)
      .get() as {
      n: number;
    };
    assert.equal(Number(events.n), 0);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search with a blank query short-circuits without reading", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    let read = false;
    const { tools } = captureTools();
    registerMemoryAgentTools(
      {
        registerTool: (t: CapturedTool) => tools.set(t.name, t),
      } as unknown as ExtensionAPI,
      {
        getDb: () => {
          read = true;
          return db;
        },
        getConfig: () => defaultMemoryWorkspaceConfig(),
        getModelRegistry: () => ({
          find: () => ({ id: "fake-model" }),
          getProvider: () => undefined,
        }),
        getSessionModel: () => null,
        getPiSessionId: () => null,
      } as unknown as MemoryToolsContext,
    );
    const result = await tools
      .get("memory_search")!
      .execute("1", { query: "   " }, undefined as never);
    assert.match(result.content[0]!.text, /No relevant memories found/);
    assert.equal(read, false, "blank queries must not touch the store");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("disabled config makes memory_search reject without reading or recording", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    let read = false;
    const { tools } = captureTools();
    registerMemoryAgentTools(
      {
        registerTool: (t: CapturedTool) => tools.set(t.name, t),
      } as unknown as ExtensionAPI,
      {
        getDb: () => {
          read = true;
          return db;
        },
        getConfig: () => ({
          ...defaultMemoryWorkspaceConfig(),
          enabled: false,
        }),
        getModelRegistry: () => ({
          find: () => ({ id: "fake-model" }),
          getProvider: () => undefined,
        }),
        getSessionModel: () => null,
        getPiSessionId: () => null,
      } as unknown as MemoryToolsContext,
    );
    await assert.rejects(
      () =>
        tools
          .get("memory_search")!
          .execute("1", { query: "emoji" }, undefined as never),
      /disabled/,
    );
    assert.equal(read, false, "disabled config must not read the store");
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM citation_events`).get() as {
          n: number;
        }
      ).n,
      0,
      "disabled config must not record",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("memory_search synthesizer failure surfaces a named tool error", async () => {
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
          find: () => ({
            id: "fake-model",
            contextWindow: 200_000,
            maxTokens: 32_000,
          }),
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                content: [{ type: "text", text: "not-json" }],
              }),
            }),
          }),
        }),
      } as unknown as MemoryToolsContext,
    );
    await assert.rejects(
      () =>
        tools
          .get("memory_search")!
          .execute("1", { query: "emoji" }, undefined as never),
      /memory_search synthesizer failed/,
    );
    const events = db
      .prepare(`SELECT COUNT(*) AS n FROM citation_events`)
      .get() as {
      n: number;
    };
    assert.equal(Number(events.n), 0, "no citations on failure");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("provider context insufficiency surfaces a named tool error and persists for status", async () => {
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
          find: () => ({ id: "tiny", contextWindow: 100, maxTokens: 64 }),
          getProvider: () => undefined,
        }),
      } as unknown as MemoryToolsContext,
    );
    await assert.rejects(
      () =>
        tools
          .get("memory_search")!
          .execute("1", { query: "emoji" }, undefined as never),
      /context/,
    );
    assert.match(
      getMemoryWorkspaceState(db).recallCapacityError ?? "",
      /context/,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a retrieval miss short-circuits to 'No relevant memories found.' without a model call", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    let providerCalled = false;
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
          getProvider: () => {
            providerCalled = true;
            return undefined;
          },
        }),
      } as unknown as MemoryToolsContext,
    );
    const result = await tools
      .get("memory_search")!
      .execute("1", { query: "zzz unmatched" }, undefined as never);
    assert.match(result.content[0]!.text, /No relevant memories found/);
    assert.equal(providerCalled, false, "no model call on a retrieval miss");
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM citation_events`).get() as {
          n: number;
        }
      ).n,
      0,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("createMemoryDiagnosticSink writes recall_diagnostic audit entries and swallows a throwing appendEntry", () => {
  // Capturing appendEntry: the sink's production output contract is the
  // audit entry shape, pinned here so transcript observability is tested.
  const entries: Array<Record<string, unknown>> = [];
  const capturingPi = {
    appendEntry: (_type: string, entry: Record<string, unknown>) => {
      entries.push(entry);
    },
  } as unknown as ExtensionAPI;
  const sink = createMemoryDiagnosticSink(capturingPi);
  sink({
    event: "phase2_trigger",
    retrievedChars: 12345,
    inputCapChars: 40000,
  });
  sink({
    event: "stale_source",
    detail: "cited memory M:1 changed during synthesis",
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    kind: "recall_diagnostic",
    event: "phase2_trigger",
    retrievedChars: 12345,
    inputCapChars: 40000,
  });
  assert.deepEqual(entries[1], {
    kind: "recall_diagnostic",
    event: "stale_source",
    detail: "cited memory M:1 changed during synthesis",
  });

  // A throwing appendEntry (non-TUI sessions) must be swallowed, never
  // propagate into the briefing or tool path.
  const throwingPi = {
    appendEntry: () => {
      throw new Error("appendEntry unavailable");
    },
  } as unknown as ExtensionAPI;
  const throwingSink = createMemoryDiagnosticSink(throwingPi);
  assert.doesNotThrow(() => {
    throwingSink({ event: "phase2_trigger", retrievedChars: 1 });
  });
});
