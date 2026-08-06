# pi-dream domain language

Workspace-scoped **adaptive memory** for pi. Dream extracts durable user preferences and workspace facts from completed sessions, stores them in an auditable append-oriented SQLite store, and serves them through **retrieval** + a single **synthesis** call into a visible first-turn briefing.

## Core terms

**Memory**: A stable node — a durable user preference or workspace fact — whose current text is a rebuildable projection of append-only **memory versions**. Every memory is a single renderable unit capped at 400 characters, so payload accounting never splits a text mid-way. Prefixed API id: `M:<id>`. Each memory carries one of two kinds — `preference` (user preference) or `fact` (workspace fact; the internal spelling). One real user preference or workspace fact = one memory; updates refine the wording in place, never a new node.

**Memory version**: An immutable event row in a memory's complete life: one per `create` or `update`, each carrying the distilled wording, the verbatim **evidence quote**, the source session, and a link to its predecessor. Nothing is ever deleted or rewritten; retirement is recorded on the memory row, not as a version.

**Retrieval**: The recall layer whose only job is recall — never precision. Query candidates come from FTS5 over active memory text (lexical) fused with MiniLM cosine (semantic) via **Reciprocal Rank Fusion** (`Σ 1/(K + rank)`). The only exclusion is the semantic **cosine floor**; anything a retriever surfaces stays surfaced, and retrieval never writes or records.

**Payload**: The bounded synthesizer input assembled from ranked candidates — whole memory units accumulated in fused-rank order until the next unit would exceed the char budget (`MEMORY_SYNTHESIS_INPUT_CHARS`) or the unit cap. When the retrieved set exceeds the budget, the payload is truncated by fused rank and the **Phase 2 trigger** is logged with the observed char count: compaction (clustering cold-ish memories into a derived, disposable projection) is designed but deferred until that trigger is observed in real use.

**Synthesizer**: Exactly one model call serving both the first-turn briefing and `memory_search`. The LLM performs relevance judgment, selection, categorization, and prose over the payload; the model returns strict JSON (`{"content", "sources"}`) with one parse retry, then fails closed. Cited memories are revalidated against the store after the call (an uncited memory changing mid-call is fine; a cited one changing fails closed with no content and no citation event). Provider-context insufficiency fails closed without truncating the payload and is reported by `/memory status`.

**Briefing**: The visible first-turn custom message (`customType: "pi-dream-briefing"`, `display: true`) containing the synthesized task-relevant context followed by a deterministic **user-preferences** section (active preference memories, id-ascending) that is rendered before the model call and preserved on cancel or synthesis failure. Never hidden system-prompt content; never a raw dump of stored nodes.

**Citation event**: An observability record that a memory was cited as a source in a synthesized answer (`source` `briefing` or `search`). There is no heat score, no decay, no novelty, and no ranking input derived from citations; `activity_generation` is an audit-only session counter and never enters ranking.

**Recurrence**: The count of distinct source sessions that produced a version of a memory (`COUNT(DISTINCT source_session_id)` over `memory_versions`). Never a separately mutated counter.

**Ingestion**: The phase of a dream that reads source sessions and extracts memories (the dreamer "mines" sessions). Mining is a deterministic batch pipeline, not an agent: the detached dreamer child runs a driver that decodes each immutable snapshot, filters generated content and memory-tool output, truncates long content (edges kept), splits the remaining evidence into char-budgeted segments, and makes one bounded model call per segment to extract candidate memories, then one bounded call per session to consolidate them into ops against the store (with deterministic recall over FTS5 + embeddings). The driver owns every piece of state — the forward-only mined-message cursor, the char and wall-clock budgets, and the checkpoints — so the LLM is a pure function of bounded inputs and can never re-read, lose its place, or loop. Mining is incremental: each session resumes at the mined-message cursor stored in its checkpoint, so an already-mined prefix is never re-read; a session mined only partially (a run budget exhausted) keeps a checkpoint whose cursor is below its recorded total and stays eligible, resuming exactly where the previous run stopped. Before creating, the driver recalls the store (read-only retrieval; no citation events) so a restated preference updates the existing memory; a `create` whose normalized text exactly matches an active memory is additionally auto-merged into a restatement version at commit, so duplicate memory nodes cannot occur. At run end the driver also maintains the **embeddings projection** (incremental; unchanged content hashes are skipped) — the projection pass runs only in the child: the parent's interactive first turn never runs it (the parent loads the embedder for query embedding only when the vector index is non-empty), and the pass never fails the run (an unavailable embedder degrades semantic retrieval to lexical-only, and the degradation is persisted for `/memory status` and the startup notice, clearing on the next successful pass). The dreamer has no other surface: there are no summaries to write, no consolidation pass, and no labels.

**Dream**: A unit of background work: a detached run that ingests eligible workspace sessions. Executed by the **dreamer**; tracked in SQLite for single-flight claims and parent notifications, and surfaced to the user as a run (`run <id>`). The product is named after this unit of work; "a dream" is always one run.

**Dreamer**: The detached `--no-session` pi child process that executes a dream. It holds no session of its own, so it can never mine itself.

**Workspace id**: Stable memory scope: `sha256(canonical_source)[:12]_safeName`, resolved from canonical git origin → git common directory → real cwd. Clones and linked worktrees that share an origin share one memory store.

**Source session**: A pi JSONL transcript whose header cwd resolves to the workspace id. Checkpoints store processed mtime/content hash (unchanged sessions are never re-mined), the mined-message cursor, and the snapshot's visible-message total; a checkpoint whose cursor is below its total is a **partial mine** and stays eligible, so a grown session — or an interrupted one — resumes incrementally from where the previous dream stopped.

**Activity generation**: Monotonic workspace counter advanced once per first-turn recall opportunity (before model resolution, on success and failure alike; a pre-aborted attempt does not advance). Audit only — displayed in `/memory status` and stamped as `creation_generation` on new versions and memories; never a ranking input.

## Lifecycle states

Memory `state`:

- `active` — eligible for retrieval
- `retired` — soft-forgotten via `forget` or `/memory forget`; excluded; provenance retained

When a memory is retired, it is removed from the derived search projections (FTS row, search document, embedding) in the same transaction; versions and evidence are preserved. Nothing is ever physically deleted.

## Dreamer operations

The detached dreamer submits only structured ops: `create`, `update`, `forget`, or `no_op`. Code validates references and text shape, then commits versions, search projections, and the source-session checkpoint in one atomic transaction. `create` is dedupe-guarded: identical normalized body text against an active memory routes to a restatement version of that memory (the partial unique index on active memory text enforces the invariant at the schema level). `update` appends a version in place — a restatement (same wording, new evidence, recurrence grows) or a refinement (new wording; the old wording stays in the version chain) — and `forget` retires a memory, recording the negating evidence on the memory row and preserving every version for audit.

## Retired vocabulary

The following terms are retired and must not be reintroduced: **Summary** (and `S:` ids), **Tree / top layer / tree root / containment** (`contains` edges), **Consolidation pass** (merging into summaries), **Promote / resurfacing**, **Heat / hot threshold / novelty**, **Recall events** (now citation events), **Standing preferences** (now user preferences), **memory_open** (agent tool), **Observation** (and `O:` ids; evidence now lives on each memory version), and **Graph edge** (supersession is in-place now; the version chain records history). Compaction of large corpora returns in Phase 2 as **clustering** (a derived, disposable projection) — never as maintained tree state.

## Out of vocabulary

Do not confuse Dream with:

- `AGENTS.md` mutation (never written by this extension)
- Hidden system-prompt memory injection
- Free-form note tools
- Physical deletion of observations (deferred; forget is retrieval retirement only)
