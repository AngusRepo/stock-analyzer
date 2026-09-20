# TimeXer market coverage source repair — 2026-09-21

Status: source data repair verified; repaired-model OOF/full-fit and A/B registration pending. Not a closure claim.

## Root cause
- Formal A source d9949ab8 completed five OOF windows. TimeXer mean IC +0.02302, coverage 53.5872%; coverage gate failed. It was not an overall negative-ranking failure.
- First window TimeXer covered 1,034 LISTED and only 3 OTC symbols. PatchTST covered 1,018 LISTED / 799 OTC. Formal features lacked OTC dates 2026-04-15 and 2026-04-16, while canonical sequence prices contained them.
- A two-session feature gap violated the existing maximum one-session stale-exogenous contract across the 168-observation context. 840 symbols hit 2026-04-16. Price-only retained the same availability eligibility as the accepted comparison; no eligibility relaxation has been made.
- Family mapping omitted TimeXer in both Controller/service validation policy. Added learned_sequence; 80% coverage floor unchanged.

## Verified repair
- Existing archived FinLab source: gs://stockvision-models/finlab/v4/backfill/finlab-v4-3y-20260701-1782951243148/raw/daily_price/{open,high,low,close,adj_close,volume,value}.parquet.
- Insert-only SQL SHA256 40e85f2eca09128dcae662cadef2ebeeadbfa7b3446105a3f8ccb57b196f4d2e, ON CONFLICT(stock_id,date) DO NOTHING.
- Production stockvision-market-db: 2,165 missing rows inserted (1,737 OTC / 428 TWSE); every new value matches source. All 2,167 existing rows unchanged. Total for both dates 4,332.
- Actual source-date eligibility replay over the five original windows: 51,567 -> 90,275 rows. This checks input eligibility only, not retrained performance.
- Broader local inventory also observed isolated one-day count gaps 2025-08-01 and TWSE 2026-04-24. These are not repaired here and were not the two-session exclusion root cause; retain as separate data quality findings rather than claiming all historical rows complete.

## Prevention and validation
- Formal TimeXer adapter derives expected per-date/per-market counts from checksum-verified canonical shards. Train checks each market against the unchanged 80% floor before building any model; full-fit checks latest ten mature dates.
- Uses Polars grouped counts, retains immutable source identity, exact eight-model roster, official architecture, training recipe, signed EV, NAV gate and risk policy.
- 20 initial focused tests passed; 21 additional coverage/roster/policy/insert-only tests passed. Training-entry test proves a missing OTC panel fails before model construction. No replacement artifact is claimed from these tests.
- Source repair readback: coverage-source/repair-verification.json. Full source hashes: coverage-source/receipt.json. Input-only replay: coverage-two-date-counterfactual.json.

## Follow-up
- New immutable snapshot execution dataset-snapshot-export-p4wpk uses original 2026-09-18 business date, actual creation time, 1,280-day request. Earlier kl7z6 failed before export due PowerShell comma quoting; corrected invocation uses a single quoted argument.
- Original A full-fit was automatically dispatched at 05:44 Taiwan (fc-01M30CESSFJBAGH3S82EBKYMJ7), original B OOF running. Both use pre-repair sealed inputs; neither can substantiate repaired results. Keep old artifacts for diagnosis.
- Rebuild repaired source prep, use distinct explicit cohort IDs via existing /walk_forward/run (no parent-fold reuse after feature history correction), complete both candidates and native paired accounts, then final deployment/readback. Do not redeploy Modal while old orchestrators can dispatch new children into a different source version.
