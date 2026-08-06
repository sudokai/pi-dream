/**
 * Stable pi child process invocation helpers for detached dreamers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the package root. */
export function memoryExtensionRoot(): string {
  return ROOT;
}

/** Join segments onto the package root. */
export function memoryExtensionPath(...segments: string[]): string {
  return path.join(ROOT, ...segments);
}

/**
 * Resolve the `pi` invocation robustly (node running pi script / pi on PATH).
 * Modeled on pi's official subagent example.
 */
export function getMemoryPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export interface BuildMemoryDreamerSpawnInput {
  cwd: string;
  workspaceId: string;
  dbPath: string;
  manifestPath: string;
  runId: string;
  dreamModel: string;
  dreamThinking?: string;
  /** Local embedding model id; the child maintains the embeddings projection with it. */
  embeddingModel: string;
}

/**
 * Build argv/env for a detached dreamer child.
 * `--no-session` is load-bearing so the dreamer cannot mine itself.
 */
export function buildMemoryDreamerSpawnArgs(
  input: BuildMemoryDreamerSpawnInput,
): { args: string[]; env: Record<string, string> } {
  const childEntry = memoryExtensionPath("child", "memory-dream-entry.ts");

  // The dreamer is a deterministic batch pipeline, not an agent: no prompt,
  // no tools, no system-prompt append. The extension body runs the mining
  // driver at session_start (print mode fires session_start unconditionally,
  // even with no prompt) and shuts the process down when the pass ends.
  const args = [
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    childEntry,
    "--model",
    input.dreamModel,
  ];
  if (input.dreamThinking) {
    args.push("--thinking", input.dreamThinking);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_DREAM_CHILD: "1",
    PI_DREAM_CWD: input.cwd,
    PI_DREAM_WORKSPACE_ID: input.workspaceId,
    PI_DREAM_DB: input.dbPath,
    PI_DREAM_MANIFEST: input.manifestPath,
    PI_DREAM_RUN_ID: input.runId,
    PI_DREAM_EMBEDDING_MODEL: input.embeddingModel,
  };

  return { args, env };
}
