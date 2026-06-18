# AlphaBuilders Factor FinLab Research Batch Report

Date: 2026-06-16

## Scope

- Runner: `tools/finlab_alphabuilders_factor_backtest.py`
- Source catalog: `worker/.tmp-test-run-codex/alphabuilders_factors_fresh.json`
- Catalog count verified: 63 factors. The local/API catalog exposed 63 available factors, not 64.
- Use: research only. No D1 write, no production selector, no deploy, no trade.
- Universe: FinLab `sii` listed common stocks
- Period: 2023-01-01 to 2026-06-15
- Benchmark test shape: top 10 monthly rebalance, close price execution, 10% single-name cap, FinLab fee/tax settings.
- Important note: top-k is only the research measurement harness, not the production architecture.

## Single-Factor Result Highlights

| Rank | Factor | Category | CAGR | Monthly Sharpe | Max DD | Alpha |
|---:|---|---|---:|---:|---:|---:|
| 1 | `val_sp` | valuation | 31.71% | 1.567 | -12.43% | 37.35% |
| 2 | `mom_hl52` | momentum | 40.28% | 1.529 | -26.65% | 46.25% |
| 3 | `mom_macd_trend_10` | momentum | 50.59% | 1.451 | -24.25% | 57.99% |
| 4 | `tech_dma_10_50` | technical | 48.72% | 1.387 | -25.41% | 55.68% |
| 5 | `size_log_mktcap` | size | 27.02% | 1.350 | -9.13% | 35.98% |
| 6 | `mom_close_to_52w_high` | momentum | 26.76% | 1.197 | -23.90% | 32.81% |
| 7 | `tech_trix_12` | technical | 43.76% | 1.196 | -23.45% | 50.58% |
| 8 | `mom_9m` | momentum | 41.47% | 1.169 | -34.43% | 57.87% |
| 9 | `tech_mtm_10` | technical | 36.72% | 1.155 | -25.07% | 44.41% |
| 10 | `mom_ma50_200_ratio` | momentum | 33.82% | 1.153 | -40.86% | 52.77% |

## Category Read

| Category | Count | Median Sharpe | Max Sharpe | Median CAGR | Max CAGR | Positive Alpha |
|---|---:|---:|---:|---:|---:|---:|
| momentum | 10 | 1.137 | 1.529 | 31.85% | 50.59% | 10/10 |
| technical | 30 | 0.721 | 1.387 | 18.45% | 48.72% | 28/30 |
| size | 1 | 1.350 | 1.350 | 27.02% | 27.02% | 1/1 |
| volume | 5 | 0.499 | 0.788 | 9.97% | 12.96% | 5/5 |
| volatility | 5 | 0.299 | 0.818 | 3.47% | 13.41% | 5/5 |
| valuation | 4 | -0.450 | 1.567 | -4.99% | 31.71% | 2/4 |
| event | 8 | -0.182 | 0.673 | -0.20% | 13.67% | 8/8 |

## Original Composite Check

| Composite | CAGR | Monthly Sharpe | Max DD | Decision |
|---|---:|---:|---:|---|
| `ab_academic_momentum` | 45.78% | 1.154 | -43.76% | return strong, drawdown too high alone |
| `ab_defensive_momentum` | 11.68% | 1.083 | -6.79% | risk evidence, not main alpha |
| `ab_low_vol_value` | 9.51% | 0.960 | -7.07% | risk evidence, not main alpha |
| `ab_channel_breakout` | 16.12% | 0.657 | -40.98% | weak alone |
| `ab_attention_flow` | -0.75% | 0.026 | -49.50% | reject as selector |
| `ab_short_reversal` | -0.62% | -0.021 | -40.46% | reject as selector |

## Result-Driven Composite Check

| Composite | Components | CAGR | Monthly Sharpe | Max DD | Alpha |
|---|---|---:|---:|---:|---:|
| `ab_result_channel_confirmed_trend` | Donchian, Keltner, SAR, ADX, MACD, DMA | 51.61% | 1.469 | -30.68% | 58.66% |
| `ab_result_sales_price_trend` | S/P, MACD, DMA, TRIX, EMV, 9M momentum | 46.57% | 1.372 | -27.89% | 57.13% |
| `ab_result_momentum_trend_core` | MACD, DMA, TRIX, 9M, vol-adjusted 12M, MA50/200 | 55.62% | 1.363 | -38.10% | 70.61% |
| `ab_result_high_sharpe_core` | S/P, 52W position, MACD, DMA, size | 34.83% | 1.081 | -35.26% | 43.25% |
| `ab_result_trend_vol_filtered` | MACD, DMA, TRIX, vol-adjusted 12M, low volatility, ATR | 20.73% | 0.952 | -21.01% | 28.05% |

## Walk-Forward Sanity Check

| Composite | 2023-2025 Sharpe | 2026 YTD Sharpe | Read |
|---|---:|---:|---|
| `ab_result_channel_confirmed_trend` | 1.077 | 3.461 | strongest, robust enough for next candidate stage |
| `ab_result_sales_price_trend` | 1.069 | 2.972 | strongest balanced candidate |
| `ab_result_momentum_trend_core` | 1.015 | 2.011 | high return, needs drawdown/crowding control |
| `ab_result_trend_vol_filtered` | 0.804 | 1.048 | lower return, useful defensive variant |
| `ab_academic_momentum` | 0.644 | 2.449 | strong 2026, weaker pre-2026 and high drawdown |
| `ab_result_52w_value_reversal` | 1.018 | -0.864 | unstable |
| `ab_low_vol_value` | 1.275 | -4.928 | not current alpha |
| `ab_defensive_momentum` | 1.413 | -5.730 | not current alpha |

2026 YTD is short and annualized metrics are unstable, so it is used only as direction sanity, not final proof.

## Recommendation

Do not add many AlphaBuilders-derived strategies. Replace the earlier AlphaBuilders set with 3 main candidates plus 1 evidence overlay:

1. `alphabuilders_channel_confirmed_trend_v1`
   - Factors: Donchian position, Keltner position, SAR, ADX, MACD trend, DMA.
   - Reason: channel breakout alone was weak, but channel breakout with trend confirmation became the best composite.
   - Use: L1 strategy labeler candidate.

2. `alphabuilders_sales_price_trend_v1`
   - Factors: S/P, MACD trend, DMA, TRIX, EMV, 9M momentum.
   - Reason: combines best valuation factor with strongest trend factors; good Sharpe and lower drawdown than pure momentum.
   - Use: L1 strategy labeler candidate.

3. `alphabuilders_momentum_trend_core_v1`
   - Factors: MACD trend, DMA, TRIX, 9M momentum, volatility-adjusted 12M momentum, MA50/MA200.
   - Reason: highest CAGR among candidate composites; needs L1.25 crowding and L4 sparse risk control.
   - Use: L1 strategy labeler candidate, but with portfolio intelligence penalty when trend family is crowded.

4. `alphabuilders_trend_vol_filtered_v1`
   - Factors: MACD trend, DMA, TRIX, volatility-adjusted 12M momentum, low realized volatility, ATR.
   - Reason: not the highest return, but more conservative evidence when market risk rises.
   - Use: L1.25/L3.5 evidence overlay or lower-priority strategy, not a primary selector unless later validation improves.

Do not use these as main selectors:

- `ab_attention_flow`
- `ab_short_reversal`
- standalone `val_ep`, `val_bp`, `val_dp`
- event flags such as limit-up/down, locked-open, disposal active

Use event and low-volatility factors as risk/evidence features, not as standalone stock-picking strategies.

## Next Validation Gate

Before production merge:

1. Re-run with 2020-2022 if FinLab coverage is sufficient.
2. Measure candidate overlap against current 25 strategies.
3. Feed them into L1.25 strategy portfolio intelligence and verify strategy weights are adaptive.
4. Confirm L1.5 slate diversity improves and L4 sparse concentration does not worsen.
5. Do not promote if improvement only comes from same trend stocks being selected repeatedly.

