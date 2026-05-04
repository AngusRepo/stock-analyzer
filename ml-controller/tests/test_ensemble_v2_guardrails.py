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


def test_attach_ensemble_v2_can_use_alpha_alternate_models_when_feature_models_fail():
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
    assert ev2["contributing_models"] == ["Chronos"]
    assert ev2["weight_total"] > 0


def test_attach_ensemble_v2_does_not_count_state_space_overlays_as_alpha_votes():
    pred = {
        "rank_scores": {},
        "kalman_filter": {"forecast_pct": 0.10},
        "markov_switching": {"forecast_pct": 0.10},
    }

    attach_ensemble_v2(
        pred,
        model_status={"KalmanFilter": "active", "MarkovSwitching": "active"},
        ic_weights={"KalmanFilter": 0.30, "MarkovSwitching": 0.30},
        degraded_dampening=1.0,
    )

    assert "ensemble_v2" not in pred


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
    types_mod = types.ModuleType("langgraph.types")
    types_mod.RetryPolicy = object
    retry_mod = types.ModuleType("langgraph.pregel.types")
    retry_mod.RetryPolicy = object
    monkeypatch.setitem(sys.modules, "langgraph.graph", graph_mod)
    monkeypatch.setitem(sys.modules, "langgraph.checkpoint.sqlite", sqlite_mod)
    monkeypatch.setitem(sys.modules, "langgraph.types", types_mod)
    monkeypatch.setitem(sys.modules, "langgraph.pregel.types", retry_mod)
    httpx_mod = types.ModuleType("httpx")
    httpx_mod.AsyncClient = object
    monkeypatch.setitem(sys.modules, "httpx", httpx_mod)
    google_mod = types.ModuleType("google")
    google_cloud_mod = types.ModuleType("google.cloud")
    google_storage_mod = types.ModuleType("google.cloud.storage")
    google_storage_mod.Client = object
    google_cloud_mod.storage = google_storage_mod
    google_mod.cloud = google_cloud_mod
    monkeypatch.setitem(sys.modules, "google", google_mod)
    monkeypatch.setitem(sys.modules, "google.cloud", google_cloud_mod)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", google_storage_mod)

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

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(google_storage_mod, "Client", lambda: Client())
    monkeypatch.setattr(daily_pipeline_v2.kv_client, "get_json", lambda *_, **__: {})

    status, ic_weights, degraded, cfg, used_pool = daily_pipeline_v2._load_pool_and_ic()

    assert used_pool is True
    assert status == {"XGBoost": "active", "CatBoost": "degraded"}
    assert ic_weights["XGBoost"] == 0.037
    assert ic_weights["CatBoost"] == 0.012
    assert degraded == 1.0
    assert cfg == {}


def test_daily_pipeline_ignores_stale_ic_when_latest_run_not_computed(monkeypatch):
    import sys
    import types

    graph_mod = types.ModuleType("langgraph.graph")
    graph_mod.END = object()
    graph_mod.StateGraph = object
    sqlite_mod = types.ModuleType("langgraph.checkpoint.sqlite")
    sqlite_mod.SqliteSaver = object
    types_mod = types.ModuleType("langgraph.types")
    types_mod.RetryPolicy = object
    retry_mod = types.ModuleType("langgraph.pregel.types")
    retry_mod.RetryPolicy = object
    monkeypatch.setitem(sys.modules, "langgraph.graph", graph_mod)
    monkeypatch.setitem(sys.modules, "langgraph.checkpoint.sqlite", sqlite_mod)
    monkeypatch.setitem(sys.modules, "langgraph.types", types_mod)
    monkeypatch.setitem(sys.modules, "langgraph.pregel.types", retry_mod)
    httpx_mod = types.ModuleType("httpx")
    httpx_mod.AsyncClient = object
    monkeypatch.setitem(sys.modules, "httpx", httpx_mod)
    google_mod = types.ModuleType("google")
    google_cloud_mod = types.ModuleType("google.cloud")
    google_storage_mod = types.ModuleType("google.cloud.storage")
    google_storage_mod.Client = object
    google_cloud_mod.storage = google_storage_mod
    google_mod.cloud = google_cloud_mod
    monkeypatch.setitem(sys.modules, "google", google_mod)
    monkeypatch.setitem(sys.modules, "google.cloud", google_cloud_mod)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", google_storage_mod)

    from graphs import daily_pipeline_v2

    pool = {
        "models": {
            "FT-Transformer": {
                "status": "active",
                "rolling_ic": 0.12,
                "last_ic_status": "insufficient_samples",
                "last_ic_root_cause": "verification_missing",
            },
            "DLinear": {
                "status": "active",
                "rolling_ic": -0.06,
                "last_ic_status": "insufficient_samples",
                "last_ic_root_cause": "verification_missing",
            },
            "PatchTST": {
                "status": "active",
                "rolling_ic": 0.07,
                "last_ic_status": "computed",
                "last_ic_root_cause": "ok",
            },
        }
    }

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            import json

            return json.dumps(pool)

    class Bucket:
        def blob(self, path):
            return Blob()

    class Client:
        def bucket(self, name):
            return Bucket()

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(google_storage_mod, "Client", lambda: Client())
    monkeypatch.setattr(daily_pipeline_v2.kv_client, "get_json", lambda *_, **__: {})

    status, ic_weights, *_ = daily_pipeline_v2._load_pool_and_ic()

    assert status["FT-Transformer"] == "active"
    assert "FT-Transformer" not in ic_weights
    assert "DLinear" not in ic_weights
    assert ic_weights["PatchTST"] == 0.07


def test_daily_pipeline_builds_expected_return_calibration_from_verified_outcomes(monkeypatch):
    import json
    import sys
    import types

    graph_mod = types.ModuleType("langgraph.graph")
    graph_mod.END = object()
    graph_mod.StateGraph = object
    types_mod = types.ModuleType("langgraph.types")
    types_mod.RetryPolicy = object
    monkeypatch.setitem(sys.modules, "langgraph.graph", graph_mod)
    monkeypatch.setitem(sys.modules, "langgraph.types", types_mod)
    httpx_mod = types.ModuleType("httpx")
    httpx_mod.AsyncClient = object
    monkeypatch.setitem(sys.modules, "httpx", httpx_mod)

    from graphs import daily_pipeline_v2

    rows = []
    for idx in range(40):
        avg_rank = 0.40 + (idx * 0.01)
        actual = -0.02 if avg_rank < 0.60 else 0.04
        rows.append({
            "forecast_data": json.dumps({"ensemble_v2": {"avg_rank": avg_rank}}),
            "actual_return_pct": actual,
        })

    monkeypatch.setattr(daily_pipeline_v2.d1_client, "query", lambda *_args, **_kwargs: rows)

    calibration = daily_pipeline_v2._load_expected_return_calibration(
        min_samples=30,
        min_bin_samples=10,
        max_bins=4,
    )

    assert calibration is not None
    assert calibration["source"] == "verified_ensemble_outcomes"
    assert calibration["sampleCount"] == 40
    assert len(calibration["bins"]) == 4
    assert calibration["bins"][-1]["meanReturn"] > 0
