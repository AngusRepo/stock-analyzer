from __future__ import annotations

from services.ensemble_v2 import attach_ensemble_v2


def test_attach_ensemble_v2_holds_when_all_lifecycle_weights_are_zero():
    pred = {
        "rank_scores": {
            "XGBoost": 0.95,
            "ExtraTrees": 0.92,
        },
        "dlinear": {"forecast_pct": 0.04},
    }

    attach_ensemble_v2(
        pred,
        model_status={
            "XGBoost": "active",
            "ExtraTrees": "retired",
            "DLinear": "active",
        },
        ic_weights={
            "XGBoost": -0.02,
            "ExtraTrees": 0.30,
            "DLinear": 0.0,
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
        "dlinear": {"forecast_pct": 0.04},
        "kalman_filter": {"forecast_pct": 0.03},
    }

    attach_ensemble_v2(
        pred,
        model_status={"DLinear": "active", "KalmanFilter": "active"},
        ic_weights={"DLinear": 0.03, "KalmanFilter": 0.02},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["avg_rank"] > 0.5
    assert ev2["contributing_models"] == ["DLinear"]
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

    assert "attach_ensemble_v2(pred, model_status, serving_weights, degraded_dampening, effective_cfg)" in body
    assert "rank_signal_thresholds" in body
    assert "ic_weight_diagnostics" in body
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
            "ExtraTrees": {"status": "degraded", "weekly_ic": [0.012]},
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
                return Blob('{"models":{"XGBoost":{"oos_ic":0.0},"ExtraTrees":{"oos_ic":0.0}}}')
            return Blob(None)

    class Client:
        def bucket(self, name):
            return Bucket()

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(google_storage_mod, "Client", lambda: Client())
    monkeypatch.setattr(daily_pipeline_v2.kv_client, "get_json", lambda *_, **__: {})

    status, ic_weights, degraded, cfg, used_pool, pool_snapshot = daily_pipeline_v2._load_pool_and_ic()

    assert used_pool is True
    assert status == {"XGBoost": "active", "ExtraTrees": "degraded"}
    assert ic_weights["XGBoost"] == 0.037
    assert ic_weights["ExtraTrees"] == 0.012
    assert degraded == 1.0
    assert cfg["buyThreshold"] == 0.7
    assert pool_snapshot["models"]["XGBoost"]["rolling_ic"] == 0.037


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
            "TabM": {
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

    assert status["TabM"] == "active"
    assert "TabM" not in ic_weights
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
    assert calibration["method"] == "empirical_rank_bins_monotonic"
    assert calibration["sampleCount"] == 40
    assert len(calibration["bins"]) == 4
    assert calibration["bins"][-1]["meanReturn"] > 0


def _import_daily_pipeline_with_stubs(monkeypatch):
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

    return daily_pipeline_v2


def test_daily_pipeline_uses_lane_ic_before_global_ic(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)

    entry = {
        "rolling_ic": -0.30,
        "ic_4w_avg": -0.25,
        "last_ic_by_segment": {
            "LISTED": {"ic": 0.18, "n_samples": 42},
            "OTC": {"ic": -0.41, "n_samples": 18},
        },
    }

    ic_value, source = daily_pipeline_v2._entry_serving_ic(entry, "LISTED")

    assert ic_value == 0.18
    assert source == "last_ic_by_segment.LISTED"


def test_daily_pipeline_requires_regime_before_recommendation(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)

    assert daily_pipeline_v2._resolve_alpha_regime_label(None, {}, {}) == "unknown"
    assert daily_pipeline_v2._resolve_alpha_regime_label(
        None,
        {},
        {"threshold_components": {"inputs": {"regime": "bull"}}},
    ) == "bull"
    import inspect
    source = inspect.getsource(daily_pipeline_v2.node_recommend)
    assert "market_regime_state missing before recommendation" in source


def test_daily_pipeline_applies_adaptive_thresholds_to_ensemble(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)
    pred = {
        "stock_meta": {"market_segment": "LISTED"},
        "rank_scores": {"XGBoost": 0.69, "ExtraTrees": 0.69},
    }
    pool = {
        "models": {
            "XGBoost": {"status": "active", "last_ic_by_segment": {"LISTED": {"ic": 0.10}}},
            "ExtraTrees": {"status": "active", "last_ic_by_segment": {"LISTED": {"ic": 0.10}}},
        }
    }
    adaptive = {"confidence_delta": -0.03}
    ev2_cfg = {"buyThreshold": 0.70, "strongBuyThreshold": 0.85}

    daily_pipeline_v2._attach_ensemble_v2(
        pred,
        {"XGBoost": "active", "ExtraTrees": "active"},
        daily_pipeline_v2._build_serving_ic_bundle(pool, "LISTED"),
        1.0,
        ev2_cfg,
        adaptive_params=adaptive,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["signal"] == "BUY"
    assert ev2["rank_signal_thresholds"]["buyThreshold"] == 0.67
    assert ev2["ic_weight_scope"] == "LISTED"


def test_daily_pipeline_validation_fail_dampens_serving_weight(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)
    pool = {
        "models": {
            "XGBoost": {
                "status": "active",
                "last_ic_by_segment": {"LISTED": {"ic": 0.20, "n_samples": 30}},
                "model_cpcv": {"decision": "FAIL", "pbo": 0.82},
            },
            "ExtraTrees": {
                "status": "active",
                "last_ic_by_segment": {"LISTED": {"ic": 0.10, "n_samples": 30}},
                "model_cpcv": {"decision": "PASS", "pbo": 0.22},
            },
        }
    }

    bundle = daily_pipeline_v2._build_serving_ic_bundle(pool, "LISTED")

    assert bundle["weights"]["XGBoost"] == 0.0
    assert 0.0 < bundle["weights"]["ExtraTrees"] < 0.10
    assert bundle["diagnostics"]["ExtraTrees"]["ic_shrinkage"]["policy"] == "empirical_bayes_shrinkage"
    assert bundle["diagnostics"]["XGBoost"]["validation_status"] == "FAIL"


def test_daily_pipeline_ic_shrinkage_keeps_short_sample_model_from_hard_zero(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)
    pool = {
        "models": {
            "DLinear": {
                "status": "active",
                "last_ic_by_segment": {"LISTED": {"ic": -0.006, "n_samples": 8}},
                "model_cpcv": {"decision": "PASS", "pbo": 0.10},
            },
            "PatchTST": {
                "status": "active",
                "last_ic_by_segment": {"LISTED": {"ic": -0.006, "n_samples": 80}},
                "model_cpcv": {"decision": "PASS", "pbo": 0.10},
            },
        }
    }

    bundle = daily_pipeline_v2._build_serving_ic_bundle(pool, "LISTED")

    assert bundle["weights"]["DLinear"] > 0
    assert bundle["weights"]["PatchTST"] == 0.0
    assert bundle["diagnostics"]["DLinear"]["ic_shrinkage"]["reason"] == "shrunk_to_prior"
    assert bundle["diagnostics"]["PatchTST"]["ic_shrinkage"]["reason"] == "negative_ic_confirmed"


def test_daily_pipeline_uncertain_negative_segment_gets_exploration_floor(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)
    pool = {
        "models": {
            "XGBoost": {
                "status": "active",
                "last_ic_by_segment": {"OTC": {"ic": -0.278226, "n_samples": 32}},
                "model_cpcv": {"decision": "PASS", "pbo": 0.10},
            },
        }
    }

    bundle = daily_pipeline_v2._build_serving_ic_bundle(pool, "OTC")

    assert bundle["weights"]["XGBoost"] == 0.0025
    assert bundle["diagnostics"]["XGBoost"]["ic_shrinkage"]["reason"] == "uncertain_negative_floor"
    assert bundle["diagnostics"]["XGBoost"]["ic_shrinkage"]["sample_count"] < 40


def test_daily_pipeline_uses_pooled_floor_when_segment_ic_is_negative_but_global_evidence_is_positive(monkeypatch):
    daily_pipeline_v2 = _import_daily_pipeline_with_stubs(monkeypatch)
    pool = {
        "models": {
            "DLinear": {
                "status": "active",
                "rolling_ic": 0.034,
                "last_ic_sample_count": 132,
                "last_ic_by_segment": {"EMERGING": {"ic": -0.089, "n_samples": 74}},
                "model_cpcv": {"decision": "PASS", "pbo": 0.10},
            },
        }
    }

    bundle = daily_pipeline_v2._build_serving_ic_bundle(pool, "EMERGING")

    assert bundle["weights"]["DLinear"] > 0
    assert bundle["diagnostics"]["DLinear"]["ic_shrinkage"]["reason"] == "pooled_segment_floor"
    assert bundle["diagnostics"]["DLinear"]["ic_shrinkage"]["segment_reason"] == "negative_ic_confirmed"
