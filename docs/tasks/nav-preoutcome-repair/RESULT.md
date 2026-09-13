# NAV / pre-outcome local repair result

Base: 04c21c0566716beac0334e9cbb25f7a8e0859d00. Local uncommitted changes only.

## Repaired

1. Native NAV-only refresh now retains an original forward-gate envelope for the exact artifact ID/checksum instead of overwriting it with `not_run`. Second refresh retains the nested diagnostic unchanged. Wrong candidate does not inherit dates. This is data migration, not promotion authorization.
2. Cross-section evaluation records its own business date. NAV-only refresh does not move that date; future-dated retained evidence is rejected.
3. L4/Fusion card shows preserved pre-outcome maturity independently of NAV readiness. Unknown/blocked metrics do not become zero or valid dates. Original metric notes remain; old gate decision is explicitly diagnostic.
4. Rolling diagnostics are collapsed, their role is explained, and duplicate offline diagnostic metrics are removed. Pre-outcome evidence is visible, not hidden in generic diagnostics.

## Verified preserved production snapshot (not a new live poll)

Source: codex_ev_fix_wt/audits/outbox/2026-09-12-nav-full-release/final-state.json.
React render using the saved production API packet:

| Stage | Pre-outcome dates | Latest mature prediction | NAV dates | NAV decision |
|---|---:|---|---:|---|
| L4 | 9 | 2026-09-04 | 0 | PENDING |
| L4+ | 9 | 2026-09-04 | 0 | PENDING |

Earlier verified D1 readback: each original candidate has 5443 samples, prediction dates 8/25 through 9/4. No production data writes this turn.

## Meaning and actual consumers

- Pre-outcome: evaluate the SAME immutable candidate against outcomes unavailable when its eligible prediction evidence was frozen. Continues accumulating original candidate evidence; not actual portfolio NAV.
- Rolling cohort: extended data -> purged temporal refit -> diagnostic packet in expected_return_shadow_evaluation_packets -> dashboard. The diagnostic model can differ; it is not a frozen candidate or a production artifact.
- Rolling quality does not directly authorize promotion, allocation weights or buys. However walk_forward.py invokes its build/archive before frozen-candidate evaluation, and receipt closure requires both shadow packets. Build/archive failure therefore affects materialization and closure retry; do not say it has zero workflow impact. Native NAV primary refresh runs separately before OOF prep.
- NAV: paired costed portfolio-accounting evidence remains the actual promotion authority. This patch does not replace it with a legacy or rolling fallback.

## Verification

- Python 62 passed: test_nav_candidate_decision.py, test_expected_return_rolling_diagnostic.py, test_nav_daily_primary.py, test_nav_candidate_owner_isolation.py, test_expected_return_candidate_forward_evaluator.py.
- Worker 9 passed: expectedReturnMaturityEvidence, expectedReturnShadowScope, pipelineDecisionMaturity. Original Python fixture additionally exercises actual SQLite -> Worker NAV read model and promotion evidence.
- Frontend 7 passed; saved-production-snapshot React render passes for both L4 and Fusion.
- Worker production/test TypeScript checks, frontend TypeScript/build and git diff whitespace check passed.
- Initial environment-only failures and resolutions preserved in progress.md. No test bypass; tests generated only small isolated fixtures, not market efficacy data.

## Historical boundary, resolved 2026-09-13

Showing nine pre-outcome dates does NOT fulfill the promise of no new NAV waiting. Old cross-sectional dates cannot be counted as original costed portfolio NAV sessions. User was asked whether existing registered candidates should retain the original pre-outcome promotion protocol or all candidates should remain under NAV authority with separate accumulation. No answer received at this point. Do not deploy as a complete no-rematurity fix, infer approval for grandfathering, or declare full migration closure.

Wei subsequently decided: "統一標準，導入NAV就不該導入半套吧". This supersedes the unresolved choice above: existing and new candidates use NAV as their sole efficacy promotion authority. Do not implement grandfathering or re-enable pre-outcome/rolling efficacy vetoes. Keep original diagnostic evidence separate, and retain PIT/source integrity, accounting reconciliation and execution risk controls. Actual original NAV sessions must accumulate where none exist; data retention is not a claim of no new waiting.

Source inspection confirms native candidate registration requires the frozen allocation_context -> exact candidate allocation_pair -> lifecycle path. Merely retaining an artifact or pre-outcome dates does not register a NAV comparison. The prior zero-context snapshot explains why its NAV candidate was unregistered; no new live production query or completed future-market-cycle verification is claimed here.

No commit, push, deploy, retrain, forced promotion, historical NAV fabrication, real/paper orders or serving-pointer changes performed.
