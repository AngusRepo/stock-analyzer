from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs import daily_pipeline_v2  # noqa: E402
from services import modal_client  # noqa: E402


def _payload(symbol: str = "2330") -> dict:
    start = date(2026, 1, 1)
    prices = []
    for idx in range(65):
        close = 100.0 + idx * 0.1
        prices.append({
            "date": (start + timedelta(days=idx)).isoformat(),
            "close": close,
            "adj_close": close,
        })
    return {
        "symbol": symbol,
        "stock_id": int(symbol),
        "prices": prices,
        "indicators": [],
        "stock_meta": {"market_segment": "LISTED"},
    }


def _feature_prediction(symbol: str = "2330") -> dict:
    return {
        "symbol": symbol,
        "stock_id": int(symbol),
        "signal": "BUY",
        "direction": "up",
        "confidence": 0.7,
        "rank_scores": {"XGBoost": 0.72, "ExtraTrees": 0.68},
    }


def _patch_common(monkeypatch, *, state_space_result: dict | None = None):
    async def fake_batch_predict(payloads):
        return [_feature_prediction(payloads[0]["symbol"])]

    async def empty_ts(*_args, **_kwargs):
        return {"results": []}

    async def fake_state_space(*_args, **_kwargs):
        return state_space_result or {"results": []}

    monkeypatch.setattr(daily_pipeline_v2, "batch_predict", fake_batch_predict)
    monkeypatch.setattr(modal_client, "dlinear_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "patchtst_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "state_space_overlays_batch_predict", fake_state_space)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            {
                "DLinear": "retired",
                "PatchTST": "retired",
                "KalmanFilter": "active",
                "MarkovSwitching": "active",
            },
            {"KalmanFilter": "v1", "MarkovSwitching": "v1"},
            {},
            True,
        ),
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_pool_and_ic",
        lambda: ({}, {}, 1.0, {}, False, {}),
    )


@pytest.mark.asyncio
async def test_state_space_shadow_mode_spawns_without_blocking_prediction(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "shadow")
    spawn_calls = []

    def fake_spawn(series_list, *, horizon=5, version_by_model=None):
        spawn_calls.append({
            "n": len(series_list),
            "horizon": horizon,
            "version_by_model": version_by_model,
        })
        return {"spawned": True, "function_call_id": "fc-123", "n_input": len(series_list)}

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "spawn_state_space_overlays_batch_predict", fake_spawn)

    result = await daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]})

    pred = result["predictions"]["2330"]
    assert pred["signal"] == "BUY"
    assert "kalman_filter" not in pred
    assert "markov_switching" not in pred
    assert spawn_calls == [{
        "n": 1,
        "horizon": 5,
        "version_by_model": {"KalmanFilter": "v1", "MarkovSwitching": "v1"},
    }]


@pytest.mark.asyncio
async def test_state_space_blocking_mode_preserves_overlay_attachment(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "blocking")
    state_space_result = {
        "overlays": {
            "KalmanFilter": {
                "results": [{"symbol": "2330", "forecast_pct": 0.01, "confidence": 0.6}],
            },
            "MarkovSwitching": {
                "results": [{"symbol": "2330", "forecast_pct": -0.01, "confidence": 0.55}],
            },
        },
        "metrics": {},
    }
    _patch_common(monkeypatch, state_space_result=state_space_result)

    result = await daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]})

    pred = result["predictions"]["2330"]
    assert pred["kalman_filter"]["forecast_pct"] == 0.01
    assert pred["markov_switching"]["forecast_pct"] == -0.01
