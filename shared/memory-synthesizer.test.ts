import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import { commitMemoryDreamSession } from "./memory-repository.ts";
import {
  checkMemoryProviderCapacity,
  renderSynthesisUserMessage,
  synthesizeMemoryContext,
  type MemorySynthesizerCompleteFn,
} from "./memory-synthesizer.ts";
import { buildMemorySynthesisPayload } from "./memory-payload.ts";
import { findMemoryCandidates } from "./memory-retrieval.ts";
import { defaultMemoryWorkspaceConfig } from "./memory-config.ts";
import {
  loadMemoryBriefingPrompt,
  loadMemorySearchPrompt,
} from "./memory-prompts.ts";
import type { MemoryPayloadBuildResult } from "./memory-payload.ts";
import { MEMORY_BRIEFING_MAX_CHARS } from "./memory-types.ts";

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

function modelRegistry() {
  return {
    find: () => ({ id: "fake-model" }),
    getProvider: () => undefined,
  };
}

function sessionModel(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    modelKey: "claude-sonnet-4-5",
    model: { id: "fake-model", contextWindow: 200_000, maxTokens: 32_000 },
    ...overrides,
  } as never;
}

function sequenceComplete(responses: string[]): MemorySynthesizerCompleteFn & {
  calls: number;
} {
  let i = 0;
  const wrapped = (async () => {
    wrapped.calls++;
    const text = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return { text };
  }) as unknown as MemorySynthesizerCompleteFn & { calls: number };
  wrapped.calls = 0;
  return wrapped;
}

async function buildPayload(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  query = "emoji commits",
): Promise<MemoryPayloadBuildResult> {
  const retrieval = await findMemoryCandidates(db, query, {
    modelId: "test/unused",
    embed: null,
  });
  return buildMemorySynthesisPayload(retrieval.candidates);
}

test("one call on the success path: content and sources validated", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const complete = sequenceComplete([
      JSON.stringify({
        content: "Avoid emoji in commits.",
        sources: ["M:1"],
      }),
    ]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "commit style?",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, "Avoid emoji in commits.");
    assert.deepEqual(result.sources, ["M:1"]);
    assert.equal(complete.calls, 1, "exactly one model call on success");
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM citation_events`).get() as {
          n: number;
        }
      ).n,
      0,
      "the synthesizer never records citations (callers do)",
    );
  });
});

test("purpose-specific prompts load; briefing prompt states brevity is not penalized", () => {
  const briefing = loadMemoryBriefingPrompt()!;
  const search = loadMemorySearchPrompt()!;
  assert.ok(briefing.includes("memory briefer"));
  assert.ok(briefing.includes("Brevity is not penalized"));
  assert.ok(
    briefing.includes("user preferences section is rendered separately"),
  );
  assert.ok(briefing.includes("<request>"));
  assert.ok(search.includes("Memory search"));
  assert.ok(search.includes("No relevant memories found"));
  assert.ok(search.includes("<request>"));
});

test("the user message orders memories, then the delimited request, then instructions", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    let captured = "";
    await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "any commit style preferences?",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: async (input) => {
        captured = input.user;
        return {
          text: JSON.stringify({ content: "", sources: [] }),
        };
      },
    });
    const payloadIdx = captured.indexOf("Memory payload:");
    const requestIdx = captured.indexOf("<request>");
    const tailIdx = captured.indexOf("Instructions:");
    assert.ok(
      payloadIdx >= 0 && requestIdx > payloadIdx && tailIdx > requestIdx,
    );
    assert.ok(captured.includes("Do not use emoji in commits"));
    assert.ok(captured.includes("any commit style preferences?"));
    assert.ok(captured.includes("not a task for you"));
    assert.ok(captured.includes("strict JSON only"));
  });
});

test("exactly one retry on malformed JSON; a third call is never issued", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const complete = sequenceComplete(["not-json", "still-not-json"]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "malformed");
    assert.equal(complete.calls, 2, "one retry, never a third call");
  });
});

test("a first response that parses but fails validation still draws only one retry", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    // First: parses but cites an unknown id. Retry: still invalid. The total
    // call count must be exactly two — never a third.
    const complete = sequenceComplete([
      JSON.stringify({ content: "x", sources: ["M:9"] }),
      JSON.stringify({ content: "x", sources: ["M:9"] }),
    ]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "malformed");
    assert.equal(complete.calls, 2, "exactly one retry, never a third call");
  });
});

test("a retry that parses but fails validation fails closed after two calls", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    // First: unparseable. Retry: parses but is invalid (duplicate id). The
    // retry budget is exhausted at two calls; no third call is issued.
    const complete = sequenceComplete([
      "not-json",
      JSON.stringify({ content: "x", sources: ["M:1", "M:1"] }),
    ]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "malformed");
    assert.equal(complete.calls, 2, "a third call is never issued");
  });
});

test("a parse failure is retried with the error appended, then succeeds", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const users: string[] = [];
    const complete = (async (input: {
      system: string;
      user: string;
      signal?: AbortSignal;
    }) => {
      users.push(input.user);
      const text =
        users.length === 1
          ? "not-json"
          : JSON.stringify({ content: "No emoji.", sources: ["M:1"] });
      return { text };
    }) as MemorySynthesizerCompleteFn;
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(users.length, 2);
    assert.match(users[1]!, /previous response was not accepted/);
  });
});

test("empty output fails closed after the retry", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const complete = sequenceComplete(["", ""]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "malformed");
    assert.equal(complete.calls, 2);
  });
});

test("duplicate and unknown cited ids are rejected", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    for (const sources of [["M:1", "M:1"], ["M:9"]]) {
      const complete = sequenceComplete([
        JSON.stringify({ content: "x", sources }),
        JSON.stringify({ content: "x", sources }),
      ]);
      const result = await synthesizeMemoryContext({
        db,
        purpose: "search",
        request: "x",
        payload: await buildPayload(db),
        config: defaultMemoryWorkspaceConfig(),
        modelRegistry: modelRegistry() as never,
        sessionModel: sessionModel(),
        complete,
      });
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.error, "malformed");
    }
  });
});

test("content beyond the briefing cap is rejected after the retry", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const complete = sequenceComplete([
      JSON.stringify({
        content: "x".repeat(MEMORY_BRIEFING_MAX_CHARS + 1),
        sources: [],
      }),
      JSON.stringify({
        content: "x".repeat(MEMORY_BRIEFING_MAX_CHARS + 1),
        sources: [],
      }),
    ]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.detail ?? "", /output cap/);
  });
});

test("mutating an UNCITED memory mid-call still produces a briefing", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const complete = (async () => {
      // The dreamer revises M:2 while the model call is in flight.
      db.prepare(
        `UPDATE memory_versions SET text = 'The build uses bun' WHERE memory_id = 2`,
      ).run();
      return {
        text: JSON.stringify({
          content: "Avoid emoji.",
          sources: ["M:1"],
        }),
      };
    }) as MemorySynthesizerCompleteFn;
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(
      result.ok,
      true,
      "uncited changes never invalidate the answer",
    );
    if (!result.ok) return;
    assert.deepEqual(result.sources, ["M:1"]);
  });
});

test("mutating a CITED memory fails closed with no content and no retry", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    let calls = 0;
    const complete = (async () => {
      calls++;
      db.prepare(`UPDATE memories SET state = 'retired' WHERE id = 1`).run();
      return {
        text: JSON.stringify({
          content: "Avoid emoji.",
          sources: ["M:1"],
        }),
      };
    }) as MemorySynthesizerCompleteFn;
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "stale_source");
    assert.equal(calls, 1, "stale evidence is never retried");
  });
});

test("a cited memory whose text changed mid-call is stale", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const complete = (async () => {
      db.prepare(
        `UPDATE memory_versions SET text = 'Changed text' WHERE memory_id = 1`,
      ).run();
      return {
        text: JSON.stringify({
          content: "Avoid emoji.",
          sources: ["M:1"],
        }),
      };
    }) as MemorySynthesizerCompleteFn;
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "stale_source");
  });
});

test("an empty payload fails closed with no_memories and no model call", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    let calls = 0;
    const empty = buildMemorySynthesisPayload([]);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: empty,
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: (async () => {
        calls++;
        return { text: "{}" };
      }) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "no_memories");
    assert.equal(calls, 0);
  });
});

test("provider context insufficiency fails closed without truncating the payload", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    let calls = 0;
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel({
        model: { id: "tiny", contextWindow: 200, maxTokens: 100 },
      }),
      complete: (async () => {
        calls++;
        return { text: "{}" };
      }) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "provider_context_insufficient");
    assert.equal(calls, 0, "the model is never called when capacity fails");
  });
});

test("maxTokens below the output reserve fails the capacity check", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel({
        model: { id: "small-out", contextWindow: 200_000, maxTokens: 64 },
      }),
      complete: (async () => ({ text: "{}" })) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "provider_context_insufficient");
  });
});

test("capacity metadata absent (unknown) never fails the check", () => {
  const ok = checkMemoryProviderCapacity(
    {
      modelId: "x/y",
      provider: "x",
      modelKey: "y",
      model: { id: "fake" },
      thinking: undefined,
    } as never,
    1000,
    100,
  );
  assert.equal(ok.ok, true);
});

test("briefing contract: empty content with empty sources is a valid no-op", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "unrelated task",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: (async () => ({
        text: JSON.stringify({ content: "", sources: [] }),
      })) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, "");
    assert.deepEqual(result.sources, []);
  });
});

test("briefing contract: content without sources is rejected", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: (async () => ({
        text: JSON.stringify({ content: "unsupported claim", sources: [] }),
      })) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "malformed");
  });
});

test("search contract: 'No relevant memories found.' passes with empty sources", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "nothing here",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: (async () => ({
        text: JSON.stringify({
          content: "No relevant memories found.",
          sources: [],
        }),
      })) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, "No relevant memories found.");
    assert.deepEqual(result.sources, []);
  });
});

test("an aborted synthesis fails closed without a call", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await synthesizeMemoryContext({
      db,
      purpose: "briefing",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      signal: controller.signal,
      complete: (async () => {
        calls++;
        return { text: "{}" };
      }) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "aborted");
    assert.equal(calls, 0);
  });
});

test("a provider error fails closed as provider_error", async () => {
  await withClaimedDb(async (db, runId) => {
    seed(db, runId);
    const result = await synthesizeMemoryContext({
      db,
      purpose: "search",
      request: "x",
      payload: await buildPayload(db),
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelRegistry() as never,
      sessionModel: sessionModel(),
      complete: (async () => {
        throw new Error("upstream 429");
      }) as MemorySynthesizerCompleteFn,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "provider_error");
    assert.match(result.detail ?? "", /upstream 429/);
  });
});

test("renderSynthesisUserMessage includes purpose-specific instruction tails", () => {
  const payload = buildMemorySynthesisPayload([
    {
      nodeType: "memory",
      nodeId: 1,
      prefixedId: "M:1",
      kind: "fact",
      state: "active",
      text: "CI runs on Ubuntu",
      recurrence: 1,
      score: 1,
      lexicalRank: 1,
      semanticRank: null,
      semanticScore: null,
    },
  ]);
  const briefing = renderSynthesisUserMessage("briefing", "task?", payload);
  assert.ok(
    briefing.includes("Brevity is not penalized and there is no target length"),
  );
  assert.ok(briefing.includes("empty content and empty sources"));
  const search = renderSynthesisUserMessage("search", "task?", payload);
  assert.ok(search.includes("No relevant memories found"));
});
