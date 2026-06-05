from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from app import batch_prediction


def test_predict_stock_v2_batch_preserves_order_and_wraps_failures(monkeypatch):
    class Request:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    def fake_predict(req):
        if req.symbol == "FAIL":
            raise ValueError("boom")
        return {"symbol": req.symbol, "stock_id": req.stock_id, "signal": "BUY"}

    monkeypatch.setattr(batch_prediction, "PredictRequest", Request)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2", fake_predict)

    results = batch_prediction.predict_stock_v2_batch([
        {"symbol": "2330", "stock_id": 2330, "prices": [{"close": 1}], "indicators": []},
        {"symbol": "FAIL", "stock_id": 9999, "prices": [{"close": 1}], "indicators": []},
        {"symbol": "2317", "stock_id": 2317, "prices": [{"close": 1}], "indicators": []},
    ])

    assert [r["symbol"] for r in results] == ["2330", "FAIL", "2317"]
    assert results[1]["signal"] == "NO_SIGNAL"
    assert "ValueError: boom" in results[1]["error"]


def test_predict_stock_v2_batch_preserves_runtime_options(monkeypatch):
    class Request:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    observed = []

    def fake_predict(req):
        observed.append(req.runtime_options)
        return {"symbol": req.symbol, "stock_id": req.stock_id, "signal": "HOLD"}

    monkeypatch.setattr(batch_prediction, "PredictRequest", Request)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2", fake_predict)

    batch_prediction.predict_stock_v2_batch([
        {
            "symbol": "2330",
            "stock_id": 2330,
            "prices": [{"close": 1}],
            "indicators": [],
            "runtime_options": {
                "embedded_time_series": False,
                "embedded_state_space": False,
                "owner": "daily_pipeline_v2.batch_predict",
            },
        }
    ])

    assert observed == [{
        "embedded_time_series": False,
        "embedded_state_space": False,
        "owner": "daily_pipeline_v2.batch_predict",
    }]


def test_predict_stock_v2_batch_metrics_report_preload_and_cache_delta(monkeypatch):
    class Request:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    stats = [
        {"hits": 1, "misses": 2, "gcs_downloads": 2},
        {"hits": 1, "misses": 7, "gcs_downloads": 7},
        {"hits": 11, "misses": 7, "gcs_downloads": 7},
    ]

    def fake_stats():
        return stats.pop(0)

    def fake_predict(req):
        return {"symbol": req.symbol, "stock_id": req.stock_id, "signal": "HOLD"}

    monkeypatch.setattr(batch_prediction, "PredictRequest", Request)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2", fake_predict)
    monkeypatch.setattr(batch_prediction, "_get_model_cache_stats", fake_stats)
    monkeypatch.setattr(
        batch_prediction,
        "preload_batch_artifacts",
        lambda payloads: {"active_attempted": 5, "active_loaded": 5, "challenger_attempted": 0, "challenger_loaded": 0},
    )

    batch = batch_prediction.predict_stock_v2_batch_with_metrics([
        {"symbol": "2330", "stock_id": 2330, "prices": [{"close": 1}], "indicators": []},
        {"symbol": "2317", "stock_id": 2317, "prices": [{"close": 1}], "indicators": []},
    ])

    assert [r["symbol"] for r in batch["results"]] == ["2330", "2317"]
    assert batch["metrics"]["batch"]["n_input"] == 2
    assert batch["metrics"]["preload"]["active_loaded"] == 5
    assert batch["metrics"]["model_cache"]["preload_delta"] == {"hits": 0, "misses": 5, "gcs_downloads": 5}
    assert batch["metrics"]["model_cache"]["total_delta"] == {"hits": 10, "misses": 5, "gcs_downloads": 5}


def _predict_payload(symbol: str, stock_id: int, base_price: float = 100.0) -> dict:
    start = date(2026, 1, 1)
    prices = []
    for idx in range(70):
        close = base_price + idx * 0.5
        prices.append({
            "date": (start + timedelta(days=idx)).isoformat(),
            "open": close - 0.2,
            "high": close + 0.8,
            "low": close - 0.8,
            "close": close,
            "volume": 1000 + idx,
        })
    return {
        "symbol": symbol,
        "stock_id": stock_id,
        "prices": prices,
        "indicators": [],
        "runtime_options": {
            "embedded_time_series": False,
            "embedded_state_space": False,
            "owner": "daily_pipeline_v2.batch_predict",
        },
    }


def test_feature_model_batch_overrides_vectorize_regular_models(monkeypatch):
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY
    from app.schemas import PredictRequest

    class FakeModel:
        def __init__(self):
            self.calls: list[tuple[int, int]] = []

        def predict(self, x_batch):
            self.calls.append(tuple(x_batch.shape))
            return np.array([0.25, 0.75], dtype=np.float32)

    fake_model = FakeModel()

    def fake_load_artifact(model_name, explicit_path=None):
        if model_name == "XGBoost":
            return fake_model, {"feature_names": [], "feature_medians": {}}
        return None, {}

    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: None)
    monkeypatch.setattr(batch_prediction, "_load_feature_artifact", fake_load_artifact)

    requests = [
        PredictRequest(**_predict_payload("2330", 2330, 100.0)),
        PredictRequest(**_predict_payload("2317", 2317, 80.0)),
    ]

    overrides = batch_prediction._build_feature_model_batch_runtime_overrides(requests)

    assert fake_model.calls
    assert fake_model.calls[0][0] == 2
    assert overrides[0][_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] == pytest.approx(0.25)
    assert overrides[1][_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] == pytest.approx(0.75)


def test_l2_tree_batch_predict_uses_only_tree_models(monkeypatch):
    loaded_models: list[str] = []

    class FakeModel:
        def predict(self, x_batch):
            return np.full((len(x_batch),), 0.72, dtype=np.float32)

    def fake_load_artifact(model_name, explicit_path=None):
        loaded_models.append(model_name)
        if model_name in {"LightGBM", "XGBoost", "ExtraTrees"}:
            return FakeModel(), {"feature_names": [], "feature_medians": {}}
        raise AssertionError(f"unexpected L2 model load: {model_name}")

    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: None)
    monkeypatch.setattr(batch_prediction, "_load_feature_artifact", fake_load_artifact)

    batch = batch_prediction.predict_l2_tree_batch([
        _predict_payload("2330", 2330, 100.0),
        _predict_payload("2317", 2317, 80.0),
    ])

    assert loaded_models == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert batch["metrics"]["contract"] == "l2_tree_predict_v1"
    assert batch["n_success"] == 2
    assert batch["results"][0]["source"] == "l2_tree_predict"
    assert batch["results"][0]["prediction_stage"] == "L2"
    assert set(batch["results"][0]["rank_scores"]) == {"LightGBM", "XGBoost", "ExtraTrees"}


def test_gnn_graphsage_batch_predict_uses_full_universe_context(monkeypatch):
    from app import gnn_batch_runtime

    pool = {
        "models": {
            "LightGBM": {"status": "retired"},
            "XGBoost": {"status": "retired"},
            "ExtraTrees": {"status": "retired"},
            "TabM": {"status": "retired"},
            "GNN": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/gnn/v1.pt",
            },
        }
    }
    artifact = gnn_batch_runtime.GraphSAGEArtifact(
        model=object(),
        metadata={"feature_names": [], "graph_context": {"correlation_lookback": 60}},
        source_path="universal/gnn/v1.pt",
        version="v1",
    )
    observed = {}

    def fail_if_generic_gnn(model_name, explicit_path=None):
        assert model_name != "GNN"
        return None, {}

    def fake_graphsage_scores(artifact_arg, *, node_features, price_series):
        observed["artifact"] = artifact_arg
        observed["node_shape"] = node_features.shape
        observed["series_count"] = len(price_series)
        return np.array([0.22, 0.78], dtype=np.float32), {
            "runtime": "graphsage_batch_context",
            "n_nodes": 2,
            "n_edges": 2,
        }

    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: pool)
    monkeypatch.setattr(batch_prediction, "_load_feature_artifact", fail_if_generic_gnn)
    monkeypatch.setattr(gnn_batch_runtime, "load_graphsage_artifact", lambda pool=None: artifact)
    monkeypatch.setattr(gnn_batch_runtime, "predict_graphsage_scores", fake_graphsage_scores)

    result = batch_prediction.predict_gnn_graphsage_batch([
        _predict_payload("2330", 2330, 100.0),
        _predict_payload("2317", 2317, 80.0),
    ])

    assert observed["artifact"] is artifact
    assert observed["node_shape"][0] == 2
    assert observed["series_count"] == 2
    assert result["n_input"] == 2
    assert result["n_success"] == 2
    assert result["results"][0]["rank_score"] == pytest.approx(0.22)
    assert result["results"][1]["rank_score"] == pytest.approx(0.78)
    assert result["results"][0]["graph_context"]["runtime"] == "graphsage_batch_context"


def test_gnn_graphsage_batch_predict_reports_error_summary(monkeypatch):
    from app import gnn_batch_runtime

    pool = {
        "models": {
            "LightGBM": {"status": "retired"},
            "XGBoost": {"status": "retired"},
            "ExtraTrees": {"status": "retired"},
            "TabM": {"status": "retired"},
            "GNN": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/gnn/v1.pt",
            },
        }
    }

    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: pool)
    monkeypatch.setattr(gnn_batch_runtime, "load_graphsage_artifact", lambda pool=None: (_ for _ in ()).throw(RuntimeError("bad artifact")))

    result = batch_prediction.predict_gnn_graphsage_batch([
        _predict_payload("2330", 2330, 100.0),
        _predict_payload("2317", 2317, 80.0),
    ])

    assert result["n_error"] == 2
    assert result["error_summary"]["error_count"] == 2
    assert result["error_summary"]["top_errors"][0]["count"] == 2
    assert "GNN: bad artifact" in result["error_summary"]["top_errors"][0]["error"]


def test_tabm_batch_overrides_use_torch_artifact_runtime(monkeypatch):
    from app import tabm_batch_runtime
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY
    from app.schemas import PredictRequest

    pool = {
        "models": {
            "LightGBM": {"status": "retired"},
            "XGBoost": {"status": "retired"},
            "ExtraTrees": {"status": "retired"},
            "TabM": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/tabm/v1.pt",
            },
            "GNN": {"status": "retired"},
        }
    }
    artifact = tabm_batch_runtime.TabMArtifact(
        model=object(),
        metadata={"feature_names": [], "feature_medians": {}},
        source_path="universal/tabm/v1.pt",
        version="v1",
    )
    observed = {}

    def fail_generic_loader(model_name, explicit_path=None):
        raise AssertionError(f"{model_name} should not use generic joblib loader")

    def fake_tabm_scores(artifact_arg, *, features):
        observed["artifact"] = artifact_arg
        observed["shape"] = features.shape
        return np.array([0.33, 0.66], dtype=np.float32)

    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: pool)
    monkeypatch.setattr(batch_prediction, "_load_feature_artifact", fail_generic_loader)
    monkeypatch.setattr(tabm_batch_runtime, "load_tabm_artifact", lambda pool=None: artifact)
    monkeypatch.setattr(tabm_batch_runtime, "predict_tabm_scores", fake_tabm_scores)

    requests = [
        PredictRequest(**_predict_payload("2330", 2330, 100.0)),
        PredictRequest(**_predict_payload("2317", 2317, 80.0)),
    ]

    overrides = batch_prediction._build_feature_model_batch_runtime_overrides(requests)

    assert observed["artifact"] is artifact
    assert observed["shape"][0] == 2
    assert overrides[0][_BATCH_FEATURE_RANK_SCORES_KEY]["TabM"] == pytest.approx(0.33)
    assert overrides[1][_BATCH_FEATURE_RANK_SCORES_KEY]["TabM"] == pytest.approx(0.66)


def test_formal_slot_without_model_artifact_is_not_active():
    pool = {
        "models": {},
        "formal_layer3_slots": {
            "GNN": {
                "status": "production_adapter_active",
                "direct_prediction": True,
                "vote_weight": 0.1,
            }
        },
    }

    assert batch_prediction._model_pool_status(pool)["GNN"] == "retired"


def test_shadow_challenger_batch_overrides_vectorize_residual_mlp(monkeypatch):
    from app.prediction_runtime import _BATCH_CHALLENGER_RANK_SCORES_KEY
    from app.schemas import PredictRequest

    class FakeModel:
        def predict(self, x_batch):
            return np.array([0.61, 0.39], dtype=np.float32)

    def fake_load_artifact(model_name, explicit_path=None):
        if model_name == "ResidualMLP":
            assert explicit_path == "experimental_shadow/residualmlp/v1.joblib"
            return FakeModel(), {"feature_names": [], "feature_medians": {}}
        return None, {}

    pool = {
        "models": {},
        "shadow_models": {
            "ResidualMLP": {
                "status": "challenger",
                "version": "v1",
                "gcs_path": "experimental_shadow/residualmlp/v1.joblib",
            },
        },
    }
    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: pool)
    monkeypatch.setattr(batch_prediction, "_load_feature_artifact", fake_load_artifact)

    requests = [
        PredictRequest(**_predict_payload("2330", 2330, 100.0)),
        PredictRequest(**_predict_payload("2317", 2317, 80.0)),
    ]

    overrides = batch_prediction._build_feature_model_batch_runtime_overrides(requests)

    assert overrides[0][_BATCH_CHALLENGER_RANK_SCORES_KEY]["ResidualMLP"] == pytest.approx(0.61)
    assert overrides[1][_BATCH_CHALLENGER_RANK_SCORES_KEY]["ResidualMLP"] == pytest.approx(0.39)


def test_predict_stock_v2_batch_attaches_true_batch_overrides(monkeypatch):
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY

    class Request:
        __module__ = "app.schemas"

        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    observed_runtime_options = []

    def fake_predict(req):
        observed_runtime_options.append(req.runtime_options)
        return {"symbol": req.symbol, "stock_id": req.stock_id, "signal": "HOLD"}

    fake_predict.__module__ = "app.prediction_runtime"

    def fake_overrides(reqs):
        assert [req.symbol for req in reqs] == ["2330", "2317"]
        return [
            {_BATCH_FEATURE_RANK_SCORES_KEY: {"XGBoost": 0.7}},
            {_BATCH_FEATURE_RANK_SCORES_KEY: {"XGBoost": 0.3}},
        ]

    monkeypatch.setattr(batch_prediction, "PredictRequest", Request)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2", fake_predict)
    monkeypatch.setattr(batch_prediction, "_build_feature_model_batch_runtime_overrides", fake_overrides)

    results = batch_prediction.predict_stock_v2_batch([
        {"symbol": "2330", "stock_id": 2330, "prices": [{"close": 1}], "indicators": []},
        {"symbol": "2317", "stock_id": 2317, "prices": [{"close": 1}], "indicators": []},
    ])

    assert [r["symbol"] for r in results] == ["2330", "2317"]
    assert observed_runtime_options[0][_BATCH_FEATURE_RANK_SCORES_KEY] == {"XGBoost": 0.7}
    assert observed_runtime_options[1][_BATCH_FEATURE_RANK_SCORES_KEY] == {"XGBoost": 0.3}


def test_predict_stock_v2_consumes_batch_scores_without_loading_models(monkeypatch):
    from app import ensemble, model_pool, model_store, prediction_runtime, stacking
    from app.prediction_runtime import (
        _BATCH_CHALLENGER_MODEL_ERRORS_KEY,
        _BATCH_CHALLENGER_RANK_SCORES_KEY,
        _BATCH_FEATURE_MODEL_ERRORS_KEY,
        _BATCH_FEATURE_RANK_SCORES_KEY,
    )
    from app.schemas import PredictRequest

    def fail_load_model(*_args, **_kwargs):
        raise AssertionError("serial model load should be skipped")

    monkeypatch.setattr(model_store, "load_model", fail_load_model)
    monkeypatch.setattr(model_pool, "load_pool", lambda: None)
    monkeypatch.setattr(ensemble, "load_ic_weights", lambda market_segment=None: {"XGBoost": 1.0})
    monkeypatch.setattr(stacking, "load_meta_learner", lambda stock_id: None)

    payload = _predict_payload("2330", 2330, 100.0)
    payload["runtime_options"] = {
        **payload["runtime_options"],
        _BATCH_FEATURE_RANK_SCORES_KEY: {"XGBoost": 0.82},
        _BATCH_FEATURE_MODEL_ERRORS_KEY: ["LightGBM: not found in GCS"],
        _BATCH_CHALLENGER_RANK_SCORES_KEY: {"ResidualMLP": 0.64},
        _BATCH_CHALLENGER_MODEL_ERRORS_KEY: [],
    }

    result = prediction_runtime.predict_stock_v2(PredictRequest(**payload))

    assert result["rank_scores"]["XGBoost"] == pytest.approx(0.82)
    assert result["challenger_rank_scores"]["ResidualMLP"] == pytest.approx(0.64)
    assert "LightGBM: not found in GCS" in result["model_errors"]
    assert _BATCH_FEATURE_RANK_SCORES_KEY not in result["runtime_options"]
    assert result["runtime_options"]["owner"] == "daily_pipeline_v2.batch_predict"
