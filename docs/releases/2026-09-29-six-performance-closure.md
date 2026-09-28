# Six performance fixes — 2026-09-29

Base main: e477168d376040ce0394d086919a0a62b3c3b1f4. Prior CPU release retained.
Wei explicitly approved the exact native build declaration below and authorized commit/push/deploy after local checks and CI pass.

1. Share bounded verified NAV reads across weekly accounting/review.
2. Verify full immutable contexts, project needed fields, reuse checksum-bound compressed sources inside the same128MiB budget.
3. Clean owned GCS temporary files on every exit and execute equivalent Parquet joins/date/symbol filters lazily.
4. Coalesce identical in-flight model-pool reads; preserve fresh per-request authority checks.
5. Persist CPU/GPU checkpoints, release CPU before GPU, and use existing watchdog to resume the original generation/checksum-bound request. Fence concurrent/stale attempts, bound no-progress retries, distinguish uncertain dispatch from terminal failure, reuse identical final publication.
6. Append grouped rows while retaining original order/formulas and eliminating quadratic prefix copies.

## Boundaries
CPU/RAM/GPU/timeouts/concurrency/min/max/warm configuration and model universe remain unchanged.
Cold Learning and Weekly historical source supply are isolated in the original worktree and excluded from this release.
No retraining, historical replay, production deletion, Paper runtime admission or A/B successor activation.

Exact native source identity: native-paper-v1:3bb2cb595b064b4900627f292c4d252ed03ecc4d607f1a984a26e559904264aa.
source_equivalence=false, maturity_transfer=false, efficacy_status=unproven. Existing runtime admission checks remain enforced.
No equivalence certificate is added and no old evidence is relabelled.

## Evidence
Targeted and full-gate receipts: audits/performance-release-20260929 in the shared workspace.
Modal tests exercise actual CPU/GPU and controller entrypoints with fake compute/storage; no paid GPU replay.
Fixed-fixture benchmarks: audits/performance-local-20260928. Context6reads2projections:20.978s to2.612s,6downloads to1,identical output SHA.
Parquet600000rows:42.86ms to19.60ms,additional RSS149.4MiB to40.6MiB,identical rows/schema/SHA.
Worker60000rows:824.8ms to2.34ms,identical grouped output SHA. These are not production p95 or billing savings.

Before release recheck main and active production. Observed controller service4CPU/8Gi; pipeline-v2 job16Gi. Preserve individual observed settings.
Deploy a clean canonical source, verify source/tree/traffic and smoke checks. Rollback by reverting on current main and releasing with the same guards.
