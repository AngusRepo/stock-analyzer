# Production strategy health — pymoo audit

- As of: `2026-08-16`
- pymoo: `0.6.1.6`
- Scope: active, candidate, shadow, research; read-only diagnostic.
- Guardrail: no threshold relaxation, promotion, weight change, or retraining.

| Strategy | Status | Class | Pareto | Samples | Hit | Avg net | MDD | Dates | LCB90 | Max |corr| |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `alpha223_0009` | active | economic_repair | 1 | 1648 | 0.4818 | 0.0007 | -0.0254 | 13 | -0.0022 | 0.7407 |
| `alpha223_0166` | active | economic_repair | 1 | 2612 | 0.4709 | -0.0006 | -0.0735 | 13 | -0.0058 | 0.9402 |
| `alpha223_0248` | active | pass | 1 | 893 | 0.5106 | 0.0058 | -0.0177 | 13 | 0.0028 | 0.8083 |
| `alpha223_0283` | active | economic_repair | 1 | 1861 | 0.4675 | 0.0002 | -0.0158 | 13 | -0.0016 | 0.5983 |
| `alpha_miner_pymoo_nsga3_novelty_0193` | active | evidence_and_economic_repair | 1 | 1119 | 0.4808 | 0.0045 | -0.0057 | 6 | -0.0005 | 0.8349 |
| `defensive_accumulation_seed_v1` | active | economic_repair | 1 | 1878 | 0.4286 | -0.0063 | -0.1388 | 13 | -0.0148 | 0.9255 |
| `finlab_ai_skill_reversion_value_v1` | active | economic_repair | 1 | 1402 | 0.4864 | 0.0015 | -0.0546 | 13 | -0.0029 | 0.9402 |
| `smrc_vwap_reclaim_v1` | active | economic_repair | 1 | 210 | 0.3095 | -0.0223 | -0.2294 | 13 | -0.0266 | 0.5562 |
| `trend_quality_breakout_fused_v1` | active | economic_repair | 1 | 1917 | 0.4225 | -0.0070 | -0.0875 | 13 | -0.0095 | 0.6329 |
| `alpha_miner_pymoo_nsga3_novelty_0187` | candidate | economic_repair | 1 | 1184 | 0.4713 | 0.0017 | -0.0083 | 13 | -0.0005 | 0.7701 |
| `stock_tech_s08_rsi2_bull_mean_reversion_v1` | candidate | evidence_repair | 1 | 171 | 0.6023 | 0.0340 | -0.0209 | 4 | 0.0047 | — |
| `stock_tech_s08_rsi2_risk_filter_v1` | research | evidence_and_economic_repair | 1 | 635 | 0.5370 | 0.0178 | -0.0269 | 6 | -0.0044 | 0.8083 |
| `stock_tech_s12_multitimeframe_smc_reclaim_v2` | candidate | economic_repair | 1 | 3090 | 0.1796 | -0.0079 | -0.1245 | 17 | -0.0088 | 0.6319 |
| `alpha223_0109` | active | economic_repair | 2 | 1740 | 0.4299 | -0.0022 | -0.0725 | 13 | -0.0078 | 0.9212 |
| `alpha_miner_pymoo_nsga3_novelty_0081` | active | evidence_and_economic_repair | 2 | 144 | 0.5347 | 0.0090 | -0.1777 | 13 | -0.0191 | 0.8349 |
| `stock_tech_s02_52w_dual_momentum_v1` | active | evidence_and_economic_repair | 2 | 133 | 0.4361 | -0.0063 | -0.2037 | 13 | -0.0209 | 0.7236 |
| `stock_tech_s06_nr7_inside_bar_breakout_v1` | active | evidence_and_economic_repair | 2 | 60 | 0.4167 | -0.0085 | -0.1485 | 9 | -0.0256 | 0.6048 |
| `finlab_ai_skill_quality_trend_v1` | candidate | economic_repair | 2 | 422 | 0.4147 | -0.0081 | -0.1580 | 13 | -0.0178 | 0.8062 |
| `finlab_ai_skill_revenue_revision_breakout_v1` | candidate | evidence_and_economic_repair | 2 | 77 | 0.4545 | -0.0004 | -0.0731 | 13 | -0.0102 | 0.7719 |
| `stock_tech_s01_55d_trend_volume_breakout_v1` | shadow | evidence_and_economic_repair | 3 | 77 | 0.3896 | -0.0316 | -0.2732 | 9 | -0.0472 | 0.9193 |
| `stock_tech_s04_ma_deduct_turn_breakout_v1` | shadow | evidence_and_economic_repair | 3 | 86 | 0.2907 | -0.0477 | -0.3959 | 13 | -0.0525 | 0.9193 |
| `stock_tech_s03_vcp_contraction_breakout_v1` | candidate | evidence_repair | — | 0 | — | — | — | 0 | — | — |
| `stock_tech_s05_first_dry_pullback_v1` | candidate | evidence_repair | — | 0 | — | — | — | 0 | — | — |
| `stock_tech_s07_2b_false_break_reversal_v1` | candidate | evidence_and_economic_repair | — | 1 | 0.0000 | -0.0410 | -0.0410 | 1 | — | — |
| `stock_tech_s09_three_soldiers_base_breakout_v1` | candidate | evidence_repair | — | 0 | — | — | — | 0 | — | — |
| `stock_tech_s10_island_reversal_v1` | candidate | evidence_repair | — | 0 | — | — | — | 0 | — | — |

## Failed strategies

- `alpha223_0009` (active): date_return_lcb90_not_positive
- `alpha223_0166` (active): hit_rate_lt_0.48, avg_return_not_positive, date_return_lcb90_not_positive
- `alpha223_0283` (active): hit_rate_lt_0.48, date_return_lcb90_not_positive
- `alpha_miner_pymoo_nsga3_novelty_0193` (active): mature_dates_lt_10, date_return_lcb90_not_positive
- `defensive_accumulation_seed_v1` (active): hit_rate_lt_0.48, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `finlab_ai_skill_reversion_value_v1` (active): date_return_lcb90_not_positive
- `smrc_vwap_reclaim_v1` (active): hit_rate_lt_0.48, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `trend_quality_breakout_fused_v1` (active): hit_rate_lt_0.48, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `alpha_miner_pymoo_nsga3_novelty_0187` (candidate): hit_rate_lt_0.52, date_return_lcb90_not_positive
- `stock_tech_s08_rsi2_bull_mean_reversion_v1` (candidate): mature_dates_lt_10
- `stock_tech_s08_rsi2_risk_filter_v1` (research): mature_dates_lt_10, date_return_lcb90_not_positive
- `stock_tech_s12_multitimeframe_smc_reclaim_v2` (candidate): hit_rate_lt_0.52, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `alpha223_0109` (active): hit_rate_lt_0.48, avg_return_not_positive, date_return_lcb90_not_positive
- `alpha_miner_pymoo_nsga3_novelty_0081` (active): match_rate_lt_0.02, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `stock_tech_s02_52w_dual_momentum_v1` (active): match_rate_lt_0.02, hit_rate_lt_0.48, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `stock_tech_s06_nr7_inside_bar_breakout_v1` (active): match_rate_lt_0.02, mature_dates_lt_10, hit_rate_lt_0.48, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `finlab_ai_skill_quality_trend_v1` (candidate): hit_rate_lt_0.52, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `finlab_ai_skill_revenue_revision_breakout_v1` (candidate): match_rate_lt_0.02, hit_rate_lt_0.52, avg_return_not_positive, date_return_lcb90_not_positive
- `stock_tech_s01_55d_trend_volume_breakout_v1` (shadow): match_rate_lt_0.02, mature_dates_lt_10, hit_rate_lt_0.52, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `stock_tech_s04_ma_deduct_turn_breakout_v1` (shadow): match_rate_lt_0.02, hit_rate_lt_0.52, avg_return_not_positive, max_drawdown_lt_-0.08, date_return_lcb90_not_positive
- `stock_tech_s03_vcp_contraction_breakout_v1` (candidate): match_rate_lt_0.02, samples_lt_30, mature_dates_lt_10, hit_rate_missing, avg_return_missing, max_drawdown_missing, date_return_lcb90_missing
- `stock_tech_s05_first_dry_pullback_v1` (candidate): match_rate_lt_0.02, samples_lt_30, mature_dates_lt_10, hit_rate_missing, avg_return_missing, max_drawdown_missing, date_return_lcb90_missing
- `stock_tech_s07_2b_false_break_reversal_v1` (candidate): match_rate_lt_0.02, samples_lt_30, mature_dates_lt_10, date_return_lcb90_missing, hit_rate_lt_0.52, avg_return_not_positive
- `stock_tech_s09_three_soldiers_base_breakout_v1` (candidate): match_rate_lt_0.02, samples_lt_30, mature_dates_lt_10, hit_rate_missing, avg_return_missing, max_drawdown_missing, date_return_lcb90_missing
- `stock_tech_s10_island_reversal_v1` (candidate): match_rate_lt_0.02, samples_lt_30, mature_dates_lt_10, hit_rate_missing, avg_return_missing, max_drawdown_missing, date_return_lcb90_missing
