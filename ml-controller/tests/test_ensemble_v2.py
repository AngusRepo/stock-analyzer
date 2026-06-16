from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.ensemble_v2 import attach_ensemble_v2  # noqa: E402


def test_ensemble_v2_blocks_equal_weight_when_ic_is_cold_start_by_default():
    pred = {
        "rank_scores": {
            "XGBoost": 0.74,
            "LightGBM": 0.70,
            "ExtraTrees": 0.66,
        }
    }

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active", "ExtraTrees": "active"},
        ic_weights={"XGBoost": 0.0, "LightGBM": 0.0, "ExtraTrees": 0.0},
        degraded_dampening=1.0,
        ev2_cfg={"buyThreshold": 0.70},
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "no_positive_lifecycle_weight"
    assert ev2["weight_total"] == 0.0
    assert ev2["signal"] == "HOLD"
    assert ev2["contributing_models"] == []


def test_ensemble_v2_uses_equal_weight_only_when_explicitly_enabled():
    pred = {
        "rank_scores": {
            "XGBoost": 0.74,
            "LightGBM": 0.70,
            "ExtraTrees": 0.66,
        }
    }

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active", "ExtraTrees": "active"},
        ic_weights={"XGBoost": 0.0, "LightGBM": 0.0, "ExtraTrees": 0.0},
        degraded_dampening=1.0,
        ev2_cfg={"buyThreshold": 0.70, "allowColdStartEqualWeight": True},
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "cold_start_equal_weight"
    assert ev2["weight_total"] == 3.0
    assert ev2["signal"] == "BUY"


def test_ensemble_v2_missing_lifecycle_status_stays_zero_weight_even_with_cold_start():
    pred = {"rank_scores": {"XGBoost": 0.95}}

    attach_ensemble_v2(
        pred,
        model_status={},
        ic_weights={"XGBoost": 0.0},
        degraded_dampening=1.0,
        ev2_cfg={"allowColdStartEqualWeight": True},
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "no_positive_lifecycle_weight"
    assert ev2["weights"] == {"XGBoost": 0.0}
    assert ev2["contributing_models"] == []


def test_ensemble_v2_keeps_no_positive_weight_when_ic_is_negative():
    pred = {"rank_scores": {"XGBoost": 0.9, "LightGBM": 0.8}}

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active"},
        ic_weights={"XGBoost": -0.2, "LightGBM": -0.1},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "no_positive_lifecycle_weight"
    assert ev2["signal"] == "HOLD"
    assert ev2["weight_total"] == 0.0


def test_attach_ensemble_v2_uses_calibrated_expected_return_not_hardcoded_cap():
    pred = {
        "rank_scores": {
            "XGBoost": 0.95,
            "LightGBM": 0.90,
        }
    }

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active"},
        ic_weights={"XGBoost": 0.03, "LightGBM": 0.03},
        degraded_dampening=1.0,
        ev2_cfg={
            "expectedReturnCalibration": {
                "minSamples": 20,
                "bins": [
                    {"rankLow": 0.0, "rankHigh": 0.8, "meanReturn": 0.01, "samples": 40},
                    {"rankLow": 0.8, "rankHigh": 1.0, "meanReturn": 0.082, "samples": 35},
                ],
            }
        },
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["forecast_pct"] == 0.082
    assert ev2["forecast_pct_source"] == "calibrated_rank_bin"


def test_attach_ensemble_v2_marks_uncalibrated_forecast_as_none():
    pred = {"rank_scores": {"XGBoost": 0.95}}

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active"},
        ic_weights={"XGBoost": 0.03},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["forecast_pct"] is None
    assert ev2["forecast_pct_source"] == "uncalibrated_rank_score"
