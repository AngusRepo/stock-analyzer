from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_dagster_assets import (  # noqa: E402
    build_finlab_asset_graph,
    validate_finlab_asset_graph,
)


def _plan() -> dict:
    return {
        "schema_version": "finlab-adoption-plan-v1",
        "generated_at": "2026-05-15T00:00:00+00:00",
        "checksum": "sha256:plan",
        "counts": {"field_count": 3},
        "assets": [
            {
                "asset_key": "finlab/parity/daily_price",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "access_tier": "compute",
                "field_count": 2,
                "markets": ["tw"],
                "namespaces": ["price", "etl"],
                "quality_gates": [
                    "20_30_day_parity, split_adjustment, missing_rate",
                ],
                "stockvision_use": "daily price parity",
                "sample_api_keys": ["price:close", "etl:adj_close"],
                "checksum": "sha256:asset1",
            },
            {
                "asset_key": "finlab/diversity/taxonomy_expansion",
                "stage": "diversity",
                "dataset_lane": "taxonomy_expansion",
                "access_tier": "compute",
                "field_count": 1,
                "markets": ["tw"],
                "namespaces": ["security_industry_themes"],
                "quality_gates": [
                    "alias_cleaning, duplicate_tag_rate, coverage_by_symbol",
                ],
                "stockvision_use": "taxonomy expansion",
                "sample_api_keys": ["security_industry_themes"],
                "checksum": "sha256:asset2",
            },
        ],
    }


def test_build_finlab_asset_graph_expands_assets_to_raw_clean_feature_nodes():
    graph = build_finlab_asset_graph(_plan(), generated_at="2026-05-16T00:00:00+00:00")

    keys = {node["asset_key"] for node in graph["nodes"]}

    assert graph["schema_version"] == "finlab-dagster-asset-graph-v1"
    assert graph["source_plan_checksum"] == "sha256:plan"
    assert "finlab/parity/daily_price/raw" in keys
    assert "finlab/parity/daily_price/clean" in keys
    assert "finlab/parity/daily_price/feature_lake" in keys
    assert "finlab/diversity/taxonomy_expansion/raw" in keys
    assert len(graph["nodes"]) == 6

    clean_node = next(node for node in graph["nodes"] if node["asset_key"] == "finlab/parity/daily_price/clean")
    feature_node = next(node for node in graph["nodes"] if node["asset_key"] == "finlab/parity/daily_price/feature_lake")

    assert clean_node["deps"] == ["finlab/parity/daily_price/raw"]
    assert feature_node["deps"] == ["finlab/parity/daily_price/clean"]
    assert feature_node["group_name"] == "finlab_v4_parity"


def test_quality_gate_runtime_includes_standard_and_plan_specific_checks():
    graph = build_finlab_asset_graph(_plan(), generated_at="2026-05-16T00:00:00+00:00")
    checks = {
        (check["asset_key"], check["check_name"])
        for check in graph["checks"]
    }

    assert ("finlab/parity/daily_price/raw", "freshness") in checks
    assert ("finlab/parity/daily_price/raw", "field_count_positive") in checks
    assert ("finlab/parity/daily_price/clean", "missing_rate") in checks
    assert ("finlab/parity/daily_price/clean", "split_adjustment") in checks
    assert ("finlab/diversity/taxonomy_expansion/clean", "alias_cleaning") in checks
    assert ("finlab/diversity/taxonomy_expansion/clean", "coverage_by_symbol") in checks


def test_validate_finlab_asset_graph_flags_missing_nodes_and_checks():
    graph = build_finlab_asset_graph(_plan(), generated_at="2026-05-16T00:00:00+00:00")
    graph["nodes"] = [node for node in graph["nodes"] if not node["asset_key"].endswith("/feature_lake")]
    graph["checks"] = []

    errors = validate_finlab_asset_graph(graph)

    assert "feature_lake_nodes_missing" in errors
    assert "checks_missing" in errors
