/**
 * pi-dream — adaptive workspace memory extension.
 *
 * Parent: first-turn visible briefing, memory_search/memory_open, /memory,
 * agent_settled cadence, detached dreamer launch.
 * Child (PI_DREAM_CHILD=1): no-op here; child uses memory-dream-entry.ts.
 */

import {
  BorderedLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemoryDatabase,
  openMemoryDatabase,
} from "./shared/memory-database.ts";
import {
  defaultMemoryWorkspaceConfig,
  disabledMemoryWorkspaceConfig,
  loadMemoryConfigForWorkspace,
  type MemoryWorkspaceConfig,
} from "./shared/memory-config.ts";
import {
  ensureMemoryWorkspaceDataDir,
  resolveMemoryWorkspaceId,
} from "./shared/memory-workspace-id.ts";
import {
  MEMORY_AUDIT_CUSTOM_TYPE,
  MEMORY_BRIEFING_CUSTOM_TYPE,
  MEMORY_CHILD_ENV,
} from "./shared/memory-types.ts";
import {
  buildMemorySessionBriefing,
  createMemoryBriefingSignal,
  type BuildMemoryBriefingResult,
} from "./parent/memory-briefing.ts";
import { evaluateMemoryDreamCadence } from "./parent/memory-cadence.ts";
import { launchMemoryDreamRun } from "./parent/memory-dream-launcher.ts";
import { registerMemoryAgentTools } from "./parent/memory-tools.ts";
import { registerMemoryCommand } from "./parent/memory-command.ts";
import { listMemoryTreeRoots } from "./shared/memory-tree.ts";
import { consumeMemoryRunNotification } from "./parent/memory-session-lifecycle.ts";

interface PinnedMemorySession {
  workspaceId: string;
  cwd: string;
  db: DatabaseSync;
  config: MemoryWorkspaceConfig;
  briefingDone: boolean;
  /** Current session model registry (updated on agent lifecycle events). */
  modelRegistry: unknown;
  model: unknown;
  getSessionId: () => string | null | undefined;
}

function isMemoryChildProcess(): boolean {
  return process.env[MEMORY_CHILD_ENV] === "1";
}

export default function piDreamExtension(pi: ExtensionAPI) {
  if (isMemoryChildProcess()) {
    return;
  }

  let pinned: PinnedMemorySession | null = null;

  const reloadConfig = (): MemoryWorkspaceConfig => {
    if (!pinned) return defaultMemoryWorkspaceConfig();
    const loaded = loadMemoryConfigForWorkspace(pinned.workspaceId);
    if (loaded.ok) {
      pinned.config = loaded.config;
      return pinned.config;
    }
    // Unreadable config must fail closed (same as session_start), not re-enable.
    pinned.config = disabledMemoryWorkspaceConfig();
    return pinned.config;
  };

  pi.registerMessageRenderer(
    MEMORY_BRIEFING_CUSTOM_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const header = theme.fg("accent", "memory briefing");
      let text = `${header}\n${message.content}`;
      if (expanded && message.details) {
        text += `\n${theme.fg("dim", JSON.stringify(message.details))}`;
      }
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    },
  );

  pi.registerMessageRenderer(
    MEMORY_AUDIT_CUSTOM_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const header = theme.fg("accent", "memory audit");
      let text = `${header}\n${message.content}`;
      if (expanded && message.details) {
        text += `\n${theme.fg("dim", JSON.stringify(message.details))}`;
      }
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    },
  );

  registerMemoryAgentTools(pi, {
    getDb: () => {
      if (!pinned) throw new Error("Memory database not ready");
      return pinned.db;
    },
    getConfig: () => pinned?.config ?? defaultMemoryWorkspaceConfig(),
    getModelRegistry: () => {
      if (!pinned) throw new Error("Memory session not ready");
      return pinned.modelRegistry as never;
    },
    getSessionModel: () => (pinned?.model as never) ?? null,
    getPiSessionId: () => pinned?.getSessionId() ?? null,
  });

  registerMemoryCommand(pi, {
    getDb: () => pinned?.db ?? null,
    getWorkspaceId: () => pinned?.workspaceId ?? null,
    getConfig: () => pinned?.config ?? defaultMemoryWorkspaceConfig(),
    reloadConfig,
    getModelRegistry: () => {
      if (!pinned) throw new Error("Memory session not ready");
      return pinned.modelRegistry as never;
    },
    getSessionModel: () => (pinned?.model as never) ?? null,
    getCwd: () => pinned?.cwd ?? process.cwd(),
  });

  pi.on("session_start", async (_event, ctx) => {
    let openedDb: DatabaseSync | null = null;
    try {
      if (pinned?.db) {
        closeMemoryDatabase(pinned.db);
      }

      const cwd = ctx.cwd;
      const workspaceId = resolveMemoryWorkspaceId(cwd);
      ensureMemoryWorkspaceDataDir(workspaceId);
      const db = openMemoryDatabase(workspaceId);
      openedDb = db;
      const loaded = loadMemoryConfigForWorkspace(workspaceId);
      const config = loaded.ok
        ? loaded.config
        : disabledMemoryWorkspaceConfig();
      if (loaded.ok && loaded.invalidFallback) {
        ctx.ui.notify(
          loaded.disabledReason ??
            "Memory config invalid; memory is disabled until repaired.",
          "warning",
        );
      }
      if (!loaded.ok) {
        ctx.ui.notify(`Memory config error: ${loaded.error}`, "warning");
      }

      pinned = {
        workspaceId,
        cwd,
        db,
        config,
        briefingDone: false,
        modelRegistry: ctx.modelRegistry,
        model: ctx.model,
        getSessionId: () => ctx.sessionManager.getSessionId(),
      };

      const notice = consumeMemoryRunNotification(db);
      if (notice) {
        ctx.ui.notify(notice.message, notice.level);
      }
      openedDb = null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Memory init failed: ${detail}`, "warning");
      if (openedDb) {
        closeMemoryDatabase(openedDb);
      }
      pinned = null;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!pinned) return;

    pinned.modelRegistry = ctx.modelRegistry;
    pinned.model = ctx.model;

    try {
      const notice = consumeMemoryRunNotification(pinned.db);
      if (notice) ctx.ui.notify(notice.message, notice.level);
    } catch (err) {
      // Notification failures must not block the agent turn, but must surface.
      const detail = err instanceof Error ? err.message : String(err);
      try {
        ctx.ui.notify(`Memory run notification error: ${detail}`, "warning");
      } catch {
        // UI may be unavailable.
      }
    }

    if (pinned.briefingDone) return;
    pinned.briefingDone = true;

    if (!pinned.config.enabled) return;

    // Shared handling for a settled briefing: surface the message, or record
    // the audit entry for silent skips (top-layer over budget, synthesizer
    // failure). Never show raw tree content.
    const handleBriefingResult = (result: BuildMemoryBriefingResult) => {
      if (!result.ok) {
        return { message: result.notice };
      }
      if (result.message) {
        return { message: result.message };
      }
      if (result.audit) {
        try {
          pi.appendEntry(MEMORY_AUDIT_CUSTOM_TYPE, result.audit);
        } catch {
          // appendEntry is optional outside interactive TUI sessions.
        }
      }
      return undefined;
    };

    try {
      const briefingInput = {
        db: pinned.db,
        query: event.prompt ?? "",
        config: pinned.config,
        modelRegistry: ctx.modelRegistry as never,
        currentSessionModel: ctx.model as never,
        piSessionId: ctx.sessionManager.getSessionId(),
      };

      // Empty tree: the briefing resolves instantly without a model call, so
      // skip the loader instead of flashing it.
      if (listMemoryTreeRoots(pinned.db).length === 0) {
        const result = await buildMemorySessionBriefing({
          ...briefingInput,
          signal: createMemoryBriefingSignal(ctx.signal),
        });
        return handleBriefingResult(result);
      }

      // Model-backed synthesis can take seconds, so show a cancellable loader
      // while it runs. Escape aborts the briefing, which fails closed into the
      // audit path below.
      const abort = new AbortController();
      const briefing = buildMemorySessionBriefing({
        ...briefingInput,
        // Pi 0.83 runs before_agent_start before creating the active run, so
        // ctx.signal is normally undefined here. Use its signal when a newer
        // lifecycle provides one; Escape on the loader is the only other
        // cancel — there is no time cap on the briefing.
        signal: createMemoryBriefingSignal(
          AbortSignal.any(
            ctx.signal ? [abort.signal, ctx.signal] : [abort.signal],
          ),
        ),
      });

      type MemoryBriefingVerdict =
        | { kind: "result"; result: BuildMemoryBriefingResult }
        | { kind: "error"; error: unknown };

      // Non-interactive runs resolve ui.custom with undefined without calling
      // the factory; the briefing promise still settles in the background.
      const verdict = await ctx.ui.custom<MemoryBriefingVerdict | undefined>(
        (tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            "Recalling your memories…",
          );
          loader.onAbort = () => abort.abort();
          briefing.then(
            (result) => done({ kind: "result", result }),
            (error) => done({ kind: "error", error }),
          );
          return loader;
        },
      );

      if (verdict === undefined) {
        // No loader was shown; the briefing is still running in the background.
        return handleBriefingResult(await briefing);
      }
      if (verdict.kind === "error") {
        throw verdict.error;
      }
      return handleBriefingResult(verdict.result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        pi.appendEntry(MEMORY_AUDIT_CUSTOM_TYPE, {
          status: "synthesizer_failed",
          error: detail,
        });
      } catch {
        // appendEntry is optional outside interactive TUI sessions.
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pinned) return;
    pinned.modelRegistry = ctx.modelRegistry;
    pinned.model = ctx.model;

    try {
      const notice = consumeMemoryRunNotification(pinned.db);
      if (notice) ctx.ui.notify(notice.message, notice.level);

      const loaded = loadMemoryConfigForWorkspace(pinned.workspaceId);
      if (!loaded.ok) {
        pinned.config = disabledMemoryWorkspaceConfig();
        ctx.ui.notify(`Memory config error: ${loaded.error}`, "warning");
      } else {
        pinned.config = loaded.config;
        if (loaded.invalidFallback) {
          ctx.ui.notify(
            loaded.disabledReason ??
              "Memory config invalid; memory is disabled until repaired.",
            "warning",
          );
        }
      }
      const config = pinned.config;
      const evaluation = evaluateMemoryDreamCadence(pinned.db, {
        cwd: pinned.cwd,
        workspaceId: pinned.workspaceId,
        config,
      });
      if (!evaluation.shouldDream) return;

      const launched = launchMemoryDreamRun({
        db: pinned.db,
        cwd: pinned.cwd,
        workspaceId: pinned.workspaceId,
        config,
        trigger: "auto",
        modelRegistry: ctx.modelRegistry as never,
        currentSessionModel: ctx.model as never,
      });
      if (launched.ok) {
        ctx.ui.notify(`Dream started (run ${launched.runId}).`, "info");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        ctx.ui.notify(`Memory cadence error: ${detail}`, "warning");
      } catch {
        // UI may be unavailable during shutdown.
      }
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (!pinned) return;
    pinned.modelRegistry = ctx.modelRegistry;
    pinned.model = ctx.model;
  });

  pi.on("session_shutdown", async () => {
    if (!pinned) return;
    closeMemoryDatabase(pinned.db);
    pinned = null;
  });
}
