from __future__ import annotations

from services.ensemble_v2 import attach_ensemble_v2


def test_attach_ensemble_v2_holds_when_all_lifecycle_weights_are_zero():
    pred = {
        "rank_scores": {
            "XGBoost": 0.95,
            "CatBoost": 0.92,
        },
        "chronos": {"forecast_pct": 0.04},
    }

    attach_ensemble_v2(
        pred,
        model_status={
            "XGBoost": "active",
            "CatBoost": "retired",
            "Chronos": "active",
        },
        ic_weights={
            "XGBoost": -0.02,
            "CatBoost": 0.30,
            "Chronos": 0.0,
        },
        degraded_dampening=0.5,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["signal"] == "HOLD"
    assert ev2["avg_rank"] == 0.5
    assert ev2["contributing_models"] == []
    assert ev2["weight_total"] == 0.0
    assert ev2["reason"] == "no_positive_lifecycle_weight"


def test_attach_ensemble_v2_can_use_alternate_models_when_feature_models_fail():
    pred = {
        "rank_scores": {},
        "chronos": {"forecast_pct": 0.04},
        "kalman_filter": {"forecast_pct": 0.03},
    }

    attach_ensemble_v2(
        pred,
        model_status={"Chronos": "active", "KalmanFilter": "active"},
        ic_weights={"Chronos": 0.03, "KalmanFilter": 0.02},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["avg_rank"] > 0.5
    assert ev2["contributing_models"] == ["Chronos", "KalmanFilter"]
    assert ev2["weight_total"] > 0


def test_daily_pipeline_wrapper_no_longer_contains_legacy_plain_mean_body():
    from pathlib import Path

    source = Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py"
    text = source.read_text(encoding="utf-8")
    start = text.index("def _attach_ensemble_v2(")
    end = text.index("async def node_compute_personas", start)
    body = text[start:end]

    assert "attach_ensemble_v2(pred, model_status, ic_weights, degraded_dampening, ev2_cfg)" in body
    assert "plain mean" not in body
    assert "weight_total > 0" not in body


def test_daily_pipeline_loads_ic_from_model_pool_before_legacy_sidecar(monkeypatch):
    import sys
    import types

    graph_mod = types.ModuleType("langgraph.graph")
    graph_mod.END = object()
    graph_mod.StateGraph = object
    sqlite_mod = types.ModuleType("langgraph.checkpoint.sqlite")
    sqlite_mod.SqliteSaver = object
    retry_mod = types.ModuleType("langgraph.pregel.types")
    retry_mod.RetryPolicy = object
    monkeypatch.setitem(sys.modules, "langgraph.graph", graph_mod)
    monkeypatch.setitem(sys.modules, "langgraph.checkpoint.sqlite", sqlite_mod)
    monkeypatch.setitem(sys.modules, "langgraph.pregel.types", retry_mod)

    from graphs import daily_pipeline_v2

    pool = {
        "models": {
            "XGBoost": {"status": "active", "rolling_ic": 0.037, "ic_4w_avg": 0.031, "weekly_ic": [0.02, 0.031]},
            "CatBoost": {"status": "degraded", "weekly_ic": [0.012]},
        }
    }

    class Blob:
        def __init__(self, payload):
            self.payload = payload

        def exists(self):
            return self.payload is not None

        def download_as_text(self):
            return self.payload

    class Bucket:
        def blob(self, path):
            import json

            if path == "universal/model_pool.json":
                return Blob(json.dumps(pool))
            if path == "universal/ic_tracking.json":
                return Blob('{"models":{"XGBoost":{"oos_ic":0.0},"CatBoost":{"oos_ic":0.0}}}')
            return Blob(None)

    class Client:
        def bucket(self, name):
            return Bucket()

    import google.cloud.storage as storage

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: Client())
    monkeypatch.setattr(daily_pipeline_v2.kv_client, "get_json", lambda *_, **__: {})

    status, ic_weights, degraded, cfg, used_pool = daily_pipeline_v2._load_pool_and_ic()

    assert used_pool is True
    assert status == {"XGBoost": "active", "CatBoost": "degraded"}
    assert ic_weights["XGBoost"] == 0.037
    assert ic_weights["CatBoost"] == 0.012
    assert degraded == 1.0
    assert cfg == {}
