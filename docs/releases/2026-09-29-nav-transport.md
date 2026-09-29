# NAV transport reuse and release reconciliation

## Preserved production

This release starts at `48f08719a6b637ec918df0af142b500b3ea6ca1b`, including all six morning commits. Worker and frontend runtime code are unchanged. Cloud Run CPU, memory, concurrency, timeouts, scaling and binding settings are unchanged. Only Controller and active8-oof-materialize images are in deployment scope.

## Changes

- Reuse the request-scoped HTTP client for all original D1 raw dependency checks, including retries. Preserve complete query sets and retry/timeout limits.
- Reuse GCS authentication/transport per thread and process. Reload Blob metadata and download the current pinned generation on every read. No evidence or source verdict is cached.
- Keep daily strategy display publication inside the existing bounded cold-read scope. Preserve checksum verification, independent deserialization and scope reset.
- Add numeric timing diagnostics for source identity, transport setup, GCS reads and D1 source validation.

## Baseline release defects

P9 run 36522822463 failed because the old UI source contract still expected markup replaced by the morning UI release. Its assertions now require current L4 gate reasons, L5 status, live S12 preview and historical fallback. No production UI behavior changed.

The morning native Paper implementation has fingerprint `native-paper-v1:7dc732413642f0ed0e5c3653f3a9d0e6513a31c8ccc0e36774fec5d3831f0426`, while the behavior release record retained `3bb2...`. Every native source component remains byte-identical to the morning baseline. Wei explicitly approved this exact fingerprint on 2026-09-29, with release conditional on all checks and CI passing. The version record is synchronized with this existing build. This is a source-build record only: no source equivalence, maturity transfer, Paper runtime admission or A/B successor activation is granted or changed.

## Serving display release gate

The incumbent Worker returned HTTP 503 in 1.781 seconds; its Controller returned HTTP 409 with `strategy_nav_read_model_missing` in 1.438 seconds. The display receipt identity includes the source SHA and controller source bytes, so a Controller release must publish a freshly verified receipt for its own identity before receiving traffic. An old receipt must never be relabeled.

Deployment order: freeze current production/main, pass local and CI gates, construct a fresh display receipt from original sources locally, deploy a no-traffic candidate, publish the verified receipt, compare all 13 challenger responses with the original result, recheck production drift, then cut traffic and update the NAV job image. Configuration and unrelated deployments remain unchanged.

## Verification and limits

The integrated NAV suite has 38 passing cases, including unchanged-source revalidation, generation freshness, separate thread/fork transports, client cleanup, retry equivalence, bounded shared scope and telemetry privacy. The existing three pending-buy preview behavioral tests pass. Full P9 and CI are required before deployment. A no-traffic candidate must pass all challenger display reads before receiving production traffic.

Cold/Weekly work remains outside this release. Production nightly latency and resource usage still require actual runtime evidence; this release does not claim that all OOM/timeout causes are eliminated.
