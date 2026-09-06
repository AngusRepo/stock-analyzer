# Active-8 unchanged-input release and historical snapshot repair

## Scope

Approved: repair duplicate full-fit versions, missing 8/20 in ML prep, calibration label-known purge; commit/push/deploy. No base-model retrain, promotion, trading or gate relaxation. Prior uncommitted monthly automation patches are excluded.

## Root causes and fixes

1. Full-fit receipt lookup used only cohort plus current execution date. Across weekly dates the same frozen training inputs could generate new versions. Resolve an existing matching input owner across dated receipts, preserving original cutoff, run ID and failure status. Frozen manifest binds source/config/data; different manifests or feature-selection checksums do not reuse. New dispatched receipts carry explicit input identity; old terminal receipts require registry manifest binding.
2. 8/20 source prices were restored, but the current ML snapshot was exported 9/4 before the repair. Physical snapshot prices lack 8/20 while Market now has 1,960 rows. Prep now checksum-verifies snapshot prices against recent source sessions. Missing middle dates invoke the existing snapshot exporter and verify its new immutable snapshot before proceeding. Old snapshots are not rewritten. Business date stays 9/4, actual repair creation time is retained.
3. Calibration included outcomes unknown at holdout start. Both calibration consumers now require label-known strictly earlier than validation start. Old validation receipts re-enter evaluation using existing base models rather than being cached forever; prior registry results are retained under superseded_evaluations and existing immutable D1 validation audits remain intact. No new probability gate or allocation policy was imported from the audit worktree.

## Verification

65 scoped tests initially passed: ensemble calibration, full-fit cross-date integration and stale-calibration evaluation-only handling, snapshot checksum/missing-middle-day/dry-run/recovery readback, existing OOF and prep contracts. Run these again from the clean release checkout before deploy.

## Release and post-release procedure

1. Verify origin/main and current production source; release only listed source/tests/this runbook. Preserve runtime env, secret bindings, commands, schedules, memory/CPU/concurrency and service accounts.
2. Stage Controller image without traffic; smoke-check source provenance. Deploy matching Modal source provenance because prep verifies producer identity. Update affected controller jobs to the image, then switch Controller traffic after health passes. Worker/frontend changes are not part of this scope.
3. Run scripts/repair_active8_source_and_evaluation.py --action prep --cutoff 2026-09-06 --apply in the updated Active-8 job image. This uses prep_only, not base fitting. Verify physical output includes 8/20 and new maturity inventory. No historical forecast is relabeled as genuinely forward.
4. Run the same script with --action evaluation --cutoff 2026-09-06 --cohort-id active8-oof-v9-feature-semantic-source-attested-2026-03-09-2026-08-18-tr60-te10 --expected-run-id universal-20260906T071629-cc23cb3b --apply. Preflight requires the exact completed eight-base-model run; existing owner performs evaluation only, no new training dispatch.
5. Read back Learning validation attempt, calibration purge, model artifact counts, serving pointers, actual new prep dates and image provenance. A negative quality decision is valid closure, not a compute failure. Do not claim new cohort until its real 10-date extension exists. Existing validation window is 17 dates; no new 20-date gate was added.

Raw baseline: audits/outbox/2026-09-06-ensemble-cohort-check/REPORT.md and JSON files. Raw licensed inputs, credentials, screenshots and unrelated audits must not be staged or packaged.
