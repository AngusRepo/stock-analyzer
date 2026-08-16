from __future__ import annotations

import json

from services.screener_seed_domain_merge import merge_screener_seed_domains


def test_merge_preserves_legacy_coalesce_precedence_and_json_semantics():
    rows = merge_screener_seed_domains(
        run_date="2026-08-16",
        ops_seed_rows=[{
            "screener_run_id": "run-1",
            "decision_universe_frozen_at": "2026-08-16T10:00:00Z",
            "symbol": "2330",
            "seed_name": "Seed name",
            "seed_stage": "l1_candidate_seed_after_overlay",
            "seed_reason_code": "seed reason",
            "seed_rank": 2,
            "seed_score": 88.0,
            "seed_evidence": json.dumps({"market_segment": "LISTED"}),
            "scoring_score": 87.0,
            "scoring_evidence": json.dumps({
                "taxonomy": {"industry": "Semiconductor"},
                "score_components": {"quality": 0.8},
            }),
            "l1_evidence": json.dumps({
                "industry": "Fallback industry",
                "strategy_pool_reason": "L1 reason",
            }),
        }],
        daily_rows=[{
            "id": 99,
            "stock_id": 1,
            "symbol": "2330",
            "name": "TSMC",
            "sector": "Technology",
            "industry": None,
            "rank": 9,
            "score": 50,
            "reason": None,
            "recommendation_lane": "",
            "eligible_for_ml": 0,
            "eligible_for_pending_buy": 0,
        }],
        stock_rows=[{
            "stock_id": 1,
            "symbol": "2330",
            "name": "Taiwan Semiconductor",
            "sector": "Semi",
            "market": "TWSE",
        }],
    )

    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == "TSMC"
    assert row["industry"] == "Semiconductor"
    assert row["rank"] == 2
    assert row["score"] == 88.0
    assert row["reason"] == "L1 reason"
    assert row["recommendation_lane"] == ""
    assert row["eligible_for_ml"] == 0
    assert row["eligible_for_pending_buy"] == 0
    assert row["score_components"] == '{"quality":0.8}'
    assert row["watch_points"] == '["screener_seed:l1_candidate_seed_after_overlay","screener_run:run-1"]'


def test_merge_filters_missing_identity_and_emerging_rows():
    rows = merge_screener_seed_domains(
        run_date="2026-08-16",
        ops_seed_rows=[
            {"symbol": "2330", "seed_rank": 1},
            {"symbol": "7777", "seed_rank": 2},
            {"symbol": "8888", "seed_rank": 3},
        ],
        daily_rows=[
            {
                "stock_id": 1,
                "symbol": "2330",
                "market_segment": "LISTED",
                "recommendation_lane": "tradable",
            },
            {
                "stock_id": 8,
                "symbol": "8888",
                "market_segment": "EMERGING",
                "recommendation_lane": "tradable",
            },
        ],
        stock_rows=[
            {"stock_id": 1, "symbol": "2330", "market": "TWSE"},
            {"stock_id": 8, "symbol": "8888", "market": "EMERGING"},
        ],
    )

    assert [row["symbol"] for row in rows] == ["2330"]


def test_merge_orders_by_rank_then_score_descending():
    rows = merge_screener_seed_domains(
        run_date="2026-08-16",
        ops_seed_rows=[
            {"symbol": "A", "seed_rank": 2, "seed_score": 90},
            {"symbol": "B", "seed_rank": 1, "seed_score": 70},
            {"symbol": "C", "seed_rank": 1, "seed_score": 80},
        ],
        daily_rows=[],
        stock_rows=[
            {"stock_id": 1, "symbol": "A", "market": "TWSE"},
            {"stock_id": 2, "symbol": "B", "market": "TWSE"},
            {"stock_id": 3, "symbol": "C", "market": "TWSE"},
        ],
    )

    assert [row["symbol"] for row in rows] == ["C", "B", "A"]
