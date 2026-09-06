# Current task — L4 confirmed bug closure and parallel IPO shadow — 2026-09-05

## Current authorization and invariants

- User explicitly rejects shrinking L4: retain its current multifeature learning/reranking and promotion mechanism.
- Repair every confirmed Phase2–8 defect with root-cause tests and truthful closure status.
- Add parallel IPO shadow accumulation and a same-page L4/IPO comparison; no IPO production allocation/promotion.
- Never reuse known Ridge outcomes as IPO prospective maturity; freeze identity before outcomes and preserve old evidence.
- User approved commit, push, deploy and required follow-up repairs on 2026-09-06 after reviewing the exact scope. No formal ML retrain, IPO promotion, manual serving-pointer moves or real orders.
- Keep existing frontend sign-color edits and all sealed research files unchanged.
- Worktree: codex_ev_fix_wt, branch codex/postverify-closure-20260905-v3, start HEAD e861b0a6.

## Current phases

1. Source/docs/memory and exact defect/consumer inventory — completed.
2. Repair archive pointer, technical owner parity and true 20-session volume window — completed locally; cross-runtime regression passes.
3. Repair canonical session completeness, exact horizon validation, dataset receipts and PIT revision reads; prepare bounded verified data repair — completed locally, including legacy immutable-taxonomy reads and expected-count acknowledgements. Real historical repair NOT executed.
4. Implement immutable IPO shadow registration/prediction/maturity/readback on existing daily lifecycle — completed locally; isolated SQLite lifecycle, retry, no-lookahead and hook-order tests pass.
5. Implement L4/IPO same-page observation with separate whole-history and paired-date metrics — completed locally; API/typechecks/build and 1280/390/320px browser checks pass with synthetic data.
6. Run regression, lifecycle retry/idempotency, UI checks; closure matrix and authorized handoff — completed locally: 275 Python tests, 10 Worker suites, typechecks/build; closure/release report written.
7. Approved release: verify origin/main and actual production lineage; preserve unrelated work — in_progress.
8. Restore complete source calendar/8-20 source data, apply bounded additive migrations, preserve before images and read back — pending.
9. Commit scoped source/tests, push main safely, deploy Worker/controller/Frontend with immutable provenance — pending.
10. Reproject only incorrect labels, verify frozen evidence/pointers, current daily chain and IPO/UI freshness; record production closure — pending.

## Current errors

- Initial combined skill/worktree output truncated: re-read selected skills and status separately; no broad worktree cleanup.
- React skill path under .codex missing: correct installed path is .agents/skills/vercel-react-best-practices.
- Existing planning files are historical: preserve below, prepend dated current plan.

---

# Historical plan — StockVision P0, L4 Lineage, and 10-Year D1 Closure Plan — 2026-08-14

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
