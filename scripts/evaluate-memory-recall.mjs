#!/usr/bin/env node
/**
 * Offline report for eval/memory-recall-corpus.json.
 * Prints queries and expected selected IDs for recall quality review.
 *
 * Live model scoring is not part of this script. Use the corpus as a fixture
 * when exercising hybrid search and the briefing planner against a configured model.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  readFileSync(join(root, "eval", "memory-recall-corpus.json"), "utf-8"),
);

console.log("Memory recall corpus");
console.log("====================");
console.log(`cases: ${corpus.cases.length}`);
for (const c of corpus.cases) {
  const expected = c.expectSelected
    ? c.expectSelected.join(", ") || "(none)"
    : c.preferSummary
      ? "prefer summary"
      : "?";
  console.log(`- ${c.id}: query=${JSON.stringify(c.query)} expect=${expected}`);
}
