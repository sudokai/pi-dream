/**
 * Stable pi child process invocation helpers for detached learners.
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

export const MEMORY_LEARNER_TASK =
  "Run one workspace memory learning pass for the sessions in the run manifest.";

export const MEMORY_LEARNER_CHILD_TOOLS = [
  "memory_list_sessions",
  "memory_read_session",
  "memory_inspect_graph",
  "memory_commit_session",
] as const;

export interface BuildMemoryLearnerSpawnInput {
  cwd: string;
  workspaceId: string;
  dbPath: string;
  manifestPath: string;
  runId: string;
  learningModel: string;
  learningThinking?: string;
}

/**
 * Build argv/env for a detached learner child.
 * `--no-session` is load-bearing so the learner cannot mine itself.
 */
export function buildMemoryLearnerSpawnArgs(
  input: BuildMemoryLearnerSpawnInput,
): { args: string[]; env: Record<string, string> } {
  const childEntry = memoryExtensionPath("child", "memory-learning-entry.ts");
  const learnerPrompt = memoryExtensionPath("prompts", "memory-learner.md");

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--append-system-prompt",
    learnerPrompt,
    "-e",
    childEntry,
    "--tools",
    MEMORY_LEARNER_CHILD_TOOLS.join(","),
    "--model",
    input.learningModel,
  ];
  if (input.learningThinking) {
    args.push("--thinking", input.learningThinking);
  }
  args.push(MEMORY_LEARNER_TASK);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_DREAM_CHILD: "1",
    PI_DREAM_CWD: input.cwd,
    PI_DREAM_WORKSPACE_ID: input.workspaceId,
    PI_DREAM_DB: input.dbPath,
    PI_DREAM_MANIFEST: input.manifestPath,
    PI_DREAM_RUN_ID: input.runId,
  };

  return { args, env };
}
