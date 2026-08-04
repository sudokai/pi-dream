# Retrieval-fed memory recall with deferred cluster compaction

The containment forest (summaries under summaries, heat, multi-call navigational synthesis) is replaced by three separated mechanisms: an append-only **observation ledger** with versioned 400-character **memories**, a **retrieval** layer whose only job is recall, and a **single synthesis call** that does relevance judgment, selection, categorization, and briefing prose. Compaction of large corpora — clustering cold-ish memories so the synthesizer sees a summary rather than many raw memories — is designed here but built as Phase 2, activated by a measured condition rather than shipped dormant.

**Status**: accepted — Phase 1 implemented; Phase 2 deferred until its trigger is observed.

## Measured motivation

- Across five real workspace stores and 32 activity generations, the containment forest never formed a single summary; the largest corpus is 61 memories ≈ 11,800 chars ≈ 3,000 tokens — the entire active store fits in one prompt with ~90% of a 40,000-char input budget unused. At that scale an LLM can judge relevance over everything, which is strictly better than any retrieval-based pre-filter.
- All 22 recorded recall events had `source = 'startup'`; zero agent-initiated paths were exercised, so removing the `memory_open` tool costs nothing measurable.
- Only 4 of 166 active memories were ever cited in two different generations: a decay-curve heat score had no signal to fit, and the generation-based half-life was calibrated against a session counter rather than wall-clock time.
- The shipped design had no bound on its rendered layer: the only bound was a reactive read-time check that stopped all recall until a dream consolidated.

## Design

- **Storage**: observations are append-only within a schema generation; memories are versioned ≤400-char units; schema bumps wipe and re-mine (durable memory is a rebuildable projection of session transcripts; `user_version` uniquely determines shape). The current schema (v5) drops `summaries`/`summary_versions`/`consolidation_attempts`/`recall_events`, drops `contains` from `graph_edges`, adds `citation_events`, an FTS5 table over active memory text, and the `embedding_degraded_error` workspace-state column (v4 never shipped; the bump to v5 ensures any store from an older build wipes cleanly rather than opening against a mismatched shape).
- **Retrieval**: BM25 (FTS5) + MiniLM fused by Reciprocal Rank Fusion; the only exclusion is the semantic cosine floor; FTS queries are built by quoting tokenized terms (never raw user text); long queries are segmented; greeting-only/blank queries skip retrieval; the parent embedder is guarded by a non-empty vector index and degrades to lexical-only on failure. The embeddings projection is maintained by the dreamer child at run finalization (incremental by content hash; the parent's interactive first turn never runs the projection, and loads the embedder for query embedding only when the vector index is non-empty). Retrieval never writes.
- **Payload**: whole-unit accumulation to `MEMORY_SYNTHESIS_INPUT_CHARS` (40,000) with a unit cap (150); an over-budget candidate set truncates by fused rank and logs the Phase 2 trigger with the observed char count.
- **Synthesis**: exactly one call, strict JSON with one parse retry then fail-closed, cited-only revalidation (uncited mutations are harmless), purpose-specific prompts with memories-first / delimited-task-second / instructions-last ordering. The task is untrusted relevance data; the briefing must not execute it. Output capped at 20,000 chars with no target length.
- **Briefing**: task-relevant context first, then a deterministic user-preferences section rendered ahead of the call and preserved on cancel; citations recorded only for validated sources.
- **Heat retired**: citation events remain as observability; no score, decay, novelty, or threshold is computed; `activity_generation` is audit only.
- **Agent surface**: exactly one tool (`memory_search`); `memory_open` deleted; `/memory open` remains for human provenance.

## Phase 2 (deferred — do not build until the trigger is observed)

Cluster summaries are a **derived, disposable projection** cached by member-set hash (the same property that dissolves the forest's complexity: promotion becomes recomputation, not a transaction). Clustering is order-independent average-linkage over cosine distance with flat top-down extraction; collapse at read time expands a cluster when any member ranks in the fused top-M, decrementing M until the payload fits, with whole units dropped from the bottom as the terminal case. Cluster summaries are indexed for retrieval; the synthesizer may cite `C:n`. Phase 2 activates when retrieved chars exceed the synthesizer input cap — a measured event, not a guess.

## Consequences

- Deleted: `shared/memory-tree.ts`, `shared/memory-heat.ts`, `shared/memory-consolidation.ts`, `prompts/memory-synthesizer.md`, the dream-only (consolidation) run path, and the `memory_inspect_graph` / `memory_commit_consolidation` dreamer tools.
- Config loses the heat and token-capacity keys; budgets are fixed constants. Old keys fail closed like any unknown key.
- A schema bump to v5 wipes v3/v4 stores; the dreamer re-mines ~2,105 on-disk transcripts. Migrating only `observations` and `source_sessions` is the documented escape hatch if that ever becomes painful — deliberately not built now.
- The read path is pure selection over an already-compacted corpus: summarization never happens at read time, so the interactive first turn stays single-call.
- Terminology: Summary, Tree, top layer, root, containment, Consolidation pass, Promote, Heat, novelty, and recall events are retired (see CONTEXT.md "Retired vocabulary"); Dream/Dreamer/Ingestion remain.
