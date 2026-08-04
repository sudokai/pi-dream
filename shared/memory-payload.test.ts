import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
} from "./memory-database.ts";
import {
  buildMemorySynthesisPayload,
  renderMemoryPayloadUnit,
} from "./memory-payload.ts";
import type { MemoryRetrievalCandidate } from "./memory-retrieval.ts";
import { findMemoryCandidates } from "./memory-retrieval.ts";
import {
  MEMORY_SYNTHESIS_INPUT_CHARS,
  MEMORY_SYNTHESIS_INPUT_MAX_UNITS,
  normalizeMemoryBodyText,
} from "./memory-types.ts";

function candidate(
  nodeId: number,
  text: string,
  score: number = 1,
): MemoryRetrievalCandidate {
  return {
    nodeType: "memory",
    nodeId,
    prefixedId: `M:${nodeId}`,
    kind: "fact",
    state: "active",
    text,
    recurrence: 1,
    score,
    lexicalRank: null,
    semanticRank: null,
    semanticScore: null,
  };
}

test("whole-unit accumulation never splits text and respects the char budget", () => {
  const candidates = [
    candidate(1, "a".repeat(100), 10),
    candidate(2, "b".repeat(100), 9),
    candidate(3, "c".repeat(100), 8),
  ];
  // Budget in RENDERED chars (the line each unit renders to includes the
  // id/kind prefix), so the guarantee describes the real prompt size.
  const lineOf = (nodeId: number, text: string): number =>
    renderMemoryPayloadUnit({
      nodeType: "memory",
      nodeId,
      prefixedId: `M:${nodeId}`,
      kind: "fact",
      state: "active",
      text,
      recurrence: 1,
      score: 0,
    }).length;
  const line = lineOf(1, "a".repeat(100));
  const payload = buildMemorySynthesisPayload(candidates, {
    maxChars: line * 2 + 1,
  });
  assert.equal(payload.units.length, 2, "third unit would exceed the budget");
  assert.ok(payload.totalChars <= line * 2 + 1);
  assert.equal(
    payload.totalChars,
    line * 2,
    "accounting covers the rendered lines",
  );
  assert.equal(payload.text.includes("a".repeat(100)), true);
  assert.equal(payload.text.includes("b".repeat(100)), true);
  assert.equal(payload.text.includes("c".repeat(100)), false);
  assert.equal(payload.truncated, true);
  assert.equal(payload.retrievedChars, line * 3);
  // Fused-rank order is preserved (strict prefix).
  assert.deepEqual(
    payload.units.map((u) => u.nodeId),
    [1, 2],
  );
});

test("the unit sanity cap bounds the payload", () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    candidate(i + 1, `memory ${i}`),
  );
  const payload = buildMemorySynthesisPayload(candidates, { maxUnits: 4 });
  assert.equal(payload.units.length, 4);
  assert.equal(payload.truncated, true);
});

test("an over-budget candidate set logs the Phase 2 trigger with the observed char count", () => {
  const candidates = Array.from({ length: 50 }, (_, i) =>
    candidate(i + 1, "x".repeat(1000)),
  );
  const events: Array<Record<string, unknown>> = [];
  const payload = buildMemorySynthesisPayload(candidates, {
    maxChars: 10_000,
    maxUnits: 40,
    log: (entry) => events.push(entry),
  });
  assert.equal(payload.truncated, true);
  assert.ok(payload.retrievedChars > 50_000, "rendered lines exceed raw text");
  assert.ok(payload.totalChars <= 10_000);
  const trigger = events.find((e) => e.event === "phase2_trigger");
  assert.ok(trigger, "the Phase 2 trigger must be logged");
  assert.equal(trigger!.retrievedChars, payload.retrievedChars);
  assert.equal(trigger!.retrievedUnits, 50);
  assert.equal(trigger!.inputCapChars, 10_000);
});

test("defaults: payload fits MEMORY_SYNTHESIS_INPUT_CHARS and the unit cap", () => {
  // 2,000 active memories at ~200 chars: retrieval caps at 600 units, and the
  // payload must land inside both caps with no mid-text truncation.
  const candidates = Array.from({ length: 600 }, (_, i) =>
    candidate(i + 1, `shared topic memory number ${i} ${"x".repeat(180)}`),
  );
  const events: Array<Record<string, unknown>> = [];
  const payload = buildMemorySynthesisPayload(candidates, {
    log: (entry) => events.push(entry),
  });
  assert.ok(payload.totalChars <= MEMORY_SYNTHESIS_INPUT_CHARS);
  assert.ok(payload.units.length <= MEMORY_SYNTHESIS_INPUT_MAX_UNITS);
  for (const unit of payload.units) {
    // Whole units only: every unit text appears verbatim in the payload.
    assert.ok(payload.text.includes(unit.text), "never split mid-text");
  }
  const trigger = events.find((e) => e.event === "phase2_trigger");
  assert.ok(trigger, "the Phase 2 trigger is logged with the observed chars");
  assert.equal(trigger!.retrievedChars, payload.retrievedChars);
});

test("an under-budget candidate set is not truncated and logs nothing", () => {
  const candidates = [
    candidate(1, "short memory one"),
    candidate(2, "short memory two"),
  ];
  const events: Array<Record<string, unknown>> = [];
  const payload = buildMemorySynthesisPayload(candidates, {
    log: (entry) => events.push(entry),
  });
  assert.equal(payload.truncated, false);
  assert.equal(payload.units.length, 2);
  assert.equal(events.length, 0, "no trigger when the set fits");
});

test("a store seeded with 2,000 active memories yields a bounded, unsplit payload and the Phase 2 trigger", async () => {
  const db = openMemoryDatabaseAtPath(":memory:");
  try {
    // Seed 2,000 active memories directly (fast; the repository path is
    // covered elsewhere) with every projection row maintained.
    const insertMemory = db.prepare(
      `INSERT INTO memories
         (kind, state, current_version_id, normalized_text, creation_generation)
       VALUES ('fact', 'active', NULL, ?, 0)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO memory_versions
         (memory_id, text, evidence_text, source_session_id, creation_generation)
       VALUES (?, ?, ?, ?, 0)`,
    );
    const insertDoc = db.prepare(
      `INSERT INTO search_documents (node_type, node_id, text, kind, state, updated_at)
       VALUES ('memory', ?, ?, 'fact', 'active', datetime('now'))`,
    );
    const insertFts = db.prepare(
      `INSERT INTO memory_fts (rowid, text) VALUES (?, ?)`,
    );
    db.exec("BEGIN");
    try {
      for (let i = 1; i <= 2000; i++) {
        const text = `shared topic memory number ${i} ${i % 2 === 0 ? "prefer" : "avoid"} pattern ${i % 100}`;
        // The v6 shape requires the normalized-text projection; the
        // partial unique index rejects two active memories sharing it.
        const mem = insertMemory.run(normalizeMemoryBodyText(text));
        const id = Number(mem.lastInsertRowid);
        const ver = insertVersion.run(id, text, text, "seed-session");
        db.prepare(
          `UPDATE memories SET current_version_id = ? WHERE id = ?`,
        ).run(Number(ver.lastInsertRowid), id);
        insertDoc.run(id, text);
        insertFts.run(id, text);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const events: Array<Record<string, unknown>> = [];
    const retrieval = await findMemoryCandidates(db, "shared topic pattern", {
      embed: null, // lexical-only; semantic indexing is not needed at this scale
    });
    assert.equal(
      retrieval.candidates.length,
      600,
      "retrieval caps at max units",
    );
    const payload = buildMemorySynthesisPayload(retrieval.candidates, {
      log: (entry) => events.push(entry),
    });
    assert.ok(payload.totalChars <= MEMORY_SYNTHESIS_INPUT_CHARS);
    assert.ok(payload.units.length <= MEMORY_SYNTHESIS_INPUT_MAX_UNITS);
    for (const unit of payload.units) {
      assert.ok(
        payload.text.includes(unit.text),
        "no memory text is truncated mid-string",
      );
    }
    const trigger = events.find((e) => e.event === "phase2_trigger");
    assert.ok(
      trigger,
      "the Phase 2 trigger is logged with the observed char count",
    );
    assert.equal(trigger!.retrievedChars, payload.retrievedChars);
    assert.equal(typeof trigger!.retrievedChars, "number");
  } finally {
    closeMemoryDatabase(db);
  }
});

test("renderMemoryPayloadUnit renders id, kind, state, recurrence, and full text", () => {
  const unit = {
    nodeType: "memory" as const,
    nodeId: 7,
    prefixedId: "M:7" as const,
    kind: "preference" as const,
    state: "active" as const,
    text: "Do not use emoji in commits",
    recurrence: 3,
    score: 0.5,
  };
  assert.equal(
    renderMemoryPayloadUnit(unit),
    "- M:7 (preference, r=3): Do not use emoji in commits",
  );
});
