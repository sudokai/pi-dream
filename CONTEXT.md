# pi-dream domain language

Workspace-scoped **adaptive memory** for pi. Dream learns durable user preferences and workspace facts from completed sessions, stores them in an auditable append-oriented SQLite graph, and recalls only relevant nodes into a visible first-turn briefing.

## Core terms

**Observation**: An immutable extracted assertion — a concise user preference or workspace fact produced by the learner, plus only the source-session identity and timestamps needed for recurrence and idempotency. Observations never store transcript excerpts or sequence ranges. Prefixed API id: `O:<id>`.

**Memory**: A stable synthesized node built from one or more observations. Current text is a rebuildable projection of append-only **memory versions**. Prefixed API id: `M:<id>`.

**Memory version**: An immutable text revision of a memory, linked to its predecessor. Ordinary supersession and forget never delete versions.

**Summary**: A graph node that groups related memories (and sometimes other summaries) for progressive drill-down. Summary text is also versioned. Prefixed API id: `S:<id>`.

**Graph edge**: A typed link between memory/summary nodes. Relation types: `contains`, `related_to`, `supersedes`, `conflicts_with`. Containment (`contains`) must remain acyclic; lateral links may form cycles.

**Recurrence**: The count of distinct source-session observations linked to a memory (`COUNT(DISTINCT source_session_id)` through `memory_observations`). Never a separately mutated counter.

**Recall event**: A record that a node was included in an LLM-approved briefing/search result or explicitly opened. Heat is derived from these events plus temporary novelty; listing a child under a parent summary does not reheat the child.

**Heat**: Reversible presentation score. Temporary novelty boost for newly activated memories plus exponentially decayed recall-event weights measured in workspace activity generations. Hot and cold are not permanent lifecycle states.

**Novelty**: Temporary heat given to a newly activated memory so it has a chance to surface. Passive presence does not renew novelty.

**Learning run**: A detached, extension-isolated pi child that mines eligible workspace sessions and commits validated operations per source session. Tracked in SQLite for single-flight claims and parent notifications.

**Briefing**: The visible first-turn custom message (`customType: "pi-dream-briefing"`, `display: true`) containing planner-selected node IDs and exact stored text. Never hidden system-prompt content. Ceiling is 8,000 estimated tokens of complete atomic nodes.

**Workspace id**: Stable memory scope: `sha256(canonical_source)[:12]_safeName`, resolved from canonical git origin → git common directory → real cwd. Clones and linked worktrees that share an origin share one memory store.

**Source session**: A pi JSONL transcript whose header cwd resolves to the workspace id. Checkpoints store processed mtime/content hash so unchanged sessions are not re-mined.

**Activity generation**: Monotonic workspace counter advanced once per first-turn recall opportunity. Used as the time base for heat decay.

## Lifecycle states

Memory/summary `state`:

- `active` — eligible for automatic search and briefing
- `conflicted` — ambiguous contradiction; excluded from automatic recall until resolved
- `superseded` — replaced by a newer memory; excluded from automatic recall; history retained
- `retired` — soft-forgotten via `/memory forget`; excluded from retrieval; provenance retained

## Learner operations

The detached learner submits only structured ops: `create`, `reinforce`, `revise`, `supersede`, `conflict`, `link`, `summarize`, or `no_op`. Code validates references, text shape, graph invariants, and checkpoints before one atomic transaction commits a source session.

## Out of vocabulary

Do not confuse Dream with:

- `AGENTS.md` mutation (never written by this extension)
- Hidden system-prompt memory injection
- Free-form note tools
- Physical deletion of observations (deferred; forget is retrieval retirement only)
