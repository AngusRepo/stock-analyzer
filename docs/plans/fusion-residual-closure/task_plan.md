# Task Plan: Fusion residual serving closure

## Goal

Replace the mandatory absolute Fusion veto with a single-owner pipeline where validated L4 base expected return remains usable, Fusion can only add a validated residual adjustment, OnlinePortfolioBandit controls allocator knobs, and sparse_tangent_inverse_risk remains the final BUY/HOLD/weight owner.

## Current Phase

Phase 7 (production rollout and D1 source-of-truth audit authorized)

## Phases

### Phase 1: Source-of-truth audit and contract map

- [x] Trace artifact build, promotion, serving, allocation, Worker handoff, and UI call paths from commit `180b3ff5`.
- [x] Inventory existing v13 schema/version checks and blockers that assume Fusion is the primary owner.
- [x] Record touched-file boundaries and preserve unrelated behavior.
- **Status:** completed

### Phase 2: Residual artifact and evaluation contract

- [x] Compare L4 base against L4 plus residual on identical PIT OOS rows, dates, labels, and costs.
- [x] Train/evaluate the residual target against legal PIT L4 base EV without score/rank fallback.
- [x] Require paired OOS incremental evidence and multiple-testing-adjusted validation before applying an adjustment.
- **Status:** completed

### Phase 3: Serving and allocator integration

- [x] Serve `final_ev = l4_base_ev + validated_fusion_adjustment`.
- [x] Make failed/missing/incompatible Fusion abstain with zero adjustment while invalid/missing L4 remains fail-closed.
- [x] Preserve OnlinePortfolioBandit as knob controller and sparse_tangent_inverse_risk as the sole final allocation owner.
- **Status:** completed

### Phase 4: Worker/API/UI evidence closure

- [x] Preserve the L4 sparse final-BUY-only pending execution handoff.
- [x] Expose base EV, adjustment, final EV, overlay status, artifact lineage, and honest blocker ownership.
- [x] Update pipeline/model-pool UI so Fusion shadow failure is visible but not shown as an L4 blocker.
- **Status:** completed

### Phase 5: Tests and local verification

- [x] Add unit and contract tests for PASS, abstain, missing, incompatible, and invalid-base paths.
- [x] Run PIT/no-leakage, artifact builder, recommendation, allocator, Worker, frontend, and type checks proportional to touched scope.
- [x] Run diff/owner audit to prove no score fallback, no forced fill, no top-k leak, and no order/deploy action.
- **Status:** completed

### Phase 6: Handoff

- [x] Summarize root cause, changed files, test evidence, remaining production actions, and rollback boundary in the scoped checkpoint.
- [x] Write/update the required Obsidian session draft without secrets after production authorization/state is known.
- [x] Stop before commit/push/deploy/retrain/promotion/order pending explicit approval.
- **Status:** completed

### Phase 7: Core-spirit and immutable-release gate

- [x] Re-run source and contract audit proving L4 base ownership, residual-only Fusion, harmless abstention, sparse allocator final ownership, and no S12/score/rank/forced-fill serving fallback.
- [x] Fetch remote history and integrate any newer upstream commits without overwriting unrelated work.
- [ ] Commit and push one immutable source commit containing the reviewed v14 implementation.
- **Status:** in_progress

### Phase 8: Same-commit production deployment

- [ ] Deploy Worker, Frontend, and ml-controller from the exact same immutable commit.
- [ ] Verify deployed provenance/revisions and basic health without triggering orders.
- **Status:** pending

### Phase 9: v14 artifact and reject-only canary

- [ ] Generate a fresh v14 residual artifact from canonical PIT/OOF evidence without promotion.
- [ ] Run reject-only canary and preserve pass/fail evidence; do not promote or place orders.
- [ ] Verify serving remains L4-only with zero adjustment when the candidate is rejected or unavailable.
- **Status:** pending

### Phase 10: D1 migration/drain/orphan root-cause closure

- [x] Trace the scheduler metric implementation and compare it with production execution/paper/legacy D1 state.
- [x] Distinguish unapplied schema migrations, historical drain backlog, new-routing regression, and metric/query defects.
- [x] Fix code/config defects within the authorized release; do not mutate production schemas or delete data without an explicit safe migration decision.
- **Status:** completed

### Phase 11: Production verification and durable handoff

- [ ] Re-run scheduler/readiness evidence after deployment/canary.
- [ ] Record exact immutable commit, deployment identities, artifact/canary outcome, D1 root cause, residual risks, and rollback boundary.
- [ ] Finish the Obsidian session draft/MOC update without secrets.
- **Status:** pending

## Key Questions

1. Where does v13 currently convert missing/failed Fusion ownership into `fusion_primary_required` or zero eligible allocation?
2. Which artifact fields can be extended safely, and which require a new schema/version to prevent semantic mixing?
3. How can the residual overlay abstain without weakening the L4, sparse allocator, pending-buy, and order-risk contracts?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Work in `.worktrees/fusion-residual-closure-20260807` on branch `codex/fusion-residual-closure-20260807` from clean commit `180b3ff5` | The main workspace contains extensive unrelated dirty changes, and the nested clone hit repeatable sandbox ACL failures after initial writes. |
| Keep one final allocation owner | Avoid split-owner ambiguity: estimators provide EV, OnlinePortfolioBandit selects knobs, sparse allocator owns final selection/weight. |
| Fusion failure means adjustment abstention, not automatic BUY | Safety remains fail-closed at L4 evidence, sparse allocation, risk, and execution layers. |
| Use a new artifact semantic version | An absolute-return Fusion artifact must not be silently interpreted as a residual adjustment artifact. |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Root workspace has extensive unrelated dirty changes in target files | 1 | Selected an isolated worktree from the deployed closure commit. |
| Root planning files belong to another unfinished task | 1 | Created task-scoped planning files under `docs/plans/fusion-residual-closure/`. |
| Nested isolated clone rejected subsequent `apply_patch` reads with sandbox ACL errors | 2 | Created a registered Git worktree from the same clean commit; do not use shell write workarounds. |
| Fixed-CWD patch helper also denied reads inside a registered nested worktree | 3 | Author standard diffs through `apply_patch`, verify with `git apply --check`, and apply mechanically in the isolated worktree. |
| Source search named nonexistent `ml-controller/tests/test_recommendation_service.py` | 1 | Switch to `rg --files` inventory before reading recommendation tests. |
| Nested patch marker was not escaped while creating a diff file | 1 | Recreated the diff as pure add-file content with every inner line prefixed. |
| Expected a nonexistent materializer implementation file and lost one parallel read output | 1 | Located the actual service with file inventory and reran the builder read independently. |

## Notes

- Wei authorized commit, push, same-commit Worker/Frontend/ml-controller deployment, fresh v14 artifact generation, and reject-only canary. Promotion and trading remain out of scope.
- Re-read this plan before each major contract decision.
- Log every failed validation and do not repeat identical failed actions.
