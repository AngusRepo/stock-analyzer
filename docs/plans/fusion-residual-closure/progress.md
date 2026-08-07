# Progress Log: Fusion residual serving closure

## Session: 2026-08-07

### Phase 1: Source-of-truth audit and contract map

- **Status:** completed
- **Started:** 2026-08-07
- Actions taken:
  - Read the planning-with-files skill and restored existing root planning context.
  - Ran session catch-up; it reported no unsynced context.
  - Audited root git status/worktrees and avoided the dirty main workspace.
  - Verified the source clone was clean at `180b3ff5`, then moved to a registered worktree after sandbox ACL failures.
  - Created branch `codex/fusion-residual-closure-20260807` from `origin/codex/fusion-v13-lineage-closure-20260807`.
  - Confirmed the OnlinePortfolioBandit/sparse allocator responsibility boundary from wiki and repo source.
  - Located the mandatory Fusion veto in `recommendation_service._canonical_expected_return_from_row` and the subsequent risk-abstention conversion.
  - Confirmed existing artifact code already implements paired canonical-L4 comparison and multiple-testing infrastructure.
  - Inventoried the real Fusion/allocator/recommendation test modules and reviewed builder constants/features.
  - Switched to apply-patch-authored unified diffs after fixed-CWD patch ACL failures on nested worktrees.
  - Traced selection-label construction and identified the relative-target versus absolute-L4 semantic mismatch that must be resolved before residual fitting.
  - Located the actual materializer service and reviewed artifact construction, policy-value heads, promotion gates, and paired comparisons.
  - Selected the two-head residual hurdle formulation so execution probability remains while L4 retains absolute baseline ownership.
  - Reviewed the actual materializer and tests; confirmed the current variable name says residual while runtime formula still replaces L4 with an absolute two-head policy value.
  - Revised the production design after tracing label ownership: v14 serves one residual-adjustment head; S12-based execution experts remain shadow diagnostics only.
- Files created/modified:
  - `docs/plans/fusion-residual-closure/task_plan.md` (created)
  - `docs/plans/fusion-residual-closure/findings.md` (created)
  - `docs/plans/fusion-residual-closure/progress.md` (created)

### Phase 2: Residual artifact and evaluation contract

- **Status:** completed
- Actions taken:
  - Released cross-layer v14 residual-overlay contract semantics.
  - Replaced the two S12-derived serving heads with one residual-adjustment head.
  - Added paired same-contract L4 comparison, recent two-date deterioration guard, and multiple-testing gate.
  - Kept S12 execution experts only under `shadow_diagnostics` with no promotion effect.
- Files created/modified:
  - See checkpoint 02.

### Phases 3-5: Serving, Worker/UI, and verification

- **Status:** completed
- Actions taken:
  - Valid L4 now remains usable when Fusion is missing/rejected/incompatible; adjustment is exactly zero.
  - Invalid/missing L4 remains risk-abstained and cannot use score/rank/S12 fallback.
  - Worker readiness treats L4/prediction freshness as hard and Fusion overlay/snapshot freshness as warnings.
  - Evidence UI compares `L4 + residual` against same-contract L4 and labels sector/S12-only evidence as diagnostic.
  - Removed dead v13/S12 serving fields and constants.

### Phase 6: Handoff

- **Status:** in_progress
- Local code and verification are complete.
- No commit, push, deploy, retrain, promotion, remote mutation, or order was executed.

### Phase 7: Immutable release and production audit

- **Status:** in_progress
- Wei authorized commit, push, same immutable commit deployment to Worker/Frontend/ml-controller, fresh v14 artifact generation, and reject-only canary.
- Promotion and trading remain prohibited.
- Completed the three-source D1 audit: wiki decision history, repo metric/query implementation, and live execution/paper/legacy D1 state.
- Verified `origin/main` is an ancestor of the release branch; no newer upstream change is being overwritten.
- Verified v14 preserves canonical L4 base ownership, residual-only Fusion, harmless overlay abstention, OPB knob-only control, sparse allocator final ownership, and no S12/score/rank/forced-fill serving fallback.
- Added a v14 source-contract guard so pre-v14 OPB priors cannot warm-start the new residual semantic.
- Updated the refresh route contract: OOF and `promote=false` requests are registry evidence only; only explicit native PASS promotion may mutate Worker config.
- Corrected D1 health semantics so 1,999 active reachable references are explicitly not orphans and capacity drain is reported as the sole blocker.

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Worktree cleanliness | `git status --short --branch` before planning files | Clean branch at latest Fusion closure | Clean at `180b3ff5` | PASS |
| Python targeted regression | refresh route plus 8 artifact/serving/OPB modules | All pass | 148 passed | PASS |
| Worker contract tests | serving/registry/evening/promotion/v14/maturity | All pass | All pass | PASS |
| Worker TypeScript | production + tests tsconfig | No errors | No errors | PASS |
| Frontend TypeScript | `tsc --noEmit` | No errors | No errors | PASS |
| Diff hygiene | `git diff --check` | Clean | Clean | PASS |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-08-07 | Root workspace contains unrelated dirty changes in target files | 1 | Work moved to a clean isolated worktree. |
| 2026-08-07 | Root planning files belong to another task | 1 | Created scoped planning directory without modifying root files. |
| 2026-08-07 | Nested clone blocked subsequent `apply_patch` operations with sandbox ACL errors | 2 | Created a registered Git worktree from the same base. |
| 2026-08-07 | Targeted search referenced nonexistent recommendation test module | 1 | Use repository file inventory to locate actual tests. |
| 2026-08-07 | Fixed-CWD patch helper denied registered nested worktree reads | 3 | Author unified diff with `apply_patch`, verify, and apply mechanically with Git. |
| 2026-08-07 | First findings-02 patch-file creation accidentally exposed an inner patch marker to the outer patch parser | 1 | Recreated the patch file with every nested diff line correctly prefixed as file content. |
| 2026-08-07 | Nonexistent materializer path caused one combined read to abort | 1 | Located `services/allocator_ev_fusion.py`; reran builder read separately. |
| 2026-08-07 | Materializer findings diff used insufficient context and stale line offsets | 2 | Read exact surrounding lines and rebuilt a three-context patch before applying. |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 7 immutable release gate and production D1 audit. |
| Where am I going? | Same-commit deploy, fresh v14 artifact, reject-only canary, D1 root-cause closure, production verification. |
| What's the goal? | Keep valid L4 usable while unvalidated Fusion abstains harmlessly; preserve sparse allocation ownership. |
| What have I learned? | Mandatory Fusion ownership caused structural starvation; one residual head closes it without bypassing sparse/risk gates. |
| What have I done? | Completed v14 contract, serving, readiness, UI, tests, local audit, and recorded the newly authorized rollout boundary. |
