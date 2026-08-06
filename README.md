# pi-dream

Adaptive **workspace memory** for [pi](https://pi.dev): extracts durable user preferences and workspace facts from completed sessions into an auditable SQLite store, and injects a **visible first-turn briefing** synthesized from a retrieval-fed payload.

## Install

```bash
pi install git:https://github.com/sudokai/pi-dream
# local development from a checkout:
pi install .
# or load directly:
pi -e ./index.ts
```

Requires **Node 24+** (native `node:sqlite`).

## What it does

| Surface            | Behavior                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First turn         | Retrieval (FTS5 + MiniLM, RRF-fused) feeds one synthesis call → task-relevant context + a deterministic user-preferences section, rendered as a visible `pi-dream-briefing` custom message |
| `memory_search`    | Same retrieval + one-call synthesizer: a grounded answer with sources; records citations for cited sources only                                                                            |
| `/memory`          | `status`, `list [query]`, `open <id>`, `dream`, `pause`, `resume`, `forget <id>`; `list` and `open` also append a visible `pi-dream-audit` entry                                           |
| Automatic dreaming | After ≥10 settled turns, ≥120 minutes, and advanced transcripts → detached `--no-session` dreamer mines eligible sessions                                                                  |

**Never** edits `AGENTS.md`, injects hidden system-prompt memory, or physically deletes history on forget (soft retirement only).

## How recall works: retrieval → payload → one synthesis call

- **Retrieval is recall-tuned, never precision.** Query candidates come from FTS5 over active memory text (lexical — exact tokens like `pnpm`, `Node 24`, file paths) fused with MiniLM cosine (semantic — connects "add a caching layer" to "abstractions before three call sites") via Reciprocal Rank Fusion (`Σ 1/(K + rank)`, K=60). The only exclusion is the semantic cosine floor (0.15); anything a retriever surfaces stays surfaced, and retrieval never writes or records.
- **FTS queries are built safely.** Input is tokenized to Unicode letters/digits and every term is quoted and OR-joined, so `"`, `-`, `*`, `NEAR`, `AND`, and non-ASCII input can never restructure or fail the query. Long task prompts are segmented; blank, trivially short, and greeting-only queries skip retrieval entirely.
- **An empty vector index never blocks the first turn on a MiniLM download.** Query embedding loads the embedder on the interactive first turn only when the vector index is non-empty; an unavailable embedder degrades to lexical-only retrieval.
- **The payload is bounded by whole units.** Memories accumulate in fused-rank order until the next unit would exceed the input budget (40,000 chars) or the unit cap (150) — never split mid-text. When the retrieved set exceeds the budget, the payload truncates by fused rank and logs the Phase 2 trigger with the observed char count.
- **Exactly one synthesis call does relevance.** The model judges relevance, categorizes, and writes prose over the payload, returning strict JSON (`{"content","sources"}`) with one parse retry, then fail-closed. Cited memories are revalidated after the call: an uncited memory changing mid-call is fine; a cited one changing produces no content and no citation event. Prompt ordering is memories-first, delimited-request-second, instructions-last: the request is relevance data the briefing must never execute.
- **The briefing is two sections.** Task-relevant context first (only when sources exist), then user preferences — rendered deterministically ahead of the model call and preserved on cancel or synthesis failure. Output is capped at 20,000 chars with no target length: brevity is not penalized, irrelevant memories are omitted entirely.
- **Fail-closed everywhere.** Synthesizer failures skip the task-relevant section with an audit entry (preferences still render); `memory_search` surfaces named tool errors; a recall model whose declared context cannot hold the complete request plus the output reserve fails closed **without truncating the payload**, and the condition is reported by `/memory status` and once at startup. A store on schema v5 or older is wiped and re-mined from transcripts; v6→v7 is an additive migration that preserves rows (schema v7 adds the partial-mine cursor total and the cadence failure-backoff column).

## Data layout

Per workspace (identity: canonical git origin → git common dir → real cwd):

```text
~/.pi/agent/dream/<workspaceId>/
  memory.db
  config.json
  runs/<runId>/                   # per dream; deleted on success, retained on failure
    manifest.json                 # sessions mined this run + immutable content hashes
    trace.jsonl                   # one line per mining step (diagnostic)
    child.stderr.log              # detached dreamer stderr
```

Override storage root in tests with `PI_DREAM_STORAGE_ROOT`.

## Configuration (`config.json`)

All fields are optional except `version` and `enabled`; missing optional fields use the defaults below.

```json
{
  "version": 1,
  "enabled": true,
  "dreamModel": "provider/modelId",
  "dreamThinking": "off",
  "recallModel": "provider/modelId",
  "recallThinking": "off",
  "minTurns": 10,
  "minMinutes": 120,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

| Field            | Default                   | Meaning                                                                                                                                                     |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`        | 1 (required)              | Config schema version; must be 1.                                                                                                                           |
| `enabled`        | — (required)              | Master switch; `/memory pause` and `resume` toggle it. Disabled suppresses the briefing, dreams, and `memory_search`; `/memory` inspection stays available. |
| `dreamModel`     | current session model     | Exact `provider/modelId` for the detached dreamer; omit to use the session model.                                                                           |
| `dreamThinking`  | unset (no override)       | Thinking level for the dreamer: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unset omits the override, so pi's default applies.               |
| `recallModel`    | current session model     | Exact `provider/modelId` for the synthesizer (briefing + search); omit to use the session model.                                                            |
| `recallThinking` | unset (no override)       | Thinking level for the synthesizer (same level set). Unset omits the override, so pi's default applies.                                                     |
| `minTurns`       | 10                        | Minimum settled turns before automatic dreaming.                                                                                                            |
| `minMinutes`     | 120                       | Minimum idle minutes before automatic dreaming.                                                                                                             |
| `embeddingModel` | `Xenova/all-MiniLM-L6-v2` | Local embedding model id (first use may download it). Used by retrieval and dreaming.                                                                       |

**Removed keys**: `briefingTokenBudget`, `hotHeatThreshold`, `synthesizerContextBudget`, `synthesizerAnswerBudget`, `noveltyBoost`, `noveltyGenerations`, `heatDecay`, and the earlier `hybridPoolSize`, `rrfK`, `semanticFloor`, `coldHeatThreshold`, `consolidationMergeBound`, and `synthesizerMaxSteps` no longer exist. A `config.json` containing them (or any other unknown key) fails closed — memory is disabled for the workspace until the file is repaired. Budgets are fixed constants now (payload 40,000 chars / 150 units; briefing 20,000 chars), not configuration.

**Slow recall models**: the briefing has no time cap — the loader stays up until synthesis completes or you press Escape (the user-preferences section is still shown; the attempt is audited; no citations are recorded). On slow or high-thinking session models, set `recallModel` and `recallThinking` (e.g. `"off"`) per workspace so the first turn isn't delayed by a heavyweight recall model. A recall model whose declared context window cannot hold the complete request plus the output reserve fails closed (no truncated payload); `/memory status` shows the condition.

## Environment variables

All variables are optional; defaults exist without them.

| Variable                 | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `PI_DREAM_STORAGE_ROOT`  | Override the per-workspace data root (tests use this).                              |
| `PI_DREAM_SESSIONS_ROOT` | Override the pi sessions root used for source-session discovery (tests/child only). |
| `PI_DREAM_CHILD`         | Set to `1` inside the detached dreamer child (`--no-session`, no agent loop).       |

`PI_DREAM_WORKSPACE_ID`, `PI_DREAM_RUN_ID`, `PI_DREAM_MANIFEST`, `PI_DREAM_DB`, `PI_DREAM_CWD`, and `PI_DREAM_EMBEDDING_MODEL` are internal handoff variables the launcher sets for the detached child; they are not for manual use.

## Commands

```text
/memory              # status: enabled, memory counts, citation count, active dream,
                     #   recall-capacity and semantic-index degradation failures, a failed
                     #   in-process embedder load; status --verbose adds config path,
                     #   models, cadence, workspace id, db path, activity gen, embedder state,
                     #   unreported dreams
/memory list [q]     # active memories flat (deterministic audit list; no recall events);
                     #   non-active nodes stay visible under "Other states"
/memory open M:12 [cursor=<n>]  # exact memory + full version history with evidence; cursor pages versions
/memory dream        # manual detached dream (bypasses cadence, still claims)
/memory pause|resume
/memory forget M:12  # soft-retire; preserves versions and evidence
```

## Agent tools

- **`memory_search({ query })`** — retrieval-fed synthesizer answer (one call; no follow-up opens); sources in details. This is the only agent tool; `memory_open` was removed because memories are capped at 400 chars and rendered in full everywhere the agent sees them — provenance remains an audit question served by `/memory open`.

## Dreams

A detached pi child (`PI_DREAM_CHILD=1`, `--no-session`) runs a **deterministic mining driver** — not an agent loop: no prompt, no tools. The driver decodes each immutable snapshot, filters generated content and memory-tool output, truncates long content (edges kept), and splits the evidence into char-budgeted segments; each segment is one bounded model call (extract candidates), then one bounded call per session consolidates candidates against deterministic recall (FTS5 + MiniLM) into structured ops: `create`, `update`, `forget`, `no_op`. The driver owns the cursor and the budgets (segment chars, run chars, wall clock), so the LLM is a pure function of bounded inputs: it cannot re-read, lose its place, or loop — the failure mode that made the old paging agent burn unbounded tokens. Mining is incremental: each session resumes at the mined-message cursor stored in its checkpoint; a session mined only partially (a run budget exhausted) keeps a checkpoint whose cursor is below its recorded total and stays eligible, resuming exactly where the previous run stopped. Before creating, the driver recalls the store (read-only retrieval, no citation events) so a restated preference updates the existing memory; a `create` whose normalized text exactly matches an active memory is additionally auto-merged into a restatement version at commit (partial unique index), so duplicate memory nodes cannot occur. Code validates references and text shape and commits memory versions (each carrying the distilled wording, the verbatim evidence quote, and the source session), search projections (FTS + documents + embeddings), and the source-session checkpoint in one transaction. A dream is held to its manifest: finalization fails loudly, naming the culprits, should any session remain uncheckpointed from its exact immutable snapshot, and a failed dream sets a cadence backoff so the same backlog is not re-fired immediately. At finalization the child also runs the incremental embeddings pass (model id from `PI_DREAM_EMBEDDING_MODEL`), so the semantic retriever's index is maintained offline — never on the parent's interactive first turn; an unavailable embedder degrades to lexical-only retrieval and never fails the run, and the degradation is persisted for `/memory status` and the startup notice, self-healing on the next successful pass.

## SQL audit examples

```sql
-- Active memories
SELECT id, kind, state FROM memories WHERE state = 'active';

-- Version history (every create/update with evidence and source session)
SELECT memory_id, id, text, evidence_text, source_session_id, previous_version_id
FROM memory_versions ORDER BY id DESC LIMIT 20;

-- Retired memories (soft-forgotten; everything preserved)
SELECT id, kind, retired_by_session_id, retired_evidence_text
FROM memories WHERE state = 'retired';

-- Citation events (observability only; no ranking input)
SELECT * FROM citation_events ORDER BY id DESC LIMIT 20;

-- FTS searchable memory text
SELECT rowid, text FROM memory_fts;

-- Latest dreams
SELECT id, trigger, status, started_at, finished_at, error_text
FROM dream_runs ORDER BY started_at DESC LIMIT 10;
```

## Development

```bash
npm install
npm run check          # typecheck + lint + format + tests (CI runs this)
npm test
npm run typecheck
npm run eval:dream  # offline corpus report
npm run eval:recall
npm run format         # prettier --write (CI enforces format:check)
```

Domain vocabulary: see [CONTEXT.md](./CONTEXT.md). For agent workflows: see [AGENTS.md](./AGENTS.md).

## Embeddings

Local MiniLM via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`). First use may download the model. The **dreamer child maintains the embeddings projection** at run finalization (incremental by content hash; new or revised memories are embedded, unchanged ones are skipped) — the parent's interactive first turn never runs the projection. The parent loads the embedder for query embedding only when the vector index is non-empty, and an unavailable embedder degrades to lexical-only retrieval rather than failing synthesis. The degradation is **persisted** (`embedding_degraded_error`) and surfaced by `/memory status` and once at startup, so a silently-off semantic retriever is diagnosable; a later successful pass clears it. Embeddings are rebuildable derived rows, cached by content hash; a revised memory's stale row is invalidated on the write path and re-embedded at the next dream.
