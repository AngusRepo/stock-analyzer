from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import httpx  # noqa: F401
except ModuleNotFoundError:
    sys.modules["httpx"] = types.SimpleNamespace(
        RequestError=RuntimeError,
        post=lambda *args, **kwargs: None,
    )

from services import verify_service  # noqa: E402


def test_verify_feedback_keeps_return_pct_and_pnl_r_separate(monkeypatch):
    monkeypatch.setattr(verify_service.d1_client, "execute", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        verify_service,
        "load_bars_for_prediction",
        lambda stock_id, generated_at, prediction_date=None: [
            {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0},
            {"open": 100.0, "high": 103.0, "low": 99.5, "close": 102.0},
            {"open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0},
            {"open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0},
            {"open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0},
        ],
    )

    result = verify_service.verify_single_prediction(
        {
            "id": 99,
            "stock_id": 1,
            "symbol": "2330",
            "generated_at": "2026-04-20T00:00:00Z",
            "entry_price": 100.0,
            "stop_loss": 95.0,
            "target1": 105.0,
            "target2": 110.0,
            "forecast_data": json.dumps(
                {
                    "signal": "BUY",
                    "forecast_pct": 0.03,
                    "arf_features": [0.1, 0.2, 0.3],
                }
            ),
        },
        market_risk={"risk_level": "low", "risk_score": 0.2},
    )

    assert result is not None
    feedback = result["arf"]
    assert feedback["actual_return_pct"] == pytest.approx(0.05)
    assert feedback["realized_pnl_r"] == pytest.approx(1.0)
    assert feedback["forecast_pct"] == pytest.approx(0.03)
    assert "actual_return" not in feedback


def test_verify_neutral_rows_still_write_actual_return_for_ic(monkeypatch):
    monkeypatch.setattr(
        verify_service,
        "load_bars_for_prediction",
        lambda stock_id, generated_at, prediction_date=None: [
            {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0},
            {"open": 100.0, "high": 103.0, "low": 99.5, "close": 102.0},
            {"open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0},
            {"open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0},
            {"open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0},
        ],
    )

    result = verify_service.verify_single_prediction(
        {
            "id": 100,
            "stock_id": 1,
            "symbol": "2330",
            "generated_at": "2026-04-20T00:00:00Z",
            "entry_price": 100.0,
            "forecast_data": json.dumps({"signal": "HOLD", "rank_score": 0.58}),
        },
        market_risk={"risk_level": "low", "risk_score": 0.2},
    )

    assert result is not None
    assert result["bind"][0] == "neutral"
    assert result["bind"][4] == -1
    assert result["bind"][8] == pytest.approx(0.05)
    assert result["arf"] is None


def test_verify_uses_prediction_business_date_for_future_bars(monkeypatch):
    captured: dict[str, object] = {}

    def fake_query(sql, params):
        captured["sql"] = sql
        captured["params"] = params
        return []

    monkeypatch.setattr(verify_service.d1_client, "query", fake_query)

    verify_service.load_bars_for_prediction(
        stock_id=1,
        generated_at="2026-05-01T01:44:00Z",
        prediction_date="2026-04-30",
    )

    assert captured["params"] == [1, "2026-05-01", "2026-05-10"]


def test_load_pending_predictions_uses_bounded_run_date_window(monkeypatch):
    captured: dict[str, object] = {"pending_params": None}

    def fake_query(sql, params):
        if "MAX(date) AS latest_date" in sql:
            return [{"latest_date": "2026-05-04"}]
        if "MAX(date) AS previous_date" in sql:
            return [{"previous_date": "2026-04-30"}]
        captured["sql"] = sql
        captured["pending_params"] = params
        return []

    monkeypatch.setattr(verify_service.d1_client, "query", fake_query)

    verify_service.load_pending_predictions(
        lookback_days=5,
        limit=600,
        run_date="2026-05-04",
        stale_grace_days=10,
    )

    assert "BETWEEN ? AND ?" in str(captured["sql"])
    assert "date(COALESCE" not in str(captured["sql"])
    assert "UPPER(COALESCE" not in str(captured["sql"])
    assert "p.prediction_date BETWEEN ? AND ?" in str(captured["sql"])
    assert "s.market IN ('TWSE', 'OTC', 'TPEX', 'EMERGING')" in str(captured["sql"])
    assert captured["pending_params"] == ["2026-04-20", "2026-04-30", 600]


def test_verification_window_does_not_use_calendar_days_across_holidays(monkeypatch):
    queries: list[tuple[str, list[object]]] = []

    def fake_query(sql, params):
        queries.append((sql, params))
        if "MAX(date) AS latest_date" in sql:
            return [{"latest_date": "2026-05-04"}]
        if "MAX(date) AS previous_date" in sql:
            return [{"previous_date": "2026-04-30"}]
        return []

    monkeypatch.setattr(verify_service.d1_client, "query", fake_query)

    min_date, max_date = verify_service._resolve_verification_prediction_window(
        as_of=verify_service._parse_run_date("2026-05-04"),
        lookback_days=5,
        stale_grace_days=10,
    )

    assert (min_date, max_date) == ("2026-04-20", "2026-04-30")
    assert max_date != "2026-04-29"
    assert len(queries) == 2


def test_prepare_verification_updates_batches_bars(monkeypatch):
    calls = {"bulk": 0, "single": 0}

    monkeypatch.setattr(
        verify_service,
        "load_bars_for_predictions",
        lambda pending: calls.__setitem__("bulk", calls["bulk"] + 1) or {
            1: [
                {"date": "2026-05-01", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0},
                {"date": "2026-05-04", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0},
            ]
        },
    )
    monkeypatch.setattr(
        verify_service,
        "load_bars_for_prediction",
        lambda *args, **kwargs: calls.__setitem__("single", calls["single"] + 1) or [],
    )

    result = verify_service.prepare_verification_updates(
        [
            {
                "id": 7,
                "stock_id": 1,
                "symbol": "2330",
                "model_name": "XGBoost",
                "generated_at": "2026-04-30T10:00:00Z",
                "prediction_date": "2026-04-30",
                "entry_price": 100.0,
                "forecast_data": json.dumps({"signal": "HOLD", "rank_score": 0.5}),
            }
        ],
        market_risk={"risk_level": "low", "risk_score": 10},
    )

    assert calls == {"bulk": 1, "single": 0}
    assert len(result["verify_updates"]) == 1
    assert result["metrics"]["skipped_no_bars"] == 0


def test_prepare_verification_updates_counts_missing_bars(monkeypatch):
    monkeypatch.setattr(verify_service, "load_bars_for_predictions", lambda pending: {})

    result = verify_service.prepare_verification_updates(
        [
            {
                "id": 7,
                "stock_id": 1,
                "symbol": "5267",
                "model_name": "XGBoost",
                "generated_at": "2026-05-25T10:00:00Z",
                "prediction_date": "2026-05-25",
                "entry_price": 100.0,
                "forecast_data": json.dumps({"signal": "HOLD", "rank_score": 0.5}),
            }
        ],
        market_risk={"risk_level": "low", "risk_score": 10},
    )

    assert result["verify_updates"] == []
    assert result["metrics"]["skipped_no_bars"] == 1
