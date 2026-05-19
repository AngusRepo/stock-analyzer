# FinLab Emerging Watchlist Manifest

Generated: 2026-05-15T18:13:36.829100+00:00
Schema: `finlab-emerging-watchlist-manifest-v1`
Checksum: `sha256:a61ff4a3eefe4f59be965853b6e8f89910ffa11d1e6b4bb4b4999f157fd2f4bd`
Source feature lake checksum: `sha256:b2cd1ac34a5edb2203d9c71cb7ee7d0ab8163cd5b3ad0d6cd24e99e5e0f59595`

## Policy

- `mode`: shadow_watchlist_only
- `pending_buy_enabled`: False
- `execution_enabled`: False
- `production_ml_training_enabled`: False
- `production_screener_candidate_enabled`: False
- `allowed_outputs`: ['watchlist', 'manual_review', 'context_only']
- `blocked_outputs`: ['pending_buy', 'execution', 'production_ml_training', 'direct_alpha_gate']
- `promotion_default`: no_direct_trading_or_ml_use

## Board Policy

- `finlab_raw_market`: rotc
- `stockvision_market_segment`: EMERGING
- `tradability`: watchlist_only_no_pending_buy
- `security_master_dependency`: security_categories.market == rotc

## Summary

```json
{
  "source_count": 3,
  "field_count_total": 20,
  "watchlist_only_sources": 3
}
```

## Source Contracts

| source_dataset | lane | fields | usage | period_key | watchlist_only | required_checks |
| --- | --- | --- | --- | --- | --- | --- |
| rotc_price | emerging_price_diversity | 10 | liquidity_spread_context | trade_date | True | rotc_market_lane, liquidity_bounds, no_pending_buy, watchlist_only, shadow_feature_only |
| rotc_monthly_revenue | emerging_revenue_diversity | 9 | revenue_momentum_context | revenue_month | True | publication_alignment, restatement_check, no_pending_buy, watchlist_only, shadow_feature_only |
| rotc_broker_transactions | emerging_chip_diversity | 1 | broker_concentration_context | trade_date | True | branch_concentration_bounds, emerging_symbol_coverage, no_pending_buy, watchlist_only, shadow_feature_only |

## Derived Context

| name | source_dataset | signals | use |
| --- | --- | --- | --- |
| liquidity_spread_context | rotc_price | turnover_value, trade_count, spread_pct | pre-trade liquidity warning and manual review context |
| revenue_momentum_context | rotc_monthly_revenue | monthly_revenue, mom_pct, yoy_pct, restatement_note | fundamental watchlist context only |
| broker_concentration_context | rotc_broker_transactions | top_branch_buy_ratio, top_branch_sell_ratio, top_branch_net_ratio | chip concentration warning, not a buy trigger |

## Boundary

Emerging-stock FinLab sources are context-only. They can enrich watchlists and manual review, but cannot create pending-buy, execution, production ML training, or direct alpha-gate output until a separate promotion decision changes this contract.
