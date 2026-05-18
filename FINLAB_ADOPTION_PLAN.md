# FinLab Adoption Plan for StockVision V4

Generated: 2026-05-15T14:57:23.780329+00:00
Schema: `finlab-adoption-plan-v1`
Checksum: `sha256:45fa20963e3345f2df972b4139bde37d84f5dec09a3202e2f9f0f04ce4ff340f`

## Policy

- `production_contract`: current_106_features_remain_stable
- `parity_lane`: verify FinLab replacement against current TWSE/TPEX or existing StockVision fields
- `diversity_lane`: ingest useful FinLab-native datasets in shadow feature lake even without old equivalents
- `research_lane`: benchmark-only until explicit promotion gates pass
- `emerging_stock_rule`: watchlist_only; eligible_for_pending_buy=false
- `taxonomy_layers`: industry, industry_theme, subindustry, concept

## Counts

```json
{
  "field_count": 2150,
  "asset_count": 15,
  "by_stage": {
    "diversity": 8,
    "parity": 5,
    "research": 2
  },
  "fields_by_stage": {
    "parity": 389,
    "diversity": 701,
    "research": 1321
  },
  "fields_by_dataset_lane": {
    "daily_price": 121,
    "revenue": 8,
    "fundamental_factor_diversity": 213,
    "research": 1319,
    "chip_diversity": 53,
    "regime_context": 118,
    "emerging_revenue_diversity": 9,
    "emerging_price_diversity": 10,
    "global_context": 296,
    "emerging_chip_diversity": 1,
    "security_master": 1,
    "taxonomy_expansion": 1
  },
  "fields_by_adoption_mode": {
    "replace": 130,
    "augment": 701,
    "benchmark": 1319
  }
}
```

## Asset Manifest

| asset_key | stage | dataset_lane | access_tier | fields | markets | quality_gates | use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| finlab/diversity/chip_diversity | diversity | chip_diversity | compute | 53 | tw | price_location, liquidity, crowding, extreme_value_winsorization; turnover, crowding, price_location_gate | institutional flow, margin/lending and broker concentration shadow features |
| finlab/diversity/emerging_chip_diversity | diversity | emerging_chip_diversity | compute | 1 | tw | emerging_symbol_coverage, branch_concentration_bounds | emerging-stock broker flow proxy and concentration checks |
| finlab/diversity/emerging_price_diversity | diversity | emerging_price_diversity | compute | 10 | tw | rotc_market_lane, liquidity_bounds, no_pending_buy | emerging-stock price, liquidity and spread watchlist context |
| finlab/diversity/emerging_revenue_diversity | diversity | emerging_revenue_diversity | compute | 9 | tw | publication_alignment, restatement_check, no_pending_buy | emerging-stock revenue momentum watchlist context |
| finlab/diversity/fundamental_factor_diversity | diversity | fundamental_factor_diversity | compute | 213 | tw | report_date_availability, no_lookahead, sector_normalization | quality, value, growth, profitability and balance-sheet factors |
| finlab/diversity/global_context | diversity | global_context | compute | 296 | tw, us | coverage, delay, holiday_calendar_alignment; coverage, delay, license, survivorship_check | US leading, world index, morning setup and regime context |
| finlab/diversity/regime_context | diversity | regime_context | compute | 118 | tw | freshness, low_frequency_alignment; market_level_only, no_direct_alpha_gate | derivatives, macro, hedge pressure and low-frequency regime evidence |
| finlab/diversity/taxonomy_expansion | diversity | taxonomy_expansion | compute | 1 | tw | alias_cleaning, duplicate_tag_rate, coverage_by_symbol | industry_theme/subindustry labels and sector-flow taxonomy |
| finlab/parity/chip_diversity | parity | chip_diversity | compute | 48 | tw | price_location, liquidity, crowding, extreme_value_winsorization | institutional flow, margin/lending and broker concentration shadow features |
| finlab/parity/daily_price | parity | daily_price | compute | 119 | tw | 20_30_day_parity, split_adjustment, missing_rate | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/parity/fundamental_factor_diversity | parity | fundamental_factor_diversity | compute | 213 | tw | report_date_availability, no_lookahead, sector_normalization | quality, value, growth, profitability and balance-sheet factors |
| finlab/parity/revenue | parity | revenue | compute | 8 | tw | announcement_date_alignment, restatement_check | monthly revenue parity and revenue momentum feature base |
| finlab/parity/security_master | parity | security_master | compute | 1 | tw | row_count, market_enum, known_symbol_checks | primary security master, market lane, tradability route |
| finlab/research/daily_price | research | daily_price | archive | 2 | us | 20_30_day_parity, split_adjustment, missing_rate | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/research/research | research | research | archive | 1319 | hk, jp, kr, tw, uk | manual_review; research_only | non-core global datasets and benchmark-only research candidates |

## Dagster Mapping

```text
raw_finlab_<dataset_lane> -> clean_finlab_<dataset_lane> -> feature_lake_finlab_<dataset_lane>
parity assets compare against current StockVision/TWSE/TPEX outputs
diversity assets remain shadow until feature promotion gates pass
research assets are archive/benchmark only
```
