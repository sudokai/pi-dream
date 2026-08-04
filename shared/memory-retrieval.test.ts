import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import { acquireMemoryRunClaim } from "./memory-run-claim.ts";
import { commitMemoryDreamSession } from "./memory-repository.ts";
import { ensureMemoryEmbeddings } from "./memory-embedding.ts";
import {
  buildMemoryFtsQuery,
  findMemoryCandidates,
  isMemoryGreetingOnlyQuery,
  segmentMemoryQuery,
  shouldSkipMemoryRetrieval,
  tokenizeMemoryFtsTerms,
} from "./memory-retrieval.ts";
import { MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS } from "./memory-types.ts";

/**
 * Semantic-alias embedder: tokens are mapped through a canonical-topic alias
 * table, so texts sharing a topic score high even with no shared surface
 * words (the semantic side the lexical retriever cannot see).
 */
const ALIASES: Record<string, string> = {
  // "add a caching layer" ↔ "abstractions appear before call sites"
  caching: "caching",
  caches: "caching",
  layer: "caching",
  abstractions: "caching",
  call: "caching",
  sites: "caching",
  // tabs / indentation
  tabs: "tabs",
  indent: "tabs",
  indentation: "tabs",
  // pnpm / build
  pnpm: "pnpm",
  build: "pnpm",
  package: "pnpm",
  manager: "pnpm",
  // ci / ubuntu
  ci: "ci",
  ubuntu: "ci",
  runs: "ci",
};

const ALIAS_VOCAB = [...new Set(Object.values(ALIASES))].sort();

function aliasEmbed(texts: string[]): Promise<Float32Array[]> {
  const vectors = texts.map((text) => {
    const v = new Float32Array(ALIAS_VOCAB.length);
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const canonical = ALIASES[token];
      if (!canonical) continue;
      v[ALIAS_VOCAB.indexOf(canonical)] = 1;
    }
    const norm = Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0)) || 1;
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
    return v;
  });
  return Promise.resolve(vectors);
}

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

function createMemory(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
  sessionId: string,
  text: string,
  kind: "preference" | "fact" = "fact",
): void {
  commitMemoryDreamSession(db, {
    runId,
    sourceSessionId: sessionId,
    sessionPath: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp",
    processedMtimeMs: 1,
    contentHash: `h-${sessionId}`,
    minedMessageOffset: 1,
    plan: {
      operations: [
        {
          op: "create",

          kind,
          evidenceText: text,
          memoryText: text,
        },
      ],
    },
  });
}

async function seedIndexed(
  db: ReturnType<typeof openMemoryDatabaseAtPath>,
  runId: string,
  texts: Array<[string, "preference" | "fact"]>,
): Promise<void> {
  texts.forEach(([text, kind], i) =>
    createMemory(db, runId, `seed-${i}`, text, kind),
  );
  const result = await ensureMemoryEmbeddings(db, {
    modelId: "test/minilm",
    embed: aliasEmbed,
  });
  assert.equal(result.degraded, false);
}

test("tokenizeMemoryFtsTerms and buildMemoryFtsQuery sanitize FTS syntax", () => {
  assert.deepEqual(tokenizeMemoryFtsTerms(`tabs - "NEAR" AND * pnpm héllo`), [
    "tabs",
    "near",
    "and",
    "pnpm",
    "héllo",
  ]);
  assert.equal(
    buildMemoryFtsQuery(`tabs - "NEAR" AND * pnpm`),
    `"tabs" OR "near" OR "and" OR "pnpm"`,
  );
  assert.equal(buildMemoryFtsQuery(`*** --- !!!`), null);
  // Non-ASCII letters survive tokenization.
  assert.deepEqual(tokenizeMemoryFtsTerms("héllo wörld"), ["héllo", "wörld"]);
});

test("segmentMemoryQuery splits long queries and caps segment size", () => {
  assert.deepEqual(segmentMemoryQuery(""), []);
  assert.deepEqual(segmentMemoryQuery("hello world"), ["hello world"]);
  const long = Array.from(
    { length: 6 },
    (_, i) =>
      `Sentence number ${i} ${Array.from({ length: 40 }, () => "word").join(" ")} about the build.`,
  ).join(" ");
  const segments = segmentMemoryQuery(long);
  assert.ok(segments.length > 1, "long queries split into segments");
  for (const s of segments) {
    assert.ok(
      s.length <= MEMORY_RETRIEVAL_SEGMENT_MAX_CHARS + 1,
      "segments stay near the cap",
    );
  }
  const joined = segments.join(" ");
  for (const word of ["Sentence", "word", "build"]) {
    assert.ok(joined.includes(word), "no content is dropped across segments");
  }
});

test("greeting-only and trivially short queries skip retrieval", () => {
  assert.equal(isMemoryGreetingOnlyQuery("hi"), true);
  assert.equal(isMemoryGreetingOnlyQuery("Hello!"), true);
  assert.equal(isMemoryGreetingOnlyQuery("good morning"), true);
  assert.equal(isMemoryGreetingOnlyQuery("hey, what's up?"), true);
  assert.equal(isMemoryGreetingOnlyQuery("hi, add caching to the API"), false);
  assert.equal(isMemoryGreetingOnlyQuery("hello world"), false);
  assert.equal(shouldSkipMemoryRetrieval(""), true);
  assert.equal(shouldSkipMemoryRetrieval("hi"), true);
  assert.equal(shouldSkipMemoryRetrieval("ok"), true);
  assert.equal(shouldSkipMemoryRetrieval("good morning"), true);
  assert.equal(shouldSkipMemoryRetrieval("add caching to the API"), false);
});

test("RRF fuses lexical and semantic ranks and orders by fused score", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [
      ["Use tabs for indentation", "preference"],
      ["CI caches the pnpm store", "fact"],
      ["Deploy to Fly.io", "fact"],
    ]);
    const result = await findMemoryCandidates(db, "tabs and caching", {
      modelId: "test/minilm",
      embed: aliasEmbed,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.semanticDegraded, false);
    const ids = result.candidates.map((c) => c.nodeId);
    assert.deepEqual(ids, [1, 2], "dual-hit ranks above single-hit");
    const first = result.candidates[0]!;
    const second = result.candidates[1]!;
    assert.ok(first.lexicalRank !== null, "tabs hit lexically");
    assert.ok(first.semanticRank !== null, "tabs hit semantically");
    assert.ok(first.score > second.score);
    assert.equal(
      second.lexicalRank,
      null,
      "caching-only memory missed lexically",
    );
    assert.ok(second.semanticRank !== null);
    // M:3 shares neither surface words nor topics.
    assert.ok(
      !result.candidates.some((c) => c.nodeId === 3),
      "irrelevant memory stays out",
    );
  });
});

test("semantic-only relevance: no shared terms still surfaces via MiniLM", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [
      [
        "user gets frustrated when abstractions appear before three call sites",
        "preference",
      ],
      ["CI runs on Ubuntu 24.04", "fact"],
    ]);
    const result = await findMemoryCandidates(
      db,
      "add a caching layer to the API",
      { modelId: "test/minilm", embed: aliasEmbed },
    );
    assert.ok(
      result.candidates.some((c) => c.nodeId === 1),
      "the alias-matched memory surfaces via the semantic retriever",
    );
    const node = result.candidates.find((c) => c.nodeId === 1)!;
    assert.equal(node.lexicalRank, null, "no shared surface words");
    assert.ok(node.semanticRank !== null);
    assert.ok((node.semanticScore ?? 0) >= 0.15);
  });
});

test("a query matching nothing returns zero candidates, not the least-bad", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [
      ["Use tabs for indentation", "preference"],
      ["CI caches the pnpm store", "fact"],
    ]);
    const result = await findMemoryCandidates(db, "quick brown fox jumps", {
      modelId: "test/minilm",
      embed: aliasEmbed,
    });
    assert.equal(result.candidates.length, 0);
  });
});

test("FTS injection characters and non-ASCII return candidates, never zero", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [
      ["Use tabs for indentation", "preference"],
      ["build uses pnpm", "fact"],
      ["héllo wörld conventions", "fact"],
    ]);
    const result = await findMemoryCandidates(
      db,
      `tabs - "NEAR" AND * pnpm héllo`,
      { modelId: "test/minilm", embed: aliasEmbed },
    );
    const ids = result.candidates.map((c) => c.nodeId).sort((a, b) => a - b);
    assert.deepEqual(
      ids,
      [1, 2, 3],
      "sanitized query matches all three without failing",
    );
  });
});

test("greeting-only queries skip retrieval entirely", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [["Use tabs for indentation", "preference"]]);
    const result = await findMemoryCandidates(db, "good morning!", {
      modelId: "test/minilm",
      embed: aliasEmbed,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.candidates.length, 0);
  });
});

test("an empty vector index never loads the embedder (first-turn guard)", async () => {
  await withClaimedDb(async (db, runId) => {
    createMemory(db, runId, "s1", "use tabs for indentation");
    // No embeddings rows exist: the embedder seam must not be touched.
    let embedderTouched = false;
    const result = await findMemoryCandidates(db, "tabs", {
      modelId: "test/minilm",
      embed: async () => {
        embedderTouched = true;
        throw new Error("embedder must not load on an empty index");
      },
    });
    assert.equal(embedderTouched, false);
    assert.equal(result.semanticDegraded, true);
    assert.ok(
      result.candidates.some((c) => c.nodeId === 1),
      "lexical retrieval still works",
    );
  });
});

test("an unavailable embedder degrades to lexical-only", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [
      ["Use tabs for indentation", "preference"],
      ["Deploy to Fly.io", "fact"],
    ]);
    const result = await findMemoryCandidates(db, "tabs", {
      modelId: "test/minilm",
      embed: null, // embedder unavailable
    });
    assert.equal(result.semanticDegraded, true);
    assert.ok(
      result.candidates.some((c) => c.nodeId === 1),
      "lexical candidates alone still produce a usable result",
    );
    for (const c of result.candidates) {
      assert.equal(c.semanticRank, null);
      assert.equal(c.semanticScore, null);
    }
  });
});

test("retrieval never writes citation events or mutates the store", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [["Use tabs for indentation", "preference"]]);
    const before = (
      db.prepare(`SELECT COUNT(*) AS n FROM citation_events`).get() as {
        n: number;
      }
    ).n;
    const beforeMemories = (
      db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }
    ).n;
    await findMemoryCandidates(db, "tabs", {
      modelId: "test/minilm",
      embed: aliasEmbed,
    });
    await findMemoryCandidates(db, "good morning", {
      modelId: "test/minilm",
      embed: aliasEmbed,
    });
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM citation_events`).get() as {
          n: number;
        }
      ).n,
      before,
      "no citation events from retrieval",
    );
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as {
          n: number;
        }
      ).n,
      beforeMemories,
    );
  });
});

test("retired and conflicted memories never surface", async () => {
  await withClaimedDb(async (db, runId) => {
    await seedIndexed(db, runId, [
      ["Use tabs for indentation", "preference"],
      ["CI caches the pnpm store", "fact"],
    ]);
    db.prepare(`UPDATE memories SET state = 'retired' WHERE id = 1`).run();
    db.prepare(`DELETE FROM memory_fts WHERE rowid = 1`).run();
    db.prepare(`DELETE FROM search_documents WHERE node_id = 1`).run();
    const result = await findMemoryCandidates(db, "tabs and pnpm", {
      modelId: "test/minilm",
      embed: aliasEmbed,
    });
    assert.ok(
      !result.candidates.some((c) => c.nodeId === 1),
      "retired memory is unreachable",
    );
    assert.ok(result.candidates.some((c) => c.nodeId === 2));
  });
});

test("retrieval caps candidates by units and chars", async () => {
  await withClaimedDb(async (db, runId) => {
    for (let i = 0; i < 20; i++) {
      createMemory(db, runId, `s${i}`, `shared topic memory number ${i}`);
    }
    const result = await findMemoryCandidates(db, "shared topic", {
      modelId: "test/minilm",
      embed: aliasEmbed,
      maxUnits: 10,
      maxChars: 100_000,
    });
    assert.equal(result.candidates.length, 10);
  });
});

test("the char cap skips an over-budget candidate instead of dropping the tail", async () => {
  await withClaimedDb(async (db, runId) => {
    // A large memory that alone exceeds the char cap, followed by smaller
    // ones that fit: recall-tuned retrieval must surface the tail, not drop
    // everything after the first over-budget candidate.
    // 400 chars is the memory ceiling, so the char cap must bind below it:
    // the 400-char memory alone exceeds maxChars and is skipped, while the
    // fitting tail still surfaces.
    createMemory(
      db,
      runId,
      "big",
      `shared topic big memory ${"x".repeat(376)}`,
    );
    for (let i = 0; i < 5; i++) {
      createMemory(db, runId, `small-${i}`, `shared topic small memory ${i}`);
    }
    const result = await findMemoryCandidates(db, "shared topic", {
      modelId: "test/minilm",
      embed: aliasEmbed,
      maxUnits: 10,
      maxChars: 300,
    });
    const ids = result.candidates.map((c) => c.nodeId).sort((a, b) => a - b);
    assert.deepEqual(
      ids,
      [2, 3, 4, 5, 6],
      "the over-budget candidate is skipped; the fitting tail still surfaces",
    );
  });
});
