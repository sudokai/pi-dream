/** Load a prompt file from the package prompts directory; undefined when missing. */
import { readFileSync } from "node:fs";
import { memoryExtensionPath } from "./pi-process-invocation.ts";

export function loadMemoryPromptFile(name: string): string | undefined {
  try {
    return readFileSync(memoryExtensionPath("prompts", name), "utf-8");
  } catch {
    return undefined;
  }
}

/** System prompt for the first-turn briefing synthesis call. */
export function loadMemoryBriefingPrompt(): string | undefined {
  return loadMemoryPromptFile("memory-briefing.md");
}

/** System prompt for the memory_search synthesis call. */
export function loadMemorySearchPrompt(): string | undefined {
  return loadMemoryPromptFile("memory-search.md");
}
