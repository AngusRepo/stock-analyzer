# Audit JSON CPU bounded serialization — 2026-09-28

## Scope
Base production/main33b1025633859ce8ccf0c239e96cf9879d8a7cc6. Materialize only the eligible page keys before quoting payloads and calculating the existing1MiB byte budget. Preserve same-statement snapshot, keyset order, eligibility, hasMore and oversized-row failure, archive checksums and scrub compare-and-swap.

No infrastructure configuration, retention window, source-release permission, migration or native execution identity change. No Cloud Run/Modal deployment or retraining.

## Evidence
-30 targeted tests passed, including8 frozen production SQL parity cases for four targets, limits1/7/100/500, nulls, Unicode, escaped JSON, canonical/latest/failed runs and protected rows.
-Local fixture3001rows: JSON scalar quoting42014→1400 calls for a100-key page, exact complete row output equal. This is not a production latency promise; eligibility scans and missing cursor indexes remain separate review items.
-Oversized first row fails closed; byte-limited page reports hasMore; empty source completes dry-run.
-Both Worker TypeScript configurations pass. Native bundle SHA256 remains9fca05c8206bbee9327179fd89b87389d3a631c60ad39cc92d59f5c585fb9efc, equal to baseline.

## Publication
Full P9 CI is required. Recheck current production/main, merge without overwriting intervening changes, deploy clean canonical main through tools/deploy_worker_with_provenance.mjs, and read back100% Worker source/version.

Raw evidence: audits/nav-cost-closure-20260928. No production historical archive/backfill job is manually triggered by this release. Rollback by reverting this code commit on current main and using the same guarded deploy path.
