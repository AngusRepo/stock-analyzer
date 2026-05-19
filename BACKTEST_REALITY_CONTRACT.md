# Backtest Reality Contract

Generated: 2026-05-16

## Purpose

V4-20 adds a tradability gate for backtest results. A strategy is not considered
production-promotable just because paper metrics look good. It must also pass
execution reality checks.

Implemented evaluator:

```text
ml-controller/services/backtest_reality_layer.py
```

Schema:

```text
backtest-reality-v1
```

## Gate Set

Every promotion candidate must include and pass:

```text
liquidity
capacity
transaction_cost
limit_lock
disposition
full_delivery
mae_mfe
turnover
walk_forward
```

## Default Policy

```json
{
  "min_avg_daily_turnover_twd": 50000000,
  "max_order_participation_pct": 0.05,
  "max_total_transaction_cost_bps": 80,
  "max_slippage_bps": 30,
  "max_limit_lock_touch_pct": 0.02,
  "max_disposition_event_count": 0,
  "max_full_delivery_trade_count": 0,
  "max_abs_mae_p95_pct": 0.12,
  "min_mfe_to_abs_mae_ratio": 0.8,
  "max_turnover_ratio": 8,
  "min_walk_forward_windows": 4
}
```

## Output Policy

```text
all gates pass -> allowed_use = promotion_candidate
any gate fails -> allowed_use = research_only
```

Failed reports include:

```text
failed_gates
warnings
capacity
transaction_cost
mae_mfe
gate-level metrics
```

## Current Scope

This slice is read-only. It does not change:

```text
backtest_engine fills
walk_forward execution
recommendation ranking
paper trade
pending buy
real orders
```

The next integration step is to attach `backtest-reality-v1` to backtest result
storage and promotion validation packets.

## Non-Goals

```text
Do not promote a strategy from return metrics alone.
Do not treat missing reality evidence as pass.
Do not ignore limit-lock, disposition, or full-delivery events.
Do not let high-turnover strategies pass without cost and capacity evidence.
```
