# OR15 market-session correction

Wei explicitly approved the local commit, deployment and exact Paper runtime
reapproval of this correction on 2026-10-01, after reviewing the local fix.

## Cause and change

Commit `430f210d1cdebdb9debe95c9ca80edbcdc883d4c` independently restricted
signals to 11:30 and entry to 11:31. No operator approval for those limits was
found in the related OR15 wiki records. Remove both limits and use the existing
`isTwIntradayTradingMinute` session guard, also used by `runIntradayCheck`.
Opening-range, VWAP, closed-bar, freshness and downstream risk checks remain.
This is a Paper behavior change, not historical source equivalence.

## Verification and publication

OR15 tests cover new signals completing at 11:31, 11:32, 12:01 and 13:30,
post-close rejection at 13:31, stale bars and expired signals. The shared session
tests and both Worker TypeScript configurations pass.

Stage the complete new native execution owner and current L3 authority-reader
hash under `ml:active8:paper_runtime_approval:v1:2026-10-01-or15-market-session`.
Retain the previous release key and primary record until candidate admission
passes. Validate and read back every KV write. Switch the exact Cloud Run
revision only after its health and Paper production bundle pass, synchronize
jobs and Modal provenance, and then synchronize the primary approval record.

The native owner declaration is in
`ml-controller/services/native_execution_behavior_release.json`. It grants no
runtime authority. Preserve the original admission, model identities, trading
and risk configuration, all execution variables and frozen KV configuration.
No real-order authority, retraining, maturity transfer or expired-frame repair
is included. A later fresh crossover remains a separate issue.

## Rollback

Retain prior runtime approval in `.tmp/paper-runtime-before-or15-session.json`
and the previous release-specific key without modifying it. The previous
Controller revision reads that prior key. Rollback must restore the complete
reviewed Worker/Controller/Jobs/Modal release set and its primary approval;
never assign the new owner to old NAV registrations.

Raw source: `worker/src/lib/or15VwapEntry.ts`, its tests, `twMarketSession.ts`,
`paperEntryTasks.ts`; baseline `bcab2ced9f8819e6f0b5edfc95bf8382fb73949e`;
Obsidian session `2026-10-01-or15-unrequested-1131-entry-cutoff-correction.draft.md`.
