# Unified 179 Pairwise Similarity Matrix

Scope: research-only feature similarity and prune recommendation; no production registry mutation.

## Summary

- Features materialized: 137.
- Pair rows: 9316.
- Pair corr >= 0.9: 32.
- Pair corr >= 0.8: 116.
- Pair corr >= 0.75: 194.
- Pair corr >= 0.6: 459.
- Drop research candidates: 1.
- Watch/not-selector candidates: 54.

## Cluster Leaders At Corr >= 0.75

| component | size | leader | leader score |
|---:|---:|---|---:|
| 1 | 34 | mom_macd_trend_10 | 0.7711 |
| 2 | 9 | size_log_mktcap | 0.9282 |
| 3 | 7 | mom_hl52 | 0.7167 |
| 4 | 4 | CNTP_20 | 0.5936 |
| 5 | 3 | CNTP_5 | 0.4581 |
| 6 | 3 | KMID | 0.5424 |
| 7 | 3 | l1_bestOrderBlockStrength | 0.4220 |
| 8 | 2 | IMIN_20 | 0.4631 |
| 9 | 2 | KLOW | 0.5004 |
| 10 | 2 | KUP2 | 0.4651 |
| 11 | 2 | foreign_5d | 0.5257 |
| 12 | 2 | l1_eps | 0.9227 |

## Drop Research Candidates

| feature | pool | category | action | reason | Sharpe | CAGR | MDD | IC | nearest | corr |
|---|---|---|---|---|---:|---:|---:|---:|---|---:|
| l1_smcBiasBearish | strategy95 | l1_signal | drop_research_candidate | negative_sharpe_and_cagr,duplicate_cluster_weaker_than_leader | -0.3583 | -2.63% | -24.59% | -0.0159 | l1_smcNetScore | 0.7504 |

## Watch / Not Selector Candidates

| feature | pool | category | action | reason | Sharpe | CAGR | MDD | IC | nearest | corr |
|---|---|---|---|---|---:|---:|---:|---:|---|---:|
| l1_liquiditySweepBullish | strategy95 | l1_signal | watch_not_selector | weak_ic_and_weak_backtest | -0.1536 | 0.05% | -15.88% | -0.0050 | l1_smcBullishScore | 0.1838 |
| ma60_bias | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.0174 | -0.23% | -36.54% | -0.0191 | tech_keltner_pos_20 | 0.7584 |
| CNTN_5 | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.0443 | 1.58% | -24.26% | 0.0102 | CNTD_5 | 0.9338 |
| l1_squeezeRelease | strategy95 | l1_signal | watch_not_selector | weak_ic_and_weak_backtest | 0.1320 | 2.93% | -25.11% | -0.0035 | l1_bosBullish | 0.1213 |
| val_dp | strategy95 | valuation | watch_not_selector | negative_sharpe_and_cagr | -0.2446 | -2.31% | -31.03% | 0.0490 | val_ep | 0.5995 |
| tech_tower_3 | strategy95 | technical | watch_not_selector | negative_sharpe_and_cagr | -0.2439 | -0.90% | -18.95% | -0.0205 | l1_smcBullishScore | 0.7190 |
| KLOW2 | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | -0.0799 | 0.63% | -13.61% | -0.0132 | KLOW | 0.8567 |
| KUP | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.5043 | 13.23% | -36.24% | -0.0086 | KUP2 | 0.8732 |
| tech_mfi_14 | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.2925 | 6.51% | -31.58% | 0.0219 | mom_rsi_14 | 0.7965 |
| tech_cci_20 | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.3836 | 8.16% | -33.20% | -0.0194 | tech_bbands_pctb_20 | 0.9767 |
| val_ep | strategy95 | valuation | watch_not_selector | negative_sharpe_and_cagr | -0.0819 | -1.04% | -26.59% | 0.0428 | val_dp | 0.5995 |
| tech_sar | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.4967 | 12.82% | -40.81% | -0.0224 | tech_ema_12_pos | 0.7643 |
| KSFT | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.6016 | 15.90% | -46.77% | -0.0227 | vwap_bias | 0.9996 |
| vola_realized_1m | strategy95 | volatility | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.3184 | 7.48% | -39.79% | 0.0395 | l1_bbBandwidthPct | 0.8298 |
| vwap_bias | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.6548 | 18.59% | -45.15% | -0.0227 | KSFT | 0.9996 |
| tech_kdj_j_9 | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.4655 | 9.56% | -32.94% | -0.0223 | tech_kd9_k | 0.8873 |
| CNTN_20 | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.2887 | 5.31% | -12.79% | -0.0094 | CNTD_20 | 0.9052 |
| return_3d | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.3430 | 7.63% | -30.00% | -0.0304 | vol_money_flow_5d | 0.7882 |
| RESI_60 | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.6161 | 19.34% | -44.10% | -0.0306 | tech_bias_20 | 0.7828 |
| tech_wma_10_pos | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.4601 | 11.94% | -38.58% | -0.0411 | tech_ema_12_pos | 0.9035 |
| tech_psy_12 | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.6254 | 14.71% | -26.64% | 0.0089 | CNTP_20 | 0.7729 |
| BETA_60 | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.8969 | 30.88% | -36.71% | 0.0025 | l1_closeAboveMa60Pct | 0.7838 |
| tech_donchian_pos_20 | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.7201 | 16.45% | -29.88% | -0.0182 | tech_williams_r_14 | 0.9218 |
| tech_ema_12_pos | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.6142 | 16.78% | -40.26% | -0.0393 | tech_bbi | 0.9963 |
| tech_bbi | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.7150 | 20.48% | -42.72% | -0.0394 | tech_ema_12_pos | 0.9963 |
| RESI_20 | ml106 | price_technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.7536 | 25.30% | -41.05% | -0.0294 | tech_wma_10_pos | 0.7692 |
| l1_diTrend | strategy95 | l1_signal | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.6174 | 15.26% | -28.87% | -0.0272 | tech_keltner_pos_20 | 0.8475 |
| tech_bbands_pctb_20 | strategy95 | technical | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.7211 | 14.84% | -27.75% | -0.0251 | tech_cci_20 | 0.9767 |
| vol_money_flow_5d | strategy95 | volume | watch_not_selector | duplicate_cluster_weaker_than_leader | 0.8227 | 24.06% | -39.24% | 0.0284 | tech_wma_10_pos | 0.8504 |
| mom_ma50_200_ratio | strategy95 | momentum | watch_not_selector | duplicate_cluster_weaker_than_leader | 1.1529 | 33.82% | -40.86% | 0.0094 | mom_reversal_6m | 0.8728 |

## Artifacts

- long_csv: `output\feature_universe_triage\unified179_pairwise_similarity_long_20260617.csv`
- square_matrix_csv: `output\feature_universe_triage\unified179_pairwise_similarity_matrix_20260617.csv`
- components_csv: `output\feature_universe_triage\unified179_similarity_components_20260617.csv`
- prune_candidates_csv: `output\feature_universe_triage\unified179_prune_candidates_20260617.csv`
- summary_json: `output\feature_universe_triage\unified179_pairwise_similarity_summary_20260617.json`
- report_md: `output\feature_universe_triage\unified179_pairwise_similarity_report_20260617.md`
