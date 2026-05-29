from __future__ import annotations

import sys
import types
import asyncio
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if "langgraph.graph" not in sys.modules:
    langgraph_mod = types.ModuleType("langgraph")
    graph_mod = types.ModuleType("langgraph.graph")
    types_mod = types.ModuleType("langgraph.types")

    class StateGraph:
        def __init__(self, *_args, **_kwargs):
            pass

        def add_node(self, *_args, **_kwargs):
            pass

        def set_entry_point(self, *_args, **_kwargs):
            pass

        def add_edge(self, *_args, **_kwargs):
            pass

        def compile(self):
            return self

    class RetryPolicy:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    graph_mod.StateGraph = StateGraph
    graph_mod.END = "__end__"
    types_mod.RetryPolicy = RetryPolicy
    sys.modules["langgraph"] = langgraph_mod
    sys.modules["langgraph.graph"] = graph_mod
    sys.modules["langgraph.types"] = types_mod

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
        "rank_scores": {"XGBoost": 0.72, "CatBoost": 0.68},
    }


def _patch_common(monkeypatch, *, state_space_result: dict | None = None):
    async def fake_batch_predict(payloads):
        return [_feature_prediction(payloads[0]["symbol"])]

    async def empty_ts(*_args, **_kwargs):
        return {"results": []}

    async def fake_state_space(*_args, **_kwargs):
        return state_space_result or {"results": []}

    monkeypatch.setattr(daily_pipeline_v2, "batch_predict", fake_batch_predict)
    monkeypatch.setattr(modal_client, "chronos_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "dlinear_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "patchtst_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "state_space_overlays_batch_predict", fake_state_space)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            {
                "Chronos": "retired",
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


def test_state_space_shadow_or_disabled_requires_explicit_quality_escape_hatch(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "shadow")
    monkeypatch.delenv("PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE", raising=False)
    assert daily_pipeline_v2._state_space_overlay_mode() == "blocking"

    monkeypatch.setenv("PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE", "1")
    assert daily_pipeline_v2._state_space_overlay_mode() == "shadow"

    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "disabled")
    monkeypatch.delenv("PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE", raising=False)
    assert daily_pipeline_v2._state_space_overlay_mode() == "blocking"


def test_state_space_shadow_mode_spawns_without_blocking_prediction(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "shadow")
    monkeypatch.setenv("PIPELINE_ALLOW_STATE_SPACE_OVERLAY_DEGRADE", "1")
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

    result = asyncio.run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["signal"] == "BUY"
    assert "kalman_filter" not in pred
    assert "markov_switching" not in pred
    assert spawn_calls == [{
        "n": 1,
        "horizon": 5,
        "version_by_model": {"KalmanFilter": "v1", "MarkovSwitching": "v1"},
    }]


def test_state_space_blocking_mode_preserves_overlay_attachment(monkeypatch):
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

    result = asyncio.run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["kalman_filter"]["forecast_pct"] == 0.01
    assert pred["markov_switching"]["forecast_pct"] == -0.01


def test_chronos_is_retired_from_evening_chain_even_if_legacy_pool_marks_active(monkeypatch):
    _patch_common(monkeypatch)
    chronos_calls = 0

    async def broken_chronos(*_args, **_kwargs):
        nonlocal chronos_calls
        chronos_calls += 1
        return {
            "results": [
                {
                    "symbol": "2330",
                    "error": "PipelineLoadError: Chronos2Model.__init__() got an unexpected keyword argument 'dtype'",
                }
            ]
        }

    monkeypatch.setattr(modal_client, "chronos_batch_predict", broken_chronos)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            {
                "Chronos": "active",
                "DLinear": "retired",
                "PatchTST": "retired",
                "KalmanFilter": "retired",
                "MarkovSwitching": "retired",
            },
            {"Chronos": "v2"},
            {},
            True,
        ),
    )

    result = asyncio.run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    assert result["predictions"]["2330"]["signal"] == "BUY"
    assert chronos_calls == 0
