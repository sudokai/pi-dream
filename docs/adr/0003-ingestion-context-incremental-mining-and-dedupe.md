# Ingestion context: incremental mining and the model/code dedupe split

The dreamer previously mined in a vacuum: it re-read a growing session's full transcript on every dream (re-extracting the already-mined prefix with drifted phrasing) and it had no read-path to the store, so a cross-session restatement created a near-duplicate memory node instead of updating the existing one. Both failure modes are ingestion-context problems: the dreamer lacked (a) "what have I already processed from this session?" and (b) "what already exists in the store?".

**Status**: accepted — implemented in schema v6.

## Design

- **Incremental mining.** `source_sessions.mined_message_offset` stores a cursor in visible-message space; a manifest entry carries the prior cursor; `memory_read_session` resumes there by default (a snapshot shorter than the cursor resets to a full re-mine). The commit advances the cursor only to where the dreamer actually read (tracked per session in the child), so an unread tail stays eligible for a later dream and is never silently lost. Recurrence is `COUNT(DISTINCT source_session_id)` — binary per session — so re-reading an already-mined prefix is definitionally incapable of raising recurrence; incremental mining is the direct consequence of the recurrence semantics, not a dedup trick.
- **Read-path (`memory_recall`).** The dreamer may recall active memories for a candidate extraction, reusing the existing retrieval pipeline (FTS5 + MiniLM, RRF, cosine floor). Read-only; never records citation events. This makes the `update`/`forget` ops usable — the schema and the prompt already defined them, but the tool surface made their `M:n` ids undiscoverable.
- **Exact-text backstop in code.** `memories.normalized_text` (denormalized projection, maintained alongside the current-version projection) with a partial unique index `WHERE state = 'active'`: two active memories can never share body text. A `create` whose normalized text collides routes to a restatement version of the existing memory at commit (evidence lands on the existing node, so recurrence stays correct by construction); a colliding `update` fails closed loudly.

## The model/code split

- **Fuzzy relevance is the model's job**: deciding that a restated preference is the same memory (`update`, optionally with a wording refinement), or wrong with nothing replacing it (`forget`) — via `memory_recall`. This follows plan.md's own principle ("text matching cannot do relevance").
- **Exact identity is code's job**: verbatim (normalized) duplicates never reach the model's judgment; the unique index is the invariant, testable without model calls.
- The op surface is `create | update | forget | no_op`. `update` covers both a restatement (same wording, new evidence) and an in-place refinement (new wording); the run claim serializes writers, so no version CAS token is needed, and `create` is dedupe-guarded. Ambiguous contradictions are resolved decisively by the dreamer. In-place `update` keeps one stable `M:n` per preference; the old wording stays in the version chain.
- **There is no separate observation layer**: the memory-version chain carries the distilled wording, the verbatim evidence quote, the source session, and the generation per event, so it is the complete append-only life of a memory; `forget` records the negating evidence on the memory row. Recurrence is `COUNT(DISTINCT source_session_id)` over versions. Nothing is ever deleted — the audit pillar holds with strictly more per event than a two-tier evidence split would provide.
- Rejected alternatives: all-model dedup (probabilistic, untestable without models), fuzzy store-side similarity merge (encodes a cosine threshold as "same memory", contradicting the relevance principle), full active-list injection into dreamer context (does not scale), and relying on Phase 2 compaction (a rendering projection that never merges storage).

## Consequences

- Schema v6 wipes and re-mines (per the established wipe-on-bump policy); the re-mine is itself incremental and sets cursors.
- Non-proliferation ("one real preference/fact = one active memory node") is enforced by schema for exact duplicates and by the read-path for paraphrased restatements.
- Near-duplicates that still arise (paraphrased restatements the model misses) are bounded and auditable; recurrence never inflates.
