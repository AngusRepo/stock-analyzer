from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_emerging_watchlist import (  # noqa: E402
    build_finlab_emerging_watchlist_manifest,
    summarize_emerging_watchlist_context,
    validate_finlab_emerging_watchlist_manifest,
)


def _feature_lake_manifest() -> dict:
    return {
        "schema_version": "finlab-feature-lake-manifest-v1",
        "checksum": "sha256:feature-lake",
        "sidecar_families": [
            {
                "asset_key": "finlab/diversity/emerging_chip_diversity/feature_lake",
                "stage": "diversity",
                "dataset_lane": "emerging_chip_diversity",
                "feature_namespace": "finlab_diversity_emerging_chip_diversity",
                "field_count": 1,
                "stockvision_use": "emerging-stock broker flow proxy and concentration checks",
                "quality_gates": ["emerging_symbol_coverage, branch_concentration_bounds"],
                "all_checks": [
                    "branch_concentration_bounds",
                    "emerging_symbol_coverage",
                    "no_pending_buy",
                    "shadow_feature_only",
                    "watchlist_only",
                ],
                "row_level_checks": ["duplicate_rate", "null_rate"],
                "metadata_only_checks": [
                    "branch_concentration_bounds",
                    "emerging_symbol_coverage",
                    "no_pending_buy",
                    "shadow_feature_only",
                    "watchlist_only",
                ],
                "eligible_for_pending_buy": False,
                "watchlist_only": True,
            },
            {
                "asset_key": "finlab/diversity/emerging_price_diversity/feature_lake",
                "stage": "diversity",
                "dataset_lane": "emerging_price_diversity",
                "feature_namespace": "finlab_diversity_emerging_price_diversity",
                "field_count": 10,
                "stockvision_use": "emerging-stock price, liquidity and spread watchlist context",
                "quality_gates": ["rotc_market_lane, liquidity_bounds, no_pending_buy"],
                "all_checks": [
                    "liquidity_bounds",
                    "no_pending_buy",
                    "rotc_market_lane",
                    "shadow_feature_only",
                    "watchlist_only",
                ],
                "row_level_checks": ["duplicate_rate", "null_rate"],
                "metadata_only_checks": [
                    "liquidity_bounds",
                    "no_pending_buy",
                    "rotc_market_lane",
                    "shadow_feature_only",
                    "watchlist_only",
                ],
                "eligible_for_pending_buy": False,
                "watchlist_only": True,
            },
            {
                "asset_key": "finlab/diversity/emerging_revenue_diversity/feature_lake",
                "stage": "diversity",
                "dataset_lane": "emerging_revenue_diversity",
                "feature_namespace": "finlab_diversity_emerging_revenue_diversity",
                "field_count": 9,
                "stockvision_use": "emerging-stock revenue momentum watchlist context",
                "quality_gates": ["publication_alignment, restatement_check, no_pending_buy"],
                "all_checks": [
                    "no_pending_buy",
                    "publication_alignment",
                    "restatement_check",
                    "shadow_feature_only",
                    "watchlist_only",
                ],
                "row_level_checks": ["duplicate_rate", "null_rate"],
                "metadata_only_checks": [
                    "no_pending_buy",
                    "publication_alignment",
                    "restatement_check",
                    "shadow_feature_only",
                    "watchlist_only",
                ],
                "eligible_for_pending_buy": False,
                "watchlist_only": True,
            },
        ],
    }


def test_emerging_watchlist_manifest_maps_three_rotc_sources_to_context_only_use():
    manifest = build_finlab_emerging_watchlist_manifest(
        _feature_lake_manifest(),
        generated_at="2026-05-16T00:00:00+00:00",
    )

    sources = {source["source_dataset"]: source for source in manifest["source_contracts"]}

    assert manifest["policy"]["mode"] == "shadow_watchlist_only"
    assert manifest["policy"]["pending_buy_enabled"] is False
    assert manifest["policy"]["execution_enabled"] is False
    assert manifest["policy"]["production_ml_training_enabled"] is False
    assert manifest["board_policy"]["finlab_raw_market"] == "rotc"
    assert manifest["board_policy"]["stockvision_market_segment"] == "EMERGING"
    assert set(sources) == {"rotc_price", "rotc_monthly_revenue", "rotc_broker_transactions"}
    assert sources["rotc_price"]["usage"] == "liquidity_spread_context"
    assert sources["rotc_monthly_revenue"]["normalized_period_key"] == "revenue_month"
    assert sources["rotc_broker_transactions"]["usage"] == "broker_concentration_context"
    assert validate_finlab_emerging_watchlist_manifest(manifest) == []


def test_validate_emerging_watchlist_manifest_blocks_pending_buy_and_missing_sources():
    manifest = build_finlab_emerging_watchlist_manifest(
        _feature_lake_manifest(),
        generated_at="2026-05-16T00:00:00+00:00",
    )
    manifest["policy"]["pending_buy_enabled"] = True
    manifest["source_contracts"] = [
        source for source in manifest["source_contracts"] if source["source_dataset"] != "rotc_broker_transactions"
    ]

    errors = validate_finlab_emerging_watchlist_manifest(manifest)

    assert "pending_buy_enabled" in errors
    assert "source_dataset_missing:rotc_broker_transactions" in errors


def test_summarize_emerging_watchlist_context_derives_liquidity_spread_and_revenue_context():
    context = summarize_emerging_watchlist_context(
        "6682",
        price_row={
            "收盤價": "52.5",
            "最後揭示買價": "52.0",
            "最後揭示賣價": "53.0",
            "成交股數": "120000",
            "成交金額": "6300000",
            "成交筆數": "48",
        },
        revenue_row={
            "當月營收": "98000000",
            "上月比較增減(%)": "12.5",
            "去年同月增減(%)": "35.1",
            "備註": "",
        },
        broker_row={
            "top_branch_buy_ratio": "0.42",
            "top_branch_sell_ratio": "0.18",
        },
    )

    assert context["symbol"] == "6682"
    assert context["allowed_decisions"] == ["watchlist", "manual_review", "context_only"]
    assert "pending_buy" in context["blocked_decisions"]
    assert context["price"]["spread_pct"] == 1.9
    assert context["price"]["turnover_value"] == 6300000.0
    assert context["revenue"]["mom_pct"] == 12.5
    assert context["revenue"]["yoy_pct"] == 35.1
    assert context["broker_flow"]["top_branch_buy_ratio"] == 0.42
