# pi-dream

Adaptive **workspace memory** for [pi](https://pi.dev): learns durable user preferences and workspace facts from completed sessions, stores them in an auditable append-oriented SQLite graph, and recalls only relevant nodes into a **visible first-turn briefing**.

## Install

```bash
pi install git:https://github.com/<your-org>/pi-dream
# local development from a checkout:
pi install .
# or load directly:
pi -e ./index.ts
```

Requires **Node 24+** (native `node:sqlite`).

## What it does

| Surface | Behavior |
|---------|----------|
| First turn | Hybrid BM25 + MiniLM search → LLM briefing planner → visible `pi-dream-briefing` custom message with stable IDs and exact stored text |
| `memory_search` | Same hybrid + LLM gate; records recall for returned nodes only |
| `memory_open` | Exact target + one deeper level + lateral IDs; never truncates a node |
| `/memory` | `status`, `list [query]`, `open <id>`, `learn`, `pause`, `resume`, `forget <id>`; learn/forget also append a visible `pi-dream-audit` entry |
| Automatic learning | After ≥10 settled turns, ≥120 minutes, and advanced transcripts → detached `--no-session` learner |

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

```json
{
  "version": 1,
  "enabled": true,
  "learningModel": "provider/modelId",
  "recallModel": "provider/modelId",
  "minTurns": 10,
  "minMinutes": 120,
  "briefingTokenBudget": 8000
}
```

Omit model fields to use the **current session model**. Invalid configured models fail that operation closed (no silent fallback). Invalid or unreadable `config.json` disables memory for the workspace until the file is repaired. Use `/memory pause` and `/memory resume` to toggle `enabled`.

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
npm test
npm run typecheck
npm run eval:learning   # offline corpus report
npm run eval:recall
```

Domain vocabulary: see [CONTEXT.md](./CONTEXT.md).

## Semantic index

Local MiniLM via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`). First use may download the model. If embeddings are unavailable, BM25 still runs but the LLM filter remains required; `/memory status` reports degraded semantic status.
