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

test("sources outside the context fail closed; every visible source is credited", async () => {
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

    // Nine visible sources: every one must be credited.
    // Build a tree with 9 visible nodes: roots S:1 and S:2, plus S:2's
    // children M:3..M:9.
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
    const many = await synthesizeMemoryAnswer({
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
    assert.equal(many.ok, true, "all visible sources are credited");
    if (!many.ok) return;
    assert.equal(many.sources.length, 8);
    assert.deepEqual(many.sources, [
      "M:3",
      "M:4",
      "M:5",
      "M:6",
      "M:7",
      "M:8",
      "M:9",
      "S:2",
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

test("a single redundant open draws a corrective hint and the synthesis continues", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const users: string[] = [];
    const responses = [
      JSON.stringify({ action: "open", id: "S:1" }),
      JSON.stringify({ action: "open", id: "S:1" }),
      JSON.stringify({
        action: "finalize",
        answer: "Tooling: no emoji, pnpm.",
        sources: ["M:1", "M:2"],
      }),
    ];
    let i = 0;
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async (input) => {
        users.push(input.user);
        return { text: responses[Math.min(i++, responses.length - 1)]! };
      },
    });
    assert.equal(
      result.ok,
      true,
      "a redundant open alone does not fail the synthesis",
    );
    if (!result.ok) return;
    assert.deepEqual(result.sources, ["M:1", "M:2"]);
    assert.equal(result.steps, 3);
    assert.match(
      users[2]!,
      /previous open of S:1 added no new context nodes — everything it contains is already visible above \(it is already open and its children are listed above\). If the visible context is sufficient for the request, finalize now/,
      "the third render carries the corrective hint",
    );
  });
});

test("a repeated open that adds no new context fails closed after the hint", async () => {
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
        JSON.stringify({ action: "open", id: "S:1" }),
        JSON.stringify({ action: "open", id: "S:1" }),
      ]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /no new context nodes after a prior hint/);
  });
});

test("an open that adds new context resets the no-new-context hint", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    // S:2 wraps M:3..M:9, a second summary to open.
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
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        JSON.stringify({ action: "open", id: "S:1" }),
        JSON.stringify({ action: "open", id: "S:1" }), // no new context: hint only
        JSON.stringify({ action: "open", id: "S:2" }), // new context clears the hint
        JSON.stringify({ action: "open", id: "S:2" }), // no new context: hint only
        JSON.stringify({
          action: "finalize",
          answer: "x",
          sources: ["M:3"],
        }),
      ]),
    });
    assert.equal(result.ok, true, "only consecutive no-new-context opens fail");
    if (!result.ok) return;
    assert.deepEqual(result.openedSummaryIds, ["S:1", "S:2"]);
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

test("a loop failure draws one forced finalize: partial result with the failure reason", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        "not-json",
        JSON.stringify({
          action: "finalize",
          answer: "Tooling: no emoji, pnpm.",
          sources: ["S:1"],
        }),
      ]),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.partial?.reason ?? "", /malformed synthesizer output/);
    assert.equal(result.answer, "Tooling: no emoji, pnpm.");
    assert.deepEqual(result.sources, ["S:1"]);
    assert.deepEqual(result.openedSummaryIds, []);
    assert.equal(result.steps, 2, "loop call plus the forced finalize call");
  });
});

test("a forced finalize that fails returns the original failure", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete(["not-json"]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /malformed synthesizer output/);
    assert.match(
      result.error,
      /forced finalize also failed/,
      "the forced call's own failure is surfaced alongside the original reason",
    );
  });
});

test("finalizeNowSignal stops navigation and forces a finalize from the gathered context", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const answerNow = new AbortController();
    const responses = [
      JSON.stringify({ action: "open", id: "S:1" }),
      JSON.stringify({
        action: "finalize",
        answer: "Tooling: no emoji, pnpm.",
        sources: ["M:1", "M:2"],
      }),
    ];
    let calls = 0;
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      finalizeNowSignal: answerNow.signal,
      complete: async ({ signal }) => {
        calls++;
        if (calls === 1) answerNow.abort(); // `a` pressed during the first call
        // The forced finalize must not receive the already-aborted answer-now
        // signal: real completion paths reject such a signal up front.
        if (calls >= 2 && signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return { text: responses[Math.min(calls - 1, responses.length - 1)]! };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.partial?.reason, "answer requested");
    assert.deepEqual(
      result.openedSummaryIds,
      ["S:1"],
      "the open before `a` is kept",
    );
    assert.deepEqual(result.sources, ["M:1", "M:2"]);
    assert.equal(result.steps, 2);
  });
});

test("answer now before the first call forces a finalize from the top layer", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const answerNow = new AbortController();
    answerNow.abort();
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      finalizeNowSignal: answerNow.signal,
      complete: sequenceComplete([
        JSON.stringify({
          action: "finalize",
          answer: "No emoji, pnpm.",
          sources: ["S:1"],
        }),
      ]),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.partial?.reason, "answer requested");
    assert.equal(result.steps, 1, "only the forced call runs");
    assert.deepEqual(result.sources, ["S:1"]);
  });
});

test("a forced finalize after answer now that fails hard-fails", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const answerNow = new AbortController();
    answerNow.abort();
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      finalizeNowSignal: answerNow.signal,
      complete: sequenceComplete(["not-json"]),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /answer requested but the finalize call failed/);
  });
});

test("an aborted finalizeNowSignal does not cancel the forced finalize call", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const answerNow = new AbortController();
    answerNow.abort();
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      finalizeNowSignal: answerNow.signal,
      complete: async ({ signal }) => {
        // Real completion paths (raceMemoryOperation) reject an already-aborted
        // signal before the model is invoked; the forced call must run under
        // the cancel signal only, so this must never fire.
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return {
          text: JSON.stringify({
            action: "finalize",
            answer: "No emoji, pnpm.",
            sources: ["S:1"],
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.partial?.reason, "answer requested");
    assert.equal(result.answer, "No emoji, pnpm.");
    assert.equal(result.steps, 1, "only the forced call runs");
    assert.deepEqual(result.sources, ["S:1"]);
  });
});

test("a cancel during the forced finalize hard-fails as aborted", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const controller = new AbortController();
    let calls = 0;
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      signal: controller.signal,
      complete: async () => {
        calls++;
        if (calls === 1) return { text: "not-json" };
        controller.abort(); // Escape pressed during the forced call
        throw new DOMException("Aborted", "AbortError");
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(
      result.error,
      "aborted",
      "the cancel is not mislabeled as the loop failure",
    );
  });
});

test("a user cancel hard-fails without a forced finalize call", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      signal: controller.signal,
      complete: async () => {
        calls++;
        return {
          text: JSON.stringify({
            action: "finalize",
            answer: "x",
            sources: [],
          }),
        };
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "aborted");
    assert.equal(calls, 0, "cancel never draws a model call");
  });
});

test("a cancel between calls stops the loop as a returned failure, not a throw", async () => {
  await withClaimedDb(async (db, runId) => {
    seedTree(db, runId);
    const controller = new AbortController();
    let calls = 0;
    const result = await synthesizeMemoryAnswer({
      db,
      request: "tooling?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      signal: controller.signal,
      complete: async () => {
        calls++;
        controller.abort(); // Escape lands between calls; the provider ignores it
        return {
          text: JSON.stringify({ action: "open", id: "S:1" }),
        };
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "aborted");
    assert.equal(calls, 1, "the loop stops at the next iteration boundary");
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

    // Mutation of a source node between calls fails finalize closed: the
    // loop's refresh rejects it, and staleness never draws a forced finalize
    // (the gathered context is provably invalid).
    seedTree(db, runId);
    let secondCalls = 0;
    const second = await synthesizeMemoryAnswer({
      db,
      request: "x",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async () => {
        secondCalls++;
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
    assert.equal(
      secondCalls,
      1,
      "staleness never draws a forced finalize call",
    );
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

test("deep tree navigation: a 10-level chain opens and finalizes", async () => {
  await withClaimedDb(async (db, runId) => {
    // S:10 -> S:9 -> ... -> S:1 -> M:1 (summary ids follow creation order:
    // the root is the last-created summary). Opening down the chain takes 10
    // opens (11 model calls). Summary texts strictly shrink upward (90..99
    // tokens vs the memory's 100) so every level satisfies strict compaction.
    commitMemoryDreamSession(db, {
      runId,
      sourceSessionId: "deep",
      sessionPath: "/tmp/deep.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h-deep",
      plan: {
        operations: [
          {
            op: "create",
            tempRef: "m1",
            kind: "fact",
            observationText: "x",
            memoryText: "x".repeat(400),
          },
          ...Array.from({ length: 10 }, (_, i) => ({
            op: "summarize" as const,
            tempRef: `s${10 - i}`,
            text: "x".repeat(360 + 4 * (10 - i - 1)),
            memberIds: [i === 0 ? "m1" : `s${11 - i}`],
          })),
        ],
      },
    });
    const result = await synthesizeMemoryAnswer({
      db,
      request: "deep?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: sequenceComplete([
        ...Array.from({ length: 10 }, (_, i) =>
          JSON.stringify({ action: "open", id: `S:${10 - i}` }),
        ),
        JSON.stringify({
          action: "finalize",
          answer: "Deep fact",
          sources: ["M:1"],
        }),
      ]),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.steps, 11, "11 model calls for the 10-level chain");
    assert.deepEqual(result.openedSummaryIds, [
      "S:10",
      "S:9",
      "S:8",
      "S:7",
      "S:6",
      "S:5",
      "S:4",
      "S:3",
      "S:2",
      "S:1",
    ]);
    assert.deepEqual(result.sources, ["M:1"]);
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
