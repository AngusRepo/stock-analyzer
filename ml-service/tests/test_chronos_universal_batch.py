from __future__ import annotations

import sys
from types import SimpleNamespace

import pandas as pd

from app import chronos_universal


class _DummyChronosPipeline:
    def __init__(self):
        self.calls = 0
        self.ids_seen: list[str] = []

    def predict_df(self, context_df, **_kwargs):
        self.calls += 1
        self.ids_seen = list(context_df["id"].drop_duplicates())
        rows = []
        for symbol in self.ids_seen:
            last = float(context_df[context_df["id"] == symbol]["target"].iloc[-1])
            rows.append({
                "id": symbol,
                "timestamp": pd.Timestamp("2026-05-04"),
                "0.1": last * 0.99,
                "0.5": last * 1.02,
                "0.9": last * 1.05,
            })
        return pd.DataFrame(rows)


def test_chronos_batch_uses_one_multi_series_predict_df(monkeypatch):
    pipeline = _DummyChronosPipeline()
    monkeypatch.setattr(chronos_universal, "_get_pipeline", lambda _model_id: pipeline)
    monkeypatch.delenv("CHRONOS2_LORA_MODEL_ID", raising=False)

    results = chronos_universal.chronos_batch_predict([
        {"symbol": "2330", "prices": [100.0] * 12},
        {"symbol": "2317", "prices": [50.0] * 12},
    ])

    assert pipeline.calls == 1
    assert pipeline.ids_seen == ["2330", "2317"]
    assert [r["symbol"] for r in results] == ["2330", "2317"]
    assert all(r["batch_mode"] == "multi_series_predict_df" for r in results)
    assert results[0]["model"] == "Chronos"


def test_chronos_batch_preserves_original_order_with_invalid_series(monkeypatch):
    pipeline = _DummyChronosPipeline()
    monkeypatch.setattr(chronos_universal, "_get_pipeline", lambda _model_id: pipeline)
    monkeypatch.delenv("CHRONOS2_LORA_MODEL_ID", raising=False)

    results = chronos_universal.chronos_batch_predict([
        {"symbol": "TOO_SHORT", "prices": [10.0] * 3},
        {"symbol": "2330", "prices": [100.0] * 12},
        {"symbol": "2317", "prices": [50.0] * 12},
    ])

    assert pipeline.calls == 1
    assert [r["symbol"] for r in results] == ["TOO_SHORT", "2330", "2317"]
    assert "insufficient data" in results[0]["error"]
    assert results[1]["batch_mode"] == "multi_series_predict_df"


def test_get_pipeline_falls_back_when_chronos_api_rejects_dtype(monkeypatch):
    calls = []

    class _FakeChronos2Pipeline:
        @staticmethod
        def from_pretrained(model_id, **kwargs):
            calls.append({"model_id": model_id, **kwargs})
            if "dtype" in kwargs:
                raise TypeError("Chronos2Model.__init__() got an unexpected keyword argument 'dtype'")
            return {"model_id": model_id, "kwargs": kwargs}

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(float32="float32"))
    monkeypatch.setitem(sys.modules, "chronos", SimpleNamespace(Chronos2Pipeline=_FakeChronos2Pipeline))
    chronos_universal._get_pipeline.cache_clear()
    try:
        pipeline = chronos_universal._get_pipeline("amazon/chronos-2")
    finally:
        chronos_universal._get_pipeline.cache_clear()

    assert pipeline["kwargs"] == {"device_map": "cpu", "torch_dtype": "float32"}
    assert calls == [
        {"model_id": "amazon/chronos-2", "device_map": "cpu", "dtype": "float32"},
        {"model_id": "amazon/chronos-2", "device_map": "cpu", "torch_dtype": "float32"},
    ]


def test_chronos_forecast_validation_passes_with_realized_outcomes():
    predictions = [
        {"symbol": "2330", "forecast_pct": 0.05, "up_prob": 0.70, "confidence": 0.70},
        {"symbol": "2317", "forecast_pct": 0.03, "up_prob": 0.65, "confidence": 0.65},
        {"symbol": "2454", "forecast_pct": 0.01, "up_prob": 0.55, "confidence": 0.55},
        {"symbol": "2303", "forecast_pct": -0.01, "up_prob": 0.45, "confidence": 0.55},
        {"symbol": "2882", "forecast_pct": -0.03, "up_prob": 0.35, "confidence": 0.65},
        {"symbol": "1301", "forecast_pct": -0.05, "up_prob": 0.30, "confidence": 0.70},
    ]
    outcomes = {
        "2330": 0.060,
        "2317": 0.025,
        "2454": 0.015,
        "2303": -0.005,
        "2882": -0.035,
        "1301": -0.055,
    }

    evidence = chronos_universal.build_chronos_forecast_validation_evidence(
        predictions=predictions,
        realized_returns=outcomes,
        policy={"min_samples": 6, "min_rank_ic": 0.50, "min_direction_accuracy": 0.60},
    )

    assert evidence["model"] == "Chronos"
    assert evidence["method"] == "chronos_forecast_rank_ic"
    assert evidence["decision"] == "PASS"
    assert evidence["samples"] == 6
    assert evidence["coverage_mean"] == 1.0
    assert evidence["direction_accuracy"] == 1.0
    assert evidence["forecast_family"] == "foundation_time_series"
    assert evidence["retrain_required"] is False


def test_chronos_forecast_validation_fails_when_outcomes_are_missing():
    evidence = chronos_universal.build_chronos_forecast_validation_evidence(
        predictions=[
            {"symbol": "2330", "forecast_pct": 0.05, "up_prob": 0.70},
            {"symbol": "2317", "forecast_pct": -0.02, "up_prob": 0.40},
        ],
        realized_returns={},
        policy={"min_samples": 2},
    )

    assert evidence["decision"] == "FAIL"
    assert evidence["samples"] == 0
    assert "chronos_outcome_missing" in evidence["failed_gates"]
    assert "chronos_min_samples" in evidence["failed_gates"]
