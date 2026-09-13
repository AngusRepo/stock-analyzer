# Verified findings

- Baseline 04c21c05: production pre-outcome evaluations remain 9 dates / 5443 samples per original L4/Fusion candidate, 2026-08-25 through 2026-09-04 (previous-turn D1/API readback and correction wiki).
- expectedReturnNavMaturity.ts demotes old promotion metrics and replaces generic progress with NAV. Frontend hides pre-outcome in collapsed diagnostics. Data retention is not promotion-readiness retention.
- NAV is PENDING/nav_candidate_not_registered with zero sessions, not nine NAV sessions. No evidence authorizes historical costed NAV reconstruction.
- expected_return_rolling_diagnostic.py refits purged OOF diagnostics on extended data and explicitly forbids promotion. walk_forward.py calls it before frozen-candidate evaluation; exceptions abort materialization, so operational completion depends on successful diagnostics even though efficacy decisions do not.
- Frontend currently renders the identical offlineDiagnosticMetrics twice. Remove this duplicate, preserve one collapsed diagnostic section.
- User choice requested for actual promotion migration; do not claim UI repair fulfills no-rematurity requirement.
- Additional native migration defect: paired_nav_daily_candidates.py retained only a NAV envelope's nested diagnostic. First NAV-only refresh of a legacy forward envelope replaced its summary with not_run. Fixed exact-ID/checksum preservation, keeping original dates and NAV count independent; future diagnostic timestamps are rejected.
- _promotion_gate summaries omitted evaluated_as_of_date. Set only during actual cross-section evaluation; NAV-only refresh must preserve the previous diagnostic timestamp rather than advance it.
