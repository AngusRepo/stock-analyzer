# Strategy optimization implementation plan — 2026-08-16

## Decision boundary

- Production thresholds, eligibility, weights, and promotion state remain unchanged.
- Mistral output is E0/E1 hypothesis support only; it is not a Jury verdict.
- Every experiment must use PIT-safe features, 18 bps round-trip costs, locked OOS,
  regime slices, and multiple-testing/PBO controls.
- Optimize failed strategies toward the existing gates; never relax gates to create
  more eligible strategies.

## Workstream A — evidence recovery

Targets:

- `stock_tech_s03_vcp_contraction_breakout_v1`
- `stock_tech_s05_first_dry_pullback_v1`
- `stock_tech_s09_three_soldiers_base_breakout_v1`
- `stock_tech_s10_island_reversal_v1`
- `stock_tech_s07_2b_false_break_reversal_v1`
- `stock_tech_s08_rsi2_bull_mean_reversion_v1`
- `alpha_miner_pymoo_nsga3_novelty_0193`

Implementation:

1. Add per-strategy funnel counters for universe input, feature unavailable,
   PIT rejection, signal false, liquidity rejection, cost rejection, match, and
   matured outcome.
2. Replay the frozen strategy spec in shadow; do not tune entry thresholds while
   collecting missing evidence.
3. For S08 bull mean reversion, collect six additional mature dates under the
   frozen spec. For alpha 0193, collect four additional mature dates and report
   LCB90 by regime.

Primary metrics strengthened:

- evaluable decisions, match rate, sample count, mature dates, evidence freshness
- LCB90 precision through more independent dates

Non-claim: evidence recovery does not improve hit rate or return by itself.

## Workstream B — LCB and regime stability

Targets:

- `alpha223_0009`
- `alpha223_0283`
- `finlab_ai_skill_reversion_value_v1`
- `alpha_miner_pymoo_nsga3_novelty_0187`

Implementation:

1. Freeze a baseline and add only pre-decision regime features: volatility
   percentile, liquidity percentile, market breadth, and trend/mean-reversion
   regime.
2. Use pymoo NSGA-III for constrained candidate search with objectives:
   maximize date-return LCB90, cost-net average return, hit rate, and samples;
   minimize drawdown, turnover/cost, and portfolio correlation.
3. Reject candidates whose gain exists only in one date/regime or disappears in
   locked OOS.

Primary metrics strengthened:

- date-return LCB90, hit rate, cost-net average return, maximum drawdown

Trade-off to monitor:

- regime filters may reduce match rate and sample count; minimum evidence gates
  remain binding.

## Workstream C — tail-risk repair

Targets:

- `alpha_miner_pymoo_nsga3_novelty_0081`
- `stock_tech_s02_52w_dual_momentum_v1`
- `stock_tech_s06_nr7_inside_bar_breakout_v1`

Implementation:

1. Materialize maximum adverse excursion, time-to-loss, gap/slippage, sector
   concentration, and loss-cluster features from locked OOS decisions.
2. Test volatility/liquidity admission guards, time stops, and adverse-excursion
   exits as separate challengers, not cumulative parameter fishing.
3. Require improvement after costs in both full OOS and worst regime; cap the
   number of tested variants and report PBO.

Primary metrics strengthened:

- maximum drawdown, LCB90, cost-net average return, tail-loss CVaR

Trade-off to monitor:

- tighter exits/filters may improve drawdown while reducing average winner size,
  match rate, and samples.

## Workstream D — replacement, not cosmetic tuning

Targets:

- `alpha223_0166`
- `alpha223_0109`
- `defensive_accumulation_seed_v1`
- `smrc_vwap_reclaim_v1`
- `trend_quality_breakout_fused_v1`
- `finlab_ai_skill_quality_trend_v1`
- `stock_tech_s12_multitimeframe_smc_reclaim_v2`
- shadow S01 and S04

Implementation:

1. Keep these strategies out of eligible production weight until a challenger
   passes the unchanged gates.
2. Build same-family challengers from a fresh causal hypothesis; do not search
   small parameter neighborhoods around a severely negative baseline.
3. For shadow S01/S04, treat max absolute correlation `0.9193` as a redundancy
   failure: freeze one family member and require incremental portfolio edge from
   the other.

Primary metrics strengthened:

- cost-net average return, hit rate, maximum drawdown, LCB90
- portfolio max absolute correlation, marginal contribution, portfolio drawdown

## Promotion and allocation acceptance

A strategy may re-enter allocation only when all are true:

1. Existing status-specific sample, match-rate, mature-date, hit-rate, average
   return, drawdown, and LCB90 gates pass.
2. PIT lineage, 18 bps costs, locked OOS, regime stability, and PBO evidence pass.
3. Portfolio correlation and marginal contribution pass; standalone performance
   is insufficient.
4. Promotion creates an immutable evidence receipt. Weight allocation occurs only
   among strategies that pass; failed strategies do not receive weight merely to
   make the dashboard look diversified.

## Priority order

1. Evidence funnel instrumentation for zero/near-zero sample strategies.
2. Frozen-spec maturity for S08 bull mean reversion and alpha 0193.
3. LCB/regime challengers for alpha 0009, alpha 0283, and reversion value.
4. Tail-risk challengers for alpha 0081; replace rather than rescue S02/S06 if
   locked OOS remains severe.
5. Replace severe active/candidate/shadow families and de-duplicate S01/S04.
