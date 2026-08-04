import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildMemorySessionBriefing,
  createMemoryBriefingSignal,
  renderMemoryBriefingMessage,
  renderMemoryUserPreferences,
} from "./memory-briefing.ts";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "../shared/memory-database.ts";
import { acquireMemoryRunClaim } from "../shared/memory-run-claim.ts";
import { commitMemoryDreamSession } from "../shared/memory-repository.ts";
import { defaultMemoryWorkspaceConfig } from "../shared/memory-config.ts";
import { getMemoryWorkspaceState } from "../shared/memory-repository.ts";
import { getMemoryActivityGeneration as gen } from "../shared/memory-graph.ts";
import { MEMORY_BRIEFING_MAX_CHARS } from "../shared/memory-types.ts";

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

function registry() {
  return {
    find: () => ({ id: "fake-model" }),
    getProvider: () => undefined,
  };
}

function modelWithCapacity(
  overrides: { contextWindow?: number; maxTokens?: number } = {},
) {
  return {
    ...registry(),
    find: () => ({
      id: "fake-model",
      contextWindow: overrides.contextWindow ?? 200_000,
      maxTokens: overrides.maxTokens ?? 32_000,
    }),
  };
}

function completeWith(response: string) {
  return async () => ({ text: response });
}

function citationCount(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS n FROM citation_events`).get() as {
        n: number;
      }
    ).n,
  );
}

test("success renders task-relevant context then user preferences, and records citations", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    // A third memory adds a user preference beyond the task-relevant one.
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s2",
      sessionPath: "/tmp/s2.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h2",
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "preference",
            evidenceText: "Prefers tabs",
            memoryText: "Prefer tabs over spaces",
          },
        ],
      },
    });

    const result = await buildMemorySessionBriefing({
      db,
      query: "what commit style do we use?",
      config: {
        ...defaultMemoryWorkspaceConfig(),
        recallThinking: "high",
      },
      modelRegistry: modelWithCapacity() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith(
        JSON.stringify({
          content: "No emoji in commits.",
          sources: ["M:1"],
        }),
      ),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message, "successful synthesis must render a briefing");
    const content = result.message!.content;
    assert.ok(content.includes("No emoji in commits."));
    assert.ok(
      content.indexOf("## Context relevant to this session") <
        content.indexOf("## User preferences"),
      "task-relevant context comes before user preferences",
    );
    assert.ok(content.includes("Do not use emoji in commits"));
    assert.ok(content.includes("Prefer tabs over spaces"));
    assert.ok(content.includes("`memory_search`"));
    assert.equal(result.audit, null);
    // Only the cited source is recorded (briefing source).
    const events = db
      .prepare(`SELECT node_type, node_id, source FROM citation_events`)
      .all() as Array<{ node_type: string; node_id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.node_type, "memory");
    assert.equal(events[0]!.node_id, 1);
    assert.equal(events[0]!.source, "briefing");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("the deterministic preference section renders ahead of the call and survives cancel", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const controller = new AbortController();
    const briefing = buildMemorySessionBriefing({
      db,
      query: "do you use emoji?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      signal: controller.signal,
      complete: async () => {
        controller.abort(); // Escape pressed during the model call
        throw new DOMException("Aborted", "AbortError");
      },
    });
    const result = await briefing;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message, "cancel must not leave the turn empty");
    assert.ok(
      result.message!.content.includes("## User preferences"),
      "the preference section is preserved on cancel",
    );
    assert.ok(
      !result.message!.content.includes("## Context relevant to this session"),
    );
    assert.equal(citationCount(db), 0, "cancel records no citations");
    assert.equal(result.audit?.status, "aborted");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("synthesizer failure renders preferences only, with an audit and no citations", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith("not-json"),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message, "preferences still render on failure");
    assert.ok(result.message!.content.includes("## User preferences"));
    assert.equal(result.message!.details.status, "synthesizer_failed");
    assert.equal(result.audit?.status, "synthesizer_failed");
    assert.equal(citationCount(db), 0, "no citations on failure");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a no-source first turn renders no task-relevant section but does render preferences", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "zzz nothing matches this",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message, "preferences render on a no-source turn");
    assert.ok(result.message!.content.includes("## User preferences"));
    assert.ok(
      !result.message!.content.includes("## Context relevant to this session"),
    );
    assert.equal(result.message!.details.status, "no_relevant_memories");
    assert.equal(result.audit, null);
    assert.equal(citationCount(db), 0);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("empty store yields no message and no model call", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    let called = false;
    const result = await buildMemorySessionBriefing({
      db,
      query: "emoji",
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
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: { find: () => undefined } as never,
      currentSessionModel: undefined,
    });
    assert.equal(r1.ok, true);
    assert.equal(gen(db), 1);

    // Synthesizer failure with memories present.
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const r2 = await buildMemorySessionBriefing({
      db,
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith("garbage"),
    });
    assert.equal(r2.ok, true);
    assert.equal(gen(db), 2);

    // Empty layer (everything retired).
    db.prepare(`UPDATE memories SET state = 'retired'`).run();
    const r3 = await buildMemorySessionBriefing({
      db,
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: registry() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    assert.equal(r3.ok, true);
    assert.equal(gen(db), 3);
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
        query: "do you use emoji?",
        config: defaultMemoryWorkspaceConfig(),
        modelRegistry: registry() as never,
        currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
        signal: controller.signal,
      }),
    );
    assert.equal(gen(db), 0);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("provider context insufficiency fails closed, persists for status, and never calls the model", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    let calls = 0;
    const result = await buildMemorySessionBriefing({
      db,
      query: "do you use emoji?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelWithCapacity({ contextWindow: 100 }) as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: async () => {
        calls++;
        return { text: "{}" };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(calls, 0, "no truncation: the model is never called");
    assert.ok(
      result.message!.content.includes("## User preferences"),
      "preferences still render",
    );
    assert.equal(result.audit?.status, "provider_context_insufficient");
    // The condition is persisted for /memory status.
    assert.match(
      getMemoryWorkspaceState(db).recallCapacityError ?? "",
      /context/,
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a successful briefing clears the persisted capacity failure", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    // Simulate a previously persisted failure.
    db.prepare(
      `UPDATE workspace_state SET recall_capacity_error = 'old failure' WHERE id = 1`,
    ).run();
    const result = await buildMemorySessionBriefing({
      db,
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelWithCapacity() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith(
        JSON.stringify({
          content: "No emoji.",
          sources: ["M:1"],
        }),
      ),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(getMemoryWorkspaceState(db).recallCapacityError, null);
  } finally {
    closeMemoryDatabase(db);
  }
});

test("mutating a CITED memory mid-call yields no content, no citations, and preferences only", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelWithCapacity() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: async () => {
        // The dreamer retires the memory the model is about to cite.
        db.prepare(`UPDATE memories SET state = 'retired' WHERE id = 1`).run();
        return {
          text: JSON.stringify({
            content: "No emoji in commits.",
            sources: ["M:1"],
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message, "preferences still render");
    assert.ok(
      !result.message!.content.includes("No emoji in commits."),
      "no partial answer is emitted",
    );
    assert.ok(result.message!.content.includes("## User preferences"));
    assert.equal(result.message!.details.status, "synthesizer_failed");
    assert.equal(citationCount(db), 0, "no citation event on stale sources");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("mutating an UNCITED memory mid-call still produces the briefing", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "emoji",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelWithCapacity() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: async () => {
        db.prepare(
          `UPDATE memory_versions SET text = 'The build uses bun' WHERE memory_id = 2`,
        ).run();
        return {
          text: JSON.stringify({
            content: "No emoji in commits.",
            sources: ["M:1"],
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(
      result.message!.content.includes("No emoji in commits."),
      "uncited changes never invalidate the answer",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("the long subsequent-review fixture flows through the delimited request block untrusted", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const query =
      "Review the changes in the last three commits and tell me what needs fixing; also write a test plan. I could not perform the review myself, so please do it for me.";
    let capturedUser = "";
    const result = await buildMemorySessionBriefing({
      db,
      query,
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelWithCapacity() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: async (input) => {
        capturedUser = input.user;
        return {
          text: JSON.stringify({
            content: "Commit style: no emoji in commit messages.",
            sources: ["M:1"],
          }),
        };
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The request is delimited and instruction-free: only cited durable context
    // reaches the rendered briefing.
    assert.ok(capturedUser.includes("<request>"));
    assert.ok(capturedUser.includes(query));
    assert.ok(capturedUser.includes("not a task for you"));
    const content = result.message!.content;
    assert.ok(content.includes("no emoji in commit messages"));
    for (const forbidden of [
      "could not perform",
      "not provided",
      "cannot access",
      "review the changes",
      "write a test plan",
    ]) {
      assert.ok(
        !content.toLowerCase().includes(forbidden),
        `briefing must not echo task-execution language: ${forbidden}`,
      );
    }
  } finally {
    closeMemoryDatabase(db);
  }
});

test("a briefing over three memories is materially shorter than the output cap", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    seed(db, claim.runId!);
    const result = await buildMemorySessionBriefing({
      db,
      query: "do you use emoji?",
      config: defaultMemoryWorkspaceConfig(),
      modelRegistry: modelWithCapacity() as never,
      currentSessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      complete: completeWith(
        JSON.stringify({
          content: "Two short facts.",
          sources: ["M:1", "M:2"],
        }),
      ),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(
      result.message!.content.length < MEMORY_BRIEFING_MAX_CHARS / 10,
      "the rendered briefing is far below the cap (no padding toward the ceiling)",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryUserPreferences lists active preferences only, id-ascending", () => {
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
      minedMessageOffset: 1,
      plan: {
        operations: [
          {
            op: "create",
            kind: "fact",
            evidenceText: "obs",
            memoryText: "Build uses pnpm",
          },
          {
            op: "create",
            kind: "preference",
            evidenceText: "obs",
            memoryText: "Prefer tabs over spaces",
          },
          {
            op: "create",
            kind: "preference",
            evidenceText: "obs",
            memoryText: "No emoji in commits",
          },
        ],
      },
    });
    // Both preferences render id-ascending; facts never do.
    const text = renderMemoryUserPreferences(db);
    assert.ok(text.includes("- M:2 (preference): Prefer tabs over spaces"));
    assert.ok(text.includes("- M:3 (preference): No emoji in commits"));
    assert.ok(!text.includes("Build uses pnpm"), "facts are not preferences");
    assert.ok(
      text.indexOf("M:2") < text.indexOf("M:3"),
      "id-ascending deterministic order",
    );
    // One preference retired: it must not render.
    db.prepare(`UPDATE memories SET state = 'retired' WHERE id = 3`).run();
    const afterRetire = renderMemoryUserPreferences(db);
    assert.ok(!afterRetire.includes("- M:3 (preference)"));
    assert.ok(afterRetire.includes("- M:2 (preference)"));
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryBriefingMessage orders context before preferences and adds the footer", () => {
  const content = renderMemoryBriefingMessage(
    "- M:1 (preference): Prefer tabs",
    "Task context here.",
  );
  assert.ok(
    content.indexOf("## Context relevant to this session") <
      content.indexOf("## User preferences"),
  );
  assert.ok(
    content
      .trimEnd()
      .endsWith(
        "`memory_search` — ask a question in your own words; the synthesizer answers from workspace memory.",
      ),
  );
  const noAnswer = renderMemoryBriefingMessage(
    "- M:1 (preference): Prefer tabs",
    null,
  );
  assert.ok(!noAnswer.includes("## Context relevant to this session"));
  assert.ok(noAnswer.includes("## User preferences"));
});

test("renderMemoryUserPreferences caps the deterministic section and notes partialness", () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    const claim = acquireMemoryRunClaim(db, "manual");
    assert.equal(claim.acquired, true);
    const ops = Array.from({ length: 60 }, (_, i) => ({
      op: "create" as const,

      kind: "preference" as const,
      evidenceText: `Pref ${i}`,
      memoryText: `Preference number ${i} ${"y".repeat(370)}`,
    }));
    commitMemoryDreamSession(db, {
      runId: claim.runId!,
      sourceSessionId: "s1",
      sessionPath: "/tmp/s1.jsonl",
      cwd: "/tmp",
      processedMtimeMs: 1,
      contentHash: "h1",
      minedMessageOffset: 1,
      plan: { operations: ops },
    });
    const text = renderMemoryUserPreferences(db);
    assert.ok(
      text.length <= MEMORY_BRIEFING_MAX_CHARS + 64,
      "the deterministic section stays bounded",
    );
    assert.match(text, /… and \d+ more \(see \/memory list for all\)/);
    assert.ok(
      text.includes("- M:1 (preference):"),
      "truncation is by id: the earliest preferences render",
    );
    assert.ok(
      !text.includes("- M:60 (preference):"),
      "the tail is omitted, not rendered in full",
    );
  } finally {
    closeMemoryDatabase(db);
  }
});
