# Active Owner Consolidation + AlphaMiner Adapter Run

Generated: 2026-06-25

Scope:
- Universe: FinLab `sii_otc`
- Window: 2023-01-01 to 2026-06-15 for FinLab base metrics
- Robustness proxy: 2020-01-01 to 2026-06-15
- Source outputs:
  - `output/finlab_technical_strategy12_backtests/technical_strategy12_sii_otc_20230101_20260615_results.csv`
  - `output/finlab_active_candidate_strategy_compare/active11_candidate12_sii_otc_20200101_20260615_pairwise.csv`
  - `output/finlab_active_candidate_strategy_compare/active11_candidate12_sii_otc_20200101_20260615_period_metrics.csv`
  - `output/finlab_active_candidate_strategy_compare/active11_candidate12_sii_otc_20200101_20260615_cost_stress.csv`

Adapter note:
- `alphaMinerPymoo0081Score`, `alphaMinerPymoo0187Score`, `alphaMinerPymoo0193Score` are now materialized by direct StrategySpec adapter reconstruction.
- Formula source is the promoted `canonical114_mresample` alphaMiner formulas.
- Directions follow the original bakeoff factor meta.
- `us_sentiment_score` remains a constant-zero proxy in this adapter; 0193 is research-only until non-constant normalized US sentiment is materialized.

## AlphaMiner D1 Base Results

| strategy | CAGR | Sharpe | MOD | Calmar | Total Return | Avg Daily Positions | Latest |
|---|---:|---:|---:|---:|---:|---:|---:|
| alpha_miner_pymoo_nsga3_novelty_0081 | -51.34% | -6.53 | -91.79% | -0.56 | -91.65% | 341.67 | 341 |
| alpha_miner_pymoo_nsga3_novelty_0187 | -55.57% | -7.48 | -94.00% | -0.59 | -93.90% | 272.30 | 302 |
| alpha_miner_pymoo_nsga3_novelty_0193 | 16.95% | 0.87 | -39.56% | 0.43 | 71.57% | 519.34 | 539 |

## AlphaMiner Robustness Proxy

| strategy | 2020-2026 proxy CAGR | proxy Sharpe | proxy MOD | cost+50bps CAGR |
|---|---:|---:|---:|---:|
| alpha_miner_pymoo_nsga3_novelty_0081 | -40.56% | -2.60 | -96.17% | -74.99% |
| alpha_miner_pymoo_nsga3_novelty_0187 | -44.16% | -2.66 | -97.38% | -76.49% |
| alpha_miner_pymoo_nsga3_novelty_0193 | 10.18% | 0.54 | -39.77% | 10.60% |

## Active Strategy Base Results

| strategy | CAGR | Sharpe | MOD | 2020-2026 proxy CAGR | cost+50bps CAGR |
|---|---:|---:|---:|---:|---:|
| alpha_miner_pymoo_nsga3_novelty_0193 | 16.95% | 0.87 | -39.56% | 10.18% | 10.60% |
| alphabuilders_multifactor_revenue_quality_momentum_v1 | 10.91% | 0.64 | -36.84% | 11.68% | -0.58% |
| trend_following_seed_v1 | -3.33% | -0.33 | -42.43% | -4.88% | -19.30% |
| finlab_ai_skill_quality_trend_v1 | -3.66% | -0.26 | -46.41% | -9.70% | -23.41% |
| finlab_ai_skill_reversion_value_v1 | -5.50% | -0.82 | -35.60% | -9.45% | -24.90% |
| finlab_ai_skill_revenue_revision_breakout_v1 | -8.40% | -0.35 | -55.38% | -19.96% | -42.10% |
| breakout_vol_expansion_seed_v1 | -9.16% | -0.68 | -47.74% | -5.23% | -21.19% |
| defensive_accumulation_seed_v1 | -14.18% | -1.31 | -53.71% | -2.83% | -29.00% |
| finlab_ai_skill_broker_accumulation_reclaim_v1 | -35.88% | -4.02 | -80.34% | -26.36% | -57.12% |
| alpha_miner_pymoo_nsga3_novelty_0081 | -51.34% | -6.53 | -91.79% | -40.56% | -74.99% |
| alpha_miner_pymoo_nsga3_novelty_0187 | -55.57% | -7.48 | -94.00% | -44.16% | -76.49% |

## Highest Active-Active Similarity

| pair | return corr | latest Jaccard | all-period Jaccard | phi |
|---|---:|---:|---:|---:|
| breakout_vol_expansion_seed_v1 / trend_following_seed_v1 | 0.987 | 0.503 | 0.568 | 0.721 |
| alpha_miner_pymoo_nsga3_novelty_0193 / alphabuilders_multifactor_revenue_quality_momentum_v1 | 0.979 | 0.267 | 0.222 | 0.151 |
| defensive_accumulation_seed_v1 / finlab_ai_skill_broker_accumulation_reclaim_v1 | 0.979 | 0.239 | 0.263 | 0.366 |
| alpha_miner_pymoo_nsga3_novelty_0081 / alpha_miner_pymoo_nsga3_novelty_0187 | 0.972 | 0.357 | 0.306 | 0.387 |
| alphabuilders_multifactor_revenue_quality_momentum_v1 / defensive_accumulation_seed_v1 | 0.971 | 0.436 | 0.339 | 0.336 |
| alphabuilders_multifactor_revenue_quality_momentum_v1 / trend_following_seed_v1 | 0.945 | 0.430 | 0.307 | 0.335 |

## Consolidation Recommendation

Recommended active owner count after consolidation: 4 current-owner groups, with 2 true active owners and 2 watch/research buckets.

1. Core broad trend / quality / accumulation owner
   - Merge: `alphabuilders_multifactor_revenue_quality_momentum_v1`, `trend_following_seed_v1`, `breakout_vol_expansion_seed_v1`, `defensive_accumulation_seed_v1`, `finlab_ai_skill_broker_accumulation_reclaim_v1`, `finlab_ai_skill_quality_trend_v1`, `finlab_ai_skill_reversion_value_v1`
   - Keep representative: `alphabuilders_multifactor_revenue_quality_momentum_v1`
   - Reason: high intra corr average 0.93, overlap/Jaccard not independent enough, and only AlphaBuilders has positive D1 base/robust proxy.

2. Sparse revenue revision breakout owner
   - Keep separate only as watch/shadow: `finlab_ai_skill_revenue_revision_breakout_v1`
   - Reason: low position overlap and sparse event exposure, but weak D1 performance and cost sensitivity.

3. AlphaMiner 0081/0187 monthly research bucket
   - Demote from D1 active: `alpha_miner_pymoo_nsga3_novelty_0081`, `alpha_miner_pymoo_nsga3_novelty_0187`
   - Reason: pair is highly similar to each other and fails D1/open threshold adapter. It may remain monthly/top-k research only.

4. Margin/sentiment flow owner
   - Keep separate research-active/watch: `alpha_miner_pymoo_nsga3_novelty_0193`
   - Reason: best D1 active result and robust under cost stress, but `us_sentiment_score` is still a constant proxy in this adapter.

If S2 is promoted, it should become a new standalone dual-momentum owner, not be merged into the current trend owner:
- S2 CAGR 40.05%, Sharpe 1.17, MOD -27.47%.
- S2 max active return corr is moderate at 0.618 vs `trend_following_seed_v1`, but all-period Jaccard stays below 0.018 against all active owners.
