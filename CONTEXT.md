# pi-dream domain language

Workspace-scoped **adaptive memory** for pi. Dream extracts durable user preferences and workspace facts from completed sessions, stores them in an auditable append-oriented SQLite store, and serves them through **retrieval** + a single **synthesis** call into a visible first-turn briefing.

## Core terms

**Observation**: An immutable extracted assertion — a concise user preference or workspace fact produced by the dreamer, plus only the source-session identity and timestamps needed for recurrence and idempotency. Observations never store transcript excerpts or sequence ranges. Prefixed API id: `O:<id>`.

**Memory**: A stable synthesized node built from one or more observations. Current text is a rebuildable projection of append-only **memory versions**. Every memory is a single renderable unit capped at 400 characters, so payload accounting never splits a text mid-way. Prefixed API id: `M:<id>`.

**Memory version**: An immutable text revision of a memory, linked to its predecessor. Ordinary supersession and forget never delete versions.

**Graph edge**: A typed lateral link between memories. Relation types: `related_to`, `supersedes`, `conflicts_with`. Edges carry a lifecycle state (`active`/`retired`): retiring an edge keeps the row for audit but removes it from live reads.

**Retrieval**: The recall layer whose only job is recall — never precision. Query candidates come from FTS5 over active memory text (lexical) fused with MiniLM cosine (semantic) via **Reciprocal Rank Fusion** (`Σ 1/(K + rank)`). The only exclusion is the semantic **cosine floor**; anything a retriever surfaces stays surfaced, and retrieval never writes or records.

**Payload**: The bounded synthesizer input assembled from ranked candidates — whole memory units accumulated in fused-rank order until the next unit would exceed the char budget (`MEMORY_SYNTHESIS_INPUT_CHARS`) or the unit cap. When the retrieved set exceeds the budget, the payload is truncated by fused rank and the **Phase 2 trigger** is logged with the observed char count: compaction (clustering cold-ish memories into summaries) is designed but deferred until that trigger is observed in real use.

**Synthesizer**: Exactly one model call serving both the first-turn briefing and `memory_search`. The LLM performs relevance judgment, selection, categorization, and prose over the payload; the model returns strict JSON (`{"content", "sources"}`) with one parse retry, then fails closed. Cited memories are revalidated against the store after the call (an uncited memory changing mid-call is fine; a cited one changing fails closed with no content and no citation event). Provider-context insufficiency fails closed without truncating the payload and is reported by `/memory status`.

**Briefing**: The visible first-turn custom message (`customType: "pi-dream-briefing"`, `display: true`) containing the synthesized task-relevant context followed by a deterministic **standing-preferences** section (active preference memories, id-ascending) that is rendered before the model call and preserved on cancel or synthesis failure. Never hidden system-prompt content; never a raw dump of stored nodes.

**Citation event**: An observability record that a memory was cited as a source in a synthesized answer (`source` `briefing` or `search`). There is no heat score, no decay, no novelty, and no ranking input derived from citations; `activity_generation` is a session counter for deterministic rotation and audit only and never enters ranking.

**Recurrence**: The count of distinct source-session observations linked to a memory (`COUNT(DISTINCT source_session_id)` through `memory_observations`). Never a separately mutated counter.

**Ingestion**: The phase of a dream that reads source sessions and extracts observations and memories (the dreamer "mines" sessions). At run end the dreamer also maintains the **embeddings projection** (incremental; unchanged content hashes are skipped) — the plan forbids the parent's interactive first turn from loading the embedder, so this pass runs only in the child and never fails the run (an unavailable embedder degrades semantic retrieval to lexical-only, and the degradation is persisted for `/memory status` and the startup notice, clearing on the next successful pass). The dreamer has no other surface: there are no summaries to write, no consolidation pass, and no labels.

**Dream**: A unit of background work: a detached run that ingests eligible workspace sessions. Executed by the **dreamer**; tracked in SQLite for single-flight claims and parent notifications, and surfaced to the user as a run (`run <id>`). The product is named after this unit of work; "a dream" is always one run.

**Dreamer**: The detached `--no-session` pi child process that executes a dream. It holds no session of its own, so it can never mine itself.

**Workspace id**: Stable memory scope: `sha256(canonical_source)[:12]_safeName`, resolved from canonical git origin → git common directory → real cwd. Clones and linked worktrees that share an origin share one memory store.

**Source session**: A pi JSONL transcript whose header cwd resolves to the workspace id. Checkpoints store processed mtime/content hash so unchanged sessions are not re-mined.

**Activity generation**: Monotonic workspace counter advanced once per first-turn recall opportunity (before model resolution, on success and failure alike; a pre-aborted attempt does not advance). Audit and rotation only — never a ranking input.

## Lifecycle states

Memory `state`:

- `active` — eligible for retrieval
- `conflicted` — ambiguous contradiction; excluded from retrieval until resolved
- `superseded` — replaced by a newer memory; excluded; history retained
- `retired` — soft-forgotten via `/memory forget`; excluded; provenance retained

When a memory becomes conflicted, superseded, or retired, it is removed from the derived search projections (FTS row, search document, embedding) in the same transaction; observations, versions, and edges are preserved.

## Dreamer operations

The detached dreamer submits only structured ops: `create`, `reinforce`, `revise`, `supersede`, `conflict`, `link`, or `no_op`. Code validates references and text shape, then commits observations, versions, edges, search projections, and the source-session checkpoint in one atomic transaction.

## Retired vocabulary

The following terms are retired and must not be reintroduced: **Summary** (and `S:` ids), **Tree / top layer / tree root / containment** (`contains` edges), **Consolidation pass** (merging into summaries), **Promote / resurfacing**, **Heat / hot threshold / novelty**, **Recall events** (now citation events), and **memory_open** (agent tool). Compaction of large corpora returns in Phase 2 as **clustering** (a derived, disposable projection) — never as maintained tree state.

## Out of vocabulary

Do not confuse Dream with:

- `AGENTS.md` mutation (never written by this extension)
- Hidden system-prompt memory injection
- Free-form note tools
- Physical deletion of observations (deferred; forget is retrieval retirement only)
