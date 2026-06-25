# S2 Replacement Portfolio Experiment

Portfolio construction: equal-weight strategy sleeves. Each sleeve equal-weights its selected stocks; scenarios replace one active sleeve with S2 instead of adding S2 as extra exposure.

## Base Period Summary

| scenario_id | removed_id | portfolio_cagr | portfolio_sharpe | portfolio_MOD | avg_daily_turnover | baseline_all_period_jaccard | baseline_return_corr | avg_unique_positions | latest_unique_positions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline_active11 |  | 0.0001 | 0.0885 | -0.3684 | 0.2596 | 1.0000 | 1.0000 | 1304.5699 | 1333 |
| replace_trend_following_with_s2 | trend_following_seed_v1 | 0.0188 | 0.1948 | -0.3588 | 0.2501 | 0.9959 | 0.9903 | 1302.3012 | 1328 |
| replace_breakout_vol_expansion_with_s2 | breakout_vol_expansion_seed_v1 | 0.0141 | 0.1688 | -0.3603 | 0.2497 | 0.9988 | 0.9898 | 1306.0988 | 1335 |
| replace_weakest_trend_breakout_with_s2 | alpha_miner_pymoo_nsga3_novelty_0187 | 0.0675 | 0.4572 | -0.3434 | 0.2161 | 0.9610 | 0.9892 | 1256.6663 | 1289 |

## Delta vs Baseline

| scenario_id | period_label | delta_cagr | delta_sharpe | delta_MOD | delta_avg_daily_turnover | baseline_all_period_jaccard | baseline_return_corr |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline_active11 | base_2023_2026 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 |
| replace_trend_following_with_s2 | base_2023_2026 | 0.0187 | 0.1063 | 0.0096 | -0.0095 | 0.9959 | 0.9903 |
| replace_breakout_vol_expansion_with_s2 | base_2023_2026 | 0.0140 | 0.0803 | 0.0081 | -0.0099 | 0.9988 | 0.9898 |
| replace_weakest_trend_breakout_with_s2 | base_2023_2026 | 0.0674 | 0.3686 | 0.0250 | -0.0435 | 0.9610 | 0.9892 |
| baseline_active11 | robust_2020_2026 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 |
| replace_trend_following_with_s2 | robust_2020_2026 | 0.0175 | 0.1147 | 0.0350 | -0.0103 | 0.9960 | 0.9904 |
| replace_breakout_vol_expansion_with_s2 | robust_2020_2026 | 0.0150 | 0.0976 | 0.0288 | -0.0108 | 0.9988 | 0.9898 |
| replace_weakest_trend_breakout_with_s2 | robust_2020_2026 | 0.0539 | 0.3139 | 0.0966 | -0.0440 | 0.9629 | 0.9894 |
| baseline_active11 | base_2023_2026_cost_plus_50bps | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 1.0000 |
| replace_trend_following_with_s2 | base_2023_2026_cost_plus_50bps | 0.0223 | 0.2252 | 0.0255 | -0.0095 | 0.9959 | 0.9903 |
| replace_breakout_vol_expansion_with_s2 | base_2023_2026_cost_plus_50bps | 0.0193 | 0.1896 | 0.0228 | -0.0099 | 0.9988 | 0.9898 |
| replace_weakest_trend_breakout_with_s2 | base_2023_2026_cost_plus_50bps | 0.0921 | 0.7235 | 0.1036 | -0.0435 | 0.9610 | 0.9892 |

## S2 vs Removed Owner Overlap

| scenario_id | removed_id | s2_vs_removed_return_corr | s2_vs_removed_latest_jaccard | s2_vs_removed_all_period_jaccard | s2_vs_removed_position_phi_corr |
| --- | --- | --- | --- | --- | --- |
| replace_trend_following_with_s2 | trend_following_seed_v1 | 0.6176 | 0.0041 | 0.0079 | 0.0343 |
| replace_breakout_vol_expansion_with_s2 | breakout_vol_expansion_seed_v1 | 0.5999 | 0.0080 | 0.0073 | 0.0219 |
| replace_weakest_trend_breakout_with_s2 | alpha_miner_pymoo_nsga3_novelty_0187 | 0.5579 | 0.0065 | 0.0046 | 0.0071 |

## Scenario Members

### baseline_active11
- `alpha_miner_pymoo_nsga3_novelty_0081`
- `alpha_miner_pymoo_nsga3_novelty_0187`
- `alpha_miner_pymoo_nsga3_novelty_0193`
- `alphabuilders_multifactor_revenue_quality_momentum_v1`
- `breakout_vol_expansion_seed_v1`
- `defensive_accumulation_seed_v1`
- `finlab_ai_skill_broker_accumulation_reclaim_v1`
- `finlab_ai_skill_quality_trend_v1`
- `finlab_ai_skill_revenue_revision_breakout_v1`
- `finlab_ai_skill_reversion_value_v1`
- `trend_following_seed_v1`

### replace_trend_following_with_s2
- `alpha_miner_pymoo_nsga3_novelty_0081`
- `alpha_miner_pymoo_nsga3_novelty_0187`
- `alpha_miner_pymoo_nsga3_novelty_0193`
- `alphabuilders_multifactor_revenue_quality_momentum_v1`
- `breakout_vol_expansion_seed_v1`
- `defensive_accumulation_seed_v1`
- `finlab_ai_skill_broker_accumulation_reclaim_v1`
- `finlab_ai_skill_quality_trend_v1`
- `finlab_ai_skill_revenue_revision_breakout_v1`
- `finlab_ai_skill_reversion_value_v1`
- `stock_tech_s02_52w_dual_momentum_v1`

### replace_breakout_vol_expansion_with_s2
- `alpha_miner_pymoo_nsga3_novelty_0081`
- `alpha_miner_pymoo_nsga3_novelty_0187`
- `alpha_miner_pymoo_nsga3_novelty_0193`
- `alphabuilders_multifactor_revenue_quality_momentum_v1`
- `defensive_accumulation_seed_v1`
- `finlab_ai_skill_broker_accumulation_reclaim_v1`
- `finlab_ai_skill_quality_trend_v1`
- `finlab_ai_skill_revenue_revision_breakout_v1`
- `finlab_ai_skill_reversion_value_v1`
- `stock_tech_s02_52w_dual_momentum_v1`
- `trend_following_seed_v1`

### replace_weakest_trend_breakout_with_s2
- `alpha_miner_pymoo_nsga3_novelty_0081`
- `alpha_miner_pymoo_nsga3_novelty_0193`
- `alphabuilders_multifactor_revenue_quality_momentum_v1`
- `breakout_vol_expansion_seed_v1`
- `defensive_accumulation_seed_v1`
- `finlab_ai_skill_broker_accumulation_reclaim_v1`
- `finlab_ai_skill_quality_trend_v1`
- `finlab_ai_skill_revenue_revision_breakout_v1`
- `finlab_ai_skill_reversion_value_v1`
- `stock_tech_s02_52w_dual_momentum_v1`
- `trend_following_seed_v1`
