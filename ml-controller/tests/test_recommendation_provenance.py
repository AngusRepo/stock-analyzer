from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services.recommendation_service import (  # noqa: E402
    apply_sparse_tangent_allocation,
    build_reason,
    build_ml_vote_summary_data,
    filter_and_score_recommendations,
    prune_predictions_outside_universe,
    update_recommendations_in_d1,
    write_predictions_to_d1,
)


def _score_components(
    *,
    final_score: float = 60.0,
    chip_flow: float = 10.0,
    technical_structure: float = 12.0,
    ml_edge: float = 0.0,
) -> dict:
    return {
        "version": "score_v2",
        "weights": {
            "mlEdge": 25,
            "chipFlow": 25,
            "technicalStructure": 25,
            "fundamentalQuality": 20,
            "newsTheme": 5,
        },
        "components": {
            "mlEdge": ml_edge,
            "chipFlow": chip_flow,
            "technicalStructure": technical_structure,
            "fundamentalQuality": 0.0,
            "newsTheme": 0.0,
        },
        "total": final_score,
        "finalScore": final_score,
        "seedComponents": {
            "chipFlowSeed40": 16.0,
            "technicalSeed30": 18.0,
            "screenerMomentumSeed20": 6.0,
            "mlEdgeSeed30": ml_edge,
            "personaAlphaSeed": 0.0,
        },
        "technicalBreakdown": {
            "trendStructure": 3.0,
            "volatilityStructure": 2.0,
            "reversalExtreme": 2.0,
            "volumeConfirmation": 3.0,
            "executionRisk": 1.0,
        },
        "legacyComponents": {
            "chip": 18.0,
            "technical": 12.0,
        },
    }


def _score_seed_inputs() -> dict:
    return _score_components()["seedComponents"]


def _screener_rec(symbol: str) -> dict:
    return {
        "id": 1,
        "stock_id": 1,
        "date": "2026-04-22",
        "symbol": symbol,
        "name": symbol,
        "sector": "Semis",
        "industry": "IC",
        "market_segment": "LISTED",
        "recommendation_lane": "tradable",
        "eligible_for_pending_buy": 1,
        "chip_score": 18.0,
        "tech_score": 12.0,
        "score_components": _score_components(),
    }


def _payload(symbol: str) -> dict:
    return {
        "symbol": symbol,
        "prices": [{"date": "2026-04-21", "close": 100.0, "open": 99.0, "high": 101.0, "low": 98.0}],
        "indicators": [{"date": "2026-04-21", "rsi14": 58.0, "macdHist": 0.4, "ma20": 96.0}],
        "chips": [{"date": "2026-04-21", "foreign_net": 1200, "trust_net": 300}],
        "market_env": {},
    }


def _sparse_policy(buy_signal_count: int = 1, slate_size: int = 3) -> dict:
    return {
        "allocation": {
            "engine": "sparse_tangent_inverse_risk",
            "controller": "sparse_tangent_inverse_risk",
            "buy_signal_count": buy_signal_count,
            "slate_size": slate_size,
        }
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
            "ExtraTrees": {"direction": "up"},
            "DLinear": {"direction": "up"},
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


def test_filter_and_score_derives_technical_snapshot_when_indicator_rows_missing(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    prices = [
        {
            "date": f"2026-04-{i + 1:02d}",
            "close": 50.0 + i,
            "open": 49.5 + i,
            "high": 51.0 + i,
            "low": 49.0 + i,
        }
        for i in range(40)
    ]
    payload = {
        "symbol": "3585",
        "prices": prices,
        "indicators": [],
        "chips": [],
        "stock_meta": {
            "market_segment": "EMERGING",
            "recommendation_lane": "emerging_watchlist",
            "eligible_for_ml": True,
            "eligible_for_execution": False,
        },
    }

    final, sell_count = filter_and_score_recommendations(
        [{**_screener_rec("3585"), "market_segment": "EMERGING", "eligible_for_pending_buy": 0}],
        {"3585": _prediction_with_ensemble_v2()},
        [payload],
    )

    assert sell_count == 0
    assert len(final) == 1
    assert final[0]["rsi14"] is not None
    assert final[0]["macd_hist"] is not None
    assert final[0]["macd_hist"] > 0
    assert final[0]["current_price"] == 89.0


def test_filter_and_score_persists_score_v2_technical_signals(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    payload = _payload("2330")
    payload["indicators"][0].update({
        "atr14": 2.0,
        "plusDi14": 34.0,
        "minusDi14": 12.0,
        "adx14": 29.0,
        "parabolicSar": 95.0,
        "cci20": 88.0,
        "volumeWeightedRsi14": 64.0,
        "volumeMomentumDivergence132710": 125000.0,
    })

    final, sell_count = filter_and_score_recommendations(
        [_screener_rec("2330")],
        {"2330": _prediction_with_ensemble_v2()},
        [payload],
    )

    assert sell_count == 0
    score_components = final[0]["score_components"]
    signals = score_components["technicalSignals"]
    breakdown = score_components["technicalBreakdown"]
    assert signals["adx14"] == pytest.approx(29.0)
    assert signals["parabolicSar"] == pytest.approx(95.0)
    assert signals["volumeMomentumDivergence132710"] == pytest.approx(125000.0)
    assert breakdown["trendStructure"] > 0
    assert breakdown["volatilityStructure"] > 0
    assert breakdown["reversalExtreme"] > 0
    assert breakdown["volumeConfirmation"] > 0
    assert "Score V2" in final[0]["reason"]
    assert "ML Edge" in final[0]["reason"]
    assert "Chip Flow" in final[0]["reason"]
    assert "ADX" in final[0]["reason"]
    assert "【籌碼】" not in final[0]["reason"]


def test_emerging_segment_overrides_dirty_tradable_lane(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    rec = {
        **_screener_rec("7879"),
        "market_segment": "EMERGING",
        "recommendation_lane": "tradable",
        "eligible_for_pending_buy": 0,
    }

    final, _sell_count = filter_and_score_recommendations(
        [rec],
        {"7879": _prediction_with_ensemble_v2()},
        [_payload("7879")],
    )

    row = final[0]
    assert row["market_segment"] == "EMERGING"
    assert row["recommendation_lane"] == "emerging_watchlist"
    assert row["eligible_for_pending_buy"] is False
    assert row["has_buy_signal"] == 0
    assert "research_only:emerging_not_for_auto_trade" in row["watch_points"]


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


def test_build_reason_formats_chip_cash_billions_without_raw_share_scaling():
    reason = build_reason({
        "foreign_net_5d": 6.0,
        "trust_net_5d": 0,
        "rsi14": 63,
        "macd_hist": 0.2,
        "current_price": 100,
        "ma20": 95,
        "ml_vote_summary": "ML 資料不足",
        "score_components": _score_components(),
    })

    assert "600000000" not in reason
    assert "6.0" in reason
    assert "億" in reason


def test_emerging_recommendation_uses_finlab_broker_chip_evidence(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    payload = {
        "symbol": "7737",
        "prices": [{"date": "2026-05-15", "close": 44.65, "open": 44.2, "high": 45.0, "low": 44.0}],
        "indicators": [{"date": "2026-05-15", "rsi14": 55.0, "macdHist": -0.1, "ma20": 43.0}],
        "chips": [{
            "date": "2026-05-15",
            "dealer_net": 30_000,
            "broker_net_shares": 30_000,
            "broker_estimated_amount": 1_339_500,
            "broker_count": 8,
            "broker_concentration": 0.3118,
            "chip_source": "finlab.rotc_broker_transactions",
            "market_segment": "EMERGING",
        }],
        "stock_meta": {
            "market_segment": "EMERGING",
            "recommendation_lane": "emerging_watchlist",
            "eligible_for_ml": True,
            "eligible_for_execution": False,
        },
    }

    final, sell_count = filter_and_score_recommendations(
        [{
            **_screener_rec("7737"),
            "date": "2026-05-15",
            "market_segment": "EMERGING",
            "recommendation_lane": "emerging_watchlist",
            "eligible_for_pending_buy": 0,
            "chip_score": 16.0,
        }],
        {"7737": _prediction_with_ensemble_v2()},
        [payload],
    )

    assert sell_count == 0
    row = final[0]
    assert "券商分點" in row["reason"]
    assert "法人買賣超接近平衡" not in row["reason"]
    assert not any("籌碼資料不足" in point for point in row["watch_points"])
    assert row["score_components"]["version"] == "score_v2"
    assert row["score_components"]["weights"]["mlEdge"] == 25
    assert row["score_components"]["components"]["chipFlow"] == pytest.approx(10.0)
    assert row["score"] == pytest.approx(row["score_components"]["finalScore"])
    assert row["score_components"]["seedComponents"]["chipFlowSeed40"] == pytest.approx(16.0)
    assert row["score_components"]["chipEvidence"]["source"] == "finlab.rotc_broker_transactions"
    assert row["score_components"]["chipEvidence"]["broker_net_amount_5d_billion"] == pytest.approx(0.013395)


def test_update_recommendations_in_d1_upserts_seed_rows(monkeypatch):
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements), "changes_total": len(statements)}

    def _fake_execute(sql, params, timeout=60):
        captured["cleanup_sql"] = sql
        captured["cleanup_params"] = params
        captured["cleanup_timeout"] = timeout
        return {"meta": {"changes": 2}}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)
    monkeypatch.setattr(recommendation_service.d1_client, "execute", _fake_execute)
    monkeypatch.setattr(
        recommendation_service.d1_client,
        "query",
        lambda *_args, **_kwargs: [{"stock_id": 1}],
    )

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
        "score_seed_inputs": _score_seed_inputs(),
        "score_components": _score_components(),
    }], "2026-04-27")

    assert "DELETE FROM daily_recommendations" in captured["cleanup_sql"]
    assert "stock_id IN (?)" in captured["cleanup_sql"]
    assert captured["cleanup_params"] == ["2026-04-27", 1]

    sql, params = captured["statements"][0]
    assert "UPDATE daily_recommendations SET" in sql
    assert "WHERE date=? AND stock_id=?" in sql
    assert params[:4] == ["2330", "TSMC", "Semis", 1]
    assert params[-2:] == ["2026-04-27", 1]


def test_update_recommendations_in_d1_skips_partial_ml_only_rows(monkeypatch):
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements), "changes_total": len(statements)}

    def _fake_execute(sql, params, timeout=60):
        captured["cleanup_params"] = params
        return {"meta": {"changes": 0}}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)
    monkeypatch.setattr(recommendation_service.d1_client, "execute", _fake_execute)
    monkeypatch.setattr(
        recommendation_service.d1_client,
        "query",
        lambda *_args, **_kwargs: [{"stock_id": 1}],
    )

    updated = update_recommendations_in_d1([
        {
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
            "score_seed_inputs": _score_seed_inputs(),
            "score_components": _score_components(),
        },
        {
            "date": "2026-04-27",
            "stock_id": 2,
            "symbol": "9999",
            "name": "ML-only",
            "sector": "Other",
            "industry": "Other",
            "chip_score": 0,
            "tech_score": 0,
            "ml_score": 30.0,
            "score": 30.0,
            "signal": "BUY",
            "confidence": 0.7,
            "has_buy_signal": 1,
            "reason": "orphan",
            "watch_points": [],
            "current_price": 10.0,
            "score_seed_inputs": _score_seed_inputs(),
            "score_components": _score_components(final_score=30.0),
        },
    ], "2026-04-27")

    assert updated == 1
    assert len(captured["statements"]) == 1
    assert captured["statements"][0][1][0] == "2330"
    assert captured["cleanup_params"] == ["2026-04-27", 1]


def test_update_recommendations_in_d1_fails_when_no_seed_rows_exist(monkeypatch):
    monkeypatch.setattr(recommendation_service.d1_client, "query", lambda *_args, **_kwargs: [])

    with pytest.raises(RuntimeError, match="Missing screener-owned daily_recommendations seed rows"):
        update_recommendations_in_d1([{
            "date": "2026-04-27",
            "stock_id": 2,
            "symbol": "9999",
            "name": "ML-only",
            "sector": "Other",
            "industry": "Other",
            "score": 30.0,
        }], "2026-04-27")


def test_sparse_tangent_allocation_marks_signal_source():
    rows = [{
        "symbol": "2330",
        "chip_score": 20.0,
        "tech_score": 15.0,
        "confidence": 0.38,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "has_buy_signal": 0,
        "score": 70.0,
        "ml_forecast_pct": 0.03,
        "score_components": _score_components(final_score=70.0),
    }]

    promoted = apply_sparse_tangent_allocation(
        rows,
        ranking_config={"enabled": True, "promoteMinConf": 0.72},
        alpha_policy=_sparse_policy(buy_signal_count=1),
    )

    assert promoted[0]["sparse_tangent_selected"] is True
    assert promoted[0]["ranking_promoted"] is False
    assert promoted[0]["signal"] == "BUY"
    assert promoted[0]["signal_raw"] == "HOLD"
    assert promoted[0]["signal_source"] == "sparse_tangent_inverse_risk"
    allocation = promoted[0]["alpha_allocation"]
    assert allocation["selection_reason"] == "selected_positive_edge_sparse_weight"
    assert allocation["expected_return"] == 0.03
    assert allocation["expected_return_source"] == "ml_forecast_pct"
    assert allocation["positive_expected_edge"] is True
    assert allocation["eligible_for_sparse"] is True
    assert allocation["allocation_rank"] == 1
    assert allocation["sparse_diagnostics"]["candidate_count"] == 1
    assert allocation["sparse_diagnostics"]["selected_count"] == 1


def test_sparse_tangent_allocation_blocks_negative_forecast():
    rows = [{
        "symbol": "5292",
        "chip_score": 36.0,
        "tech_score": 30.0,
        "confidence": 0.5,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "has_buy_signal": 0,
        "ml_forecast_pct": -0.01,
        "score": 80.0,
        "score_components": _score_components(final_score=80.0),
    }]

    promoted = apply_sparse_tangent_allocation(
        rows,
        ranking_config={"enabled": True},
        alpha_policy=_sparse_policy(buy_signal_count=1),
    )

    assert promoted[0]["signal"] == "HOLD"
    assert promoted[0].get("sparse_tangent_selected") is not True
    assert promoted[0]["promotion_blocked_reason"] == "negative_or_below_min_forecast"


def test_sparse_tangent_allocation_reowns_existing_buy_labels():
    rows = [{
        "symbol": "2330",
        "chip_score": 20.0,
        "tech_score": 15.0,
        "confidence": 0.72,
        "signal": "BUY",
        "signal_source": "ensemble_v2_topk_policy",
        "has_buy_signal": 1,
        "topk_forced": True,
        "score": 72.0,
        "ml_forecast_pct": 0.03,
        "score_components": _score_components(final_score=72.0),
    }, {
        "symbol": "2317",
        "chip_score": 19.0,
        "tech_score": 14.0,
        "confidence": 0.41,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "has_buy_signal": 0,
        "score": 62.0,
        "ml_forecast_pct": 0.01,
        "score_components": _score_components(final_score=62.0),
    }]

    promoted = apply_sparse_tangent_allocation(
        rows,
        ranking_config={"enabled": True},
        alpha_policy=_sparse_policy(buy_signal_count=1),
    )

    assert promoted[0]["signal_source_raw"] == "ensemble_v2_topk_policy"
    assert promoted[0]["signal_source"] == "sparse_tangent_inverse_risk"
    assert promoted[0]["sparse_tangent_selected"] is True
    assert promoted[1]["signal"] == "HOLD"
    assert promoted[1].get("sparse_tangent_selected") is not True


def test_sparse_tangent_allocation_uses_alpha_policy_buy_signal_count():
    rows = [
        {
            "symbol": "2330",
            "chip_score": 20.0,
            "tech_score": 15.0,
            "confidence": 0.76,
            "signal": "BUY",
            "has_buy_signal": 1,
            "score": 70.0,
            "ml_forecast_pct": 0.03,
            "alpha_context": {"edge_bucket": "trend_following"},
            "score_components": _score_components(final_score=70.0),
        },
        {
            "symbol": "2317",
            "chip_score": 19.0,
            "tech_score": 14.0,
            "confidence": 0.72,
            "signal": "BUY",
            "has_buy_signal": 1,
            "score": 69.0,
            "ml_forecast_pct": 0.02,
            "alpha_context": {"edge_bucket": "mean_reversion"},
            "score_components": _score_components(final_score=69.0),
        },
        {
            "symbol": "2454",
            "chip_score": 18.0,
            "tech_score": 13.0,
            "confidence": 0.70,
            "signal": "BUY",
            "has_buy_signal": 1,
            "score": 68.0,
            "ml_forecast_pct": 0.01,
            "alpha_context": {"edge_bucket": "defensive_accumulation"},
            "score_components": _score_components(final_score=68.0),
        },
    ]

    promoted = apply_sparse_tangent_allocation(
        rows,
        ranking_config={"enabled": True},
        alpha_policy=_sparse_policy(buy_signal_count=2, slate_size=2),
        regime_label="sideways",
    )

    selected = [row for row in promoted if row.get("alpha_allocation", {}).get("selected")]
    assert len(selected) == 2
    assert selected[0]["alpha_allocation"]["capacity_policy"] == "maximum_capacity_not_minimum_fill"
    assert selected[0]["alpha_allocation"]["hard_minimum_fill"] is False


def test_sparse_tangent_allocation_keeps_cash_when_explicit_forecast_has_no_edge():
    rows = [
        {
            "symbol": "2330",
            "chip_score": 20.0,
            "tech_score": 15.0,
            "confidence": 0.80,
            "signal": "HOLD",
            "has_buy_signal": 0,
            "score": 95.0,
            "ml_forecast_pct": 0.0,
            "score_components": _score_components(final_score=95.0),
        },
        {
            "symbol": "2317",
            "chip_score": 19.0,
            "tech_score": 14.0,
            "confidence": 0.78,
            "signal": "HOLD",
            "has_buy_signal": 0,
            "score": 94.0,
            "ml_forecast_pct": 0.0,
            "score_components": _score_components(final_score=94.0),
        },
    ]

    promoted = apply_sparse_tangent_allocation(
        rows,
        ranking_config={"enabled": True},
        alpha_policy=_sparse_policy(buy_signal_count=2, slate_size=2),
    )

    assert all(row["signal"] == "HOLD" for row in promoted)
    assert all(row.get("has_buy_signal") == 0 for row in promoted)
    assert all(row.get("sparse_tangent_selected") is not True for row in promoted)
    allocations = [row.get("alpha_allocation") for row in promoted]
    assert all(isinstance(allocation, dict) for allocation in allocations)
    assert all(allocation["selected"] is False for allocation in allocations)
    assert all(allocation["allows_empty_portfolio"] is True for allocation in allocations)
    assert all(allocation["hard_minimum_fill"] is False for allocation in allocations)
    assert all(allocation["selection_policy"] == "positive_expected_edge_sparse_weights_no_forced_fill" for allocation in allocations)
    assert all(allocation["selection_reason"] == "no_positive_expected_edge" for allocation in allocations)
    assert all(allocation["expected_return"] == 0.0 for allocation in allocations)
    assert all(allocation["positive_expected_edge"] is False for allocation in allocations)
    assert all(allocation["sparse_diagnostics"]["candidate_count"] == 2 for allocation in allocations)
    assert all(allocation["sparse_diagnostics"]["evaluated_candidate_count"] == 2 for allocation in allocations)
    assert all(allocation["sparse_diagnostics"]["positive_edge_count"] == 0 for allocation in allocations)
    assert all(allocation["sparse_diagnostics"]["selected_count"] == 0 for allocation in allocations)
    assert all(allocation["sparse_diagnostics"]["zero_selection_allowed"] is True for allocation in allocations)


def test_batch_predict_http_fallback_uses_predict_v2(monkeypatch):
    pytest.importorskip("httpx")
    from services import modal_client

    monkeypatch.setattr(modal_client, "_USE_MODAL", False)
    monkeypatch.setattr(modal_client, "_ML_SERVICE_URL", "https://ml.example.com")

    observed = {}

    async def _fake_http_batch(path: str, payloads: list[dict], concurrency: int):
        observed["path"] = path
        observed["concurrency"] = concurrency
        observed["payloads"] = payloads
        return [{"ok": True}]

    monkeypatch.setattr(modal_client, "_http_batch", _fake_http_batch)

    result = asyncio.run(modal_client.batch_predict([{"symbol": "2330"}]))

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

    insert_params = captured["statements"][2][1]
    forecast_data = insert_params[4]
    assert '"signal_source": "ensemble_v2_topk_policy"' in forecast_data


def test_ml_vote_summary_counts_weight_gated_models_as_reported():
    summary = build_ml_vote_summary_data(
        {
            "rank_scores": {
                "LightGBM": 0.61,
                "XGBoost": 0.61,
                "ExtraTrees": 0.52,
                "TabM": 0.56,
                "GNN": 0.47,
            },
            "dlinear": {"forecast_pct": -0.01},
            "patchtst": {"forecast_pct": 0.015},
            "itransformer": {"forecast_pct": 0.02},
            "timesfm": {"forecast_pct": -0.02},
            "ensemble_v2": {
                "forecast_pct": 0.0066,
                "weights": {
                    "LightGBM": 0.02,
                    "XGBoost": 0.02,
                    "ExtraTrees": 0.02,
                    "TabM": 0.0,
                    "GNN": 0.06,
                    "DLinear": 0.0,
                    "PatchTST": 0.17,
                    "iTransformer": 0.24,
                    "TimesFM": 0.0,
                },
                "contributing_models": ["LightGBM", "XGBoost", "ExtraTrees", "GNN", "PatchTST", "iTransformer"],
            },
        },
        {"up": 0, "down": 0, "total": 0},
    )

    assert summary["reported"] == 9
    assert summary["missing"] == 0
    assert summary["activeWeightCount"] == 6
    assert summary["zeroWeightModels"] == ["TabM", "DLinear", "TimesFM"]


def test_write_predictions_to_d1_clears_stale_per_model_rows(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    written = write_predictions_to_d1(
        {
            "2330": {
                "signal": "HOLD",
                "confidence": 0.31,
                "entry_price": 100.0,
                "stop_loss": 95.0,
                "target1": 108.0,
                "target2": 112.0,
                "feature_version": "v2",
                "ensemble_v2": {"signal": "HOLD", "signal_source": "ensemble_v2"},
                "rank_scores": {"XGBoost": 0.6},
            }
        },
        {"2330": 1},
        run_date="2026-04-29",
    )

    stale_cleanup_sql, stale_cleanup_params = captured["statements"][1]
    assert "model_name!='ensemble'" in stale_cleanup_sql
    assert "prediction_date = ?" in stale_cleanup_sql
    assert stale_cleanup_params == [1, "2026-04-29"]
    assert written == 2


def test_write_predictions_to_d1_preserves_timesfm_per_model_forecast_pct(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    written = write_predictions_to_d1(
        {
            "2330": {
                "signal": "HOLD",
                "confidence": 0.31,
                "entry_price": 100.0,
                "stop_loss": 95.0,
                "target1": 108.0,
                "target2": 112.0,
                "feature_version": "v2",
                "ensemble_v2": {"signal": "HOLD", "signal_source": "ensemble_v2"},
                "timesfm": {
                    "forecast_pct": -0.0123,
                    "confidence": 0.61,
                    "n_used": 1024,
                    "model_version": "v20260612T160113_timesfm25_ctx1024",
                },
            }
        },
        {"2330": 1},
        run_date="2026-06-14",
    )

    timesfm_insert = [
        params
        for sql, params in captured["statements"]
        if "model_name" in sql and len(params) > 1 and params[1] == "TimesFM"
    ][0]
    payload = json.loads(timesfm_insert[5])

    assert written == 2
    assert payload["rank_score"] < 0.5
    assert payload["forecast_pct"] == -0.0123
    assert payload["forecast_pct_source"] == "timesfm.forecast_pct"
    assert payload["model_signal"]["n_used"] == 1024


def test_prune_predictions_outside_universe_deletes_same_date_non_universe(monkeypatch):
    captured = {}

    def _fake_execute(sql, params, timeout=60):
        captured["sql"] = sql
        captured["params"] = params
        captured["timeout"] = timeout
        return {"meta": {"changes": 12}}

    monkeypatch.setattr(recommendation_service.d1_client, "execute", _fake_execute)
    monkeypatch.setattr(recommendation_service.d1_client, "query", lambda *_args, **_kwargs: [{"stock_id": 9}])

    deleted = prune_predictions_outside_universe([1, 2, 3], "2026-04-30")

    assert deleted == 12
    assert "DELETE FROM predictions" in captured["sql"]
    assert "prediction_date = ?" in captured["sql"]
    assert "stock_id IN (?)" in captured["sql"]
    assert captured["params"] == ["2026-04-30", 9]
