# AGENTS.md

Guidance for autonomous work in this repository. pi-dream is a pi package (extension) that extracts durable user preferences and workspace facts from completed pi sessions into an auditable SQLite graph and injects a visible first-turn briefing.

## Setup and validation

- Requires **Node >= 24** (native `node:sqlite` and type-stripping). `engines` enforces this; on older Node everything fails, so do not debug further.
- No build step: pi loads the TypeScript entrypoint (`index.ts`) directly. `npm run typecheck` is the static gate.
- Run the full gate with `npm run check` (typecheck + lint + format:check + tests). All fast (~10s) and fully offline — no model calls in tests or evals.
- Scoped fast loop for a small change: `node --test <file>` runs a single `.ts` test file directly (Node 24 type-stripping), typically <1s. Test discovery is automatic across `shared/`, `parent/`, `child/`.
- `npm run eval:dream` and `npm run eval:recall` are offline corpus reports (exit 0, print summaries, no pass/fail) — not a validation gate.
- Tooling: `npm run lint` (ESLint + typescript-eslint), `npm run format` (Prettier, config in `.prettierrc.json`). Formatting is CI-enforced; run `npm run format` before committing.

## Architecture

- `index.ts` — extension entrypoint wiring hooks, commands, tools.
- `parent/` — in-session side: briefing, cadence, `/memory` command, dream launcher, session lifecycle, agent tools.
- `child/` — detached dreamer (`--no-session` pi child, no prompt or tools): entry, finalize.
- `shared/` — pure logic: config, database, graph, search index, embeddings, recall planner, mining driver, workspace id, pi-process invocation.
- Domain vocabulary lives in `CONTEXT.md` (Memory, Memory version, Retrieval, Payload, Synthesizer, Briefing, Citation event, Ingestion, Dream, Dreamer, Workspace id, Source session). Use these terms exactly.

## Constraints to preserve

- Never mutate `AGENTS.md`, inject hidden system-prompt memory, or physically delete history on forget (soft retirement only). See "Out of vocabulary" in `CONTEXT.md`.
- Config is fail-closed: unknown keys in `config.json` disable memory until repaired. When changing `MemoryWorkspaceConfig`, update `parseMemoryWorkspaceConfig`'s allowed-key set and the README schema table together.
- Per-workspace data lives under `~/.pi/agent/dream/<workspaceId>/` (memory.db, config.json). Tests override roots via `PI_DREAM_STORAGE_ROOT` / `PI_DREAM_SESSIONS_ROOT`.
- SQLite writes use the shared transaction patterns in `shared/`; don't bypass `memory-database.ts` helpers.
