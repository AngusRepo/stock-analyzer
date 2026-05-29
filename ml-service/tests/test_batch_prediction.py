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


def test_legacy_layer3_side_channel_pool_is_ignored_by_batch_runtime(monkeypatch):
    from app.prediction_runtime import _BATCH_CHALLENGER_RANK_SCORES_KEY
    from app.schemas import PredictRequest

    def fake_load_artifact(model_name, explicit_path=None):
        if model_name == "ResidualMLP":
            raise AssertionError("legacy ResidualMLP side-channel should not be loaded")
        return None, {}

    pool = {
        "models": {},
        "legacy_layer3_models": {
            "ResidualMLP": {
                "status": "challenger",
                "version": "v1",
                "gcs_path": "legacy_layer3/residualmlp/v1.joblib",
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

    assert _BATCH_CHALLENGER_RANK_SCORES_KEY not in overrides[0]
    assert _BATCH_CHALLENGER_RANK_SCORES_KEY not in overrides[1]


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
        _BATCH_CHALLENGER_RANK_SCORES_KEY: {"XGBoost": 0.64},
        _BATCH_CHALLENGER_MODEL_ERRORS_KEY: [],
    }

    result = prediction_runtime.predict_stock_v2(PredictRequest(**payload))

    assert result["rank_scores"]["XGBoost"] == pytest.approx(0.82)
    assert result["challenger_rank_scores"] == {}
    assert "LightGBM: not found in GCS" in result["model_errors"]
    assert _BATCH_FEATURE_RANK_SCORES_KEY not in result["runtime_options"]
    assert result["runtime_options"]["owner"] == "daily_pipeline_v2.batch_predict"
