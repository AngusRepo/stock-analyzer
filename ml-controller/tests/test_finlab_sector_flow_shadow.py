from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_sector_flow_shadow import (  # noqa: E402
    build_finlab_sector_flow_shadow_manifest,
    normalize_sector_flow_memberships,
    validate_finlab_sector_flow_shadow_manifest,
)


def _feature_lake_manifest() -> dict:
    return {
        "schema_version": "finlab-feature-lake-manifest-v1",
        "checksum": "sha256:feature-lake",
        "sidecar_families": [
            {
                "asset_key": "finlab/diversity/taxonomy_expansion/feature_lake",
                "stage": "diversity",
                "dataset_lane": "taxonomy_expansion",
                "feature_namespace": "finlab_diversity_taxonomy_expansion",
                "field_count": 2,
                "row_level_checks": ["duplicate_rate", "null_rate"],
                "metadata_only_checks": ["alias_cleaning", "coverage_by_symbol"],
            },
            {
                "asset_key": "finlab/diversity/chip_diversity/feature_lake",
                "stage": "diversity",
                "dataset_lane": "chip_diversity",
                "feature_namespace": "finlab_diversity_chip_diversity",
                "field_count": 50,
                "row_level_checks": ["duplicate_rate", "null_rate"],
                "metadata_only_checks": ["liquidity"],
            },
        ],
    }


def test_sector_flow_shadow_manifest_has_four_isolated_layers():
    manifest = build_finlab_sector_flow_shadow_manifest(
        _feature_lake_manifest(),
        generated_at="2026-05-16T00:00:00+00:00",
    )

    layers = {layer["tag_type"]: layer for layer in manifest["layers"]}

    assert manifest["policy"]["mode"] == "shadow_only"
    assert manifest["policy"]["cross_layer_rollup_allowed"] is False
    assert manifest["policy"]["isolation_key"] == ["date", "sector", "classification"]
    assert layers["industry"]["classification"] == "industry"
    assert layers["industry"]["source_dataset"] == "security_categories"
    assert layers["industry_theme"]["classification"] == "industry_theme"
    assert layers["industry_theme"]["source_dataset"] == "security_industry_themes"
    assert layers["subindustry"]["classification"] == "subindustry"
    assert layers["concept"]["classification"] == "theme"
    assert layers["concept"]["source_kind"] == "local_overlay"


def test_normalize_sector_flow_memberships_dedupes_within_layer_only():
    result = normalize_sector_flow_memberships([
        {"symbol": "2330", "tag_type": "industry", "tag": "半導體", "source": "finlab"},
        {"symbol": "2330", "tag_type": "industry", "tag": "半導體", "source": "finlab"},
        {"symbol": "2330", "tag_type": "industry_theme", "tag": "AI", "source": "finlab"},
        {"symbol": "2330", "tag_type": "concept", "tag": "AI", "source": "local"},
    ])

    keys = {(row["symbol"], row["tag_type"], row["tag"]) for row in result["memberships"]}

    assert result["duplicate_rows_dropped"] == 1
    assert len(result["memberships"]) == 3
    assert ("2330", "industry_theme", "AI") in keys
    assert ("2330", "concept", "AI") in keys
    assert result["cross_layer_memberships_preserved"] is True


def test_validate_sector_flow_shadow_manifest_blocks_cross_layer_rollup():
    manifest = build_finlab_sector_flow_shadow_manifest(
        _feature_lake_manifest(),
        generated_at="2026-05-16T00:00:00+00:00",
    )
    manifest["policy"]["cross_layer_rollup_allowed"] = True
    manifest["layers"][1]["classification"] = "industry"

    errors = validate_finlab_sector_flow_shadow_manifest(manifest)

    assert "cross_layer_rollup_allowed" in errors
    assert "classification_not_unique:industry" in errors
