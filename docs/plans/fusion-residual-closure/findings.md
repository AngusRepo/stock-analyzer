# Findings & Decisions: Fusion residual serving closure

## Requirements

- Stop requiring the current Fusion artifact to mature before a valid L4 base EV can reach allocation.
- Preserve L4, OnlinePortfolioBandit, sparse_tangent_inverse_risk, risk controls, and pending-buy final-owner checks.
- Fusion may only provide a validated incremental residual adjustment.
- Failed/missing/incompatible Fusion must produce adjustment `0`, not erase an otherwise valid L4 EV.
- Missing/invalid L4 must remain fail-closed; no score/rank expected-return fallback is allowed.
- Compare base-only, current absolute Fusion, and residual Fusion on identical PIT dates/samples/cost assumptions.
- Close tests, automation, lineage, blockers, API, and UI together.

## Current Authorization Boundary

- Authorized: commit, push, same immutable commit deployment to Worker/Frontend/ml-controller, fresh v14 artifact generation, reject-only canary, and read-only production diagnosis.
- Not authorized: promotion, real orders, destructive data cleanup, or production schema mutation that is not an established safe deployment step.

## Research Findings

- Production closure base is clean commit `180b3ff5` on branch `codex/fusion-v13-lineage-closure-20260807`.
- The main workspace is unsafe for this patch because it has extensive unrelated changes, including `ml-controller/graphs/daily_pipeline_v2.py`.
- Repo configuration explicitly pairs `controller=OnlinePortfolioBandit` with `engine=sparse_tangent_inverse_risk`.
- `OnlinePortfolioBandit` chooses allocator knobs only; its module contract states final weights come from the sparse allocator and it cannot submit orders.
- Worker pending-buy execution requires `has_buy_signal=1`, `alpha_allocation.selected=1`, and `alpha_allocation.engine=sparse_tangent_inverse_risk`.
- Existing wiki decisions require no WATCH_BUY fallback, no forced fill, and L4 sparse final-BUY-only execution handoff.
- Prior production diagnosis found v13 Fusion artifacts failing offline while valid upstream L4-formal BUY evidence was starved by mandatory Fusion ownership.
- `recommendation_service._canonical_expected_return_from_row` returns `None` whenever Fusion is missing, rejected, or lacks `primary_expected_return_allowed=true`, even when its payload carries a canonical L4 alpha EV.
- The following resolver path converts that `None` into `expected_return_owner=risk_abstention`, leaving the sparse allocator with zero positive eligible edges.
- The artifact builder already contains paired canonical-L4 comparison, benchmark-panel identity checks, and a multiple-testing gate; residual validation should extend these mechanisms rather than create a second stack.
- Current tests expose validation packet v14 while artifact/contract remain v13, so the residual semantic release must make those versions internally consistent.
- Actual relevant test modules are `test_allocator_ev_fusion_artifact_builder.py`, `test_allocator_ev_fusion_materializer.py`, `test_daily_pipeline_allocator_ev_fusion_contract.py`, `test_allocator_contract_guard.py`, and `test_s12_fusion_v13_end_to_end_contract.py`; there is no monolithic recommendation service test module.
- Builder feature input already includes canonical `l4_expected_return` plus availability flags, score components, sector-alpha, and market context. Residual fitting can reuse the same causal feature snapshot, but the L4 base value must not silently become a second absolute-owner path.
- Existing maturity constants require 40 total dates/10 OOS dates, 1,500 samples, and separate PIT coverage floors. Those remain evidence inputs, but residual application must be gated by incremental paired evidence rather than the current absolute-primary authority flag.
- Current selection labels are cost-net realized returns demeaned by same-date sector, segment, or market cross-section. The current model predicts that relative-alpha target while consuming absolute `l4_expected_return` as an input.
- A naive residual `selection_target - l4_expected_return` would mix relative and absolute semantics. Residual construction must first create a same-date canonical L4 comparison prediction in the identical target space, while serving adjustments must remain in absolute trade-EV units.
- Current paired canonical-L4 comparison directly compares absolute L4 EV with the relative selection target. This is acceptable only as a rank diagnostic, not as the numerical residual definition.
- The current walk-forward pass rule accepts at least half positive folds; the residual gate needs an additional latest-fold deterioration guard so early positive folds cannot hide consecutive recent negative folds.
- The actual materializer is `services/allocator_ev_fusion.py`; there is no separate materializer module despite the test filename.
- v13 already uses two policy-value heads: execution probability and conditional executed return. A coherent residual v14 can preserve both by training conditional residual `executed_net_return - l4_base_ev` and serving `final_ev = p_execution * (l4_base_ev + conditional_residual)`; `adjustment = final_ev - l4_base_ev`.
- Selection residual must be defined in the same relative target space: first demean canonical L4 EV by the same date/sector/segment benchmark, then train on `selection_target - l4_relative_base` and evaluate `l4_relative_base + predicted_residual`.
- Historical S12 replay outcomes remain an allowed research label source under the retired-serving decision; this change does not restore S12 live/evening serving authority.
- Artifact application must require both residual-head validation and incremental paired superiority. Otherwise overlay status is abstained and adjustment is exactly zero.
- The v13 materializer already calls its output `execution_residual_adjustment`, but it actually sets `expected_return = p_execution * absolute_conditional_return`; L4 is only a feature and receives no baseline-preservation guarantee.
- Rejected Fusion payloads currently erase the EV (`expected_return=None`) and keep owner `allocator_ev_fusion`, which triggers the recommendation resolver's risk-abstention path even when `l4_alpha_ev` is present.
- Residual v14 must reject pre-v14 contract/semantic pairs before inference, require a valid L4 base, and return explicit `overlay_status`, `base_expected_return`, `fusion_residual_adjustment`, and `final_expected_return` fields.
- Existing tests intentionally require non-primary artifacts to be rejected. The new contract must distinguish `artifact rejected as overlay` from `candidate rejected for allocation`; only the former falls back to L4.
- v13 is the only supported Fusion contract in both Python and Worker. v14 requires an atomic cross-layer contract update; v13 must not be interpreted with residual semantics.
- Because production S12 serving is retired, S12 replay may remain a research diagnostic but cannot qualify a production residual overlay. Promotion labels must come from canonical downstream paper/execution outcomes with valid lineage.
- Changing expected-return ownership from absolute Fusion to L4-with-overlay invalidates owner-specific OnlinePortfolioBandit priors. The existing controller safely falls back to static priors on owner mismatch until new reward evidence exists.
- Recommendation fallback must preserve the valid L4 value and attach Fusion blockers as overlay diagnostics; only invalid/missing L4 invokes risk abstention.
- `_samples` currently records `trade_pnl_pct` as audit-only and trains both execution heads exclusively from S12 replay labels. Native SQL loads `trade_pnl_pct`, while OOF SQL explicitly sets it to NULL; neither path loads `trade_outcome` for canonical non-execution labels.
- v14 native rows must load a canonical execution observation field and outcome-known lineage. OOF rows without actual execution observations can train selection diagnostics but cannot qualify the production execution overlay.
- Worker `selectionReferenceEvidence` and `updateOrchestrator` hard-code `expected_return_owner=allocator_ev_fusion`; both must accept the new L4-base-with-residual owner without weakening sparse final-owner checks.

## D1 Production Findings

- The 2026-08-06 wiki closure states execution/paper pending migrations were 0 and true orphans were 0 after commit `091c9825`; it did not claim the historical legacy bytes were already drained.
- The v14 worktree base `180b3ff5` is a direct descendant of latest `origin/main` `9b147c40`, which already contains `091c9825`; current source history is not missing that fix.
- Live execution D1 has exactly `0001_execution_baseline.sql`, all 3 expected domain tables, and 0 pending baseline migrations.
- Live paper D1 has exactly `0001_paper_baseline.sql`, all 11 expected domain tables, and 0 pending baseline migrations.
- Live legacy D1 has 1,999 active reachable hard references and 0 true orphan references. Active references must never be labeled as orphans.
- Live canonical execution and paper closure artifacts are ready and checksum-verified through business date 2026-08-07.
- The 2026-08-07 06:45 storage-health payload reports migration pending 0/0, true orphans 0, lineage ready, retention progress 45, and only `capacity_status=drain` as the health blocker.
- Legacy D1 was 8,011,993,088 bytes (80.1199%) at the scheduler run and 8,004,182,016 bytes at the read-only audit, so drain is progressing but remains above the admission threshold.
- Today's retirement automation succeeded and archived/deleted another 1,799 obsolete screener rows in its final window; evidence and strategy durable drains both report no remaining candidates.
- The repeated “26 pending / 1,999 orphan” statement is a stale pre-fix interpretation, not current production truth. Runtime health now needs explicit blocking reasons and an explicit active-reference-is-not-orphan contract to prevent recurrence.

- The remaining three drain cohorts are one obsolete screener row, one superseded pending execution event protected by paper-shadow parity, and one old screener-evidence cohort that has no eligible noncanonical migration candidate. They explain why physical drain is incomplete without implying a routing regression.
- `artifactLifecycle` now returns exact `blocking_reasons`, `capacity_only_blocker`, and `artifact_active_references_are_orphans=false`; active hard references can no longer be rendered as lineage orphans.
- The only current storage-health blocker is legacy capacity drain. Execution/paper schema readiness and canonical daily lineage are already ready, so migration/orphan warnings must not be repeated from the old global-catalog query.
- Physical removal of the protected execution event or canonical old evidence requires a separately reviewed archive/read-through parity change; this release intentionally makes no destructive production data mutation.

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Separate estimator lineage from final decision ownership | L4/Fusion estimate EV; sparse allocator alone owns selection and weight. |
| Encode `base_ev`, `residual_adjustment`, `final_ev`, and overlay decision explicitly | Prevent hidden fallback and make UI/runtime audits exact. |
| Treat every pre-residual artifact as incompatible with the residual serving contract | Prevent v12/v13 absolute prediction semantics from leaking into the new overlay. |
| Keep Fusion adjustment at zero unless paired OOS incremental evidence passes | An unvalidated overlay must be harmless while it learns. |
| Preserve the two-head hurdle model but residualize the conditional return head against L4 | Retains execution realism while preventing Fusion from relearning the entire absolute EV owner. |
| Use canonical paper/execution outcomes for production residual validation; keep S12 replay diagnostic-only | A retired execution policy cannot be the promotion label owner for a production overlay. |
| Supersede the two-head production formulation with one L4 residual-adjustment serving head; retain execution experts as shadow diagnostics | Source audit proved both v13 heads are trained from retired S12 replay policy labels, so they cannot own v14 production promotion. |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| Root planning files contain unrelated Strategy Discovery work | Preserve them unchanged and use a scoped plan directory in the isolated worktree. |
| Initial search referenced nonexistent `ml-controller/tests/test_recommendation_service.py` | Inventory actual tests with `rg --files` before targeted reads. |
| Nested clone sandbox allowed initial creation but denied subsequent patches | Use a registered Git worktree; do not bypass `apply_patch`. |
| Nested Git worktrees expose a fixed-CWD patch-helper ACL limitation | Author unified diffs with `apply_patch`, verify with `git apply --check`, then apply mechanically inside the isolated worktree. |
| Expected `allocator_ev_fusion_materializer.py` does not exist and the combined read hid the builder output | Located `services/allocator_ev_fusion.py` with `rg --files` and reran builder read separately. |

## Resources

- `ml-controller/services/allocator_ev_fusion_artifact_builder.py`
- `ml-controller/services/recommendation_service.py`
- `ml-controller/services/alpha_framework.py`
- `ml-controller/services/online_portfolio_bandit.py`
- `ml-controller/graphs/daily_pipeline_v2.py`
- `worker/src/lib/pendingBuyOrchestrator.ts`
- `worker/src/lib/dataQualityMonitor.ts`
- `frontend/src/pages/PipelinePage.tsx`
- Obsidian: `02_Products/StockVision/Sessions/2026-08-07-fusion-no-buy-structural-starvation-production-diagnosis.draft.md`
- Obsidian: `02_Products/StockVision/Sessions/2026-06-14-stockvision-l4-sparse-final-buy-only-pending-execution-handoff.draft.md`

## Visual/Browser Findings

- None.
- The D1 scheduler warning must not be declared closed from code state alone; live migration tables, routing timestamps, and orphan-age distribution are required evidence.
