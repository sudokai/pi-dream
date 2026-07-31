# pi-dream

Adaptive **workspace memory** for [pi](https://pi.dev): learns durable user preferences and workspace facts from completed sessions, stores them in an auditable append-oriented SQLite graph, and recalls only relevant nodes into a **visible first-turn briefing**.

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

| Surface            | Behavior                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First turn         | Hybrid BM25 + MiniLM search → LLM briefing planner → visible `pi-dream-briefing` custom message with stable IDs and exact stored text                                           |
| `memory_search`    | Same hybrid + LLM gate; records recall for returned nodes only                                                                                                                  |
| `memory_open`      | Exact target + one deeper level + lateral IDs; never truncates a node                                                                                                           |
| `/memory`          | `status`, `list [query]`, `open <id>`, `learn`, `pause`, `resume`, `forget <id>`; `list` and `open` also append a visible `pi-dream-audit` entry (learn/forget are notify-only) |
| Automatic learning | After ≥10 settled turns, ≥120 minutes, and advanced transcripts → detached `--no-session` learner                                                                               |

**Never** edits `AGENTS.md`, injects hidden system-prompt memory, or physically deletes history on forget (soft retirement only).

## Data layout

Per workspace (identity: canonical git origin → git common dir → real cwd):

```text
~/.pi/agent/dream/<workspaceId>/
  memory.db
  config.json
  runs/<runId>/manifest.json   # temporary
```

Override storage root in tests with `PI_DREAM_STORAGE_ROOT`.

## Configuration (`config.json`)

All fields are optional except `version` and `enabled`; missing optional fields use the defaults below.

```json
{
  "version": 1,
  "enabled": true,
  "learningModel": "provider/modelId",
  "learningThinking": "off",
  "recallModel": "provider/modelId",
  "recallThinking": "off",
  "minTurns": 10,
  "minMinutes": 120,
  "briefingTokenBudget": 8000,
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "hybridPoolSize": 50,
  "rrfK": 20,
  "semanticFloor": 0.25,
  "noveltyBoost": 1.0,
  "noveltyGenerations": 3,
  "heatDecay": 0.85
}
```

| Field                 | Default                   | Meaning                                                                                                                                       |
| --------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`             | 1 (required)              | Config schema version; must be 1.                                                                                                             |
| `enabled`             | — (required)              | Master switch; `/memory pause` and `resume` toggle it.                                                                                        |
| `learningModel`       | current session model     | Exact `provider/modelId` for the detached learner; omit to use the session model.                                                             |
| `learningThinking`    | unset (no override)       | Thinking level for the learner: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unset omits the override, so pi's default applies. |
| `recallModel`         | current session model     | Exact `provider/modelId` for briefing/search recall; omit to use the session model.                                                           |
| `recallThinking`      | unset (no override)       | Thinking level for recall planning (same level set). Unset omits the override, so pi's default applies.                                       |
| `minTurns`            | 10                        | Minimum settled turns before automatic learning.                                                                                              |
| `minMinutes`          | 120                       | Minimum idle minutes before automatic learning.                                                                                               |
| `briefingTokenBudget` | 8000                      | Ceiling for the first-turn briefing, in estimated tokens.                                                                                     |
| `embeddingModel`      | `Xenova/all-MiniLM-L6-v2` | Local embedding model id (first use may download it).                                                                                         |
| `hybridPoolSize`      | 50                        | Candidate pool size per hybrid retrieval query.                                                                                               |
| `rrfK`                | 20                        | Reciprocal rank fusion constant for BM25 + semantic merging.                                                                                  |
| `semanticFloor`       | 0.25                      | Minimum semantic similarity to enter the candidate pool.                                                                                      |
| `noveltyBoost`        | 1.0                       | Temporary heat added to a newly activated memory.                                                                                             |
| `noveltyGenerations`  | 3                         | Activity generations novelty lasts.                                                                                                           |
| `heatDecay`           | 0.85                      | Per-generation exponential decay factor for recall heat.                                                                                      |

**Unknown keys are rejected**: a `config.json` containing a key not listed above fails closed — memory is disabled for the workspace until the file is repaired. Invalid configured models fail that operation closed (no silent fallback); invalid or unreadable `config.json` disables memory until repaired.

## Environment variables

All variables are optional; defaults exist without them.

| Variable                 | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `PI_DREAM_STORAGE_ROOT`  | Override the per-workspace data root (tests use this).                              |
| `PI_DREAM_SESSIONS_ROOT` | Override the pi sessions root used for source-session discovery (tests/child only). |
| `PI_DREAM_CHILD`         | Set to `1` inside the detached learner child (`--no-session`, isolated tools).      |

`PI_DREAM_WORKSPACE_ID`, `PI_DREAM_RUN_ID`, `PI_DREAM_MANIFEST`, `PI_DREAM_DB`, and `PI_DREAM_CWD` are internal handoff variables the launcher sets for the detached child; they are not for manual use.

## Commands

```text
/memory              # status: workspace id, db path, counts, cadence, last run
/memory list [q]     # deterministic audit list (no recall events)
/memory open M:12 [cursor=<n>]  # exact node + one level; versions; cursor for more children
/memory learn        # manual detached run (bypasses cadence, still claims)
/memory pause|resume
/memory forget M:12  # soft-retire; preserves versions and observations
```

## Agent tools

- **`memory_search({ query })`** — hybrid retrieval + LLM filter; complete nodes only
- **`memory_open({ id, cursor? })`** — progressive drill-down (`M:` / `S:` / `O:`)

## Learning

A detached pi child (`PI_DREAM_CHILD=1`, `--no-session`, isolated tools) processes eligible sessions and submits structured ops: `create`, `reinforce`, `revise`, `supersede`, `conflict`, `link`, `summarize`, `no_op`. Code validates graph invariants and commits observations, versions, edges, search indexes, and the source-session checkpoint in one transaction.

## SQL audit examples

```sql
-- Active memories with current text
SELECT m.id, m.kind, m.state, v.text
FROM memories m
JOIN memory_versions v ON v.id = m.current_version_id
WHERE m.state = 'active';

-- Observations supporting a memory
SELECT o.*
FROM memory_observations mo
JOIN observations o ON o.id = mo.observation_id
WHERE mo.memory_id = 1;

-- Supersession edges
SELECT * FROM graph_edges WHERE relation = 'supersedes';

-- Recall history
SELECT * FROM recall_events ORDER BY id DESC LIMIT 20;

-- Latest learning runs
SELECT id, trigger, status, started_at, finished_at, error_text
FROM learning_runs ORDER BY started_at DESC LIMIT 10;
```

## Development

```bash
npm install
npm run check          # typecheck + lint + format + tests (CI runs this)
npm test
npm run typecheck
npm run eval:learning  # offline corpus report
npm run eval:recall
npm run format         # prettier --write (CI enforces format:check)
```

Domain vocabulary: see [CONTEXT.md](./CONTEXT.md). For agent workflows: see [AGENTS.md](./AGENTS.md).

## Semantic index

Local MiniLM via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`). First use may download the model. The embedder loads lazily on first semantic search, so `/memory status` reports the in-process state precisely: `not loaded (loads on first use)` before any search warms it up, `loading (first use may download the model)` while warming up, `degraded (<error>)` only on an actual load failure, or `ready`. If embeddings are unavailable, BM25 still runs but the LLM filter remains required.
