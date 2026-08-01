import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import { commitMemoryDreamSession } from "./memory-repository.ts";
import { synthesizeMemoryAnswer } from "./memory-synthesizer.ts";
import { defaultMemoryWorkspaceConfig } from "./memory-config.ts";
import { retireMemoryNode } from "./memory-graph.ts";
import { MEMORY_SYNTHESIZER_MAX_STEPS } from "./memory-types.ts";

async function withClaimedDb(
  fn: (
    db: ReturnType<typeof openMemoryDatabaseAtPath>,
    runId: string,
  ) => void | Promise<void>,
) {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    await fn(db, claim.runId!);
  } finally {
    closeMemoryDatabase(db);
  }
}

function seedTree(
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
        {
          op: "summarize",
          tempRef: "s1",
          text: "Tooling",
          memberIds: ["m1", "m2"],
        },
      ],
    },
  });
}

function modelRegistry() {
  return {
    find: () => ({ id: "fake-model" }),
    getProvider: () => undefined,
  };
}

function sessionModel() {
  return {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    modelKey: "claude-sonnet-4-5",
    model: { id: "fake-model" },
  } as never;
}

function sequenceComplete(responses: string[]) {
  let i = 0;
  return async () => {
    const text = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return { text };
  };
}

test("finalize from the top layer: sources validated, opened summaries tracked", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "any commit style preferences?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({
          action: "finalize",
          answer: "Avoid emoji in commits.",
          sources: ["S:1"],
        }),
      ]),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.answer, "Avoid emoji in commits.");
    assert.deepEqual(result.sources, ["S:1"]);
    assert.deepEqual(result.openedSummaryIds, []);
    assert.equal(result.steps, 1);
  });
});

test("open then finalize: children appended, opened summary reported", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "what are the tooling preferences?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
        JSON.stringify({
          action: "finalize",
          answer: "Tooling: no emoji, pnpm build.",
          sources: ["M:1", "M:2"],
        }),
      ]),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.sources, ["M:1", "M:2"]);
    assert.deepEqual(result.openedSummaryIds, ["S:1"]);
    assert.equal(result.steps, 2);
  });
});

test("opening an unseen id fails closed", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:999" }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not visible in the current context/);
  });
});

test("sources outside the context fail closed; over-cap sources truncate", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const bad = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({
          action: "finalize",
          answer: "x",
          sources: ["M:7"],
        }),
      ]),
    });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.match(bad.error, /not visible in the current context/);

    // More than MEMORY_SYNTHESIZER_MAX_SOURCES sources: first N credited.
    // Build a tree with 8 visible nodes: S:1 wrapping M:1..M:7, plus S:1.
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "rich",
      sessionPath: "/tmp/rich.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-rich",
      plan: {
        operations: [
          ...Array.from({ length: 7 }, (_, i) => ({
            op: "create" as const,
            tempRef: `m${i + 1}`,
            kind: "fact" as const,
            observationText: `Fact ${i + 1}`,
            memoryText: `Fact ${i + 1}`,
          })),
          {
            op: "summarize",
            tempRef: "s2",
            text: "Rich",
            memberIds: Array.from({ length: 7 }, (_, i) => `m${i + 1}`),
          },
        ],
      },
    });
    const tooMany = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:2" }),
        JSON.stringify({
          action: "finalize",
          answer: "x",
          sources: ["M:3", "M:4", "M:5", "M:6", "M:7", "M:8", "M:9", "S:2"],
        }),
      ]),
    });
    assert.equal(tooMany.ok, true, "over-citation is truncated, not fatal");
    if (!tooMany.ok) return;
    assert.equal(tooMany.sources.length, 6);
    assert.deepEqual(tooMany.sources, [
      "M:3",
      "M:4",
      "M:5",
      "M:6",
      "M:7",
      "M:8",
    ]);
  });
});

test("malformed output and unknown actions fail closed", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const malformed = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete(["not-json"]),
    });
    assert.equal(malformed.ok, false);
    if (malformed.ok) return;
    assert.match(malformed.error, /malformed synthesizer output/);

    const unknown = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([JSON.stringify({ action: "dance" })]),
    });
    assert.equal(unknown.ok, false);
    if (unknown.ok) return;
    assert.match(unknown.error, /unknown synthesizer action/);
  });
});

test("step budget exhaustion fails closed", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /step budget exhausted/);
  });
});

test("abort propagation fails closed", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const controller = new AbortController();
    controller.abort();
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      signal: controller.signal,
      complete: async () => {
        throw new DOMException("Aborted", "AbortError");
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "aborted");
  });
});

test("answer token cap is enforced", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        synthesizerAnswerBudget: 10,
      },
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({
          action: "finalize",
          answer: "x".repeat(100),
          sources: [],
        }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /answer budget/);
  });
});

test("an over-budget top layer fails closed and never truncates", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        briefingTokenBudget: 1,
      },
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async () => ({ text: "{}" }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "top_layer_over_budget");
    assert.equal(result.budget, 1);
    assert.ok((result.layerTokens ?? 0) > 1);
  });
});

test("a concurrent mutation of a context node fails the next open/finalize closed", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    // The injected complete retires the summary the model is about to open.
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async () => {
        retireMemoryNode(db, "S:1");
        return {
          text: JSON.stringify({ action: "open", id: "S:1" }),
        };
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /no longer active/);

    // Mutation of a source node between calls fails finalize.
    seedTree(db, runId);
    const second = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async () => {
        db.prepare(
          `UPDATE memories SET state = 'conflicted' WHERE id = 1`,
        ).run();
        return {
          text: JSON.stringify({
            action: "finalize",
            answer: "x",
            sources: ["M:1"],
          }),
        };
      },
    });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.match(second.error, /no longer active/);
  });
});

test("envelope enforcement: opening a summary whose children overflow fails closed", async () => {
  await withClaimedDb(async (db, runId) => {
    // S:1 has one huge child; the envelope cannot hold both the layer and it.
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
            kind: "fact",
            observationText: "x",
            memoryText: "x".repeat(300),
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["m1"],
          },
        ],
      },
    });
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        synthesizerContextBudget: 120, // layer ~75 tokens + framing leaves no room
      },
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /context envelope/);
  });
});

test("max steps is configurable", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        synthesizerMaxSteps: MEMORY_SYNTHESIZER_MAX_STEPS + 1,
      },
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /step budget exhausted/);
  });
});

test("a long request counts against the context envelope and fails closed", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    // Envelope: 4000 - framing 512 - answer 2000 - nav 256 = 1232 tokens for
    // request + nodes. The layer fits; the long request does not.
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x".repeat(5000),
      config: {
        ...defaultMemoryWorkspaceConfig(),
        synthesizerContextBudget: 4000,
      },
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async () => ({ text: "{}" }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /context envelope/);
  });
});

test("re-opening an already-open summary does not duplicate its children", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
        JSON.stringify({ action: "open", id: "S:1" }),
        JSON.stringify({
          action: "finalize",
          answer: "Tooling: no emoji, pnpm.",
          sources: ["M:1", "M:2"],
        }),
      ]),
    });
    assert.equal(
      result.ok,
      true,
      "double-open must not fail or corrupt context",
    );
    if (!result.ok) return;
    assert.deepEqual(
      result.openedSummaryIds,
      ["S:1"],
      "opened summaries are deduplicated",
    );
    assert.equal(result.steps, 3);
    assert.deepEqual(result.sources, ["M:1", "M:2"]);
  });
});

test("opening a summary counts the request tokens in the open-time envelope check", async () => {
  await withClaimedDb(async (db, runId) => {
    // Layer: S:1 wrapping three max-size children (400 chars -> 100 tokens
    // each; 300 tokens total when opened).
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
            kind: "fact",
            observationText: "x",
            memoryText: "x".repeat(400),
          },
          {
            op: "create",
            tempRef: "m2",
            kind: "fact",
            observationText: "y",
            memoryText: "y".repeat(400),
          },
          {
            op: "create",
            tempRef: "m3",
            kind: "fact",
            observationText: "z",
            memoryText: "z".repeat(400),
          },
          {
            op: "summarize",
            tempRef: "s1",
            text: "Tooling",
            memberIds: ["m1", "m2", "m3"],
          },
        ],
      },
    });
    // Envelope: 9000 - framing 512 - answer 2000 - nav 256 = 6232 tokens for
    // request + nodes. Request 6000 tokens: the initial check passes
    // (6000 + 2 <= 6232); opening S:1 adds the 250-token child and must fail
    // closed with the request included (6000 + 2 + 300 > 6232).
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x".repeat(24000),
      config: {
        ...defaultMemoryWorkspaceConfig(),
        synthesizerContextBudget: 9000,
      },
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /would exceed the context envelope/);
  });
});
