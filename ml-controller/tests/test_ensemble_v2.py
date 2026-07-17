from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.ensemble_v2 import attach_ensemble_v2, build_formal_model_input_contract  # noqa: E402
from services.active_model_policy import ACTIVE_ALPHA_MODELS  # noqa: E402
from services.active8_score_semantics import (  # noqa: E402
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
    MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
)


def _formal_pred(scores: dict[str, float], *, missing: set[str] | None = None) -> dict:
    missing = missing or set()
    ranks = {name: 0.5 for name in ACTIVE_ALPHA_MODELS if name not in missing}
    ranks.update({name: value for name, value in scores.items() if name not in missing})
    versions = {name: f"{name}-test-v1" for name in ACTIVE_ALPHA_MODELS}
    blockers = [f"rank_missing:{name}" for name in ACTIVE_ALPHA_MODELS if name in missing]
    return {
        "rank_scores": ranks,
        "model_score_lineage": {
            "schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
            "semantic_version": MODEL_SCORE_SEMANTIC_VERSION,
            "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
            "complete": not blockers,
            "blockers": blockers,
            "artifact_versions": versions,
            "model_set_signature": "|".join(f"{name}@{versions[name]}" for name in sorted(versions)),
        },
    }


def test_formal_active8_contract_requires_finite_outputs_from_every_model():
    pred = _formal_pred({
            "LightGBM": 0.51,
            "XGBoost": 0.52,
            "ExtraTrees": 0.53,
            "TabM": 0.54,
            "GNN": float("nan"),
    }, missing={"GNN"})

    contract = build_formal_model_input_contract(pred)

    assert contract["complete"] is False
    assert contract["missing_models"] == ["GNN"]
    assert contract["finite_scores_required"] is True


def test_ensemble_v2_blocks_equal_weight_when_ic_is_cold_start_by_default():
    pred = _formal_pred({
            "XGBoost": 0.74,
            "LightGBM": 0.70,
            "ExtraTrees": 0.66,
    })

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
    pred = _formal_pred({
            "XGBoost": 0.74,
            "LightGBM": 0.70,
            "ExtraTrees": 0.66,
    })

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
    assert ev2["schema_version"] == "ensemble-v2-payload-v3"
    assert ev2["semantic_version"] == "active8-ic-weighted-rank-v4"
    assert ev2["model_set_signature"] is None
    assert ev2["lineage_status"] == "incomplete"
    assert ev2["lineage_blockers"] == [
        "artifact_version_missing:ExtraTrees",
        "artifact_version_missing:LightGBM",
        "artifact_version_missing:XGBoost",
    ]


def test_ensemble_v2_missing_lifecycle_status_stays_zero_weight_even_with_cold_start():
    pred = _formal_pred({"XGBoost": 0.95})

    attach_ensemble_v2(
        pred,
        model_status={},
        ic_weights={"XGBoost": 0.0},
        degraded_dampening=1.0,
        ev2_cfg={"allowColdStartEqualWeight": True},
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "no_positive_lifecycle_weight"
    assert ev2["weights"]["XGBoost"] == 0.0
    assert all(weight == 0.0 for weight in ev2["weights"].values())
    assert ev2["contributing_models"] == []


def test_ensemble_v2_keeps_no_positive_weight_when_ic_is_negative():
    pred = _formal_pred({"XGBoost": 0.9, "LightGBM": 0.8})

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
    assert ev2["expected_return"] is None
    assert ev2["expected_return_source"] == "no_positive_lifecycle_weight"
    assert ev2["contrarian_policy_effect"]["rejected_inverse_models"] == ["LightGBM", "XGBoost"]


def test_ensemble_v2_uses_negative_ic_only_with_approved_contrarian_policy():
    pred = _formal_pred({"XGBoost": 0.10, "LightGBM": 0.20})

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "LightGBM": "active"},
        ic_weights={"XGBoost": -0.08, "LightGBM": -0.02},
        degraded_dampening=1.0,
        ev2_cfg={
            "buyThreshold": 0.70,
            "strongBuyThreshold": 0.95,
            "contrarianPolicy": {
                "enabled": True,
                "approved": True,
                "production_effect": "capped_production_effect",
                "minAbsIc": 0.05,
                "maxWeight": 0.06,
                "allowedModels": ["XGBoost"],
            },
            "expectedReturnCalibration": {
                "minSamples": 20,
                "bins": [
                    {"rankLow": 0.0, "rankHigh": 0.8, "meanReturn": 0.0, "samples": 40},
                    {"rankLow": 0.8, "rankHigh": 1.0, "meanReturn": 0.04, "samples": 35},
                ],
            },
        },
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["signal"] == "BUY"
    assert ev2["avg_rank"] == 0.9
    assert {name: weight for name, weight in ev2["weights"].items() if weight > 0} == {"XGBoost": 0.06}
    assert ev2["weights"]["LightGBM"] == 0.0
    assert ev2["contrarian_policy_effect"]["inverted_models"] == ["XGBoost"]
    assert ev2["contrarian_policy_effect"]["rejected_inverse_models"] == ["LightGBM"]
    assert ev2["forecast_return_5bar"] == 0.04
    assert ev2["forecast_return_5bar_owner"] == "ensemble_v2_calibrated_5bar_close_forecast"
    assert ev2["expected_return"] is None
    assert ev2["expected_return_owner"] == "s12_trade_ev"
    assert ev2["expected_return_source"] == "s12_trade_ev_required"


def test_attach_ensemble_v2_uses_calibrated_5bar_forecast_not_trade_ev():
    pred = _formal_pred({
            "XGBoost": 0.95,
            "LightGBM": 0.90,
    })

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
    assert ev2["forecast_return_5bar"] == 0.082
    assert ev2["forecast_return_5bar_source"] == "calibrated_rank_bin"
    assert ev2["forecast_horizon_bars"] == 5
    assert ev2["expected_return"] is None
    assert ev2["expected_return_source"] == "s12_trade_ev_required"
    assert ev2["expected_return_owner"] == "s12_trade_ev"


def test_attach_ensemble_v2_marks_uncalibrated_forecast_as_none():
    pred = _formal_pred({"XGBoost": 0.95})

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active"},
        ic_weights={"XGBoost": 0.03},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["forecast_pct"] is None
    assert ev2["forecast_pct_source"] == "uncalibrated_rank_score"


def test_attach_ensemble_v2_tail_clamps_out_of_support_calibration():
    pred = _formal_pred({"XGBoost": 0.95})

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active"},
        ic_weights={"XGBoost": 0.03},
        degraded_dampening=1.0,
        ev2_cfg={
            "expectedReturnCalibration": {
                "method": "empirical_rank_bins",
                "minSamples": 20,
                "tailDampening": 0.5,
                "bins": [
                    {"rankLow": 0.20, "rankHigh": 0.40, "meanReturn": -0.01, "samples": 35},
                    {"rankLow": 0.40, "rankHigh": 0.80, "meanReturn": 0.02, "samples": 42},
                ],
            }
        },
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["forecast_pct"] == 0.01
    assert ev2["forecast_pct_source"] == "calibrated_rank_tail_clamp"
    assert ev2["forecast_calibration_ood"] is True
    assert ev2["forecast_calibration_ood_side"] == "above_max_rank"
    assert ev2["forecast_calibration_tail_policy"] == "conservative_empirical_bin_clamp"


def test_attach_ensemble_v2_lower_tail_never_invents_positive_edge():
    pred = _formal_pred({"XGBoost": 0.10})

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active"},
        ic_weights={"XGBoost": 0.03},
        degraded_dampening=1.0,
        ev2_cfg={
            "expectedReturnCalibration": {
                "minSamples": 20,
                "bins": [
                    {"rankLow": 0.20, "rankHigh": 0.40, "meanReturn": 0.015, "samples": 35},
                    {"rankLow": 0.40, "rankHigh": 0.80, "meanReturn": 0.02, "samples": 42},
                ],
            }
        },
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["forecast_pct"] == 0.0
    assert ev2["forecast_pct_source"] == "calibrated_rank_tail_clamp"
    assert ev2["forecast_calibration_ood_side"] == "below_min_rank"


def test_attach_ensemble_v2_applies_only_capped_approved_allocator_policy():
    pred = _formal_pred({"XGBoost": 0.9, "LightGBM": 0.6})

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
    assert {name: weight for name, weight in ev2["weights"].items() if weight > 0} == {"LightGBM": 0.085, "XGBoost": 0.115}


def test_attach_ensemble_v2_emits_full_allocator_learning_ledger():
    pred = _formal_pred({
            "XGBoost": 0.9,
            "LightGBM": 0.6,
            "TimesFM": 0.99,
    })

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
    assert {name: weight for name, weight in ev2["weights"].items() if weight > 0} == {"XGBoost": 0.1}
    assert ev2["weights"]["LightGBM"] == 0.0
    assert ledger["model_states"]["XGBoost"]["state"] == "production"
    assert ledger["model_states"]["XGBoost"]["production_weight"] == 0.1
    assert ledger["model_states"]["LightGBM"]["state"] == "learning_only"
    assert ledger["model_states"]["LightGBM"]["production_weight"] == 0.0
    assert ledger["model_states"]["LightGBM"]["learning_weight"] == 0.015
    assert ledger["model_states"]["TimesFM"]["state"] == "rejected"
    assert ledger["model_states"]["TimesFM"]["reject_reason"] == "direct_alpha_blocked_sidecar_only"
    assert ledger["learning_policy_effect"]["applied"] is True
    assert ledger["learning_policy_effect"]["production_effect"] is False
