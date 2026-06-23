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


def test_attach_ensemble_v2_applies_only_capped_approved_allocator_policy():
    pred = {"rank_scores": {"XGBoost": 0.9, "LightGBM": 0.6}}

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active"},
        ic_weights={"XGBoost": 0.1, "LightGBM": 0.1},
        degraded_dampening=1.0,
        ev2_cfg={
            "allocatorPolicy": {
                "approved": True,
                "production_effect": "capped_production_effect",
                "model_multiplier_cap": 0.15,
                "model_weight_multipliers": {"XGBoost": 2.0, "LightGBM": 0.1},
                "policy_id": "linucb-approved-test",
            }
        },
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["allocator_policy_effect"]["applied"] is True
    assert ev2["allocator_policy_effect"]["multipliers"] == {"XGBoost": 1.15, "LightGBM": 0.85}
    assert ev2["weights"] == {"LightGBM": 0.085, "XGBoost": 0.115}


def test_attach_ensemble_v2_emits_full_allocator_learning_ledger():
    pred = {
        "rank_scores": {
            "XGBoost": 0.9,
            "LightGBM": 0.6,
            "TimesFM": 0.99,
        }
    }

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active", "TimesFM": "active"},
        ic_weights={"XGBoost": 0.1, "LightGBM": -0.1, "TimesFM": 0.9},
        degraded_dampening=1.0,
        ev2_cfg={
            "allocatorLearningPolicy": {
                "policy_id": "linucb-learning-test",
                "model_learning_multipliers": {"LightGBM": 1.5},
                "learning_weight_cap": 0.50,
            }
        },
    )

    ev2 = pred["ensemble_v2"]
    ledger = ev2["allocator_learning_ledger"]
    assert ledger["schema_version"] == "model-allocator-learning-ledger-v1"
    assert ev2["weights"] == {"XGBoost": 0.1, "LightGBM": 0.0}
    assert ledger["model_states"]["XGBoost"]["state"] == "production"
    assert ledger["model_states"]["XGBoost"]["production_weight"] == 0.1
    assert ledger["model_states"]["LightGBM"]["state"] == "learning_only"
    assert ledger["model_states"]["LightGBM"]["production_weight"] == 0.0
    assert ledger["model_states"]["LightGBM"]["learning_weight"] == 0.015
    assert ledger["model_states"]["TimesFM"]["state"] == "rejected"
    assert ledger["model_states"]["TimesFM"]["reject_reason"] == "direct_alpha_blocked_sidecar_only"
    assert ledger["learning_policy_effect"]["applied"] is True
    assert ledger["learning_policy_effect"]["production_effect"] is False
