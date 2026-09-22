# 2026-09-22 storage, model-pool and strategy evidence follow-up

Status: locally verified repair package; NOT deployed; ten-year closure remains false.
Base: 046097ee88e36e6ecaa3cabf08a6b3c98756f046. No retraining, model promotion, real orders, retention deletion or remote writes in this follow-up.

## Model pool
Production lineage returns 502 because Controller raises `active8_nav_current_configuration_changed_or_unverified`. The only changed publication configuration field is native execution owner. The storage deployment changed the compiled Worker and cold transport identity, although model/allocator/risk/trading settings are unchanged. Reconstructed 6f295db5 exactly reproduces the frozen owner 7000a685...; deployed 046097ee exactly reproduces aae2cc6a....

Repair: exact component-vector storage equivalence certificate, preserving raw runtime hashes and unknown-build rejection; ASGI sync reads offloaded to bounded threadpool; original publication evidence read in two complete SQL snapshots, with schema recheck, instead of individual HTTP queries per table; per-request HTTP connection reuse. Worker model-pool GET timeout 60s; mutation endpoints unchanged. No NAV efficacy test or model gate is waived.

Read-only production-data test: 8/8 models eligible. Last measured read 27.44s, before adding the repeated schema query. Earlier profile: 54 to 26 D1 queries, with four schema rechecks now restored for concurrent schema protection. Cold-start latency still requires production measurement after release.

Actual old/current native binaries: settlement/retry/next-day and equity snapshots have identical state, checksums, frame receipts and zero fabricated NAV credit. Unknown native source remains invalid.

## Strategy lab
At 2026-09-22 17:11 TW formal prices ended 9/21. Signal 9/14 enters 9/15 and five-session exit is 9/21. Latest mature signal 9/14 is therefore consistent with the current price frontier.

9/15-18 have original canonical references and matrices but no decision/stat projections. Production recovery reader also incorrectly only accepts `strategy-labeler-v1`; real stored artifacts use the formal v3 labeler. Exact downloaded 9/15 artifact and route packet verify locally after accepting the explicit current/legacy formal producer versions: 802 candidates, 26 strategies, 20,852 cells, 802 route scores, valid checksum and parity. Unknown versions remain rejected. This reader fix alone is NOT proof of complete historical evidence rebuild; normal recovery must still verify PIT, policies, grid and outcome coverage.

## Retention
Add source-local immutable release receipts in the SAME D1 batch as exact row deletion. Lost HTTP/OPS acknowledgement can no longer make a committed archive unreadable. Receipt failure, concurrent row changes or partial deletion roll back. Immutable receipt rejects replace/update/delete.

Add additive migrations: Market0008, Learning0050, Execution0003, Ops0015, Research0005. Schema generation retains immutable migration equality checking and reviewed existing schema content. No migration applied remotely.

Cold market projection preserves natural-key hot precedence, checksum, original schema/date/value semantics and explicit errors. Connected to snapshot export and original backtest price/indicator/chip readers. Cold predictions also reach OOF native PIT input. Consumer closure remains incomplete: Worker historical consumers, reference protection, reconciliation, automatic catch-up, OOF/legacy executors and capacity proof must close before general deletion is enabled. Scheduler remains preflight only.

## A/B
No eligible allocation/execution pair or paired daily journal row exists in the production read. Three 9/21 manifests are allocation contexts only. New prices alone cannot create the first formal A/B NAV observation. Late B slate may be evaluated diagnostically but cannot become retrospective prospective evidence.

Existing review policy: fixed first look at 10 paired portfolio sessions, final checkpoint 30, total family alpha .05 split across the two looks, stationary bootstrap block length 3, 19,999 resamples and family correction. These are checkpoints, not guaranteed significance. Do not count stock rows as independent daily portfolios or repeatedly test daily at 5%.

## Verification
- Python grouped regressions: 70 passed (native, exact publication transaction, OOF materializer, snapshot job contracts); separate 53 passed (retention readers, environment, NAV readiness); market reader integration 8 passed. Groups overlap, not an assertion of 131 unique tests.
- Worker targeted 17 passed; source-release 4 passed again after replace protection test.
- Worker source and test TypeScript checks passed.
- Schema generation repeat build test passed; immutable migration drift check retained.
- Read-only actual production lineage and actual R2 9/15 artifact verification passed locally.
- No closure claim or production result inferred from local tests.

Raw source pointers: `audits/closure-followup-20260922/` (local only, excluded from release): runtime.json, diagnosis.json, lab-gap.json, lab-recovery-preflight.json, lab-artifact-index.json, local-pool-proof.json, release-native-parity.json. Earlier release receipt: `audits/ab-capacity-closure-20260922/storage-after-runtime.json`.
