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
            {"date": "2026-04-21", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "adj_open": 100.0, "adj_high": 101.0, "adj_low": 99.0, "adj_close": 100.0},
            {"date": "2026-04-22", "open": 100.0, "high": 103.0, "low": 99.5, "close": 102.0, "adj_open": 100.0, "adj_high": 103.0, "adj_low": 99.5, "adj_close": 102.0},
            {"date": "2026-04-23", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "adj_open": 102.0, "adj_high": 104.0, "adj_low": 101.0, "adj_close": 103.0},
            {"date": "2026-04-24", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "adj_open": 103.0, "adj_high": 105.0, "adj_low": 102.0, "adj_close": 104.0},
            {"date": "2026-04-27", "open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0, "adj_open": 104.0, "adj_high": 106.0, "adj_low": 103.0, "adj_close": 105.0},
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
    assert feedback["actual_return_pct"] == pytest.approx(0.0482)
    assert feedback["realized_pnl_r"] == pytest.approx(1.0)
    assert feedback["forecast_pct"] == pytest.approx(0.03)
    assert "actual_return" not in feedback
    assert result["bind"][14] == verify_service.VERIFICATION_RETURN_SEMANTIC_VERSION
    assert result["bind"][15] == pytest.approx(100.0)
    assert result["bind"][16] == "2026-04-27"
    assert result["bind"][17] == "2026-04-27"


def test_verify_neutral_rows_still_write_actual_return_for_ic(monkeypatch):
    monkeypatch.setattr(
        verify_service,
        "load_bars_for_prediction",
        lambda stock_id, generated_at, prediction_date=None: [
            {"date": "2026-04-21", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "adj_open": 100.0, "adj_high": 101.0, "adj_low": 99.0, "adj_close": 100.0},
            {"date": "2026-04-22", "open": 100.0, "high": 103.0, "low": 99.5, "close": 102.0, "adj_open": 100.0, "adj_high": 103.0, "adj_low": 99.5, "adj_close": 102.0},
            {"date": "2026-04-23", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "adj_open": 102.0, "adj_high": 104.0, "adj_low": 101.0, "adj_close": 103.0},
            {"date": "2026-04-24", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "adj_open": 103.0, "adj_high": 105.0, "adj_low": 102.0, "adj_close": 104.0},
            {"date": "2026-04-27", "open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0, "adj_open": 104.0, "adj_high": 106.0, "adj_low": 103.0, "adj_close": 105.0},
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
    assert result["bind"][4] is None
    assert result["bind"][8] == pytest.approx(0.0482)
    assert result["arf"] is None


def test_verify_ic_label_uses_shared_next_open_not_planned_entry():
    result = verify_service.verify_single_prediction(
        {
            "id": 102,
            "stock_id": 1,
            "generated_at": "2026-07-01T10:00:00Z",
            "entry_price": 95.0,
            "stop_loss": 90.0,
            "target1": 105.0,
            "target2": 110.0,
            "forecast_data": json.dumps({
                "signal": "BUY",
                "rank_score": 0.8,
                "arf_features": [0.8],
            }),
        },
        market_risk={},
        bars_override=[
            {"date": "2026-07-02", "open": 100.0, "high": 101.0, "low": 96.0, "close": 100.0, "adj_open": 100.0, "adj_high": 101.0, "adj_low": 96.0, "adj_close": 100.0},
            {"date": "2026-07-03", "open": 101.0, "high": 103.0, "low": 99.0, "close": 102.0, "adj_open": 101.0, "adj_high": 103.0, "adj_low": 99.0, "adj_close": 102.0},
            {"date": "2026-07-06", "open": 102.0, "high": 104.0, "low": 101.0, "close": 103.0, "adj_open": 102.0, "adj_high": 104.0, "adj_low": 101.0, "adj_close": 103.0},
            {"date": "2026-07-07", "open": 103.0, "high": 105.0, "low": 102.0, "close": 104.0, "adj_open": 103.0, "adj_high": 105.0, "adj_low": 102.0, "adj_close": 104.0},
            {"date": "2026-07-08", "open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0, "adj_open": 104.0, "adj_high": 106.0, "adj_low": 103.0, "adj_close": 105.0},
        ],
    )

    assert result is not None
    assert result["bind"][8] == pytest.approx(0.0482)
    assert result["arf"]["actual_return_pct"] == pytest.approx(0.0482)


def test_verify_does_not_write_immature_five_session_label():
    result = verify_service.verify_single_prediction(
        {
            "id": 101,
            "stock_id": 1,
            "generated_at": "2026-07-03T10:00:00Z",
            "entry_price": 100.0,
            "forecast_data": json.dumps({"signal": "BUY"}),
        },
        market_risk={},
        bars_override=[
            {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "adj_open": 100.0, "adj_high": 101.0, "adj_low": 99.0, "adj_close": 100.0}
            for _ in range(4)
        ],
    )

    assert result is None


def test_rebuild_verification_labels_clears_stale_unrepairable_rows(monkeypatch):
    monkeypatch.setattr(
        verify_service,
        "load_predictions_for_verification_repair",
        lambda *args, **kwargs: [{"id": 1}, {"id": 2}],
    )
    monkeypatch.setattr(verify_service, "load_market_risk", lambda: {})
    monkeypatch.setattr(
        verify_service,
        "prepare_verification_updates",
        lambda rows, risk: {
            "verify_updates": [{"id": 1}],
            "metrics": {},
            "errors": [],
        },
    )
    monkeypatch.setattr(verify_service, "write_verified_predictions", lambda updates: 1)
    captured: list[int] = []
    monkeypatch.setattr(
        verify_service,
        "clear_verification_labels",
        lambda ids: captured.extend(ids) or len(ids),
    )

    result = verify_service.rebuild_verification_labels(
        "2026-06-29",
        "2026-06-29",
        dry_run=False,
    )

    assert captured == [2]
    assert result["written"] == 1
    assert result["stale_labels_clear_planned"] == 1
    assert result["stale_labels_cleared"] == 1


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

    assert captured["params"] == [1, "2026-04-30"]
    assert "date > ?" in str(captured["sql"])
    assert "date <= ?" not in str(captured["sql"])


def test_load_pending_predictions_uses_bounded_run_date_window(monkeypatch):
    captured: dict[str, object] = {"pending_params": None}

    def fake_query(sql, params):
        if "MAX(date) AS latest_date" in sql:
            return [{"latest_date": "2026-05-04"}]
        if "mature_prediction_date" in sql:
            return [{"mature_prediction_date": "2026-04-24"}]
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
    assert captured["pending_params"] == [
        verify_service.VERIFICATION_RETURN_SEMANTIC_VERSION,
        "2026-04-14",
        "2026-04-24",
        600,
    ]
    assert "verification_label_schema_version" in str(captured["sql"])
    assert "ORDER BY p.prediction_date ASC" in str(captured["sql"])


def test_verification_window_does_not_use_calendar_days_across_holidays(monkeypatch):
    queries: list[tuple[str, list[object]]] = []

    def fake_query(sql, params):
        queries.append((sql, params))
        if "MAX(date) AS latest_date" in sql:
            return [{"latest_date": "2026-05-04"}]
        if "mature_prediction_date" in sql:
            return [{"mature_prediction_date": "2026-04-24"}]
        return []

    monkeypatch.setattr(verify_service.d1_client, "query", fake_query)

    min_date, max_date = verify_service._resolve_verification_prediction_window(
        as_of=verify_service._parse_run_date("2026-05-04"),
        lookback_days=5,
        stale_grace_days=10,
    )

    assert (min_date, max_date) == ("2026-04-14", "2026-04-24")
    assert max_date != "2026-04-29"
    assert len(queries) == 2


def test_prepare_verification_updates_batches_bars(monkeypatch):
    calls = {"bulk": 0, "single": 0}

    monkeypatch.setattr(
        verify_service,
        "load_bars_for_predictions",
        lambda pending: calls.__setitem__("bulk", calls["bulk"] + 1) or {
            1: [
                {"date": "2026-05-01", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "adj_open": 100.0, "adj_high": 101.0, "adj_low": 99.0, "adj_close": 100.0},
                {"date": "2026-05-04", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "adj_open": 100.0, "adj_high": 102.0, "adj_low": 99.0, "adj_close": 101.0},
                {"date": "2026-05-05", "open": 101.0, "high": 102.0, "low": 100.0, "close": 101.0, "adj_open": 101.0, "adj_high": 102.0, "adj_low": 100.0, "adj_close": 101.0},
                {"date": "2026-05-06", "open": 101.0, "high": 103.0, "low": 100.0, "close": 102.0, "adj_open": 101.0, "adj_high": 103.0, "adj_low": 100.0, "adj_close": 102.0},
                {"date": "2026-05-07", "open": 102.0, "high": 103.0, "low": 101.0, "close": 102.0, "adj_open": 102.0, "adj_high": 103.0, "adj_low": 101.0, "adj_close": 102.0},
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
    assert result["metrics"]["skipped_no_update"] == 0


def test_prepare_verification_updates_counts_missing_bars(monkeypatch):
    monkeypatch.setattr(
        verify_service,
        "load_bars_for_predictions",
        lambda pending: {},
    )

    result = verify_service.prepare_verification_updates(
        [
            {
                "id": 7,
                "stock_id": 1,
                "symbol": "6748",
                "model_name": "ensemble",
                "generated_at": "2026-07-02T00:20:14Z",
                "prediction_date": "2026-07-01",
                "entry_price": 166.0,
                "forecast_data": json.dumps({"signal": "HOLD", "rank_score": 0.5}),
            }
        ],
        market_risk={"risk_level": "low", "risk_score": 10},
    )

    assert result["verify_updates"] == []
    assert result["metrics"]["skipped_no_bars"] == 1
    assert result["metrics"]["skipped_no_update"] == 0
