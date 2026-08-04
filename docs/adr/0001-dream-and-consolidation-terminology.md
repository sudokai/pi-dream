# Dream and consolidation terminology

pi-dream's vocabulary originally described the detached background run as a "learning run" and the merge/promote phase as "maintenance" — generic engineer-speak that surfaced in notifications, `/memory`, status, and docs. We renamed to the sleep metaphor that is the product's identity: the background run is a **dream** (executed by the **dreamer** child), its session-mining phase is **ingestion**, and the merge/promote phase is **consolidation**. The run id survives only as an id handle (`run 123`), `/memory learn` became `/memory dream`, and "learns" was purged from user-facing prose (product descriptions now say "extracts").

**Status**: accepted; the consolidation phase it named is retired by [0002](./0002-retrieval-fed-recall.md), and the observation/edge layers are retired by [0003](./0003-ingestion-context-incremental-mining-and-dedupe.md). "Dream" and "dreamer" remain the load-bearing names for the background run and its detached process; "consolidation" no longer names any phase in the codebase and must not be reintroduced for compaction (see 0002 for the replacement vocabulary: clustering, compaction, collapse — Phase 2).

**Considered options**:

- **Rename only "maintenance" → "dreams", keep "learning run"** — rejected: once `/memory dream` makes the run a dream, "maintenance" as "dreams" would mean dreams inside dreams. The phase needed its own accurate word; "consolidation" is also the sleep-science term for exactly this mechanism.
- **Keep "maintenance"** — rejected: colorless and misleading. It implies upkeep of machinery, not the deliberate compaction of memories that gives the extension its name.
- **Rename the tables with compatibility shims** — rejected: the store already follows a documented wipe-and-recreate policy ("no backwards-compatibility shims"), so schema v3 simply wipes v2 stores (`learning_runs`, `maintenance_attempts`) and the next dream re-mines everything from transcripts.

**Consequences**:

- Do not rename "consolidation" back to "maintenance", or collapse Dream/Dreamer — the split is load-bearing: a dream is the unit of work (tracked as a run in `dream_runs`), the dreamer is the process that executes it.
- Config keys renamed (`dreamModel`, `dreamThinking`, `consolidationMergeBound`); config parsing is fail-closed, so pre-rename `config.json` files disable memory until their keys are repaired. `consolidationMergeBound` and `coldHeatThreshold` were later removed when merging became budget-gated — they now fail closed as unknown keys like any other.
- The only remaining "learning" in the package is the `continual-learning` keyword, kept for package discoverability.
- As of the retrieval-fed redesign (0002), the summary/containment machinery that consolidation maintained is deleted: `summaries`, `summary_versions`, `consolidation_attempts`, the `contains` relation, and the Tree/Summary/Promotion/Heat vocabulary are retired, and the dreamer is ingestion-only.
