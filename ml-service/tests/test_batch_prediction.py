from __future__ import annotations

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
