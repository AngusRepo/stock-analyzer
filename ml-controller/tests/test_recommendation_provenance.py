from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services import modal_client  # noqa: E402
from services.recommendation_service import (  # noqa: E402
    build_reason,
    build_screener_seed_recommendations,
    filter_and_score_recommendations,
    hybrid_ranking_promotion,
    update_recommendations_in_d1,
    write_predictions_to_d1,
)


def _screener_rec(symbol: str) -> dict:
    return {
        "id": 1,
        "stock_id": 1,
        "date": "2026-04-22",
        "symbol": symbol,
        "name": symbol,
        "sector": "Semis",
        "industry": "IC",
        "chip_score": 18.0,
        "tech_score": 12.0,
    }


def _payload(symbol: str) -> dict:
    return {
        "symbol": symbol,
        "prices": [{"date": "2026-04-21", "close": 100.0, "open": 99.0, "high": 101.0, "low": 98.0}],
        "indicators": [{"date": "2026-04-21", "rsi14": 58.0, "macdHist": 0.4, "ma20": 96.0}],
        "chips": [{"date": "2026-04-21", "foreign_net": 1200, "trust_net": 300}],
        "market_env": {},
    }


def _prediction_with_ensemble_v2() -> dict:
    return {
        "signal": "HOLD",
        "confidence": 0.31,
        "forecast_pct": 0.004,
        "direction": "neutral",
        "ensemble_v2": {
            "signal": "BUY",
            "confidence": 0.79,
            "forecast_pct": 0.034,
            "signal_source": "ensemble_v2_topk_policy",
            "signal_raw": "HOLD",
        },
        "models": {
            "XGBoost": {"direction": "up"},
            "CatBoost": {"direction": "up"},
            "Chronos": {"direction": "up"},
        },
    }


def test_filter_and_score_uses_ensemble_v2_consistently(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    final, sell_count = filter_and_score_recommendations(
        [_screener_rec("2330")],
        {"2330": _prediction_with_ensemble_v2()},
        [_payload("2330")],
    )

    assert sell_count == 0
    assert len(final) == 1
    row = final[0]

    assert row["signal"] == "BUY"
    assert row["confidence"] == pytest.approx(0.79, abs=1e-6)
    assert row["signal_source"] == "ensemble_v2_topk_policy"
    assert row["signal_raw"] == "HOLD"
    assert row["has_buy_signal"] == 1
    assert row["ml_score"] == 0
    assert row["stock_id"] == 1


def test_ensemble_v2_zero_forecast_does_not_fall_back_to_legacy_negative(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    prediction = {
        "signal": "HOLD",
        "confidence": 0.44,
        "forecast_pct": -0.01,
        "ensemble_v2": {
            "signal": "HOLD",
            "confidence": 0.5,
            "forecast_pct": 0.0,
            "signal_source": "ensemble_v2",
            "reason": "no_positive_lifecycle_weight",
            "weight_total": 0.0,
        },
        "models": {"XGBoost": {"direction": "up"}},
    }

    final, _sell_count = filter_and_score_recommendations(
        [_screener_rec("5292")],
        {"5292": prediction},
        [_payload("5292")],
    )

    assert final[0]["signal"] == "HOLD"
    assert final[0]["ml_forecast_pct"] == 0.0
    assert final[0]["ml_score"] == 0
    assert "暫無正 IC 權重" in final[0]["reason"]


def test_build_reason_formats_chip_raw_shares_as_yi_not_raw_number():
    reason = build_reason({
        "foreign_net_5d": 600_000_000,
        "trust_net_5d": 0,
        "rsi14": 63,
        "macd_hist": 0.2,
        "current_price": 100,
        "ma20": 95,
        "ml_vote_summary": "ML 資料不足",
    })

    assert "600000000" not in reason
    assert "6.0" in reason
    assert "億" in reason


def test_build_screener_seed_recommendations_from_payloads():
    seeds = build_screener_seed_recommendations(
        [{"id": 1, "symbol": "2330", "name": "TSMC", "sector": "Semis", "industry": "IC"}],
        [_payload("2330")],
        "2026-04-27",
    )

    assert len(seeds) == 1
    assert seeds[0]["date"] == "2026-04-27"
    assert seeds[0]["stock_id"] == 1
    assert seeds[0]["symbol"] == "2330"
    assert seeds[0]["current_price"] == 100.0
    assert seeds[0]["chip_score"] >= 0
    assert seeds[0]["tech_score"] > 0


def test_update_recommendations_in_d1_upserts_seed_rows(monkeypatch):
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    update_recommendations_in_d1([{
        "date": "2026-04-27",
        "stock_id": 1,
        "symbol": "2330",
        "name": "TSMC",
        "sector": "Semis",
        "industry": "IC",
        "chip_score": 12.0,
        "tech_score": 20.0,
        "ml_score": 25.0,
        "score": 57.0,
        "signal": "BUY",
        "confidence": 0.78,
        "has_buy_signal": 1,
        "reason": "ok",
        "watch_points": ["watch"],
        "current_price": 100.0,
    }], "2026-04-27")

    sql, params = captured["statements"][0]
    assert "INSERT INTO daily_recommendations" in sql
    assert "ON CONFLICT(date, stock_id) DO UPDATE" in sql
    assert params[:4] == ["2026-04-27", 1, "2330", "TSMC"]


def test_hybrid_ranking_promotion_marks_signal_source():
    rows = [{
        "symbol": "2330",
        "chip_score": 20.0,
        "tech_score": 15.0,
        "confidence": 0.38,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "has_buy_signal": 0,
    }]

    promoted = hybrid_ranking_promotion(
        rows,
        ranking_config={"enabled": True, "topK": 1, "alpha": 0.4, "beta": 0.4, "gamma": 0.2},
        ensemble_v2_cfg={"topKConfidenceOverride": 0.72},
    )

    assert promoted[0]["ranking_promoted"] is True
    assert promoted[0]["signal"] == "BUY"
    assert promoted[0]["signal_raw"] == "HOLD"
    assert promoted[0]["signal_source"] == "ranking_promotion"


def test_hybrid_ranking_promotion_blocks_negative_forecast():
    rows = [{
        "symbol": "5292",
        "chip_score": 36.0,
        "tech_score": 30.0,
        "confidence": 0.5,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "has_buy_signal": 0,
        "ml_forecast_pct": -0.01,
    }]

    promoted = hybrid_ranking_promotion(
        rows,
        ranking_config={"enabled": True, "topK": 1, "alpha": 0.4, "beta": 0.4, "gamma": 0.2},
        ensemble_v2_cfg={"topKConfidenceOverride": 0.72},
    )

    assert promoted[0]["signal"] == "HOLD"
    assert promoted[0].get("ranking_promoted") is not True
    assert promoted[0]["promotion_blocked_reason"] == "negative_or_below_min_forecast"


def test_hybrid_ranking_promotion_skips_when_controller_policy_already_applied():
    rows = [{
        "symbol": "2330",
        "chip_score": 20.0,
        "tech_score": 15.0,
        "confidence": 0.72,
        "signal": "BUY",
        "signal_source": "ensemble_v2_topk_policy",
        "has_buy_signal": 1,
        "topk_forced": True,
    }, {
        "symbol": "2317",
        "chip_score": 19.0,
        "tech_score": 14.0,
        "confidence": 0.41,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "has_buy_signal": 0,
    }]

    promoted = hybrid_ranking_promotion(
        rows,
        ranking_config={"enabled": True, "topK": 3, "alpha": 0.4, "beta": 0.4, "gamma": 0.2},
        ensemble_v2_cfg={"topKConfidenceOverride": 0.72},
    )

    assert promoted[0]["signal_source"] == "ensemble_v2_topk_policy"
    assert promoted[1]["signal"] == "HOLD"
    assert promoted[1].get("ranking_promoted") is not True


def test_hybrid_ranking_promotion_uses_alpha_policy_slate_size():
    rows = [
        {
            "symbol": "2330",
            "chip_score": 20.0,
            "tech_score": 15.0,
            "confidence": 0.76,
            "signal": "BUY",
            "has_buy_signal": 1,
            "score": 70.0,
            "alpha_context": {"edge_bucket": "trend_following"},
        },
        {
            "symbol": "2317",
            "chip_score": 19.0,
            "tech_score": 14.0,
            "confidence": 0.72,
            "signal": "BUY",
            "has_buy_signal": 1,
            "score": 69.0,
            "alpha_context": {"edge_bucket": "mean_reversion"},
        },
        {
            "symbol": "2454",
            "chip_score": 18.0,
            "tech_score": 13.0,
            "confidence": 0.70,
            "signal": "BUY",
            "has_buy_signal": 1,
            "score": 68.0,
            "alpha_context": {"edge_bucket": "defensive_accumulation"},
        },
    ]

    promoted = hybrid_ranking_promotion(
        rows,
        ranking_config={"enabled": True, "topK": 1, "alpha": 0.4, "beta": 0.4, "gamma": 0.2},
        alpha_policy={"allocation": {"slateSize": 2}},
        regime_label="sideways",
    )

    selected = [row for row in promoted if row.get("alpha_allocation", {}).get("selected")]
    assert len(selected) == 2


@pytest.mark.asyncio
async def test_batch_predict_http_fallback_uses_predict_v2(monkeypatch):
    monkeypatch.setattr(modal_client, "_USE_MODAL", False)
    monkeypatch.setattr(modal_client, "_ML_SERVICE_URL", "https://ml.example.com")

    observed = {}

    async def _fake_http_batch(path: str, payloads: list[dict], concurrency: int):
        observed["path"] = path
        observed["concurrency"] = concurrency
        observed["payloads"] = payloads
        return [{"ok": True}]

    monkeypatch.setattr(modal_client, "_http_batch", _fake_http_batch)

    result = await modal_client.batch_predict([{"symbol": "2330"}])

    assert result == [{"ok": True}]
    assert observed["path"] == "/predict/v2"


def test_write_predictions_to_d1_preserves_policy_signal_source(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    predictions = {
        "2330": {
            "signal": "HOLD",
            "confidence": 0.31,
            "forecast_pct": 0.004,
            "entry_price": 100.0,
            "stop_loss": 95.0,
            "target1": 108.0,
            "target2": 112.0,
            "feature_version": "v2",
            "ensemble_v2": {
                "signal": "BUY",
                "signal_source": "ensemble_v2_topk_policy",
            },
            "models": {},
            "forecasts": {},
            "arf_features": {},
        }
    }

    write_predictions_to_d1(predictions, {"2330": 1})

    insert_params = captured["statements"][1][1]
    forecast_data = insert_params[3]
    assert '"signal_source": "ensemble_v2_topk_policy"' in forecast_data
