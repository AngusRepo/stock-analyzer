# Scheduler and cold-cache runtime repair

Scope: Paper operational repair; no model promotion, retraining, account reset or live orders.

- Preserve production ae5dcc4a Controller and ee40fe42 Worker source ancestry.
- Four logical rescore times (10:00,11:00,12:00,12:30 Taipei) use two physical schedules; delayed deliveries use original ScheduleTime.
- Setup atomically queues allocation and delayed 08:30 broker-health stages. Published plans cannot mask terminal health failure. Retire duplicate 08:50 trigger after Worker verification.
- Reuse verified small trading_config projections across premarket resume. Keep manifest/locator verification and file-cache limits; no large raw cache retention.
- Seal/read phase timings expose actual I/O; allocator source/policy remains unchanged.
- Service minimum instances are the sole min owner; all routed/tagged revisions must have min0. Preserve CPU/RAM and trading warm windows.

Exact Paper key: `ml:active8:paper_runtime_approval:v1:2026-10-08-scheduler-cost-repair`.
Native identity: `bd5664cc7791ac18797c66f8c181709a18a2a3118badbecd19fb749433dbd1f5` -> `8f77122d01678fe7d17ed193570fc7a4ecaa9607f425ab1273ecd74deeb93fbd`.
Separate explicit KV approval is required. Preserve prior grant and Full MLP cutover evidence; only native execution identity changes. No efficacy/maturity transfer.

Local validation: 84 Python tests,28 Worker tests,Worker type checks,exact current Paper configuration/read-only admission simulation passed.
Raw receipts: audits/cloud-run-cost-20261007/remediation/release/ (main workspace).

Release: stage no-traffic Controller, verify resources/env and candidate Paper admission, update dependent Jobs without execution, route Controller, deploy Worker with provenance, then apply exact Scheduler changes. Do not start training or reset any pipeline.
Rollback: route prior Controller and restore archived Job/Scheduler definitions with matching old source; retain old KV grant.
