#!/usr/bin/env node
/**
 * Offline report for eval/memory-recall-corpus.json.
 * Prints retrieval and one-call synthesizer scenarios for recall quality review.
 *
 * Live model scoring is not part of this script. Use the corpus as a fixture
 * when exercising retrieval, the payload builder, and the synthesizer against
 * a configured model. Exit code is always 0 — the unit tests in
 * shared/memory-retrieval.test.ts, shared/memory-payload.test.ts, and
 * shared/memory-synthesizer.test.ts are the real gate.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  readFileSync(join(root, "eval", "memory-recall-corpus.json"), "utf-8"),
);

console.log("Memory recall corpus (retrieval + one-call synthesizer)");
console.log("========================================================");
console.log(`cases: ${corpus.cases.length}`);
for (const c of corpus.cases) {
  const line = [`- ${c.id}: ${c.scenario ?? "?"}`];
  if (c.expectSources) {
    line.push(`sources=${c.expectSources.join(", ") || "(none)"}`);
  }
  if (c.expect) line.push(`expect=${c.expect}`);
  if (c.notes) line.push(`notes: ${c.notes}`);
  console.log(line.join(" "));
}
