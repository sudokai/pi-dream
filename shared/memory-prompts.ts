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

export function loadMemorySynthesizerPrompt(): string | undefined {
  return loadMemoryPromptFile("memory-synthesizer.md");
}
