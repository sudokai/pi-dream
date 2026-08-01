#!/usr/bin/env node
/**
 * Offline report for eval/memory-dream-corpus.json.
 * Prints include/exclude expectations for dreamer quality review.
 *
 * Live model scoring is not part of this script. Use the corpus as a fixture
 * when exercising the detached dreamer against a configured model.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(
  readFileSync(join(root, "eval", "memory-dream-corpus.json"), "utf-8"),
);

const include = corpus.cases.filter((c) => c.shouldExtract);
const exclude = corpus.cases.filter((c) => !c.shouldExtract);

console.log("Memory dream corpus");
console.log("======================");
console.log(`cases: ${corpus.cases.length}`);
console.log(`should extract: ${include.length}`);
console.log(`should reject:  ${exclude.length}`);
console.log("");
console.log("Include themes:");
for (const c of include) {
  console.log(`  - ${c.id}: ${c.expectedTheme ?? c.kind}`);
}
console.log("");
console.log("Exclude reasons:");
for (const c of exclude) {
  console.log(`  - ${c.id}: ${c.reason}`);
}
