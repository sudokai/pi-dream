/** Load the briefing planner system prompt; undefined → caller uses its default. */
import { readFileSync } from "node:fs";
import { memoryExtensionPath } from "./pi-process-invocation.ts";

export function loadBriefingPlannerPrompt(): string | undefined {
  try {
    return readFileSync(
      memoryExtensionPath("prompts", "memory-briefing-planner.md"),
      "utf-8",
    );
  } catch {
    return undefined;
  }
}
