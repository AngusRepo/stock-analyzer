# September monthly automation — local repair and release boundary

Status: locally implemented/tested; NOT committed, pushed, deployed or remotely repaired in this turn.
Branch: codex/postverify-closure-20260905-v3, base ba77aafb.

## Verified incident and fixes

| Incident | Root cause | Implemented repair |
|---|---|---|
| Mining failed before initial ledger | Research DomainD1Client bypassed the dedicated Worker transport; Modal intentionally has no legacy direct D1 ID | Domain-aware dedicated gateway, no broad credentials/fallback; Worker explicitly selects Research D1 |
| Next mining batch would fail | Python default 250 versus dedicated gateway max 100 | Cap normal chunks to 100; reject atomic batches above 100 rather than silently splitting; validate every acknowledgement |
| Mining KV error but Ops still triggered | Compute leaf identity not bound to durable scheduler parent | Bind in server-side dispatch before compute, settle Ops then KV, exact legacy parent recovery and persisted binding before summary replacement; retries finish partial writes |
| September monthly looked successful on August 27 | Physical future schedule admitted; spawned falsely stored success; old success deduplicated real September trigger | Reject future physical headers (>5 minutes clock skew); never display/admit diagnosed false terminal as completed; offline exact-row quarantine planner |
| Monthly readiness missed missing monthly execution | Only success/skip checked | Current-cycle timestamps, dispatch-versus-terminal semantics, same compute run/cohort in existing Learning freshness ledger; no requirement that quality rejection become promotion |
| Valid no-op reuse could appear missing | Controller returns checksum-verified receipt without running another job | Reproject the same verified date/cadence/cohort into existing freshness ledger and retain full-fit summary; no training or new maturity credit |
| Optuna green despite missing composite | Infeasible screener was skipped, no runtime errors, so aggregate success | Compute remains completed; callback skipped with closure=partial/source_incomplete; readiness blocks full closure. Independent GA staging remains intact; no futile retry of infeasible search |
| Optuna early error could lose callback | Result remained None, then metadata dereferenced result.get | Normalize error result before callback construction, preserve original error and failed closure |

Raw before evidence: audits/outbox/2026-09-06-monthly-diagnosis/REPORT.md and tickets.json, monthly_jobs.json, research_counts.json, root_cause_reproduction.json, GCS/registry receipts in the same directory. Those before-images were not edited.

## Verification performed

- 72 Python tests: mining gateway/domain/job, Research ownership, Optuna ticket/partial/early failure, exact ticket repair, weekly job closure, OOF job callbacks/idempotent summaries.
- 10 Worker suites: monthlyAutomationClosure, strategyDiscoveryPymooSecurity, schedulerExecutionTickets, schedulerExecutionTicketContract, schedulerStatusDisplay, monthlySchedulerClosureContract, parameterCandidatePromotionContract, dataDomainRegistry, active8OofSchedulerClosureContract, active8DailySnapshotPreflight.
- Both Worker TypeScript projects and git diff --check pass.
- Test KV outages intentionally produce error logs/HTTP500; retry assertions verify Ops/KV closure. They are local injected failures, not production errors.
- Offline repair planner validates both diagnosed real ticket rows. It does not connect to production, execute SQL, dispatch any task or promote anything.
- Existing unrelated work and sealed L4/IPO research are untouched.

## Production follow-up — requires explicit release/repair approval

1. Refresh actual production SHA, active compute jobs, same-cycle scheduler/KV/Research/Learning receipts and serving-pointer baseline. Do not overwrite a newer deployed fix or interrupt running jobs.
2. Release scoped Worker + Controller/affected Job images + dedicated Modal mining app. Worker must expose the corrected Research gateway before the mining image is run. No schema migration, frontend build/deploy or changed schedule is required for this patch.
3. Re-read exact Ops rows for:
   - scheduler-ticket-v1-68f0c1b9e37a85d04da99fbf57f7d535d4deb8bb
   - scheduler-ticket-v1-9f12b1b8ba048c701483141d0f4db803c228105f
   Check that no matching compute is active and neither row has gained valid closure. Generate a fresh plan using ml-controller/scripts/plan_future_scheduler_ticket_repair.py with the fresh JSON row-array snapshot, two explicit --ticket-id arguments and an explicit --as-of UTC timestamp. The planner prints SQL only.
4. After approval, apply each generated CAS UPDATE to Ops and read back changes()==1. Repeated/stale plans must change zero rows and stop for review. Read back status=blocked and the complete original row inside metadata.future_ticket_repair_v1.before. No row deletion, reset of attempts or invented success.
5. Reconcile the existing failed mining callback against its server dispatch/unique root, preserving failure history. A mining rerun must use the corrected app and a fresh bounded identity; verify initial Research ledger, terminal ledger, artifact/candidate counts, Ops and KV root identity. Successful quality rejection is distinct from absence of a ledger.
6. Before an Active-8 monthly retry, inspect same-cohort/cutoff full-fit receipt (already shared across cadences) and terminal validation result. Reuse only an attested matching receipt via the normal owner. Do not rerun the same failed ensemble solely to make the UI green. If recovery would launch new ML fitting, explicit retrain approval is required. This turn did not provide it.
7. Do not rerun Optuna's 300 infeasible screener trials simply to change status. After release, readiness recognizes the existing SKIPPED_NOT_READY summary even if the old root remains historically success. A retrospective status correction must carry original source evidence and be separately audited, not masquerade as a new successful candidate.
8. Run readiness after real dependencies settle; inspect correct business date, compute run, cohort, full-fit/quality result, mining ledger and Ops/KV closure. Verify serving pointers/maturity unchanged except changes independently permitted by already-established production evaluators. A live future cycle is not verified by local tests.

## Weekly versus monthly — evidence and proposal, not a cadence change

Current source: Worker runActive8OofLifecycle sets dispatch_full_fit=(cadence != daily). July 26 commit 6d63a6ff already contains that distinction; later August fixes continued it. August wiki records a monthly-retrain owner and weekly OOF work, but no verified decision permanently prohibiting weekly artifacts. The actual September 6 weekly run produced eight model files (version v20260905231708, is_monthly=0); the integrated ensemble failed validation. None of these facts prove that September monthly ran.

Full-fit receipt path is cohort/full_fit/knowledge_cutoff_date.json and is shared across cadences. Existing valid reuse must be preserved, not replaced with another cache owner. L4/L4+ daily exact-candidate evaluation and L3 ensemble validation remain distinct; artifact existence does not imply serving promotion.

Industry evidence:
- Google Cloud MLOps explicitly allows daily/weekly/monthly or event-driven training based on new labels, changing patterns and cost; requires data validation and comparison against the deployed model before release: https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning
- Gu, Kelly & Xiu (2020), Empirical Asset Pricing via Machine Learning, section 2.1/published page 2249: monthly return prediction with annual refitting because many signals update annually and fitting is expensive. This is a concrete research design, not a universal monthly or weekly rule: https://dachxiu.chicagobooth.edu/download/ML.pdf

Recommendation for discussion: daily inference/maturity/evaluation; monthly planned heavy refit/search; weekly monitoring and candidate generation only when new mature data or validated drift justifies it. Retain the same candidate registry, evaluator and immutable maturity evidence. No cadence A/B has established a return advantage for this proposal in StockVision; frequency must not be changed on that unsupported claim. Current schedules and gates remain unchanged by this repair.
