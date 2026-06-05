from __future__ import annotations

import sys
import asyncio
import types
from datetime import date, timedelta
from pathlib import Path

graph_mod = types.ModuleType("langgraph.graph")
graph_mod.END = "__END__"


class _StateGraph:
    def __init__(self, *_args, **_kwargs):
        self.nodes = []

    def add_node(self, *args, **kwargs):
        self.nodes.append((args, kwargs))

    def set_entry_point(self, *_args, **_kwargs):
        return None

    def add_edge(self, *_args, **_kwargs):
        return None

    def compile(self, *_args, **_kwargs):
        return self


graph_mod.StateGraph = _StateGraph
types_mod = types.ModuleType("langgraph.types")


class _RetryPolicy:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


types_mod.RetryPolicy = _RetryPolicy
httpx_mod = types.ModuleType("httpx")
httpx_mod.AsyncClient = object
httpx_mod.RequestError = Exception
httpx_mod.Timeout = lambda *_args, **_kwargs: None
sys.modules.setdefault("langgraph.graph", graph_mod)
sys.modules.setdefault("langgraph.types", types_mod)
sys.modules.setdefault("httpx", httpx_mod)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs import daily_pipeline_v2  # noqa: E402
from services import modal_client  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


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


def _patch_common(monkeypatch, *, state_space_result: dict | None = None, state_space_fn=None):
    async def fake_batch_predict(payloads):
        return [_feature_prediction(payloads[0]["symbol"])]

    async def empty_ts(*_args, **_kwargs):
        return {"results": []}

    async def fake_state_space(*_args, **_kwargs):
        return state_space_result or {"results": []}

    monkeypatch.setattr(daily_pipeline_v2, "batch_predict", fake_batch_predict)
    monkeypatch.setattr(modal_client, "dlinear_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "patchtst_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "itransformer_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "timesfm_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "gnn_graphsage_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "state_space_overlays_batch_predict", state_space_fn or fake_state_space)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            {
                "DLinear": "retired",
                "PatchTST": "retired",
                "iTransformer": "retired",
                "TimesFM": "retired",
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


def test_state_space_shadow_mode_spawns_without_blocking_prediction(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "shadow")
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example.test")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "service-token")
    spawn_calls = []

    def fake_spawn(
        series_list,
        *,
        horizon=5,
        version_by_model=None,
        run_date=None,
        run_id=None,
        callback_url=None,
        callback_token=None,
    ):
        spawn_calls.append({
            "n": len(series_list),
            "horizon": horizon,
            "version_by_model": version_by_model,
            "run_date": run_date,
            "run_id": run_id,
            "callback_url": callback_url,
            "callback_token": callback_token,
        })
        return {"spawned": True, "function_call_id": "fc-123", "n_input": len(series_list)}

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "spawn_state_space_overlays_batch_predict", fake_spawn)

    result = _run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["signal"] == "BUY"
    assert "kalman_filter" not in pred
    assert "markov_switching" not in pred
    assert spawn_calls == [{
        "n": 1,
        "horizon": 5,
        "version_by_model": {"KalmanFilter": "v1", "MarkovSwitching": "v1"},
        "run_date": None,
        "run_id": None,
        "callback_url": "https://worker.example.test/api/internal/state-space-shadow/callback",
        "callback_token": "service-token",
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

    result = _run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["kalman_filter"]["forecast_pct"] == 0.01
    assert pred["markov_switching"]["forecast_pct"] == -0.01


def test_state_space_soft_deadline_continues_without_overlay(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "blocking")
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS", "0.01")
    calls = []

    async def slow_state_space(series_list, *_args, **_kwargs):
        calls.append(len(series_list))
        await asyncio.sleep(0.2)
        return {
            "overlays": {
                "KalmanFilter": {"results": [{"symbol": "2330", "forecast_pct": 0.01}]},
                "MarkovSwitching": {"results": [{"symbol": "2330", "forecast_pct": -0.01}]},
            },
            "metrics": {},
        }

    _patch_common(monkeypatch, state_space_fn=slow_state_space)

    result = _run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["signal"] == "BUY"
    assert "kalman_filter" not in pred
    assert "markov_switching" not in pred
    assert calls == [1]


def test_gnn_full_universe_scores_attach_to_rank_scores(monkeypatch):
    async def fake_gnn(payloads, *_args, **_kwargs):
        return {
            "results": [
                {"symbol": payloads[0]["symbol"], "rank_score": 0.81, "graph_context": {"n_nodes": len(payloads)}}
            ],
            "n_input": len(payloads),
            "n_success": 1,
        }

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "gnn_graphsage_batch_predict", fake_gnn)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            {
                "GNN": "active",
                "DLinear": "retired",
                "PatchTST": "retired",
                "iTransformer": "retired",
                "TimesFM": "retired",
                "KalmanFilter": "retired",
                "MarkovSwitching": "retired",
            },
            {"GNN": "v1"},
            {},
            True,
        ),
    )

    result = _run(daily_pipeline_v2.node_ml_predict({"payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["gnn"]["graph_context"]["n_nodes"] == 1
    assert pred["rank_scores"]["GNN"] == 0.81
    assert result["modal_wait_telemetry"]["stage_timings"]["gnn_graphsage_universal_predict"]["required_alpha"] is True


def test_timesfm_gate_requires_coverage_and_positive_effective_ic(monkeypatch):
    series = [{"symbol": "2330", "prices": list(range(60))}]
    pool = {"models": {"TimesFM": {"status": "active", "ic_4w_avg": 0.04, "last_ic_sample_count": 50}}}

    allowed, meta = daily_pipeline_v2._timesfm_sync_gate(
        model_status={"TimesFM": "active"},
        pool=pool,
        ev2_cfg={},
        sequence_series=series,
    )

    assert allowed is True
    assert meta["reason"] == "timesfm_gate_passed"

    blocked, blocked_meta = daily_pipeline_v2._timesfm_sync_gate(
        model_status={"TimesFM": "active"},
        pool={"models": {"TimesFM": {"status": "active", "ic_4w_avg": -0.05, "last_ic_sample_count": 80}}},
        ev2_cfg={},
        sequence_series=series,
    )

    assert blocked is False
    assert blocked_meta["reason"] == "timesfm_non_positive_effective_ic"
