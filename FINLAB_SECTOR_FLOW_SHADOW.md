# FinLab Sector Flow Shadow Manifest

Generated: 2026-05-15T18:06:14.900117+00:00
Schema: `finlab-sector-flow-shadow-manifest-v1`
Checksum: `sha256:3cdd0722d1f6f1259c81a06eb3891c0a784d20a1ff42caca19419027c73cd841`
Source feature lake checksum: `sha256:b2cd1ac34a5edb2203d9c71cb7ee7d0ab8163cd5b3ad0d6cd24e99e5e0f59595`

## Policy

- `mode`: shadow_only
- `production_write_enabled`: False
- `cross_layer_rollup_allowed`: False
- `isolation_key`: ['date', 'sector', 'classification']
- `dedupe_key`: ['symbol', 'tag_type', 'tag']
- `cash_flow_source`: chip_data_5d_or_finlab_chip_diversity_shadow
- `promotion_default`: no_direct_screener_or_ml_use

## Sources

```json
{
  "taxonomy_source": {
    "asset_key": "finlab/diversity/taxonomy_expansion/feature_lake",
    "feature_namespace": "finlab_diversity_taxonomy_expansion",
    "field_count": 1,
    "metadata_only_checks": [
      "alias_cleaning",
      "coverage_by_symbol",
      "duplicate_tag_rate",
      "field_count_positive",
      "freshness",
      "promotion_gate_status",
      "provenance",
      "schema_compatibility",
      "schema_presence",
      "shadow_feature_only"
    ],
    "row_level_checks": [
      "duplicate_rate",
      "null_rate"
    ]
  },
  "cash_flow_source": {
    "asset_key": "finlab/diversity/chip_diversity/feature_lake",
    "feature_namespace": "finlab_diversity_chip_diversity",
    "field_count": 53,
    "row_level_checks": [
      "duplicate_rate",
      "null_rate"
    ]
  },
  "summary": {
    "layer_count": 4,
    "taxonomy_sidecar_fields": 1,
    "chip_sidecar_fields": 53
  }
}
```

## Layer Contract

| tag_type | classification | source_kind | source_dataset | source_fields | role |
| --- | --- | --- | --- | --- | --- |
| industry | industry | finlab | security_categories | category, market | formal listed/otc/emerging industry grouping |
| industry_theme | industry_theme | finlab | security_industry_themes | category, name | FinLab thematic industry taxonomy |
| subindustry | subindustry | finlab | security_industry_themes | name, category | finer taxonomy below formal industry/theme |
| concept | theme | local_overlay | concept_stock_mapping.json | concept, symbol | local market-topic overlay and event-driven concept tags |

## No Double Counting Rule

Each layer is aggregated independently with isolation key `(date, sector, classification)`. The same symbol can appear in industry, industry_theme, subindustry, and concept layers, but those memberships must not be rolled up into a single cross-layer total. Within a layer, duplicate `(symbol, tag_type, tag)` rows are dropped before aggregation.

## Boundary

This manifest does not alter the existing `sector_flow` production write path. It defines the FinLab taxonomy shadow contract that future Dagster materialization and row-level checks must satisfy before screener or ML promotion.
