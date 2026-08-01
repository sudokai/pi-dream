# pi-dream domain language

Workspace-scoped **adaptive memory** for pi. Dream learns durable user preferences and workspace facts from completed sessions, stores them in an auditable append-oriented SQLite graph, and serves them through a **tree** whose top layer is synthesized into a visible first-turn briefing.

## Core terms

**Observation**: An immutable extracted assertion — a concise user preference or workspace fact produced by the learner, plus only the source-session identity and timestamps needed for recurrence and idempotency. Observations never store transcript excerpts or sequence ranges. Prefixed API id: `O:<id>`.

**Memory**: A stable synthesized node built from one or more observations. Current text is a rebuildable projection of append-only **memory versions**. Prefixed API id: `M:<id>`.

**Memory version**: An immutable text revision of a memory, linked to its predecessor. Ordinary supersession and forget never delete versions.

**Summary**: A graph node that groups related memories (and sometimes other summaries) for progressive drill-down. Summary text is also versioned; a summary may carry `label_source = 'fallback'` when its text was produced by the deterministic maintenance fallback. Prefixed API id: `S:<id>`.

**Graph edge**: A typed link between memory/summary nodes. Relation types: `contains`, `related_to`, `supersedes`, `conflicts_with`. Containment (`contains`) is created only by validated `summarize`/`promote`/lifecycle ops — never by `link` — and must remain acyclic; lateral links may form cycles. Edges carry a lifecycle state (`active`/`retired`): retiring an edge keeps the row for audit but removes it from the live tree.

**Tree**: Memories and summaries form a strict tree: every node has at most one active parent summary, and containment is always created by validated ops. Only roots merge; the tree is a dendrogram, which keeps heat semantics, merge selection, and resurfacing unambiguous.

**Tree root**: A node with no active `contains` edge pointing at it from an active parent summary (edges from retired parents do not block rootness). Conflicted, superseded, and retired nodes are never roots.

**Top layer**: The set of all roots, capped by an estimated-token budget (`briefingTokenBudget`, 8000). The cap is enforced by maintenance — never by read-time truncation; an over-budget layer fails reads closed with an audit entry.

**Maintenance pass**: A deterministic, cadence-scheduled consolidation phase (post-ingestion in every learner run, plus maintenance-only runs gated by `agent_settled`): roots whose heat is at or below the **cold threshold** (0.4) are paired by semantic nearest-neighbor (cosine over stored MiniLM embeddings, no similarity floor) and merged into summaries; if the top layer exceeds its budget, additional coldest roots are merged regardless of warmth (budget override). Fresh summaries are merge-ineligible inside a grace window of 3 activity generations. Model-written summary texts are repository-validated for strict measured compaction; consecutive rejections are counted per candidate and a deterministic fallback text applies at the third rejection.

**Promote (resurfacing)**: Moving a hot child — heat at or above the **hot threshold** (1.5) — back out of its parent summary: the `contains` edge is retired, the parent is rewritten without it (new summary version) or retired when it drops to ≤ 1 member, resurfacing remaining active children as roots. The hysteresis gap between the cold and hot thresholds prevents flapping.

**Synthesizer**: A single shared LLM loop serving both the first-turn briefing and `memory_search`. It reads the top layer, opens summaries only when it needs more detail (bounded to 8 steps within a 16000-token serialized-context envelope), refreshes its context after every model result (the learner can mutate the DB mid-loop), and returns `{answer, sources, openedSummaryIds}`. Only the synthesized answer is shown; any failure skips silently with an audit entry (fail-closed, no raw tree fallback).

**Recurrence**: The count of distinct source-session observations linked to a memory (`COUNT(DISTINCT source_session_id)` through `memory_observations`). Never a separately mutated counter.

**Recall event**: A record that a node was selected as a source in a synthesized answer or explicitly opened via `memory_open`. Heat is derived from these events plus temporary novelty; deterministic display of the top layer, the briefing index, and `memory_search` hit-listing never heat anything.

**Heat**: Reversible presentation score. Temporary novelty boost for newly activated memories plus exponentially decayed recall-event weights measured in workspace activity generations. Memories and summaries each carry their own heat (summaries: their own recall events only — no novelty, no derivation from children). Hot and cold are not permanent lifecycle states.

**Novelty**: Temporary heat given to a newly activated memory so it has a chance to surface. Passive presence does not renew novelty. Memories mined from sessions older than the source-age cutoff enter cold.

**Learning run**: A detached, extension-isolated pi child that mines eligible workspace sessions and commits validated operations per source session, plus maintenance operations. Tracked in SQLite for single-flight claims and parent notifications. A maintenance-only run has a zero-session manifest and is gated by the deterministic candidate predicate instead of transcripts.

**Briefing**: The visible first-turn custom message (`customType: "pi-dream-briefing"`, `display: true`) containing the synthesized answer plus a one-line index of the remaining top-layer roots. Never hidden system-prompt content; never a raw dump of stored nodes.

**Workspace id**: Stable memory scope: `sha256(canonical_source)[:12]_safeName`, resolved from canonical git origin → git common directory → real cwd. Clones and linked worktrees that share an origin share one memory store.

**Source session**: A pi JSONL transcript whose header cwd resolves to the workspace id. Checkpoints store processed mtime/content hash so unchanged sessions are not re-mined.

**Activity generation**: Monotonic workspace counter advanced once per first-turn recall opportunity (before model resolution, on success and failure alike; a pre-aborted attempt does not advance). Used as the time base for heat decay and summary grace windows.

## Lifecycle states

Memory/summary `state`:

- `active` — eligible for the top layer and maintenance
- `conflicted` — ambiguous contradiction; excluded from the top layer and from maintenance until resolved
- `superseded` — replaced by a newer memory; excluded; history retained
- `retired` — soft-forgotten via `/memory forget`; excluded; provenance retained

When a node becomes conflicted, superseded, or retired, its incoming `contains` edges are retired and every active ancestor summary whose member set contains the inactive node is retired with its outgoing edges, resurfacing remaining active children as roots (lifecycle reconciliation).

## Learner operations

The detached learner submits only structured ops: `create`, `reinforce`, `revise`, `supersede`, `conflict`, `link`, `summarize`, `promote`, or `no_op`. Code validates references, text shape, strict-tree invariants (summarize members must be roots; `link` never creates `contains`), strict measured compaction for summary text, and checkpoints before one atomic transaction commits a source session. Maintenance commits (`summarize`/`promote` only) additionally re-measure the top layer with the actual written texts and reject non-compacting merges with a persisted attempt counter; the third consecutive rejection applies the deterministic fallback text.

## Out of vocabulary

Do not confuse Dream with:

- `AGENTS.md` mutation (never written by this extension)
- Hidden system-prompt memory injection
- Free-form note tools
- Physical deletion of observations (deferred; forget is retrieval retirement only)
