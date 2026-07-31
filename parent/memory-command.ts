/**
 * /memory command: status, list, open, learn, pause, resume, forget.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  defaultMemoryWorkspaceConfig,
  setMemoryWorkspaceEnabled,
  type MemoryWorkspaceConfig,
} from "../shared/memory-config.ts";
import {
  countMemoryNodesByState,
  getMemoryActivityGeneration,
  listAllMemories,
  listAllSummaries,
  openMemoryNodeExact,
  retireMemoryNode,
} from "../shared/memory-graph.ts";
import { getMemoryWorkspaceState } from "../shared/memory-repository.ts";
import {
  activeMemoryRunId,
  listUnreportedMemoryRuns,
} from "../shared/memory-run-claim.ts";
import { memoryEmbeddingStatus } from "../shared/memory-embedding.ts";
import {
  memoryWorkspaceConfigPath,
  memoryWorkspaceDbPath,
} from "../shared/memory-workspace-id.ts";
import { MEMORY_AUDIT_CUSTOM_TYPE } from "../shared/memory-types.ts";
import { formatSessionModelId } from "../shared/memory-model.ts";
import { launchMemoryLearningRun } from "./memory-learning-launcher.ts";
import type { MemoryModelRegistryLike } from "../shared/memory-model.ts";

export const MEMORY_COMMAND_USAGE =
  "Usage: /memory [status|list [query]|open <id> [cursor=<n>]|learn|pause|resume|forget <id>]";

export const MEMORY_COMMAND_ARG_CHOICES = [
  "status",
  "list",
  "open",
  "learn",
  "pause",
  "resume",
  "forget",
] as const;

export type MemoryCommandAction =
  | { action: "status" }
  | { action: "list"; query: string }
  | { action: "open"; id: string; cursor?: string }
  | { action: "learn" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "forget"; id: string }
  | { action: "error"; message: string };

/** Parse /memory arguments. */
export function parseMemoryCommandArgs(args: string): MemoryCommandAction {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status" };
  const parts = trimmed.split(/\s+/);
  const head = parts[0]!.toLowerCase();
  if (head === "status" || head === "show") return { action: "status" };
  if (head === "list") {
    return { action: "list", query: parts.slice(1).join(" ") };
  }
  if (head === "open") {
    if (!parts[1]) {
      return {
        action: "error",
        message: `open requires an id. ${MEMORY_COMMAND_USAGE}`,
      };
    }
    const id = parts[1];
    let cursor: string | undefined;
    for (const arg of parts.slice(2)) {
      if (arg.startsWith("cursor=")) {
        const value = arg.slice("cursor=".length);
        if (!/^\d+$/.test(value)) {
          return {
            action: "error",
            message: `Invalid cursor "${arg}"; expected cursor=<page offset>. ${MEMORY_COMMAND_USAGE}`,
          };
        }
        cursor = value;
      } else {
        return {
          action: "error",
          message: `Unknown open argument: ${arg}. ${MEMORY_COMMAND_USAGE}`,
        };
      }
    }
    return cursor === undefined
      ? { action: "open", id }
      : { action: "open", id, cursor };
  }
  if (head === "learn") return { action: "learn" };
  if (head === "pause") return { action: "pause" };
  if (head === "resume") return { action: "resume" };
  if (head === "forget") {
    if (!parts[1]) {
      return {
        action: "error",
        message: `forget requires an id. ${MEMORY_COMMAND_USAGE}`,
      };
    }
    return { action: "forget", id: parts[1] };
  }
  return {
    action: "error",
    message: `Unknown argument: ${trimmed}. ${MEMORY_COMMAND_USAGE}`,
  };
}

/** Completions for /memory args. */
export function getMemoryCommandArgumentCompletions(
  argumentPrefix: string,
): Array<{ value: string; label: string }> | null {
  const withoutLeading = argumentPrefix.replace(/^[ \t]+/, "");
  if (/[ \t]/.test(withoutLeading)) return null;
  const prefix = withoutLeading.toLowerCase();
  const filtered = MEMORY_COMMAND_ARG_CHOICES.filter((c) =>
    c.startsWith(prefix),
  );
  if (filtered.length === 0) return null;
  return filtered.map((value) => ({ value, label: value }));
}

function formatStatus(input: {
  workspaceId: string;
  dbPath: string;
  config: MemoryWorkspaceConfig;
  sessionModelId?: string;
  db: DatabaseSync;
}): string {
  const counts = countMemoryNodesByState(input.db);
  const state = getMemoryWorkspaceState(input.db);
  const emb = memoryEmbeddingStatus();
  const activeRun = activeMemoryRunId(input.db);
  const lastRuns = listUnreportedMemoryRuns(input.db);
  const lines = [
    "Memory status",
    "─────────────",
    `workspace id:     ${input.workspaceId}`,
    `database:         ${input.dbPath}`,
    `config:           ${memoryWorkspaceConfigPath(input.workspaceId)}`,
    `enabled:          ${input.config.enabled ? "yes" : "no (paused)"}`,
    `learning model:   ${input.config.learningModel ?? `(session: ${input.sessionModelId ?? "unset"})`}`,
    `recall model:     ${input.config.recallModel ?? `(session: ${input.sessionModelId ?? "unset"})`}`,
    `activity gen:     ${getMemoryActivityGeneration(input.db)}`,
    `cadence turns:    ${state.turnsSinceLastRun} (min ${input.config.minTurns})`,
    `last success ms:  ${state.lastSuccessfulRunAtMs || "never"}`,
    `memories:         active=${counts.memories.active} conflicted=${counts.memories.conflicted} superseded=${counts.memories.superseded} retired=${counts.memories.retired}`,
    `summaries:        active=${counts.summaries.active} retired=${counts.summaries.retired}`,
    `observations:     ${counts.observations}`,
    `semantic index:   ${emb.available ? "ready" : `degraded${emb.error ? ` (${emb.error})` : ""}`}`,
    `active run:       ${activeRun ?? "none"}`,
    `unreported runs:  ${lastRuns.length}`,
  ];
  return lines.join("\n");
}

function formatList(db: DatabaseSync, query: string): string {
  const q = query.trim().toLowerCase();
  const memories = listAllMemories(db);
  const summaries = listAllSummaries(db);
  const lines: string[] = ["# Memory list", ""];
  const match = (text: string, id: string) =>
    !q || text.toLowerCase().includes(q) || id.toLowerCase().includes(q);

  lines.push("## Memories");
  for (const m of memories) {
    const id = `M:${m.id}`;
    if (!match(m.text, id)) continue;
    lines.push(
      `- **${id}** [${m.state}/${m.kind}] (r=${m.recurrence}): ${m.text}`,
    );
  }
  lines.push("", "## Summaries");
  for (const s of summaries) {
    const id = `S:${s.id}`;
    if (!match(s.text, id)) continue;
    lines.push(`- **${id}** [${s.state}]: ${s.text}`);
  }
  return lines.join("\n");
}

export interface MemoryCommandContext {
  getDb: () => DatabaseSync | null;
  getWorkspaceId: () => string | null;
  getConfig: () => MemoryWorkspaceConfig;
  reloadConfig: () => MemoryWorkspaceConfig;
  getModelRegistry: () => MemoryModelRegistryLike;
  getSessionModel: () => { provider?: string; id?: string } | null | undefined;
  getCwd: () => string;
  launchLearning?: typeof launchMemoryLearningRun;
}

/**
 * Register the /memory command.
 */
export function registerMemoryCommand(
  pi: ExtensionAPI,
  ctx: MemoryCommandContext,
): void {
  pi.registerCommand("memory", {
    description:
      "Workspace memory: status, list, open, learn, pause, resume, forget",
    getArgumentCompletions: (prefix: string) =>
      getMemoryCommandArgumentCompletions(prefix),
    handler: async (args, cmdCtx: ExtensionCommandContext) => {
      const parsed = parseMemoryCommandArgs(args);
      if (parsed.action === "error") {
        cmdCtx.ui.notify(parsed.message, "warning");
        return;
      }

      const workspaceId = ctx.getWorkspaceId();
      const db = ctx.getDb();
      if (!workspaceId || !db) {
        cmdCtx.ui.notify(
          "Memory is not initialized for this session yet.",
          "warning",
        );
        return;
      }

      try {
        if (parsed.action === "status") {
          const config = ctx.getConfig();
          const text = formatStatus({
            workspaceId,
            dbPath: memoryWorkspaceDbPath(workspaceId),
            config,
            sessionModelId: formatSessionModelId(ctx.getSessionModel()),
            db,
          });
          cmdCtx.ui.notify(text, "info");
          return;
        }

        if (parsed.action === "list") {
          const text = formatList(db, parsed.query);
          // Audit entry: TUI-only when supported; also notify for non-TUI.
          try {
            pi.appendEntry(MEMORY_AUDIT_CUSTOM_TYPE, {
              kind: "list",
              text,
            });
          } catch {
            // appendEntry is optional outside interactive TUI sessions.
          }
          cmdCtx.ui.notify(text, "info");
          return;
        }

        if (parsed.action === "open") {
          const result = openMemoryNodeExact(db, parsed.id, {
            cursor: parsed.cursor,
          });
          const lines = [
            `# ${result.target.prefixedId}`,
            `type: ${result.target.nodeType}`,
            result.target.state ? `state: ${result.target.state}` : "",
            `text: ${result.target.text}`,
            "",
            ...result.children.map((c) => `child ${c.prefixedId}: ${c.text}`),
            ...result.lateral.map(
              (l) => `link ${l.relation} ${l.direction} ${l.prefixedId}`,
            ),
          ].filter(Boolean);
          if (result.versions && result.versions.length > 1) {
            lines.push("", "## Version history");
            for (const v of result.versions) {
              lines.push(`- v${v.id} (${v.createdAt}): ${v.text}`);
            }
          }
          if (result.continuationCursor) {
            lines.push(
              "",
              `More children available: /memory open ${parsed.id} cursor=${result.continuationCursor}`,
            );
          }
          const text = lines.join("\n");
          try {
            pi.appendEntry(MEMORY_AUDIT_CUSTOM_TYPE, {
              kind: "open",
              id: parsed.id,
              cursor: parsed.cursor,
              text,
            });
          } catch {
            // appendEntry is optional outside interactive TUI sessions.
          }
          cmdCtx.ui.notify(text, "info");
          return;
        }

        if (parsed.action === "pause") {
          setMemoryWorkspaceEnabled(workspaceId, false);
          ctx.reloadConfig();
          cmdCtx.ui.notify(
            "Automatic memory learning paused for this workspace.",
            "info",
          );
          return;
        }

        if (parsed.action === "resume") {
          setMemoryWorkspaceEnabled(workspaceId, true);
          ctx.reloadConfig();
          cmdCtx.ui.notify(
            "Automatic memory learning resumed for this workspace.",
            "info",
          );
          return;
        }

        if (parsed.action === "forget") {
          retireMemoryNode(db, parsed.id);
          cmdCtx.ui.notify(
            `Forgot ${parsed.id} (soft-retired; history preserved).`,
            "info",
          );
          return;
        }

        if (parsed.action === "learn") {
          const config = ctx.getConfig();
          const launch = ctx.launchLearning ?? launchMemoryLearningRun;
          const result = launch({
            db,
            cwd: ctx.getCwd(),
            workspaceId,
            config,
            trigger: "manual",
            modelRegistry: ctx.getModelRegistry(),
            currentSessionModel: ctx.getSessionModel(),
          });
          if (!result.ok) {
            cmdCtx.ui.notify(`Memory learn: ${result.reason}`, "warning");
            return;
          }
          cmdCtx.ui.notify(
            `Memory learning started (run ${result.runId}, ${result.sessionCount} session(s)).`,
            "info",
          );
          return;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        cmdCtx.ui.notify(`Memory command failed: ${detail}`, "error");
      }
    },
  });
}

/** Build status text for tests without UI. */
export function buildMemoryStatusText(input: {
  workspaceId: string;
  db: DatabaseSync;
  config?: MemoryWorkspaceConfig;
  sessionModelId?: string;
}): string {
  return formatStatus({
    workspaceId: input.workspaceId,
    dbPath: memoryWorkspaceDbPath(input.workspaceId),
    config: input.config ?? defaultMemoryWorkspaceConfig(),
    sessionModelId: input.sessionModelId,
    db: input.db,
  });
}
