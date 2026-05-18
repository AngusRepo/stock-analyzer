from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_adoption_plan import (  # noqa: E402
    FINLAB_ADOPTION_PLAN_SCHEMA_VERSION,
    build_finlab_adoption_plan,
    validate_finlab_adoption_plan,
)


def _field(
    api_key: str,
    *,
    lane: str,
    mode: str,
    priority: str = "P0",
    market: str = "tw",
    namespace: str = "mock",
    replace: bool = False,
) -> dict:
    return {
        "market": market,
        "namespace": namespace,
        "field": api_key.split(":", 1)[1] if ":" in api_key else "",
        "api_key": api_key,
        "group": "mock",
        "stockvision_use": "mock use",
        "adoption_priority": priority,
        "adoption_mode": mode,
        "dataset_lane": lane,
        "quality_gate": f"{lane}_quality_gate",
        "replaces_twse_tpex_primary": replace,
    }


def test_build_finlab_adoption_plan_splits_parity_diversity_and_research():
    catalog = {
        "generated_at": "2026-05-15T00:00:00+00:00",
        "finlab_sdk_version": "2.0.7",
        "all_market_search_count": 8,
        "field_count": 8,
        "fields": [
            _field("security_categories", lane="security_master", mode="replace", replace=True),
            _field("security_industry_themes", lane="taxonomy_expansion", mode="augment"),
            _field("price:close", lane="daily_price", mode="replace", replace=True),
            _field("monthly_revenue:current", lane="revenue", mode="replace", replace=True),
            _field("institutional:foreign", lane="chip_diversity", mode="augment"),
            _field("rotc_broker_transactions", lane="emerging_chip_diversity", mode="augment"),
            _field("world_index:close", lane="global_context", mode="augment"),
            _field("hk_price:close", lane="research", mode="benchmark", priority="P2", market="hk"),
        ],
    }

    plan = build_finlab_adoption_plan(catalog, generated_at="2026-05-15T01:00:00+00:00")

    assert plan["schema_version"] == FINLAB_ADOPTION_PLAN_SCHEMA_VERSION
    assert plan["counts"]["field_count"] == 8
    assert plan["counts"]["fields_by_stage"] == {
        "parity": 3,
        "diversity": 4,
        "research": 1,
    }
    assert validate_finlab_adoption_plan(plan) == []


def test_validate_finlab_adoption_plan_requires_mandatory_lanes():
    plan = build_finlab_adoption_plan(
        {
            "fields": [
                _field("price:close", lane="daily_price", mode="replace", replace=True),
            ]
        }
    )

    errors = validate_finlab_adoption_plan(plan)

    assert any(error.startswith("required_lanes_missing:") for error in errors)


def test_replace_mode_without_replacement_flag_stays_out_of_parity():
    plan = build_finlab_adoption_plan(
        {
            "fields": [
                _field(
                    "etl:us_liquid_stock_filter",
                    lane="daily_price",
                    mode="replace",
                    market="us",
                    namespace="etl",
                    replace=False,
                ),
            ]
        }
    )

    assert plan["counts"]["fields_by_stage"] == {"research": 1}
