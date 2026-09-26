# S12 durable calibration checkpoint release

## Baseline and authorization

- Reviewed against `origin/main` and production source `338f416aca053da7361877773926978e2471d251` on 2026-09-26. The seven intervening research/native successor commits are retained.
- Worker baseline: `fc4d4ef2-d3ed-431d-9706-f70ca18e82fd`, 100% traffic.
- Cloud Run baseline: `ml-controller-research-338f416aca05`, 100% traffic; image `sha256:322eda1cbe1a0a076f3562573e5a616c88b626fbf1d5dc4b761c0c4a9b57f264`.
- Wei explicitly approved the exact source declaration, deployment preflight, commit/push, full-CI-gated publication, Learning0058, and Worker deployment. Recheck current main and production immediately before publication.
- Source owner: `native-paper-v1:603b0789d9000a289a3c984a63345def64fc55b516f541c6ce91afc5500f7586`.
- Native bundle SHA256: `9fca05c8206bbee9327179fd89b87389d3a631c60ad39cc92d59f5c585fb9efc`.
- This is a source-build declaration only. It grants no Paper runtime or A/B successor activation, source equivalence, maturity transfer, retraining, source deletion, or Cloud Run deployment authority. Existing research validation review: `ml-controller/RESEARCH_VALIDATION_HARDENING.md`.

## Root cause and correction

The bounded cold reader was still called as one synchronous calibration scan. A crash lost read progress and the file bound prevented long-history completion. Re-reading source rows also allowed inputs to change in place. Long explanatory strings dominated scratch storage despite only six fields being used by calibration.

Learning0058 adds five attempt/projection tables with immutable identity guards. Capture freezes the hot projection, lifecycle and cold inventory in one transaction. Each cold page reads at most four files, 4 MiB and 1000 source rows; revision and token guards commit page results and cursor atomically. A queue continuation acknowledges only after its successor is accepted. Recovery limits are preserved. Deferred lifecycle work gets a fresh capture later.

Final evidence reads use 512-row keyset pages. SQLite REAL values retain exact binary64 round trips. Existing numerical calculation, economics, original 100000-ID selection, censor counts and promotion gates are preserved. Publication and scratch cleanup are atomic; idle scratch expires on a later capture after 24 hours without progress. At most two active attempts are admitted, each capped at 64 MiB candidate payload, 100000 candidates, 5000 lifecycle rows and 10000 censor groups. Durable receipt metadata is retained.

## Verification

- 53 Worker tests: real scheduler/queue path, stale delivery, lost lease/ACK, corrupt cold files, deferred recapture, idle cleanup rollback, migration parity and local Cloudflare D1.
- 51 integrated native sandbox/bootstrap/prestart/registration tests on the current main baseline.
- 7 native source identity/equivalence tests, including exact approved fingerprint and unknown-version rejection.
- Both Worker TypeScript configurations and whitespace checks pass.
- Offline retained production sample: 84 rows and four lifecycle records. All-hot, mixed and all-cold outputs have zero numerical difference and SHA256 `45305ebe6d345653b97f2f912baf5c556303f8fe274fc919deb8dff0169c225d`; 48 rows qualify. This small sample lacks date coverage for artifacts; 96/312 synthetic rows across 12 dates separately cover artifact parity.
- 312 release manifests finish in 78 pages with exactly 312 downloads and at most 23 D1 calls per page. Scratch is empty after publication.
- 100005 synthetic source rows preserve the original 100000 selected IDs and all 100005 censor rows.
- Actual sample scratch: 343781 to 29731 bytes (-91.35%). Final reads for 100000 rows: 782 to 197 (-74.81%).
- Local bounded-heap run: 81.89 MiB observed peak, including fixture/compiler overhead. This does not establish production isolate memory, latency, a whole-chain no-error guarantee, or Cloud Run 8/16 GiB sizing.

Raw local audit: `audits/s12-calibration-checkpoint-20260926/REPORT.md`, `parity-and-capacity.json`, and `release/`. Full required CI must pass on the exact PR head before merging.

## Release and rollback

1. Recheck latest main, Worker provenance, Cloud Run revision/image and active calibration leases. Preserve newer production changes.
2. Merge only the reviewed, successful CI head. Use clean canonical main for deployment.
3. Apply only `worker/domain-migrations/learning/0058_s12_calibration_work.sql`; verify all table/index/trigger definitions and migration tracking.
4. The deploy wrapper verifies schema and zero active frozen attempts before changing the source tag. Use the existing provenance wrapper to deploy only Worker.
5. Read back Worker version, 100% traffic, health source/attestation and unchanged Cloud Run baseline. Observe natural scheduling separately from deployment health.

On release failure, stop at the failed gate. A Worker rollback must target the verified preceding production version, never the older patch base; retain the additive schema and receipts. Do not delete source data or enable runtime admissions as a recovery shortcut.

## Remaining limitations

Synchronous administrative consumers retain their existing bounds. Full-scope restore parity, remaining Learning readers, long-term receipt/index bounds, hard-reference retirement, derived backfill, orphan reconciliation and natural scheduled throughput still gate the ten-year storage plan. GA/RFS/B-card/controller changes belong to separate work and are not included here.
