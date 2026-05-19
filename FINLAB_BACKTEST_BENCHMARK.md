# FinLab Backtest Benchmark Contract

## Purpose

V4-21 defines how StockVision uses FinLab backtest output:

```text
StockVision backtest:
  production truth for strategy evaluation, promotion, and recommendation review

FinLab backtest:
  external sanity check, variance detector, and research benchmark only
```

FinLab backtest results are useful because they provide an independent
implementation surface. They are not allowed to write `daily_recommendations`,
change ranking, change alpha allocation, create paper trades, create pending
buys, or promote a strategy by themselves.

## Runtime Contract

Implemented in:

```text
ml-controller/services/finlab_backtest_benchmark.py
ml-controller/tests/test_finlab_backtest_benchmark.py
```

Report schema:

```text
schema_version: finlab-backtest-benchmark-v1
allowed_use: sanity_check_only
decision_effect: benchmark_only
stockvision_backtest_authority: production_truth
finlab_backtest_authority: external_sanity_check
```

The benchmark compares shared high-level metrics:

```text
annual_return
max_drawdown
sharpe
turnover_ratio
```

Default variance tolerances:

```text
annual_return: 0.15 absolute delta
max_drawdown: 0.10 absolute delta
sharpe: 0.50 absolute delta
turnover_ratio: 2.00 absolute delta
```

## Status Semantics

| status | Meaning | Production effect |
|---|---|---|
| `pass` | FinLab benchmark is broadly consistent with StockVision backtest. | No direct effect; may be kept as audit evidence. |
| `warn` | FinLab benchmark differs beyond tolerance. | Trigger research review; no score/rank/promotion effect. |
| `blocked` | FinLab payload includes decision/order/recommendation fields. | Quarantine as unsafe external decision output. |
| `missing_benchmark` | No FinLab benchmark was supplied. | Advisory only; StockVision backtest remains usable. |

## Quarantine Rule

The adapter quarantines FinLab benchmark payloads that expose direct decision
or order-like fields such as:

```text
recommendation_score
buy_signal
sell_signal
target_position
order_action
pending_buy
alpha_adjustment
rank
score_modifier
```

This does not mean FinLab is wrong to expose these fields in its own ecosystem.
It means StockVision V4 treats them as external decisions, not owned
StockVision recommendations.

## Integration Path

1. Run StockVision backtest and `backtest_reality_layer.py`.
2. Optionally run the equivalent FinLab strategy/backtest in research or CI.
3. Build `finlab-backtest-benchmark-v1`.
4. Store the report as audit/research evidence.
5. If status is `warn`, inspect data alignment, fee/slippage assumptions,
   rebalance timing, universe definition, and look-ahead handling.
6. If status is `blocked`, strip or quarantine the external decision fields.

Promotion still requires StockVision-owned gates:

```text
schema/freshness checks
no look-ahead
IC / hit-rate
transaction cost / turnover
drawdown / MAE-MFE
regime split
paper-trade or recommendation-shadow evidence
Decision Engine review
```

## Non-Goals

```text
Do not use FinLab backtest output as a recommendation score.
Do not use FinLab backtest output as a rank modifier.
Do not let FinLab backtest create pending buys or paper fills.
Do not let FinLab benchmark pass override StockVision reality gates.
Do not treat missing FinLab benchmark as a StockVision backtest failure.
```
