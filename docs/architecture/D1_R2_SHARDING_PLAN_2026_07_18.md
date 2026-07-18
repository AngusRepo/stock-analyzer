# D1 and Object Storage Boundary Plan (2026-07-18)

## Evidence

- Production `stockvision-db` size: 9,903,112,192 bytes (99.03% of the 10 GB per-database limit).
- Production schema: 172 tables.
- Active-8 OOF materialization generated about 15k snapshot rows and 15k L4 rows per cohort. These are immutable offline evidence, not latency-sensitive serving rows.
- D1 has no cross-database joins, foreign keys, or atomic transactions. A split must follow existing query and transaction boundaries.

## Immediate Boundary

Large immutable Active-8 OOF snapshot and L4 evidence is stored as deterministic gzip JSONL in GCS. D1 stores only:

- cohort identity;
- artifact kind and object path;
- SHA-256 checksum;
- row/date counts and date range;
- source manifest checksum.

Artifact readers must verify checksum, schema, cohort, manifest, and row count before using the payload. Promotion gates and model calculations remain unchanged.

## Target Databases

### `stockvision-db` (hot serving and trading)

Keep together until a query-boundary migration proves parity:

- stock/config/canonical current-state tables;
- current predictions, recommendations, screener scalar funnel, and S12 structures;
- orders, fills, positions, reconciliation, and execution ledger;
- scheduler state and idempotency records needed by the live DAG.

These rows participate in same-request joins or trading consistency and must not be split by table size alone.

### `stockvision-research-db` (offline scalar indexes)

Eligible after a dual-read parity phase:

- OOF cohort/fold/materialized-artifact indexes;
- backtest, Optuna, strategy-mining, model lifecycle, and validation metrics;
- verified historical labels and research-only scalar aggregates.

Bulk predictions, snapshots, metrics JSON, and feature matrices remain in GCS/R2. A second D1 is an index/query store, not a replacement blob store.

### `stockvision-audit-db` (operational audit indexes)

Eligible after readers use an explicit audit repository:

- scheduler history beyond the hot status window;
- observability, model-call, debate, and non-trading event scalar indexes;
- R2 evidence pointers and retention checkpoints.

Trading reconciliation and execution evidence stay in the hot DB even if old payloads are archived.

## Migration Sequence

1. Inventory every table writer, reader, join, foreign key, retention rule, and bytes trend.
2. Add `RESEARCH_DB` and `AUDIT_DB` bindings without routing traffic.
3. Backfill scalar rows in bounded chunks; write an immutable migration manifest and checksums.
4. Shadow-read both databases and compare row identity, counts, date coverage, and query results.
5. Route isolated writers through an outbox/idempotency key. Do not dual-write trading transactions.
6. Cut readers only after a full daily/weekly/monthly lifecycle parity window.
7. Archive large JSON to R2/GCS, verify checksum, then delete only confirmed cold payloads from D1.
8. Keep rollback readers until the time-travel and object-retention windows have passed.

## Daily Learning Closure

The production lifecycle is asynchronous and callback-driven:

1. evening chain creates native PIT recommendations and allocator snapshots;
2. verify/lifecycle tasks create labels only after their outcome horizon is known;
3. S12 replay is enqueued and the allocator lifecycle watchdog retries mature missing rows;
4. weekly OOF creates or incrementally extends the immutable Active-8 cohort;
5. daily OOF dispatches `active8-oof-materialize` as a Cloud Run Job;
6. the Job rebuilds L4/Fusion evidence from GCS plus PIT data, writes compact indexes, applies unchanged quality/parity gates, and sends the terminal scheduler callback;
7. failed quality gates preserve the canonical production artifact. They never force promotion.

## Cutover Gates

A database shard cutover is blocked unless all are true:

- zero unresolved cross-database SQL joins on the moved tables;
- writer idempotency and outbox replay tests pass;
- checksum/count/date parity passes for backfill and one complete lifecycle window;
- dashboard, evening chain, replay, OOF, promotion, and retention readers pass shadow parity;
- latency and D1 query counts do not regress materially;
- rollback path and retention manifests are verified.
