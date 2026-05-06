# P6 Emerging ML Governance

## Contract

Emerging-board stocks are a research ML segment, not an execution segment.

- `LISTED` / `OTC`: production vote, can enter `pending_buys`.
- `EMERGING`: ML eligible, research-only shadow serving, cannot enter `pending_buys`.
- `UNKNOWN`: blocked until market segment is classified.

## Why Not Share Execution Directly

Emerging-board data has different microstructure: lower liquidity, quote/average-price semantics, weaker opening-price reliability, and higher manual-discretion need. Reusing listed/OTC execution gates without segment governance can overstate tradability and create false pending-buy candidates.

## Current Implementation

- Screener produces `emerging_watchlist` rows separately from tradable candidates.
- ML pipeline includes emerging rows in `build_ml_universe()` for prediction/evidence collection.
- Prediction `forecast_data.stock_meta` stores `market_segment`, `recommendation_lane`, execution eligibility, and segment governance fields.
- Per-model prediction rows also store `stock_meta`, so IC can be diagnosed by segment.
- Model IC tracker persists `last_ic_by_segment` into `model_pool.json`.
- Production `weekly_ic` / `ic_4w_avg` only uses `LISTED` / `OTC` / legacy `UNKNOWN` rows. `EMERGING` rows are diagnostics-only and never affect production model promotion/decay.

## Promotion Boundary

Emerging models cannot promote into production execution by generic model-pool promotion. A future promotion must explicitly create an emerging-specific production policy with:

- enough active days;
- enough segment IC samples;
- stable calibration;
- liquidity/price-shape gates;
- manual approval before execution is enabled.

## Current Thresholds

- Listed/OTC core pool: `min_ic_samples = 50`, `min_active_days = 20`.
- Emerging research pool: `min_ic_samples = 120`, `min_active_days = 60`.

The higher emerging thresholds are intentional because emerging-board labels are noisier and execution cannot be assumed from normal OHLC semantics.

## Independent Emerging ML Strategy

Emerging-board ML should not reuse listed/OTC promotion statistics as-is. It may share feature engineering modules, but it needs an independent segment policy and model card because the label quality, liquidity, price formation, and execution meaning are different.

Training spec:

- Universe: `market_segment = EMERGING` and `recommendation_lane = emerging_watchlist`.
- Label: forward return and rank labels must be computed from emerging-board close/average-price semantics, not listed/OTC executable open-price assumptions.
- Serving mode: research-only prediction and explanation; `eligible_for_pending_buy = 0` until a future manual approval explicitly enables execution.
- Validation: walk-forward by date, segment-only IC, calibration drift, missingness, and liquidity sanity checks.
- Promotion: emerging models promote only inside the emerging research pool; they do not change listed/OTC production weights.

Sizing policy:

- `candidatePoolSize`: cross-section pool used for news/fundamental/correlation enrichment.
- `mlShortlistSize`: listed/OTC shortlist that proceeds into production ML prediction and normal recommendation flow.
- `emergingResearchSize`: emerging-board research shortlist that proceeds into ML prediction for evidence collection but cannot become `pending_buys`.

These sizes are resolved by `worker/src/lib/screenerPolicy.ts` from `trading:config.screener` with optional `ml:adaptive_params.screener` deltas. This keeps P6 free of scattered `slice(0, N)` hardcodes.

Scoring governance:

- Raw chip/technical factors remain interpretable and auditable.
- Cross-section calibration uses percentile plus z-score so a bull market does not make most candidates look near-perfect.
- Calibration is conservative: it can reduce crowded high component scores, but it does not inflate raw chip/technical scores.
