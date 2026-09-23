# A/B repeated-picks investigation — 2026-09-23

## Conclusion and boundary
No evidence of copied daily A predictions or allocator shortlist truncation in September 21/22 frozen records. B has only one published allocation date (September 22 retrospective research), so a two-day B overlap claim cannot be verified. A real display-reader bug was found and fixed separately; it did not cause the repeated A holdings.

## Formal evidence
- API: `api.json`; raw plans: `plans.json`; checksum-indexed manifests: `manifests.json`.
- September 21 A: 2485 25%, 3576 25%, 4763 9.647431%, 4534 5.250184%, 2855 3.102384%.
- September 22 A: 2485 25%, 3576 25%, 3691 13%, 6443 5%; both dates cash 32%.
- Two shared names; 40% of prior five / 50% of new four; Jaccard 2/7 = 28.57%. Their 50% NAV is 73.53% of the 68% invested target, explaining visual/weight persistence.
- Routed candidate pools 672 -> 679; 640 common names, zero identical full predictions, zero identical L4 feature checksums. Full source/output execution checksums and signal dates differ.
- Formal raw-score changes: TimeXer 577/577 comparable; ExtraTrees, LightGBM, TabM, XGBoost 640/640; GNN 615/640; PatchTST and iTransformer 567/569 each. Some rounded/constant outputs coinciding is not reused entire predictions.
- 2485 five-session expected gross: 1.099765% -> 1.042636%; 3576: 0.603647% -> 0.769140%. They remain EV ranks 1 and 2; both hit 25% name cap. These are model forecasts, not realized returns or performance validation.
- Both accounts empty, no locked holdings; OPB zero matured rewards / cold_start_base; original A reward ledger empty. B replay resetting an empty ledger did not introduce a reward-history asymmetry for this date.
- Allocator proof: all 672/679 candidates evaluated, preselection false, objective gaps 3.3955e-9 / 0 against 1e-8 tolerance. B September22 also evaluates all679, gap9.8972e-9.
- B September22: 6538, 6141, 6168, 3189, 6213. September21 B unavailable. September23 both unavailable: API never falls back to September22 for an explicit September23 request.
- Actual pending-buy API returns execution date September23 / source_reco_date September22. The A/B UI deliberately requests September22, and labels that signal date. Calendar viewing days are not independent model signal days. Daily recommendation endpoint requires Google-admin auth (service-token read received401); no browser-admin bypass was attempted.

## Verified display bug and fix
`parent_plan_id` in `l4_distribution_runtime.run` means prior active account plan, including a previous day's plan. A/B reader mistakenly required it NULL, hiding valid new-day and same-day revised plans. September22 plan8a7a6a99 has parent4076eb57; published research packet happened to supply A, masking this reader defect. Remove NULL condition; select latest same-date account1 plan, preserving date/identity/weight validation. Exact-date B/cold research selection unchanged. No allocation, risk, model, execution, or NAV eligibility changes.

## Verification
Real SQLite regression includes first day, next-day inherited plan, same-day revised plan, missing future day, missing B. Existing research checksum/date failures and weight checks pass; Worker production/test typechecks pass. Raw evidence remains local; only compact summary and this report are versioned. No retraining or GPU execution.
