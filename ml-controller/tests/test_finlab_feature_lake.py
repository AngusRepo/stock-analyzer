from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_feature_lake import (  # noqa: E402
    build_canonical_feature_contract,
    build_finlab_feature_lake_manifest,
    validate_finlab_feature_lake_manifest,
)


def _feature_cols() -> list[str]:
    return [f"feature_{idx:03d}" for idx in range(137)]


def _adoption_plan() -> dict:
    return {
        "schema_version": "finlab-adoption-plan-v1",
        "checksum": "sha256:plan",
        "assets": [
            {
                "asset_key": "finlab/parity/daily_price",
                "stage": "parity",
                "dataset_lane": "daily_price",
                "field_count": 10,
                "stockvision_use": "daily price parity",
                "quality_gates": ["20_30_day_parity", "missing_rate"],
            },
            {
                "asset_key": "finlab/diversity/emerging_chip_diversity",
                "stage": "diversity",
                "dataset_lane": "emerging_chip_diversity",
                "field_count": 1,
                "stockvision_use": "emerging broker flow",
                "quality_gates": ["emerging_symbol_coverage"],
            },
            {
                "asset_key": "finlab/research/research",
                "stage": "research",
                "dataset_lane": "research",
                "field_count": 100,
                "stockvision_use": "benchmark-only research candidates",
                "quality_gates": ["research_only"],
            },
        ],
    }


def _definitions_payload() -> dict:
    return {
        "schema_version": "finlab-dagster-definitions-payload-v1",
        "asset_graph_checksum": "sha256:graph",
        "source_plan_checksum": "sha256:plan",
        "assets": [
            {
                "key": ["finlab", "parity", "daily_price", "feature_lake"],
                "metadata": {
                    "stage": "parity",
                    "dataset_lane": "daily_price",
                    "field_count": 10,
                    "stockvision_use": "daily price parity",
                },
            },
            {
                "key": ["finlab", "diversity", "emerging_chip_diversity", "feature_lake"],
                "metadata": {
                    "stage": "diversity",
                    "dataset_lane": "emerging_chip_diversity",
                    "field_count": 1,
                    "stockvision_use": "emerging broker flow",
                },
            },
            {
                "key": ["finlab", "research", "research", "feature_lake"],
                "metadata": {
                    "stage": "research",
                    "dataset_lane": "research",
                    "field_count": 100,
                    "stockvision_use": "benchmark-only research candidates",
                },
            },
        ],
        "asset_checks": [
            {
                "name": "missing_rate",
                "asset_key": ["finlab", "parity", "daily_price", "clean"],
                "metadata": {"severity": "error"},
            },
            {
                "name": "twse_tpex_diff_report",
                "asset_key": ["finlab", "parity", "daily_price", "feature_lake"],
                "metadata": {"severity": "error"},
            },
            {
                "name": "no_pending_buy",
                "asset_key": ["finlab", "diversity", "emerging_chip_diversity", "feature_lake"],
                "metadata": {"severity": "error"},
            },
        ],
    }


def test_canonical_feature_contract_freezes_formal137_features():
    contract = build_canonical_feature_contract(
        _feature_cols(),
        schema_version="v2",
        source_module="ml-service.app.features.FEATURE_COLS",
    )

    assert contract["feature_count"] == 137
    assert contract["production_mutation_allowed"] is False
    assert contract["sidecar_policy"] == "do_not_append_unpromoted_finlab_sidecar_to_formal_feature_contract"
    assert contract["features"][0] == "feature_000"
    assert contract["features_hash"].startswith("sha256:")


def test_feature_lake_manifest_keeps_finlab_sidecar_out_of_production_features():
    manifest = build_finlab_feature_lake_manifest(
        _adoption_plan(),
        _definitions_payload(),
        canonical_features=_feature_cols(),
        generated_at="2026-05-16T00:00:00+00:00",
    )

    families = {family["asset_key"]: family for family in manifest["sidecar_families"]}
    parity = families["finlab/parity/daily_price/feature_lake"]
    emerging = families["finlab/diversity/emerging_chip_diversity/feature_lake"]
    research = families["finlab/research/research/feature_lake"]

    assert manifest["canonical_feature_contract"]["feature_count"] == 137
    assert manifest["policy"]["production_ml_input"] == "formal137_governed_feature_contract"
    assert parity["promotion_state"] == "shadow_parity"
    assert parity["eligible_for_ml_training"] is False
    assert parity["join_keys"] == ["symbol", "date"]
    assert "twse_tpex_diff_report" in parity["row_level_checks"]
    assert emerging["eligible_for_pending_buy"] is False
    assert emerging["watchlist_only"] is True
    assert research["promotion_state"] == "research_only"


def test_validate_feature_lake_manifest_blocks_unsafe_promotion():
    manifest = build_finlab_feature_lake_manifest(
        _adoption_plan(),
        _definitions_payload(),
        canonical_features=_feature_cols(),
        generated_at="2026-05-16T00:00:00+00:00",
    )
    manifest["canonical_feature_contract"]["feature_count"] = 136
    manifest["sidecar_families"][1]["eligible_for_pending_buy"] = True

    errors = validate_finlab_feature_lake_manifest(manifest)

    assert "canonical_feature_count_mismatch" in errors
    assert "emerging_pending_buy_enabled:finlab/diversity/emerging_chip_diversity/feature_lake" in errors
