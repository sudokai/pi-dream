#!/usr/bin/env node
/**
 * Offline report for eval/memory-recall-corpus.json.
 * Prints tree-consolidation and synthesizer scenarios for recall quality review.
 *
 * Live model scoring is not part of this script. Use the corpus as a fixture
 * when exercising the synthesizer, the consolidation planner, and the cap
 * enforcement against a configured model. Exit code is always 0 — the unit
 * tests in shared/memory-consolidation.test.ts and shared/memory-synthesizer.test.ts
 * are the real gate.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  readFileSync(join(root, "eval", "memory-recall-corpus.json"), "utf-8"),
);

console.log("Memory recall corpus (tree + synthesizer)");
console.log("==========================================");
console.log(`cases: ${corpus.cases.length}`);
for (const c of corpus.cases) {
  const line = [`- ${c.id}: ${c.scenario ?? "?"}`];
  if (c.expectPairing) {
    line.push(`pairing=${c.expectPairing.map((p) => p.join("+")).join(" | ")}`);
  }
  if (c.expectPromoted) line.push(`promote=${c.expectPromoted.join(", ")}`);
  if (c.expectAction) line.push(`action=${c.expectAction}`);
  if (c.expectSources) {
    line.push(`sources=${c.expectSources.join(", ") || "(none)"}`);
  }
  if (c.expect) line.push(`expect=${c.expect}`);
  if (c.expectSourceEvents) {
    line.push(`events=${c.expectSourceEvents.join(", ")}`);
  }
  console.log(line.join(" "));
}
