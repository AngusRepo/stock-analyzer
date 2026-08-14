# StockVision P0, L4 Lineage, and 10-Year D1 Closure Plan — 2026-08-14

## Goal

Repair the production-source stock-selection stack so L4/L4+ evidence cadence and ownership are explicit, `candidate_artifact_owner_mismatch` is resolved at the source, the 2026-08-08..2026-08-14 operational week is audited, and the previously confirmed P0/hidden-bypass/dead-code/Multi-D1 issues begin concrete closure without touching unrelated dirty-session changes.

## Source and safety

- Production immutable source: `6e468f5e5a2c572c4985ae07ed402e47853b8d3b`.
- Isolated branch/worktree: `codex/p0-lineage-d1-closure-20260814` at `C:/tmp/stockvision-p0-lineage-d1-closure-20260814`.
- No deploy, commit, push, retrain, promotion, scheduler/job execution, secret rotation, or order unless Wei separately approves it.
- Production inspection is read-only. Never print or persist secret values.

## Closure invariants

1. Every evidence row exposes cadence (`daily`, `weekly`, `monthly`, `event-driven`), role (`serving`, `candidate`, `monitoring`), as-of date, OOF max, owner, and artifact/cohort identity.
2. `Unavailable`, `Missing`, `Pending`, and `Not comparable` must have machine-readable reason codes; UI cannot collapse different causes.
3. Candidate/serving/cohort identities may differ only when the UI and contract explicitly explain why; true owner mismatches fail closed.
4. Infrastructure/data/lineage errors fail the job; quality rejection completes successfully and abstains.
5. Secrets are normalized and redacted before use/logging; raw HTTP exceptions cannot expose Authorization values.
6. Canonical publication uses generation/readback semantics; requested writes/deletes cannot be reported as actual success.
7. Multi-D1 readiness requires active routing, table ownership, migration parity, lineage parity, retention execution, capacity slope, and automated rollback proof.
8. Dead code is removed only after tracked-call and production-reachability evidence.

## Phases

### Phase 0 — Restore source, memory, and planning (`completed`)
- Read relevant Obsidian decisions/incidents and prior full-pipeline audit.
- Freeze production commit and create isolated worktree.
- Load planning, security, and React performance instructions.

### Phase 1 — 2026-08-08..2026-08-14 production incident audit (`completed`)
- Audit Cloud Run Jobs/services, Worker cron/readiness, callbacks/watchdogs, D1/KV evidence, and recommendation freshness.
- Classify each anomaly as infrastructure failure, data gap, quality rejection, stale UI, or expected abstention.

### Phase 2 — L4/L4+ evidence cadence and owner root cause (`completed`)
- Trace `Lineage evidence`, `Offline candidate`, `Production serving pointer`, and `Active-8 causal shadow` backend fields to UI.
- Reconcile 8/8, 8/9, 8/13 dates and missing OOF max.
- Find and fix `candidate_artifact_owner_mismatch` without hiding real mismatch.

### Phase 3 — UI cadence/role contract (`completed`)
- Add explicit daily/weekly/monthly/event-driven labels and serving/candidate/monitoring roles.
- Add reason-specific states and comparison compatibility fields.
- Add backend/frontend contract tests and avoid new eager bundles/renders.

### Phase 4 — P0 security and terminal-state repair (`completed`)
- Normalize/redact callback tokens and HTTP errors; add CR/LF and secret-leak regression tests.
- Add graph error criticality and prevent `completed` with critical node errors.
- Preserve quality-fail-as-success-with-abstention semantics.

### Phase 5 — Hidden/bypass correctness repair (`in_progress`; bounded P0 paths completed)
- Fix false atomic/write/delete closure.
- Fix GCS-indexed OOF audit vacuity and historical-retrain PIT fallback.
- Fix legacy `/recommend` exact signal semantics and paper verdict allowlist/settlement repair boundaries.
- Make degraded Fusion/OPB/persona modes explicit and auditable.

### Phase 6 — Dead code and performance closure (`in_progress`; confirmed dead paths removed)
- Prove reachability before removing legacy route/dependencies/config.
- Remove confirmed unused `react-router` and dead `buyConfThreshold` path if current source still matches.
- Bound homepage overfetch and lazy-load heavy chart code where safe.

### Phase 7 — 10-year Multi-D1 closure (`completed` code-only; strict cutover intentionally blocked)
- Measure current DB sizes/growth/top writers and migration/ownership/parity state.
- Repair registry/migration enumeration and active retention ownership.
- Implement the next safe routing/generation closure step without switching production routing.

### Phase 8 — Verification and handoff (`completed` locally; production actions require separate approval)
- Run scoped tests, typechecks, builds, security scans, D1 contract checks, and diff review.
- Produce severity/root-cause/fix/remaining-risk matrix and exact post-approval production steps.

## Errors encountered

| Error | Attempt | Resolution |
|---|---:|---|
| React skill catalog pointed to a missing `.codex/skills` path | 1 | Located the actual installation under `.agents/skills` and read it completely. |
| Combined skill/status reads exceeded output or returned no output when one command exited 1 | 1 | Re-ran bounded commands separately and paged truncated security references to EOF. |
| Initial plan patch tried to add tracked `progress.md` | 1 | Preserved the historical file and changed the plan patch to append a dated section. |
