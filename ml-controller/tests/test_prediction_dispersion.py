from __future__ import annotations

from services.prediction_dispersion import build_prediction_dispersion_report


def test_prediction_dispersion_flags_low_active_weights_and_annotates_symbols():
    predictions = {
        "2330": {
            "rank_scores": {"LightGBM": 0.82, "XGBoost": 0.81, "ExtraTrees": 0.80},
            "dlinear": {"forecast_pct": 0.02},
            "ensemble_v2": {
                "avg_rank": 0.80,
                "weights": {"LightGBM": 0.03, "XGBoost": 0.0, "ExtraTrees": 0.0, "DLinear": 0.0},
            },
        },
        "2317": {
            "rank_scores": {"LightGBM": 0.22, "XGBoost": 0.21, "ExtraTrees": 0.20},
            "dlinear": {"forecast_pct": -0.02},
            "ensemble_v2": {
                "avg_rank": 0.22,
                "weights": {"LightGBM": 0.04, "XGBoost": 0.0, "ExtraTrees": 0.0, "DLinear": 0.0},
            },
        },
    }

    report = build_prediction_dispersion_report(predictions)

    assert report["n_symbols"] == 2
    assert "low_active_weight_count" in report["flags"]
    assert report["avg_active_weight_count"] == 1.0
    assert predictions["2330"]["dispersion_diagnostics"]["raw_model_count"] == 4
    assert "XGBoost" in predictions["2330"]["dispersion_diagnostics"]["zero_weight_models"]


def test_prediction_dispersion_detects_merge_compression():
    predictions = {
        "3037": {
            "rank_scores": {"LightGBM": 0.90, "XGBoost": 0.88, "ExtraTrees": 0.86},
            "ensemble_v2": {
                "avg_rank": 0.51,
                "weights": {"LightGBM": 0.01, "XGBoost": 0.01, "ExtraTrees": 0.01},
            },
        }
    }

    report = build_prediction_dispersion_report(predictions)

    assert report["avg_merge_compression"] > 0.30
    assert "high_merge_compression" in report["flags"]
