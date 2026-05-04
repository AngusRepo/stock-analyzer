from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.payload_builder import (  # noqa: E402
    build_ml_universe,
    infer_market_segment,
    build_stock_meta_with_segment,
)
from services.recommendation_service import (  # noqa: E402
    filter_and_score_recommendations,
    hybrid_ranking_promotion,
    update_recommendations_in_d1,
    write_predictions_to_d1,
)


def test_emerging_daily_recommendation_enters_ml_universe_but_not_execution():
    active = [{"id": 1, "symbol": "2330", "name": "TSMC", "market": "TWSE", "sector": "semi"}]
    screener_recs = [
        {
            "stock_id": 2,
            "symbol": "7879",
            "name": "EmergingCo",
            "sector": "other",
            "market": "OTC",
            "watch_points": '["research_only:emerging_not_for_auto_trade","board_lane:emerging_watchlist"]',
        }
    ]

    universe = build_ml_universe(active, screener_recs)
    by_symbol = {row["symbol"]: row for row in universe}

    assert set(by_symbol) == {"2330", "7879"}
    assert by_symbol["2330"]["eligible_for_execution"] is True
    assert by_symbol["7879"]["market_segment"] == "EMERGING"
    assert by_symbol["7879"]["eligible_for_ml"] is True
    assert by_symbol["7879"]["eligible_for_execution"] is False
    assert by_symbol["7879"]["recommendation_lane"] == "emerging_watchlist"


def test_stock_meta_exposes_market_segment_for_train_serve_parity():
    assert infer_market_segment({"market": "OTC"}, {"open": None, "avg_price": 100.53}) == "EMERGING"

    meta = build_stock_meta_with_segment(
        base_meta={"sector_encoded": 3},
        stock={"market": "OTC", "recommendation_lane": "emerging_watchlist"},
        latest_price={"open": None, "avg_price": 100.53},
    )

    assert meta["market_segment"] == "EMERGING"
    assert meta["recommendation_lane"] == "emerging_watchlist"
    assert meta["eligible_for_ml"] is True
    assert meta["eligible_for_execution"] is False
    assert meta["segment_serving_mode"] == "research_only_shadow"
    assert meta["segment_model_pool_scope"] == "emerging_research_pool"
    assert meta["segment_calibration_scope"] == "emerging_research"
    assert meta["segment_calibration_artifact_prefix"] == "calibration/emerging_research"
    assert meta["train_serve_parity_required"] is True


def test_emerging_ml_result_is_kept_as_research_only_and_never_promoted():
    screener_recs = [
        {
            "date": "2026-04-30",
            "stock_id": 2,
            "symbol": "7879",
            "name": "EmergingCo",
            "sector": "other",
            "industry": "other",
            "chip_score": 35,
            "tech_score": 25,
            "score": 60,
            "watch_points": ["research_only:emerging_not_for_auto_trade"],
        }
    ]
    payloads = [
        {
            "symbol": "7879",
            "prices": [{"date": "2026-04-29", "close": 101.5}],
            "stock_meta": {
                "market_segment": "EMERGING",
                "recommendation_lane": "emerging_watchlist",
                "eligible_for_ml": True,
                "eligible_for_execution": False,
            },
        }
    ]
    predictions = {
        "7879": {
            "signal": "BUY",
            "confidence": 0.95,
            "forecast_pct": 0.08,
            "models": {"XGBoost": {"direction": "up"}},
        }
    }

    final, sell_count = filter_and_score_recommendations(screener_recs, predictions, payloads)
    assert sell_count == 0
    assert len(final) == 1
    assert final[0]["ml_score"] > 0
    assert final[0]["has_buy_signal"] == 0
    assert final[0]["recommendation_lane"] == "emerging_watchlist"
    assert final[0]["eligible_for_pending_buy"] is False
    assert "research_only:emerging_not_for_auto_trade" in final[0]["watch_points"]

    promoted = hybrid_ranking_promotion(
        final,
        {"enabled": True, "topK": 1, "alpha": 0.4, "beta": 0.4, "gamma": 0.2, "screenerDenominator": 60, "promoteMinConf": 0.6},
        {"topKConfidenceOverride": 0.72},
    )
    assert promoted[0]["has_buy_signal"] == 0


def test_prediction_forecast_data_preserves_market_segment_metadata(monkeypatch):
    captured: dict[str, object] = {}

    def fake_batch(statements):
        captured["statements"] = statements
        return len(statements)

    def fake_query(sql, params):
        captured["seed_query"] = (sql, params)
        return [{"stock_id": 2}]

    monkeypatch.setattr("services.recommendation_service.d1_client.batch_execute", fake_batch)
    monkeypatch.setattr("services.recommendation_service.d1_client.query", fake_query)
    monkeypatch.setattr("services.recommendation_service._is_use_ensemble_v2", lambda: False)

    write_predictions_to_d1(
        {
            "7879": {
                "signal": "BUY",
                "confidence": 0.9,
                "entry_price": 101.5,
                "stop_loss": 95.0,
                "target1": 110.0,
                "target2": 120.0,
                "rank_scores": {"XGBoost": 0.71},
                "stock_meta": {
                    "market_segment": "EMERGING",
                    "recommendation_lane": "emerging_watchlist",
                    "eligible_for_ml": True,
                    "eligible_for_execution": False,
                    "eligible_for_pending_buy": False,
                },
            }
        },
        {"7879": 2},
        "2026-04-30",
    )

    insert_params = captured["statements"][2][1]
    forecast_data = insert_params[4]
    assert '"stock_meta"' in forecast_data
    assert '"market_segment": "EMERGING"' in forecast_data
    assert '"eligible_for_pending_buy": false' in forecast_data
    assert '"segment_calibration_scope": "emerging_research"' in forecast_data
    assert '"train_serve_parity_required": true' in forecast_data

    per_model_params = captured["statements"][3][1]
    per_model_forecast = per_model_params[5]
    assert '"stock_meta"' in per_model_forecast
    assert '"market_segment": "EMERGING"' in per_model_forecast
    assert '"segment_calibration_artifact_prefix": "calibration/emerging_research"' in per_model_forecast


def test_daily_recommendation_writer_persists_segment_governance(monkeypatch):
    captured: dict[str, object] = {}

    def fake_batch(statements):
        captured["statements"] = statements
        return len(statements)

    def fake_query(sql, params):
        captured["seed_query"] = (sql, params)
        return [{"stock_id": 2}]

    monkeypatch.setattr("services.recommendation_service.d1_client.batch_execute", fake_batch)
    monkeypatch.setattr("services.recommendation_service.d1_client.query", fake_query)

    update_recommendations_in_d1(
        [
            {
                "stock_id": 2,
                "symbol": "7879",
                "name": "EmergingCo",
                "sector": "other",
                "rank": 1,
                "score": 88,
                "signal": "BUY",
                "confidence": 0.91,
                "reason": "research only",
                "watch_points": ["research_only:emerging_not_for_auto_trade"],
                "has_buy_signal": 0,
                "current_price": 101.5,
                "foreign_net_5d": 0,
                "trust_net_5d": 0,
                "rsi14": 55,
                "macd_hist": 0.1,
                "chip_score": 30,
                "tech_score": 24,
                "ml_score": 26,
                "industry": "other",
                "market_segment": "EMERGING",
                "recommendation_lane": "emerging_watchlist",
                "eligible_for_ml": True,
                "eligible_for_pending_buy": False,
            }
        ],
        "2026-04-30",
    )

    sql, params = captured["statements"][0]
    assert "market_segment" in sql
    assert "recommendation_lane" in sql
    assert "eligible_for_ml" in sql
    assert "eligible_for_pending_buy" in sql
    assert "UPDATE daily_recommendations" in sql
    assert "INSERT INTO daily_recommendations" not in sql
    assert "EMERGING" in params
    assert "emerging_watchlist" in params
    assert 1 in params
    assert captured["seed_query"][1] == ["2026-04-30", 2]
