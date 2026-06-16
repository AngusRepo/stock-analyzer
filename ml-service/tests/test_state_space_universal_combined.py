from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from app import model_pool
from app import state_space_universal


def test_state_space_overlays_batch_predict_combines_models(monkeypatch):
    calls: list[tuple[str, int]] = []

    def fake_batch_predict(model_name, series_list, horizon=5, version="v1"):
        calls.append((model_name, len(series_list)))
        return [
            {
                "symbol": row["symbol"],
                "model": model_name,
                "forecast_pct": 0.01,
                "up_prob": 0.55,
                "confidence": 0.6,
                "direction": "up",
                "model_version": version,
            }
            for row in series_list
        ]

    monkeypatch.setattr(state_space_universal, "state_space_batch_predict", fake_batch_predict)

    result = state_space_universal.state_space_overlays_batch_predict(
        model_names=["KalmanFilter", "MarkovSwitching"],
        series_list=[
            {"symbol": "2330", "prices": [1.0] * 40},
            {"symbol": "2317", "prices": [2.0] * 40},
        ],
        horizon=5,
        version_by_model={"KalmanFilter": "v2", "MarkovSwitching": "v3"},
    )

    assert calls == [("KalmanFilter", 2), ("MarkovSwitching", 2)]
    assert result["n_input"] == 2
    assert result["models"] == ["KalmanFilter", "MarkovSwitching"]
    assert result["overlays"]["KalmanFilter"]["n_success"] == 2
    assert result["overlays"]["KalmanFilter"]["n_fallback"] == 0
    assert result["overlays"]["MarkovSwitching"]["n_success"] == 2
    assert result["overlays"]["MarkovSwitching"]["n_fallback"] == 0
    assert result["metrics"]["KalmanFilter"]["elapsed_s"] >= 0
    assert result["metrics"]["MarkovSwitching"]["elapsed_s"] >= 0


def test_markov_batch_parallelization_preserves_input_order(monkeypatch):
    from app import models

    monkeypatch.setenv("STATE_SPACE_MARKOVSWITCHING_MAX_WORKERS", "2")
    monkeypatch.setattr(state_space_universal, "_load_hyperparams", lambda *_: {"same": "spec"})

    seen_hyperparams: list[dict] = []

    def fake_markov_runner(prices, horizon=5, stock_id=0, hyperparams=None):
        marker = float(prices[0])
        if marker == 1.0:
            time.sleep(0.03)
        seen_hyperparams.append(hyperparams)
        return SimpleNamespace(
            forecast_pct=marker / 100.0,
            direction="up",
            confidence=0.6,
        )

    monkeypatch.setattr(models, "run_markov_switching", fake_markov_runner)

    result = state_space_universal.state_space_batch_predict(
        model_name="MarkovSwitching",
        series_list=[
            {"symbol": "slow", "prices": [1.0] * 60},
            {"symbol": "fast", "prices": [2.0] * 60},
            {"symbol": "mid", "prices": [3.0] * 60},
        ],
        horizon=5,
        version="v-test",
    )

    assert [row["symbol"] for row in result] == ["slow", "fast", "mid"]
    assert [row["forecast_pct"] for row in result] == [0.01, 0.02, 0.03]
    assert all(hp == {"same": "spec"} for hp in seen_hyperparams)
    assert all(row["model_version"] == "v-test" for row in result)


def test_markov_parallelization_requires_explicit_worker_override(monkeypatch):
    monkeypatch.delenv("STATE_SPACE_MARKOVSWITCHING_MAX_WORKERS", raising=False)
    monkeypatch.delenv("STATE_SPACE_MAX_WORKERS", raising=False)

    assert state_space_universal._max_workers_for_model("MarkovSwitching", 64) == 1

    monkeypatch.setenv("STATE_SPACE_MARKOVSWITCHING_MAX_WORKERS", "2")

    assert state_space_universal._max_workers_for_model("MarkovSwitching", 64) == 2


def test_state_space_parallel_parity_report_passes_for_identical_outputs(monkeypatch):
    from app import models

    monkeypatch.setattr(state_space_universal, "_load_hyperparams", lambda *_: {})

    def fake_markov_runner(prices, horizon=5, stock_id=0, hyperparams=None):
        marker = float(prices[0])
        return SimpleNamespace(
            forecast_pct=marker / 100.0,
            direction="up",
            confidence=0.6,
        )

    monkeypatch.setattr(models, "run_markov_switching", fake_markov_runner)

    report = state_space_universal.build_state_space_parallel_parity_report(
        model_name="MarkovSwitching",
        series_list=[
            {"symbol": "a", "prices": [1.0] * 60},
            {"symbol": "b", "prices": [2.0] * 60},
        ],
        horizon=5,
        version="v-test",
        parallel_workers=2,
    )

    assert report["status"] == "pass"
    assert report["parallel_workers"] == 2
    assert report["n_mismatch"] == 0
    assert report["n_serial_success"] == 2
    assert report["n_parallel_success"] == 2


def test_state_space_parallel_parity_report_flags_mismatch(monkeypatch):
    def fake_batch_predict(model_name, series_list, horizon=5, version="v1", *, max_workers=None):
        forecast_pct = 0.01 if max_workers == 1 else 0.02
        return [
            {
                "symbol": row["symbol"],
                "model": model_name,
                "forecast_pct": forecast_pct,
                "up_prob": 0.55,
                "confidence": 0.6,
                "direction": "up",
                "model_version": version,
            }
            for row in series_list
        ]

    monkeypatch.setattr(state_space_universal, "state_space_batch_predict", fake_batch_predict)

    report = state_space_universal.build_state_space_parallel_parity_report(
        model_name="MarkovSwitching",
        series_list=[{"symbol": "a", "prices": [1.0] * 60}],
        parallel_workers=2,
    )

    assert report["status"] == "fail"
    assert report["n_mismatch"] == 1
    assert report["mismatches"][0]["symbol"] == "a"


def test_state_space_batch_marks_insufficient_rows_without_calling_runner(monkeypatch):
    from app import models

    monkeypatch.setenv("STATE_SPACE_MARKOVSWITCHING_MAX_WORKERS", "2")
    monkeypatch.setattr(state_space_universal, "_load_hyperparams", lambda *_: {})

    def unexpected_runner(*args, **kwargs):
        raise AssertionError("runner should not be called for insufficient rows")

    monkeypatch.setattr(models, "run_markov_switching", unexpected_runner)

    result = state_space_universal.state_space_batch_predict(
        model_name="MarkovSwitching",
        series_list=[{"symbol": "too-short", "prices": [1.0] * 10}],
    )

    assert result == [{"symbol": "too-short", "error": "insufficient data (10 < 60)"}]


def test_state_space_batch_surfaces_markov_fallback_reason(monkeypatch):
    from app import models

    monkeypatch.setattr(state_space_universal, "_load_hyperparams", lambda *_: {})

    def fallback_runner(prices, horizon=5, stock_id=0, hyperparams=None):
        pred = models.ModelPrediction(
            model_name="MarkovSwitching",
            direction="up",
            confidence=0.5,
            forecast_pct=0.0,
        )
        setattr(pred, "degraded", True)
        setattr(pred, "fallback_reason", "svd_not_converged")
        setattr(pred, "diagnostics", {"fallback_type": "momentum"})
        return pred

    monkeypatch.setattr(models, "run_markov_switching", fallback_runner)

    result = state_space_universal.state_space_batch_predict(
        model_name="MarkovSwitching",
        series_list=[{"symbol": "2330", "prices": [1.0] * 60}],
    )

    assert result[0]["degraded"] is True
    assert result[0]["fallback_reason"] == "svd_not_converged"
    assert result[0]["diagnostics"]["fallback_type"] == "momentum"


def test_state_space_batch_requires_hyperparam_aware_runner(monkeypatch):
    from app import models

    monkeypatch.setattr(state_space_universal, "_load_hyperparams", lambda *_: {"same": "spec"})

    def legacy_runner(prices, horizon=5, stock_id=0):
        return SimpleNamespace(
            forecast_pct=0.01,
            direction="up",
            confidence=0.6,
        )

    monkeypatch.setattr(models, "run_markov_switching", legacy_runner)

    result = state_space_universal.state_space_batch_predict(
        model_name="MarkovSwitching",
        series_list=[{"symbol": "2330", "prices": [1.0] * 60}],
    )

    assert result[0]["symbol"] == "2330"
    assert result[0]["error"].startswith("TypeError:")
    assert "hyperparams" in result[0]["error"]


def test_state_space_hyperparams_missing_artifact_fails_closed(monkeypatch):
    class Blob:
        def exists(self):
            return False

    class Bucket:
        def blob(self, _path):
            return Blob()

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(model_pool, "_get_bucket", lambda: Bucket())

    with pytest.raises(FileNotFoundError, match="state-space hyperparams missing"):
        model_pool.load_state_space_hyperparams("KalmanFilter", "v404")
