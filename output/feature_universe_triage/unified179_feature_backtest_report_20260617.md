# Unified 179 Feature Backtest Report

Data source: existing FinLab research-only artifacts for strategy95 and ML106; no new FinLab rerun.

## Summary

- Active candidates: 179 / raw 201 strategy95+ML106.
- Origin split: strategy95=95, ml106=84.
- Removed high-overlap ML106 aliases: 22.
- Average Sharpe: 0.5015; median Sharpe: 0.6029.
- Average CAGR: 15.34%; median CAGR: 13.77%.
- Average abs MDD: 26.50%; median abs MDD: 25.63%.
- Average abs mean IC 5d: 0.0166.

## Quality Buckets

```json
{
  "monthly_sharpe_ge_1_5": 5,
  "monthly_sharpe_ge_1_0": 34,
  "monthly_sharpe_lt_0": 49,
  "cagr_ge_30pct": 34,
  "cagr_ge_15pct": 84,
  "abs_mdd_le_15pct": 13,
  "abs_mdd_gt_30pct": 57,
  "abs_mean_ic_ge_0_03": 19,
  "abs_mean_ic_ge_0_02": 52
}
```

## Homogeneity

- Before dedupe known cross-pool pairs >=0.8: 74.
- After dedupe known cross-pool pairs >=0.8: 0.
- After dedupe known cross-pool pairs >=0.6: 144.
- Residual max known cross-pool corr: 0.7882.

Computed from stored strategy95-vs-ml106 pair rows with abs rank corr >= 0.6; intra-strategy95 and intra-ml106 pair matrices were not stored in existing artifacts.

## Top 20 By Sharpe

| feature | pool | category | Sharpe | CAGR | MDD | mean IC 5d | coverage |
|---|---:|---|---:|---:|---:|---:|---:|
| size_log_mktcap | strategy95 | size | 1.7618 | 45.22% | -8.29% | -0.0293 | 89.91% |
| tech_atr_14 | strategy95 | technical | 1.6245 | 58.85% | -14.83% | 0.0103 | 94.45% |
| val_sp | strategy95 | valuation | 1.5668 | 31.71% | -12.43% | 0.0168 | 89.72% |
| l1_brokerNetAmount5d | strategy95 | l1_signal | 1.5373 | 53.60% | -13.59% | -0.0075 | 84.32% |
| mom_hl52 | strategy95 | momentum | 1.5290 | 40.28% | -26.65% | 0.0086 | 73.90% |
| mom_macd_trend_10 | strategy95 | momentum | 1.4511 | 50.59% | -24.25% | -0.0043 | 94.77% |
| liq_amihud_21d | strategy95 | volatility | 1.3895 | 42.30% | -20.47% | -0.0172 | 82.81% |
| tech_dma_10_50 | strategy95 | technical | 1.3872 | 48.72% | -25.41% | -0.0056 | 81.05% |
| l1_eps | strategy95 | l1_signal | 1.3846 | 40.86% | -11.67% | 0.0437 | 93.56% |
| vol_share_turnover_21d | strategy95 | volume | 1.3185 | 45.93% | -30.90% | 0.0229 | 82.51% |
| vola_cv_90d | strategy95 | volatility | 1.2880 | 51.34% | -34.14% | 0.0239 | 79.13% |
| mom_reversal_6m | strategy95 | momentum | 1.2480 | 40.35% | -32.68% | 0.0049 | 83.28% |
| margin_balance | ml106 | price_technical | 1.2270 | 50.64% | -21.26% | 0.0010 | 84.90% |
| mom_close_to_52w_high | strategy95 | momentum | 1.1971 | 26.76% | -23.90% | 0.0291 | 73.90% |
| tech_trix_12 | strategy95 | technical | 1.1959 | 43.76% | -23.45% | -0.0073 | 94.76% |
| l1_squeezeMomentum | strategy95 | l1_signal | 1.1882 | 39.07% | -29.13% | -0.0268 | 82.90% |
| l1_macdHist | strategy95 | l1_signal | 1.1775 | 34.54% | -27.32% | -0.0215 | 94.77% |
| mom_9m | strategy95 | momentum | 1.1693 | 41.47% | -34.43% | -0.0007 | 82.66% |
| tech_mtm_10 | strategy95 | technical | 1.1553 | 36.72% | -25.07% | -0.0237 | 84.58% |
| mom_ma50_200_ratio | strategy95 | momentum | 1.1529 | 33.82% | -40.86% | 0.0094 | 75.28% |

## Top 20 By Absolute IC

| feature | pool | category | Sharpe | CAGR | MDD | mean IC 5d | coverage |
|---|---:|---|---:|---:|---:|---:|---:|
| KLEN | ml106 | price_technical | 0.6069 | 17.05% | -38.74% | -0.0504 | 84.90% |
| val_dp | strategy95 | valuation | -0.2446 | -2.31% | -31.03% | 0.0490 | 92.51% |
| l1_eps | strategy95 | l1_signal | 1.3846 | 40.86% | -11.67% | 0.0437 | 93.56% |
| val_ep | strategy95 | valuation | -0.0819 | -1.04% | -26.59% | 0.0428 | 90.80% |
| l1_roe | strategy95 | l1_signal | 1.1162 | 25.80% | -25.26% | 0.0427 | 93.56% |
| vola_realized_12m | strategy95 | volatility | 0.5041 | 11.57% | -25.71% | 0.0423 | 92.23% |
| tech_wma_10_pos | strategy95 | technical | 0.4601 | 11.94% | -38.58% | -0.0411 | 83.76% |
| vola_realized_1m | strategy95 | volatility | 0.3184 | 7.48% | -39.79% | 0.0395 | 94.53% |
| tech_bbi | strategy95 | technical | 0.7150 | 20.48% | -42.72% | -0.0394 | 82.61% |
| tech_ema_12_pos | strategy95 | technical | 0.6142 | 16.78% | -40.26% | -0.0393 | 84.90% |
| vol_cv_volprice_20d | strategy95 | volume | 0.5706 | 9.97% | -20.36% | 0.0351 | 82.90% |
| CORD_10 | ml106 | price_technical | 0.2710 | 5.27% | -22.98% | -0.0341 | 84.90% |
| tech_sma_20_pos | strategy95 | technical | 0.7552 | 22.41% | -34.98% | -0.0335 | 82.90% |
| tech_bias_20 | strategy95 | technical | 0.7552 | 22.41% | -34.98% | 0.0335 | 82.90% |
| KLOW | ml106 | price_technical | 0.5208 | 11.51% | -29.92% | -0.0326 | 84.90% |
| CORR_10 | ml106 | price_technical | 0.4060 | 6.30% | -21.56% | -0.0326 | 84.90% |
| RESI_60 | ml106 | price_technical | 0.6161 | 19.34% | -44.10% | -0.0306 | 84.90% |
| return_3d | ml106 | price_technical | 0.3430 | 7.63% | -30.00% | -0.0304 | 84.90% |
| return_5d | ml106 | price_technical | -0.0392 | -1.13% | -33.77% | -0.0303 | 84.90% |
| RESI_20 | ml106 | price_technical | 0.7536 | 25.30% | -41.05% | -0.0294 | 84.90% |

## Weakest 20 By Sharpe Then IC

| feature | pool | category | Sharpe | CAGR | MDD | mean IC 5d | coverage |
|---|---:|---|---:|---:|---:|---:|---:|
| KSFT2 | ml106 | price_technical | -0.7412 | -6.60% | -21.94% | -0.0264 | 84.90% |
| l1_smcBiasBearish | strategy95 | l1_signal | -0.3583 | -2.63% | -24.59% | -0.0159 | n/a |
| stock_vs_market | ml106 | other | -0.3147 | -3.01% | -26.97% | -0.0244 | 84.90% |
| val_dp | strategy95 | valuation | -0.2446 | -2.31% | -31.03% | 0.0490 | 92.51% |
| tech_tower_3 | strategy95 | technical | -0.2439 | -0.90% | -18.95% | -0.0205 | 100.00% |
| foreign_consecutive_sell | ml106 | chip_margin_flow | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| foreign_net_5d_market | ml106 | chip_margin_flow | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| retail_pct | ml106 | chip_margin_flow | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| short_ratio | ml106 | chip_margin_flow | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| revenue_yoy | ml106 | fundamental_revenue | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| adl_trend_numeric | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| adl_value | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| advance_ratio | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| bull_alignment_pct | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| limit_down_count | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| limit_down_pct | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| us_dxy_return | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| us_gspc_return | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| us_hy_spread | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
| us_hy_spread_chg | ml106 | market_regime | -0.2329 | -0.74% | -18.05% | n/a | 84.90% |
