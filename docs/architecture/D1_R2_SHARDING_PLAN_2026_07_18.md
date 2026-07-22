# D1 and Object Storage Boundary Runbook (updated 2026-07-22)

## Current Evidence

- Production `stockvision-db` measured `9,785,389,056` bytes on 2026-07-22, or 97.85% of the 10 GB per-database limit.
- Cloudflare Workers Paid allows 10 GB per D1 database, 1 TB total account storage, and is designed for horizontal scale across multiple smaller databases.
- A D1 database is single-threaded. Long scans and overlapping maintenance tasks reduce total throughput and can produce queue overload or CPU reset failures.
- `D1Database.batch()` is one database transaction. A failed statement aborts or rolls back the sequence.
- R2 lifecycle rules are suitable for cold payload retention, but object deletion is allowed only after checksum and hard-reference verification.

Authoritative platform references:

- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/

## Architecture Decision

Use seven logical data domains with bounded hot D1 windows. Ten-year history belongs in checksum-verified R2 or GCS objects, not in an ever-growing D1 table. A logical domain may gain another physical shard later, but no query may depend on cross-database SQL joins.

| Domain | Binding | Hot responsibility |
| --- | --- | --- |
| core | `CORE_DB` | users, stocks, configuration, watchlists, current recommendation state |
| market | `MARKET_DB` | canonical prices, PIT fundamentals, chips, indicators, market sessions |
| learning | `LEARNING_DB` | predictions, labels, replay, snapshots, OOF and model-learning scalar lineage |
| ops | `OPS_DB` | scheduler state, idempotency, leases, observability, artifact pointers, retention state |
| execution | `EXECUTION_DB` | real orders, fills, positions, reconciliation and execution ledger |
| paper | `PAPER_DB` | paper orders, positions, fills, pending buys and paper audit scalars |
| research | `RESEARCH_DB` | backtests, Optuna, PBO, strategy discovery and offline validation indexes |

The legacy `DB` binding remains the rollback source until each domain reaches `complete`. `MULTI_D1_STRICT=true` is forbidden before every production reader and writer for the selected domain has passed parity.

## Storage Boundaries

### D1

D1 stores rows needed for indexed serving, joins within one domain, idempotency and compact learning/audit scalars. Large JSON, feature matrices, immutable OOF payloads and raw reports do not remain inline.

Capacity states are measured from each binding's query `meta.size_after`:

- below 65%: `healthy`
- 65% to below 75%: `warning`
- 75% to below 85%: `drain`; archive schedulers must make measurable daily progress
- 85% or above: `critical`; block heavy research and artifact promotion, continue live serving and execution

### R2/GCS

- Every archived payload uses a content-addressed key, SHA-256 checksum, schema version, row count and producer run identity.
- D1 payload scrub or row deletion happens only after the object is readable and checksum-verified.
- Active/champion artifact hard references block deletion.
- R2 lifecycle expiration applies only to retention classes with an explicit finite cold window.

## Retention Policy

| Dataset class | D1 hot window | Cold window | Rule |
| --- | ---: | ---: | --- |
| canonical market/fundamental PIT | 504 days | 10 years | archive then delete only when unreferenced |
| predictions, verified labels, S12 replay, allocator/OOF snapshots | 730 days | 10 years | active/champion hard references block retirement |
| real execution evidence | 730 days | 10 years | never delete before verified archive and reconciliation closure |
| strategy/screener/paper large JSON | 90 days | 7 years | keep scalar rows; replace JSON with verified pointer |
| scheduler/projection run summaries | 504 days | 5 years | retain compact status and blocker evidence |
| research/backtest/Optuna/PBO | 180 days | 5 years | immutable artifacts in object storage, D1 keeps indexes |
| failed debug | 90 days | none unless incident-pinned | delete after incident/reference check |
| request debug | 30 days | none | delete |
| staging orphan | 7 days | none | delete after reachability check |

Retention is a lifecycle, not a direct `DELETE`: select bounded keyset, write object, verify checksum, create pointer/hard references, scrub or delete, record counts and errors, then advance the durable high-water mark.

## Write and Query Contracts

- Daily high-write tables use `INSERT ... ON CONFLICT DO UPDATE`; `INSERT OR REPLACE` is prohibited because it deletes and reinserts rows, churns indexes and can erase fields owned by another lifecycle stage.
- Bulk paths use Worker `env.DB.batch()` first and Cloudflare raw batch second. Both transports failing creates a durable retry requirement; production never falls back to per-statement REST writes.
- A model artifact must support matrix inference. Batch incompatibility is a contract failure, not permission to call the model once per symbol.
- Full-history `LEAD/LAG` label scans are replaced by bounded `market_trading_sessions` and `price_horizon_labels_v1` projections.
- Large migrations use monotonic keyset cursors. Runtime pagination may use a bounded offset only when the complete input is strictly capped and indexed.
- D1-heavy maintenance tasks share one lease. Daily serving and execution are not stopped by a maintenance lease.

## Cross-Domain Data Flow

Cross-domain joins and best-effort dual writes are prohibited.

1. The source domain commits its local row and a deterministic `domain_projection_outbox` event.
2. The projector writes the target-domain scalar projection using the event id as the idempotency key.
3. `domain_projection_inbox` records the applied checksum.
4. The source marks the event published only after target acknowledgement.
5. Payloads larger than the scalar projection go to R2/GCS; the event carries the artifact id and checksum.

The price-horizon projection is the first implemented example: market prices and sessions produce compact learning labels consumed by L4, Fusion, recommendation evaluation and OPB without repeated market-table scans.

## Emergency Drain Sequence

The current 97.85% database must be drained before adding broad indexes or launching large backfills.

1. Apply migrations `0074` through `0077`.
2. Deploy Worker and ml-controller code with all optional domain bindings still absent and strict mode off.
3. Run storage integrity and retention dry-runs; compare candidates to canonical/hard-reference sets.
4. Archive and scrub old strategy/screener/paper JSON in bounded chunks.
5. Archive and delete only obsolete screener reruns, superseded non-trading pending events, null-date predictions, stale unreferenced intraday manifests and retired shadow rows.
6. Materialize bounded price-horizon labels and historical market breadth; verify no full-history window scans remain.
7. Re-read `meta.size_after`, rows read/written, query duration and backlog progress. Do not assume deleted SQLite pages immediately reduce file bytes; capacity must show reusable progress and no new growth.
8. If capacity remains critical, provision `MARKET_DB`, `LEARNING_DB` and `OPS_DB` and begin shadow backfill before running research backfills.

## Domain Cutover Order

Each domain is independent and reversible.

1. **ops control plane:** create cutover registry/outbox/inbox and verify scheduler/idempotency state. Keep canonical live leases on legacy DB until final switch.
2. **market:** bounded historical backfill, date/symbol checksums, current-day parity and price/fundamental reader parity.
3. **learning:** backfill scalar labels/snapshots/replay, verify date coverage and L4/Fusion/OPB input parity.
4. **research:** move offline indexes after weekly/monthly lifecycle parity; bulk artifacts stay in GCS/R2.
5. **paper:** cut only after paper position/order reconciliation parity.
6. **execution:** cut after orders/fills/positions/reconciliation are transactionally self-contained in the target DB. No dual-write of broker state.
7. **core:** cut last because it is small and shared by user-facing serving paths.

For each domain:

1. create target database and apply only that domain's schema;
2. add binding/environment id without routing traffic;
3. backfill by keyset in bounded chunks and persist manifest/checksum;
4. shadow-read legacy and target for at least one complete daily lifecycle plus the relevant weekly/monthly lifecycle;
5. require row identity, counts, date coverage and result parity;
6. switch reads, then writes, then set the domain state to `complete`;
7. retain rollback reads through the D1 Time Travel window;
8. remove legacy rows only after object/archive and rollback gates pass.

## Promotion and Rollback Gates

A cutover is blocked unless all are true:

- every table in `worker/schema.sql` has exactly one domain owner;
- zero unresolved cross-database SQL joins for moved tables;
- outbox replay and inbox idempotency tests pass;
- source/target row count, identity, date coverage and checksums match;
- dashboard, evening chain, S12 replay, Active-8 OOF, L4/Fusion, OPB and retention shadow parity pass;
- no increase in D1 CPU resets, queue overloads or callback SLA misses;
- capacity is below 75% or has demonstrated bounded daily drain progress;
- rollback source, restore instructions and artifact checksums are verified.

Rollback changes only one domain state to `rollback`, routes reads/writes back to legacy, and leaves target data intact for diagnosis. Never delete a target shard during rollback.

## Implementation Status

Completed locally:

- date-level callback lease and deterministic verify idempotency;
- durable strategy-learning high-water cursor and UPSERT;
- keyset legacy migration cursors and one global D1-heavy maintenance lease;
- seven-domain table ownership registry with fail-closed unknown ownership;
- optional Worker/Python domain routing with strict-mode guard;
- outbox/inbox and domain cutover state schema;
- retention/capacity schema and per-binding `meta.size_after` telemetry;
- bounded price-horizon/market-session projections and L4/Fusion/OPB consumers;
- true model batch inference contract and binary D1 scrub isolation;
- daily high-write UPSERT conversion.

Not performed without explicit production approval:

- commit, push, migration application and deployment;
- creation of six new production D1 databases and binding ids;
- production archive/delete drain;
- shadow backfills, parity windows and per-domain cutovers;
- enabling `MULTI_D1_STRICT`.
