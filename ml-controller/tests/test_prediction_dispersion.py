from __future__ import annotations

from services.prediction_dispersion import build_prediction_dispersion_report


def test_prediction_dispersion_flags_low_active_weights_and_annotates_symbols():
    predictions = {
        "2330": {
            "rank_scores": {"XGBoost": 0.82, "CatBoost": 0.81, "LightGBM": 0.80},
            "chronos": {"forecast_pct": 0.02},
            "ensemble_v2": {
                "avg_rank": 0.80,
                "weights": {"XGBoost": 0.03, "CatBoost": 0.0, "LightGBM": 0.0, "Chronos": 0.0},
            },
        },
        "2317": {
            "rank_scores": {"XGBoost": 0.22, "CatBoost": 0.21, "LightGBM": 0.20},
            "chronos": {"forecast_pct": -0.02},
            "ensemble_v2": {
                "avg_rank": 0.22,
                "weights": {"XGBoost": 0.04, "CatBoost": 0.0, "LightGBM": 0.0, "Chronos": 0.0},
            },
        },
    }

    report = build_prediction_dispersion_report(predictions)

    assert report["n_symbols"] == 2
    assert "low_active_weight_count" in report["flags"]
    assert report["avg_active_weight_count"] == 1.0
    assert predictions["2330"]["dispersion_diagnostics"]["raw_model_count"] == 4
    assert "CatBoost" in predictions["2330"]["dispersion_diagnostics"]["zero_weight_models"]


def test_prediction_dispersion_detects_merge_compression():
    predictions = {
        "3037": {
            "rank_scores": {"XGBoost": 0.90, "CatBoost": 0.88, "LightGBM": 0.86},
            "ensemble_v2": {
                "avg_rank": 0.51,
                "weights": {"XGBoost": 0.01, "CatBoost": 0.01, "LightGBM": 0.01},
            },
        }
    }

    report = build_prediction_dispersion_report(predictions)

    assert report["avg_merge_compression"] > 0.30
    assert "high_merge_compression" in report["flags"]
