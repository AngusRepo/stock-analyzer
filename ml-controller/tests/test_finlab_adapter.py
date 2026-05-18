from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_adapter import (  # noqa: E402
    FinLabReadOnlyAdapter,
    build_finlab_parallel_diff_plan,
    classify_finlab_field,
    normalize_finlab_market,
    normalize_security_categories,
    normalize_security_taxonomy,
    split_finlab_field,
)


def test_finlab_market_aliases_match_stockvision_segments():
    assert normalize_finlab_market("sii") == "LISTED"
    assert normalize_finlab_market("otc") == "OTC"
    assert normalize_finlab_market("rotc") == "EMERGING"
    assert normalize_finlab_market("pub") == "UNKNOWN"


def test_security_categories_normalization_preserves_finlab_market_and_lanes():
    securities = normalize_security_categories(
        [
            {
                "symbol": "7820",
                "name": "立盈",
                "category": "綠能環保",
                "market": "otc",
                "stock_id": "7820",
            },
            {
                "symbol": "6682",
                "name": "華旭先進",
                "category": "光電業",
                "market": "rotc",
                "stock_id": "6682",
            },
        ]
    )

    by_symbol = {item.symbol: item for item in securities}
    assert by_symbol["7820"].market_segment == "OTC"
    assert by_symbol["7820"].recommendation_lane == "tradable"
    assert by_symbol["7820"].eligible_for_pending_buy is True
    assert by_symbol["6682"].market_segment == "EMERGING"
    assert by_symbol["6682"].recommendation_lane == "emerging_watchlist"
    assert by_symbol["6682"].eligible_for_pending_buy is False


def test_finlab_field_classification_marks_primary_replacement_scope():
    namespace, field = split_finlab_field("monthly_revenue:當月營收")
    meta = classify_finlab_field(market="tw", namespace=namespace, field=field)

    assert meta.group == "monthly revenue"
    assert meta.adoption_priority == "P0"
    assert meta.adoption_mode == "replace"
    assert meta.dataset_lane == "revenue"
    assert meta.replaces_twse_tpex_primary is True

    us_meta = classify_finlab_field(
        market="us",
        namespace="us_balance_sheet",
        field="cash_and_cash_equivalents",
    )
    assert us_meta.group == "us market"
    assert us_meta.adoption_priority == "P1"
    assert us_meta.adoption_mode == "augment"
    assert us_meta.replaces_twse_tpex_primary is False


def test_finlab_field_classification_promotes_diversity_fields():
    rotc_broker = classify_finlab_field(
        market="tw",
        namespace="rotc_broker_transactions",
    )
    assert rotc_broker.group == "broker / branch flow"
    assert rotc_broker.adoption_priority == "P0"
    assert rotc_broker.adoption_mode == "augment"
    assert rotc_broker.dataset_lane == "emerging_chip_diversity"
    assert rotc_broker.replaces_twse_tpex_primary is False

    listed_broker_metric = classify_finlab_field(
        market="tw",
        namespace="etl",
        field="broker_transactions:top15_buy",
    )
    assert listed_broker_metric.group == "broker / branch flow"
    assert listed_broker_metric.adoption_priority == "P1"
    assert listed_broker_metric.adoption_mode == "augment"
    assert listed_broker_metric.replaces_twse_tpex_primary is False


def test_parallel_diff_plan_keeps_replacement_and_diversity_lanes_separate():
    monthly_revenue = classify_finlab_field(
        market="tw",
        namespace="monthly_revenue",
        field="current_month_revenue",
    )
    rotc_broker = classify_finlab_field(
        market="tw",
        namespace="rotc_broker_transactions",
    )
    us_balance = classify_finlab_field(
        market="us",
        namespace="us_balance_sheet",
        field="cash_and_cash_equivalents",
    )

    plan = build_finlab_parallel_diff_plan([monthly_revenue, rotc_broker, us_balance])

    assert [field.api_key for field in plan.parity_fields] == [
        "monthly_revenue:current_month_revenue"
    ]
    assert [field.api_key for field in plan.diversity_fields] == [
        "rotc_broker_transactions",
        "us_balance_sheet:cash_and_cash_equivalents",
    ]
    assert plan.research_fields == ()


def test_security_taxonomy_builds_finlab_industry_theme_and_subindustry_tags():
    tags = normalize_security_taxonomy(
        security_categories=[
            {
                "symbol": "2330",
                "stock_id": "2330",
                "name": "TSMC",
                "category": "Semiconductor",
            }
        ],
        security_industry_themes=[
            {
                "symbol": "2330",
                "stock_id": "2330",
                "name": "TSMC",
                "category": "\u25baElectronics:IC Design",
            },
            {
                "symbol": "2330",
                "stock_id": "2330",
                "name": "TSMC",
                "category": "Advanced Packaging",
            },
        ],
    )

    tag_map = {(tag.tag_type, tag.tag, tag.source) for tag in tags}
    assert ("industry", "Semiconductor", "finlab:security_categories") in tag_map
    assert (
        "industry_theme",
        "Electronics",
        "finlab:security_industry_themes",
    ) in tag_map
    assert ("subindustry", "IC Design", "finlab:security_industry_themes") in tag_map
    assert (
        "subindustry",
        "Advanced Packaging",
        "finlab:security_industry_themes",
    ) in tag_map


def test_catalog_fields_preserves_market_on_sdk_search_results():
    class FakeData:
        def search(self, *, market: str):
            return {
                "tw": ["price:收盤價", "monthly_revenue:當月營收"],
                "us": ["us_balance_sheet:cash_and_cash_equivalents"],
            }[market]

    adapter = FinLabReadOnlyAdapter(api_key="dummy")
    adapter._data_module = FakeData()
    adapter._logged_in = True

    fields = adapter.catalog_fields(markets=["tw", "us"])
    by_key = {field.api_key: field for field in fields}

    assert by_key["price:收盤價"].market == "tw"
    assert by_key["price:收盤價"].replaces_twse_tpex_primary is True
    assert by_key["us_balance_sheet:cash_and_cash_equivalents"].market == "us"
    assert by_key["us_balance_sheet:cash_and_cash_equivalents"].replaces_twse_tpex_primary is False
