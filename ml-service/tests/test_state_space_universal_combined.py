from __future__ import annotations

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
    assert result["overlays"]["MarkovSwitching"]["n_success"] == 2
    assert result["metrics"]["KalmanFilter"]["elapsed_s"] >= 0
    assert result["metrics"]["MarkovSwitching"]["elapsed_s"] >= 0
