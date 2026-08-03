# pi-dream

Adaptive **workspace memory** for [pi](https://pi.dev): extracts durable user preferences and workspace facts from completed sessions into an auditable SQLite **tree**, and synthesizes the top layer into a **visible first-turn briefing**.

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

| Surface            | Behavior                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First turn         | Synthesizer turns the top layer of the memory tree into a grounded answer + an index of the remaining roots (top 35 preferences, up to 15 facts; heat-ordered; visible `pi-dream-briefing` custom message) |
| `memory_search`    | Same synthesizer: returns a synthesized answer with sources; records recall for sources and opened summaries only                                                                                          |
| `memory_open`      | Exact target + one deeper level + lateral IDs; never truncates a node                                                                                                                                      |
| `/memory`          | `status`, `list [query]`, `open <id>`, `dream`, `pause`, `resume`, `forget <id>`; `list` and `open` also append a visible `pi-dream-audit` entry (dream/forget are notify-only)                            |
| Automatic dreaming | After ≥10 settled turns, ≥120 minutes, and advanced transcripts (or pending tree consolidation) → detached `--no-session` dreamer                                                                          |

**Never** edits `AGENTS.md`, injects hidden system-prompt memory, or physically deletes history on forget (soft retirement only).

## How recall works: tree + synthesizer

- **Tree consolidation is forced, algorithmic, and budget-gated.** When the top layer's estimated tokens exceed `briefingTokenBudget`, roots are paired by semantic nearest-neighbor (cosine over stored MiniLM embeddings, coldest first, **no similarity floor**) and merged into summaries until the layer fits; under budget no merges are planned. A root whose heat reaches the hot threshold is automatically promoted back out of its parent. Conflicted/retired/superseded nodes are excluded from the top layer and from consolidation.
- **The top layer always fits.** The estimated token size of all roots is capped by `briefingTokenBudget` (8000). The cap is enforced by consolidation — budget-forced merges, a summary grace window, per-merge strict-compaction validation, and a deterministic fallback text after three consecutive rejections. Reads never truncate: an over-budget layer fails closed with an audit entry, and while merge-eligible candidates exist the over-budget state waives the cadence turn/time gates so the next agent settle launches an urgent consolidation run.
- **One synthesizer serves briefing and search.** A single bounded LLM loop (≤ 8 steps, 16000-token envelope) reads the top layer, opens summaries only when it needs more detail, refreshes its context after every model result, and returns `{answer, sources, openedSummaryIds}`. Only the synthesized answer is shown; sources and opened summaries are reheated (selection credits heat; display never does).
- **Fail-closed everywhere.** Synthesizer failures skip silently with an audit entry (no raw tree dump); consolidation commits reject non-compacting merges with a persisted attempt counter; a legacy store (old schema) is wiped and re-mined from transcripts.

## Data layout

Per workspace (identity: canonical git origin → git common dir → real cwd):

```text
~/.pi/agent/dream/<workspaceId>/
  memory.db
  config.json
  last-consolidation-inspect.json   # last inspect-time consolidation batch (status reads it)
  runs/<runId>/manifest.json      # temporary
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
  "briefingTokenBudget": 8000,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "hotHeatThreshold": 1.5,
  "synthesizerContextBudget": 16000,
  "synthesizerAnswerBudget": 2000,
  "noveltyBoost": 1.0,
  "noveltyGenerations": 3,
  "heatDecay": 0.85
}
```

| Field                      | Default                   | Meaning                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | 1 (required)              | Config schema version; must be 1.                                                                                                                                                                                                                                                   |
| `enabled`                  | — (required)              | Master switch; `/memory pause` and `resume` toggle it.                                                                                                                                                                                                                              |
| `dreamModel`               | current session model     | Exact `provider/modelId` for the detached dreamer; omit to use the session model.                                                                                                                                                                                                   |
| `dreamThinking`            | unset (no override)       | Thinking level for the dreamer: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unset omits the override, so pi's default applies.                                                                                                                                       |
| `recallModel`              | current session model     | Exact `provider/modelId` for the synthesizer (briefing + search); omit to use the session model.                                                                                                                                                                                    |
| `recallThinking`           | unset (no override)       | Thinking level for the synthesizer (same level set). Unset omits the override, so pi's default applies.                                                                                                                                                                             |
| `minTurns`                 | 10                        | Minimum settled turns before automatic dreaming.                                                                                                                                                                                                                                    |
| `minMinutes`               | 120                       | Minimum idle minutes before automatic dreaming.                                                                                                                                                                                                                                     |
| `briefingTokenBudget`      | 8000                      | Estimated-token cap for the top layer (consolidation-enforced; reads fail closed above it, and while merge-eligible candidates exist an over-budget layer waives the cadence gates so the next settle runs urgent consolidation). Must be ≥ 200 (the largest single-node estimate). |
| `embeddingModel`           | `Xenova/all-MiniLM-L6-v2` | Local embedding model id (first use may download it). Used by consolidation and dreaming only — never by the briefing/search read path.                                                                                                                                             |
| `hotHeatThreshold`         | 1.5                       | Children at or above this heat are promote-eligible (resurfaced).                                                                                                                                                                                                                   |
| `synthesizerContextBudget` | 16000                     | Serialized-context envelope: framing + request + top layer + navigation reserve + answer reserve. Synthesizer navigation has no step limit: the loop ends on finalize; an open that adds no new context draws one corrective hint and fails closed if repeated.                     |
| `synthesizerAnswerBudget`  | 2000                      | Answer token cap inside the envelope.                                                                                                                                                                                                                                               |
| `noveltyBoost`             | 1.0                       | Temporary heat added to a newly activated memory.                                                                                                                                                                                                                                   |
| `noveltyGenerations`       | 3                         | Activity generations novelty lasts.                                                                                                                                                                                                                                                 |
| `heatDecay`                | 0.85                      | Per-generation exponential decay factor for recall heat; repeated recalls of a node within one generation count once.                                                                                                                                                               |

**Removed keys**: `hybridPoolSize`, `rrfK`, `semanticFloor`, `coldHeatThreshold`, `consolidationMergeBound`, and `synthesizerMaxSteps` no longer exist. A `config.json` containing them (or any other unknown key) fails closed — memory is disabled for the workspace until the file is repaired.

**Unknown keys are rejected**: a `config.json` containing a key not listed above fails closed — memory is disabled for the workspace until the file is repaired. Invalid configured models fail that operation closed (no silent fallback); invalid or unreadable `config.json` disables memory until repaired. Cross-key validation rejects `briefingTokenBudget < 200` and `synthesizerContextBudget` at or below the envelope floor (see the table row) the same way.

**Slow recall models**: the briefing has no time cap — the loader stays up until synthesis completes, you press Escape (nothing is shown; the attempt is audited), or you press `a` for an answer now from the context gathered so far (marked "Answered on request from partial context"). Any failed synthesis also draws one finalize-only call against the gathered context before failing closed, so an interruption still yields the best answer the model can give from what it had — except a staleness failure (the dreamer mutated the tree mid-loop), which fails closed immediately since the gathered context is provably invalid. On slow or high-thinking session models, set `recallModel` and `recallThinking` (e.g. `"off"`) per workspace so the first turn isn't delayed by a heavyweight recall model.

## Environment variables

All variables are optional; defaults exist without them.

| Variable                 | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `PI_DREAM_STORAGE_ROOT`  | Override the per-workspace data root (tests use this).                              |
| `PI_DREAM_SESSIONS_ROOT` | Override the pi sessions root used for source-session discovery (tests/child only). |
| `PI_DREAM_CHILD`         | Set to `1` inside the detached dreamer child (`--no-session`, isolated tools).      |

`PI_DREAM_WORKSPACE_ID`, `PI_DREAM_RUN_ID`, `PI_DREAM_MANIFEST`, `PI_DREAM_DB`, and `PI_DREAM_CWD` are internal handoff variables the launcher sets for the detached child; they are not for manual use.

## Commands

```text
/memory              # status: enabled, counts, top-layer token estimate (with OVER
                     #   BUDGET flag), last dream, active dream; status --verbose adds
                     #   config path, models, cadence, workspace id, db path, activity
                     #   gen, unreported dreams, and pending attempt counters
/memory list [q]     # the tree rendered indented (roots + children under summaries);
                     #   fallback-labeled summaries render as "S:n (fallback)"; non-active
                     #   nodes stay visible flat; deterministic audit list (no recall events)
/memory open M:12 [cursor=<n>]  # exact node + one level; versions; cursor for more children
/memory dream        # manual detached dream (bypasses cadence, still claims)
/memory pause|resume
/memory forget M:12  # soft-retire; preserves versions and observations
```

## Agent tools

- **`memory_search({ query })`** — self-contained synthesizer answer (it opens summaries internally); sources in details
- **`memory_open({ id, cursor? })`** — progressive drill-down (`M:` / `S:` / `O:`); open returned children to descend, cursor pages children

## Dreams

A detached pi child (`PI_DREAM_CHILD=1`, `--no-session`, isolated tools) processes eligible sessions and submits structured ops: `create`, `reinforce`, `revise`, `supersede`, `conflict`, `link`, `summarize`, `promote`, `no_op`. Code validates graph invariants (strict tree, strict summary compaction) and commits observations, versions, edges, projections, and the source-session checkpoint in one transaction. Every dream ends with a post-ingestion consolidation phase; deterministic consolidation candidates also trigger **dream-only runs** (zero-session manifests) from `agent_settled`.

## SQL audit examples

```sql
-- Active roots of the tree (memories and summaries without an active parent)
SELECT 'M' AS kind, id FROM memories WHERE state = 'active'
UNION ALL
SELECT 'S', id FROM summaries WHERE state = 'active';

-- Containment edges (retired edges are audit history)
SELECT * FROM graph_edges WHERE relation = 'contains';

-- Pending consolidation attempt counters
SELECT * FROM consolidation_attempts;

-- Recall history
SELECT * FROM recall_events ORDER BY id DESC LIMIT 20;

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

Local MiniLM via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`). First use may download the model. The embedder is loaded only by the consolidation pass (merge pairing) and by new-node embedding during dreaming — never by the briefing or `memory_search` read path. If embeddings are unavailable, pairing degrades (missing similarities score 0, still pairable — there is no similarity floor) and consolidation never aborts a dream.
