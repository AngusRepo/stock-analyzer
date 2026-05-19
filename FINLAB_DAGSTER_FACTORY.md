# FinLab Dagster Asset Runtime

Schema: `finlab-dagster-definitions-payload-v1`
Mode: `asset_runtime_formal_shadow`
Runtime dependency: `dagster==1.13.4`
Code location module: `dagster_defs.finlab_v4`
Dagster runtime available in this environment: `True`
Asset graph checksum: `sha256:0bc05f924f7ce7ba0130f495fb771531a0263690a4a527a4edc51ff0bfcccf44`
Source plan checksum: `sha256:45fa20963e3345f2df972b4139bde37d84f5dec09a3202e2f9f0f04ce4ff340f`

## Runtime Contract

- This runtime is the FinLab Dagster Asset Runtime formal-shadow entrypoint.
- It creates Dagster-compatible asset specs and check specs from `dagster_asset_graph.json`.
- It can drive formal-shadow materialization, but production feature writes, schedules, order submit, and ML retrain remain disabled until CPD approval.
- Dagster is a planned V4 runtime dependency and is now pinned in `ml-controller/requirements.txt`.
- `dagster_defs.finlab_v4` loads the FinLab asset graph as formal-shadow Dagster assets.
- `finlab_v4_formal_shadow_quality_checks` exposes payload checks as one Dagster multi-asset check.
- Checks that require materialized rows are reported as observed until the FinLab shadow feature lake writes rows.

## Summary

```json
{
  "asset_count": 45,
  "asset_check_count": 190,
  "group_counts": {
    "finlab_v4_diversity": 24,
    "finlab_v4_parity": 15,
    "finlab_v4_research": 6
  },
  "check_severity_counts": {
    "error": 188,
    "warn": 2
  },
  "schedule_count": 1,
  "dagster_check_def_count": 1
}
```

## Schedules

| name | cron | timezone | enabled | reason |
| --- | --- | --- | --- | --- |
| finlab_v4_shadow_refresh | 30 18 * * 1-5 | Asia/Taipei | False | formal_shadow_requires_cpd_enablement |

## Asset Specs

| asset_key | deps | group | layer | fields | use |
| --- | --- | --- | --- | --- | --- |
| finlab/diversity/chip_diversity/raw |  | finlab_v4_diversity | raw | 53 | institutional flow, margin/lending and broker concentration shadow features |
| finlab/diversity/chip_diversity/clean | finlab/diversity/chip_diversity/raw | finlab_v4_diversity | clean | 53 | institutional flow, margin/lending and broker concentration shadow features |
| finlab/diversity/chip_diversity/feature_lake | finlab/diversity/chip_diversity/clean | finlab_v4_diversity | feature_lake | 53 | institutional flow, margin/lending and broker concentration shadow features |
| finlab/diversity/emerging_chip_diversity/raw |  | finlab_v4_diversity | raw | 1 | emerging-stock broker flow proxy and concentration checks |
| finlab/diversity/emerging_chip_diversity/clean | finlab/diversity/emerging_chip_diversity/raw | finlab_v4_diversity | clean | 1 | emerging-stock broker flow proxy and concentration checks |
| finlab/diversity/emerging_chip_diversity/feature_lake | finlab/diversity/emerging_chip_diversity/clean | finlab_v4_diversity | feature_lake | 1 | emerging-stock broker flow proxy and concentration checks |
| finlab/diversity/emerging_price_diversity/raw |  | finlab_v4_diversity | raw | 10 | emerging-stock price, liquidity and spread watchlist context |
| finlab/diversity/emerging_price_diversity/clean | finlab/diversity/emerging_price_diversity/raw | finlab_v4_diversity | clean | 10 | emerging-stock price, liquidity and spread watchlist context |
| finlab/diversity/emerging_price_diversity/feature_lake | finlab/diversity/emerging_price_diversity/clean | finlab_v4_diversity | feature_lake | 10 | emerging-stock price, liquidity and spread watchlist context |
| finlab/diversity/emerging_revenue_diversity/raw |  | finlab_v4_diversity | raw | 9 | emerging-stock revenue momentum watchlist context |
| finlab/diversity/emerging_revenue_diversity/clean | finlab/diversity/emerging_revenue_diversity/raw | finlab_v4_diversity | clean | 9 | emerging-stock revenue momentum watchlist context |
| finlab/diversity/emerging_revenue_diversity/feature_lake | finlab/diversity/emerging_revenue_diversity/clean | finlab_v4_diversity | feature_lake | 9 | emerging-stock revenue momentum watchlist context |
| finlab/diversity/fundamental_factor_diversity/raw |  | finlab_v4_diversity | raw | 213 | quality, value, growth, profitability and balance-sheet factors |
| finlab/diversity/fundamental_factor_diversity/clean | finlab/diversity/fundamental_factor_diversity/raw | finlab_v4_diversity | clean | 213 | quality, value, growth, profitability and balance-sheet factors |
| finlab/diversity/fundamental_factor_diversity/feature_lake | finlab/diversity/fundamental_factor_diversity/clean | finlab_v4_diversity | feature_lake | 213 | quality, value, growth, profitability and balance-sheet factors |
| finlab/diversity/global_context/raw |  | finlab_v4_diversity | raw | 296 | US leading, world index, morning setup and regime context |
| finlab/diversity/global_context/clean | finlab/diversity/global_context/raw | finlab_v4_diversity | clean | 296 | US leading, world index, morning setup and regime context |
| finlab/diversity/global_context/feature_lake | finlab/diversity/global_context/clean | finlab_v4_diversity | feature_lake | 296 | US leading, world index, morning setup and regime context |
| finlab/diversity/regime_context/raw |  | finlab_v4_diversity | raw | 118 | derivatives, macro, hedge pressure and low-frequency regime evidence |
| finlab/diversity/regime_context/clean | finlab/diversity/regime_context/raw | finlab_v4_diversity | clean | 118 | derivatives, macro, hedge pressure and low-frequency regime evidence |
| finlab/diversity/regime_context/feature_lake | finlab/diversity/regime_context/clean | finlab_v4_diversity | feature_lake | 118 | derivatives, macro, hedge pressure and low-frequency regime evidence |
| finlab/diversity/taxonomy_expansion/raw |  | finlab_v4_diversity | raw | 1 | industry_theme/subindustry labels and sector-flow taxonomy |
| finlab/diversity/taxonomy_expansion/clean | finlab/diversity/taxonomy_expansion/raw | finlab_v4_diversity | clean | 1 | industry_theme/subindustry labels and sector-flow taxonomy |
| finlab/diversity/taxonomy_expansion/feature_lake | finlab/diversity/taxonomy_expansion/clean | finlab_v4_diversity | feature_lake | 1 | industry_theme/subindustry labels and sector-flow taxonomy |
| finlab/parity/chip_diversity/raw |  | finlab_v4_parity | raw | 48 | institutional flow, margin/lending and broker concentration shadow features |
| finlab/parity/chip_diversity/clean | finlab/parity/chip_diversity/raw | finlab_v4_parity | clean | 48 | institutional flow, margin/lending and broker concentration shadow features |
| finlab/parity/chip_diversity/feature_lake | finlab/parity/chip_diversity/clean | finlab_v4_parity | feature_lake | 48 | institutional flow, margin/lending and broker concentration shadow features |
| finlab/parity/daily_price/raw |  | finlab_v4_parity | raw | 119 | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/parity/daily_price/clean | finlab/parity/daily_price/raw | finlab_v4_parity | clean | 119 | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/parity/daily_price/feature_lake | finlab/parity/daily_price/clean | finlab_v4_parity | feature_lake | 119 | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/parity/fundamental_factor_diversity/raw |  | finlab_v4_parity | raw | 213 | quality, value, growth, profitability and balance-sheet factors |
| finlab/parity/fundamental_factor_diversity/clean | finlab/parity/fundamental_factor_diversity/raw | finlab_v4_parity | clean | 213 | quality, value, growth, profitability and balance-sheet factors |
| finlab/parity/fundamental_factor_diversity/feature_lake | finlab/parity/fundamental_factor_diversity/clean | finlab_v4_parity | feature_lake | 213 | quality, value, growth, profitability and balance-sheet factors |
| finlab/parity/revenue/raw |  | finlab_v4_parity | raw | 8 | monthly revenue parity and revenue momentum feature base |
| finlab/parity/revenue/clean | finlab/parity/revenue/raw | finlab_v4_parity | clean | 8 | monthly revenue parity and revenue momentum feature base |
| finlab/parity/revenue/feature_lake | finlab/parity/revenue/clean | finlab_v4_parity | feature_lake | 8 | monthly revenue parity and revenue momentum feature base |
| finlab/parity/security_master/raw |  | finlab_v4_parity | raw | 1 | primary security master, market lane, tradability route |
| finlab/parity/security_master/clean | finlab/parity/security_master/raw | finlab_v4_parity | clean | 1 | primary security master, market lane, tradability route |
| finlab/parity/security_master/feature_lake | finlab/parity/security_master/clean | finlab_v4_parity | feature_lake | 1 | primary security master, market lane, tradability route |
| finlab/research/daily_price/raw |  | finlab_v4_research | raw | 2 | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/research/daily_price/clean | finlab/research/daily_price/raw | finlab_v4_research | clean | 2 | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/research/daily_price/feature_lake | finlab/research/daily_price/clean | finlab_v4_research | feature_lake | 2 | daily price parity against TWSE/TPEX and adjusted OHLCV feature base |
| finlab/research/research/raw |  | finlab_v4_research | raw | 1319 | non-core global datasets and benchmark-only research candidates |
| finlab/research/research/clean | finlab/research/research/raw | finlab_v4_research | clean | 1319 | non-core global datasets and benchmark-only research candidates |
| finlab/research/research/feature_lake | finlab/research/research/clean | finlab_v4_research | feature_lake | 1319 | non-core global datasets and benchmark-only research candidates |

## Asset Check Specs

Dagster runtime mapping: one `multi_asset_check` named `finlab_v4_formal_shadow_quality_checks`. Metadata-only checks can pass/fail immediately; row-level checks such as `null_rate`, `duplicate_rate`, and parity diff are marked `observed` until the FinLab shadow feature lake materializes rows.

| asset_key | check_name | severity |
| --- | --- | --- |
| finlab/diversity/chip_diversity/raw | freshness | error |
| finlab/diversity/chip_diversity/raw | schema_presence | error |
| finlab/diversity/chip_diversity/raw | field_count_positive | error |
| finlab/diversity/chip_diversity/clean | schema_compatibility | error |
| finlab/diversity/chip_diversity/clean | null_rate | error |
| finlab/diversity/chip_diversity/clean | duplicate_rate | error |
| finlab/diversity/chip_diversity/feature_lake | provenance | error |
| finlab/diversity/chip_diversity/feature_lake | promotion_gate_status | error |
| finlab/diversity/chip_diversity/clean | crowding | error |
| finlab/diversity/chip_diversity/clean | extreme_value_winsorization | error |
| finlab/diversity/chip_diversity/clean | liquidity | error |
| finlab/diversity/chip_diversity/clean | price_location | error |
| finlab/diversity/chip_diversity/clean | price_location_gate | error |
| finlab/diversity/chip_diversity/clean | turnover | error |
| finlab/diversity/chip_diversity/feature_lake | shadow_feature_only | error |
| finlab/diversity/emerging_chip_diversity/raw | freshness | error |
| finlab/diversity/emerging_chip_diversity/raw | schema_presence | error |
| finlab/diversity/emerging_chip_diversity/raw | field_count_positive | error |
| finlab/diversity/emerging_chip_diversity/clean | schema_compatibility | error |
| finlab/diversity/emerging_chip_diversity/clean | null_rate | error |
| finlab/diversity/emerging_chip_diversity/clean | duplicate_rate | error |
| finlab/diversity/emerging_chip_diversity/feature_lake | provenance | error |
| finlab/diversity/emerging_chip_diversity/feature_lake | promotion_gate_status | error |
| finlab/diversity/emerging_chip_diversity/clean | branch_concentration_bounds | error |
| finlab/diversity/emerging_chip_diversity/clean | emerging_symbol_coverage | error |
| finlab/diversity/emerging_chip_diversity/feature_lake | no_pending_buy | error |
| finlab/diversity/emerging_chip_diversity/feature_lake | watchlist_only | error |
| finlab/diversity/emerging_chip_diversity/feature_lake | shadow_feature_only | error |
| finlab/diversity/emerging_price_diversity/raw | freshness | error |
| finlab/diversity/emerging_price_diversity/raw | schema_presence | error |
| finlab/diversity/emerging_price_diversity/raw | field_count_positive | error |
| finlab/diversity/emerging_price_diversity/clean | schema_compatibility | error |
| finlab/diversity/emerging_price_diversity/clean | null_rate | error |
| finlab/diversity/emerging_price_diversity/clean | duplicate_rate | error |
| finlab/diversity/emerging_price_diversity/feature_lake | provenance | error |
| finlab/diversity/emerging_price_diversity/feature_lake | promotion_gate_status | error |
| finlab/diversity/emerging_price_diversity/clean | liquidity_bounds | error |
| finlab/diversity/emerging_price_diversity/clean | no_pending_buy | error |
| finlab/diversity/emerging_price_diversity/clean | rotc_market_lane | error |
| finlab/diversity/emerging_price_diversity/feature_lake | no_pending_buy | error |
| finlab/diversity/emerging_price_diversity/feature_lake | watchlist_only | error |
| finlab/diversity/emerging_price_diversity/feature_lake | shadow_feature_only | error |
| finlab/diversity/emerging_revenue_diversity/raw | freshness | error |
| finlab/diversity/emerging_revenue_diversity/raw | schema_presence | error |
| finlab/diversity/emerging_revenue_diversity/raw | field_count_positive | error |
| finlab/diversity/emerging_revenue_diversity/clean | schema_compatibility | error |
| finlab/diversity/emerging_revenue_diversity/clean | null_rate | error |
| finlab/diversity/emerging_revenue_diversity/clean | duplicate_rate | error |
| finlab/diversity/emerging_revenue_diversity/feature_lake | provenance | error |
| finlab/diversity/emerging_revenue_diversity/feature_lake | promotion_gate_status | error |
| finlab/diversity/emerging_revenue_diversity/clean | no_pending_buy | error |
| finlab/diversity/emerging_revenue_diversity/clean | publication_alignment | error |
| finlab/diversity/emerging_revenue_diversity/clean | restatement_check | error |
| finlab/diversity/emerging_revenue_diversity/feature_lake | no_pending_buy | error |
| finlab/diversity/emerging_revenue_diversity/feature_lake | watchlist_only | error |
| finlab/diversity/emerging_revenue_diversity/feature_lake | shadow_feature_only | error |
| finlab/diversity/fundamental_factor_diversity/raw | freshness | error |
| finlab/diversity/fundamental_factor_diversity/raw | schema_presence | error |
| finlab/diversity/fundamental_factor_diversity/raw | field_count_positive | error |
| finlab/diversity/fundamental_factor_diversity/clean | schema_compatibility | error |
| finlab/diversity/fundamental_factor_diversity/clean | null_rate | error |
| finlab/diversity/fundamental_factor_diversity/clean | duplicate_rate | error |
| finlab/diversity/fundamental_factor_diversity/feature_lake | provenance | error |
| finlab/diversity/fundamental_factor_diversity/feature_lake | promotion_gate_status | error |
| finlab/diversity/fundamental_factor_diversity/clean | no_lookahead | error |
| finlab/diversity/fundamental_factor_diversity/clean | report_date_availability | error |
| finlab/diversity/fundamental_factor_diversity/clean | sector_normalization | error |
| finlab/diversity/fundamental_factor_diversity/feature_lake | shadow_feature_only | error |
| finlab/diversity/global_context/raw | freshness | error |
| finlab/diversity/global_context/raw | schema_presence | error |
| finlab/diversity/global_context/raw | field_count_positive | error |
| finlab/diversity/global_context/clean | schema_compatibility | error |
| finlab/diversity/global_context/clean | null_rate | error |
| finlab/diversity/global_context/clean | duplicate_rate | error |
| finlab/diversity/global_context/feature_lake | provenance | error |
| finlab/diversity/global_context/feature_lake | promotion_gate_status | error |
| finlab/diversity/global_context/clean | coverage | error |
| finlab/diversity/global_context/clean | delay | error |
| finlab/diversity/global_context/clean | holiday_calendar_alignment | error |
| finlab/diversity/global_context/clean | license | error |
| finlab/diversity/global_context/clean | survivorship_check | error |
| finlab/diversity/global_context/feature_lake | shadow_feature_only | error |
| finlab/diversity/regime_context/raw | freshness | error |
| finlab/diversity/regime_context/raw | schema_presence | error |
| finlab/diversity/regime_context/raw | field_count_positive | error |
| finlab/diversity/regime_context/clean | schema_compatibility | error |
| finlab/diversity/regime_context/clean | null_rate | error |
| finlab/diversity/regime_context/clean | duplicate_rate | error |
| finlab/diversity/regime_context/feature_lake | provenance | error |
| finlab/diversity/regime_context/feature_lake | promotion_gate_status | error |
| finlab/diversity/regime_context/clean | freshness | error |
| finlab/diversity/regime_context/clean | low_frequency_alignment | error |
| finlab/diversity/regime_context/clean | market_level_only | error |
| finlab/diversity/regime_context/clean | no_direct_alpha_gate | error |
| finlab/diversity/regime_context/feature_lake | shadow_feature_only | error |
| finlab/diversity/taxonomy_expansion/raw | freshness | error |
| finlab/diversity/taxonomy_expansion/raw | schema_presence | error |
| finlab/diversity/taxonomy_expansion/raw | field_count_positive | error |
| finlab/diversity/taxonomy_expansion/clean | schema_compatibility | error |
| finlab/diversity/taxonomy_expansion/clean | null_rate | error |
| finlab/diversity/taxonomy_expansion/clean | duplicate_rate | error |
| finlab/diversity/taxonomy_expansion/feature_lake | provenance | error |
| finlab/diversity/taxonomy_expansion/feature_lake | promotion_gate_status | error |
| finlab/diversity/taxonomy_expansion/clean | alias_cleaning | error |
| finlab/diversity/taxonomy_expansion/clean | coverage_by_symbol | error |
| finlab/diversity/taxonomy_expansion/clean | duplicate_tag_rate | error |
| finlab/diversity/taxonomy_expansion/feature_lake | shadow_feature_only | error |
| finlab/parity/chip_diversity/raw | freshness | error |
| finlab/parity/chip_diversity/raw | schema_presence | error |
| finlab/parity/chip_diversity/raw | field_count_positive | error |
| finlab/parity/chip_diversity/clean | schema_compatibility | error |
| finlab/parity/chip_diversity/clean | null_rate | error |
| finlab/parity/chip_diversity/clean | duplicate_rate | error |
| finlab/parity/chip_diversity/feature_lake | provenance | error |
| finlab/parity/chip_diversity/feature_lake | promotion_gate_status | error |
| finlab/parity/chip_diversity/clean | crowding | error |
| finlab/parity/chip_diversity/clean | extreme_value_winsorization | error |
| finlab/parity/chip_diversity/clean | liquidity | error |
| finlab/parity/chip_diversity/clean | price_location | error |
| finlab/parity/chip_diversity/feature_lake | twse_tpex_diff_report | error |
| finlab/parity/daily_price/raw | freshness | error |
| finlab/parity/daily_price/raw | schema_presence | error |
| finlab/parity/daily_price/raw | field_count_positive | error |
| finlab/parity/daily_price/clean | schema_compatibility | error |
| finlab/parity/daily_price/clean | null_rate | error |
| finlab/parity/daily_price/clean | duplicate_rate | error |
| finlab/parity/daily_price/feature_lake | provenance | error |
| finlab/parity/daily_price/feature_lake | promotion_gate_status | error |
| finlab/parity/daily_price/clean | 20_30_day_parity | error |
| finlab/parity/daily_price/clean | missing_rate | error |
| finlab/parity/daily_price/clean | split_adjustment | error |
| finlab/parity/daily_price/feature_lake | twse_tpex_diff_report | error |
| finlab/parity/fundamental_factor_diversity/raw | freshness | error |
| finlab/parity/fundamental_factor_diversity/raw | schema_presence | error |
| finlab/parity/fundamental_factor_diversity/raw | field_count_positive | error |
| finlab/parity/fundamental_factor_diversity/clean | schema_compatibility | error |
| finlab/parity/fundamental_factor_diversity/clean | null_rate | error |
| finlab/parity/fundamental_factor_diversity/clean | duplicate_rate | error |
| finlab/parity/fundamental_factor_diversity/feature_lake | provenance | error |
| finlab/parity/fundamental_factor_diversity/feature_lake | promotion_gate_status | error |
| finlab/parity/fundamental_factor_diversity/clean | no_lookahead | error |
| finlab/parity/fundamental_factor_diversity/clean | report_date_availability | error |
| finlab/parity/fundamental_factor_diversity/clean | sector_normalization | error |
| finlab/parity/fundamental_factor_diversity/feature_lake | twse_tpex_diff_report | error |
| finlab/parity/revenue/raw | freshness | error |
| finlab/parity/revenue/raw | schema_presence | error |
| finlab/parity/revenue/raw | field_count_positive | error |
| finlab/parity/revenue/clean | schema_compatibility | error |
| finlab/parity/revenue/clean | null_rate | error |
| finlab/parity/revenue/clean | duplicate_rate | error |
| finlab/parity/revenue/feature_lake | provenance | error |
| finlab/parity/revenue/feature_lake | promotion_gate_status | error |
| finlab/parity/revenue/clean | announcement_date_alignment | error |
| finlab/parity/revenue/clean | restatement_check | error |
| finlab/parity/revenue/feature_lake | twse_tpex_diff_report | error |
| finlab/parity/security_master/raw | freshness | error |
| finlab/parity/security_master/raw | schema_presence | error |
| finlab/parity/security_master/raw | field_count_positive | error |
| finlab/parity/security_master/clean | schema_compatibility | error |
| finlab/parity/security_master/clean | null_rate | error |
| finlab/parity/security_master/clean | duplicate_rate | error |
| finlab/parity/security_master/feature_lake | provenance | error |
| finlab/parity/security_master/feature_lake | promotion_gate_status | error |
| finlab/parity/security_master/clean | known_symbol_checks | error |
| finlab/parity/security_master/clean | market_enum | error |
| finlab/parity/security_master/clean | row_count | error |
| finlab/parity/security_master/feature_lake | twse_tpex_diff_report | error |
| finlab/research/daily_price/raw | freshness | error |
| finlab/research/daily_price/raw | schema_presence | error |
| finlab/research/daily_price/raw | field_count_positive | error |
| finlab/research/daily_price/clean | schema_compatibility | error |
| finlab/research/daily_price/clean | null_rate | error |
| finlab/research/daily_price/clean | duplicate_rate | error |
| finlab/research/daily_price/feature_lake | provenance | error |
| finlab/research/daily_price/feature_lake | promotion_gate_status | error |
| finlab/research/daily_price/clean | 20_30_day_parity | error |
| finlab/research/daily_price/clean | missing_rate | error |
| finlab/research/daily_price/clean | split_adjustment | error |
| finlab/research/daily_price/feature_lake | research_only | warn |
| finlab/research/research/raw | freshness | error |
| finlab/research/research/raw | schema_presence | error |
| finlab/research/research/raw | field_count_positive | error |
| finlab/research/research/clean | schema_compatibility | error |
| finlab/research/research/clean | null_rate | error |
| finlab/research/research/clean | duplicate_rate | error |
| finlab/research/research/feature_lake | provenance | error |
| finlab/research/research/feature_lake | promotion_gate_status | error |
| finlab/research/research/clean | manual_review | error |
| finlab/research/research/clean | research_only | error |
| finlab/research/research/feature_lake | research_only | warn |

## Promotion Rule

Enable Dagster schedules only after the POC can prove schema compatibility, freshness checks, lineage, and rerun semantics without changing StockVision's current 106-feature production contract.
