# FinLab Feature Lake Manifest

Generated: 2026-05-15T17:56:54.265862+00:00
Schema: `finlab-feature-lake-manifest-v1`
Checksum: `sha256:b2cd1ac34a5edb2203d9c71cb7ee7d0ab8163cd5b3ad0d6cd24e99e5e0f59595`
Source plan checksum: `sha256:45fa20963e3345f2df972b4139bde37d84f5dec09a3202e2f9f0f04ce4ff340f`
Source Dagster payload checksum: `sha256:8bb3fb6d48f14a580c411bf71886f1ea6cb59b03ae7d25beae28e2f47052ecb8`

## Policy

- `production_ml_input`: current_106_features_only
- `sidecar_mode`: clean_asset_or_paper_active_until_real_promotion
- `promotion_default`: no_direct_real_production_use
- `training_policy`: not_eligible_for_real_training_until_promotion_gates_pass
- `screener_policy`: eligible_for_paper_active_after_data_quality_and_reality_gates
- `emerging_stock_policy`: watchlist_or_paper_active_only_no_real_pending_buy

## Canonical Production Features

- source: `ml-service.app.features.FEATURE_COLS`
- schema_version: `v2`
- feature_count: `106`
- features_hash: `sha256:24db7897d1fb9d9c0c80a25ce91da6e8b288c80a617b70e21a806ea739def88f`
- production_mutation_allowed: `False`

## Summary

```json
{
  "canonical_feature_count": 106,
  "sidecar_family_count": 15,
  "sidecar_fields_total": 2411,
  "families_by_stage": {
    "diversity": 8,
    "parity": 5,
    "research": 2
  }
}
```

## Sidecar Families

| asset_key | stage | lane | fields | promotion_state | watchlist_only | row_checks | use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| finlab/diversity/chip_diversity/feature_lake | diversity | chip_diversity | 53 | shadow_diversity | False | duplicate_rate, null_rate | institutional flow, margin/lending and broker concentration shadow features |
| finlab/diversity/emerging_chip_diversity/feature_lake | diversity | emerging_chip_diversity | 1 | shadow_diversity | True | duplicate_rate, null_rate | emerging-stock broker flow proxy and concentration checks |
| finlab/diversity/emerging_price_diversity/feature_lake | diversity | emerging_price_diversity | 10 | shadow_diversity | True | duplicate_rate, null_rate | emerging-stock price, liquidity and spread watchlist context |
| finlab/diversity/emerging_revenue_diversity/feature_lake | diversity | emerging_revenue_diversity | 9 | shadow_diversity | True | duplicate_rate, null_rate | emerging-stock revenue momentum watchlist context |
| finlab/diversity/fundamental_factor_diversity/feature_lake | diversity | fundamental_factor_diversity | 213 | shadow_diversity | False | duplicate_rate, null_rate | quality, value, growth, profitability and balance-sheet factors |
| finlab/diversity/global_context/feature_lake | diversity | global_context | 296 | shadow_diversity | False | duplicate_rate, null_rate | US leading, world index, morning setup and regime context |
| finlab/diversity/regime_context/feature_lake | diversity | regime_context | 118 | shadow_diversity | False | duplicate_rate, null_rate | derivatives, macro, hedge pressure and low-frequency regime evidence |
| finlab/diversity/taxonomy_expansion/feature_lake | diversity | taxonomy_expansion | 1 | shadow_diversity | False | duplicate_rate, null_rate | industry_theme/subindustry labels and sector-flow taxonomy |
| finlab/parity/chip_diversity/feature_lake | parity | chip_diversity | 48 | shadow_parity | False | duplicate_rate, null_rate, twse_tpex_diff_report | institutional flow, margin/lending and broker concentration shadow features |
| finlab/parity/daily_price/feature_lake | parity | daily_price | 119 | shadow_parity | False | 20_30_day_parity, duplicate_rate, missing_rate, null_rate, split_adjustment, twse_tpex_diff_report | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/parity/fundamental_factor_diversity/feature_lake | parity | fundamental_factor_diversity | 213 | shadow_parity | False | duplicate_rate, null_rate, twse_tpex_diff_report | quality, value, growth, profitability and balance-sheet factors |
| finlab/parity/revenue/feature_lake | parity | revenue | 8 | shadow_parity | False | duplicate_rate, null_rate, twse_tpex_diff_report | monthly revenue parity and revenue momentum feature base |
| finlab/parity/security_master/feature_lake | parity | security_master | 1 | shadow_parity | False | duplicate_rate, null_rate, twse_tpex_diff_report | primary security master, market lane, tradability route |
| finlab/research/daily_price/feature_lake | research | daily_price | 2 | research_only | True | 20_30_day_parity, duplicate_rate, missing_rate, null_rate, split_adjustment | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/research/research/feature_lake | research | research | 1319 | research_only | True | duplicate_rate, null_rate | non-core global datasets and benchmark-only research candidates |

## Boundary

FinLab sidecar fields do not append to `FEATURE_COLS`, do not enter real-production ML, and do not affect real pending-buy until explicit promotion gates pass. V4.1 may promote gated sidecar fields into `paper_active_challenger` or `paper_primary` through `promotion-gate-contract-v2`, but the packet must keep `can_write_order=false`, `can_write_106_feature=false`, `can_write_ml_vote=false`, and `can_write_regime=false`. Row-level checks remain `observed` until rows are materialized.

`FINLAB_SECTOR_FLOW_SHADOW.md` binds the taxonomy and chip-diversity sidecar families to the four sector-flow layers: industry, industry_theme, subindustry, and concept. Cross-layer rollups are forbidden; each layer uses `(date, sector, classification)` as the isolation key.

`FINLAB_EMERGING_WATCHLIST.md` binds the three emerging-stock sidecar families to watchlist and paper-active use: `rotc_price`, `rotc_monthly_revenue`, and `rotc_broker_transactions`. These sources cannot create real pending-buy, execution, real-production ML training, or direct real alpha-gate output.
