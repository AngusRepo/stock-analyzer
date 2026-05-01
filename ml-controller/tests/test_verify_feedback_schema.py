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
