"""Serving adapter for the immutable Active-8 OOF ensemble artifact.

Cross-sectional rank is input normalization only.  Production coefficients,
probability calibration, uncertainty intervals and signals are learned from
chronological label-resolved OOF evidence.
"""
from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_right
from typing import Any

import numpy as np

from services.active_model_policy import (
    ACTIVE_ALPHA_MODELS,
    CORE_CROSS_SECTIONAL_ALPHA_MODELS,
    OPTIONAL_SEQUENCE_ALPHA_MODELS,
)
from services.active8_score_semantics import (
    MIN_REQUIRED_CROSS_SECTIONAL_MODELS,
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
    MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
)

ENSEMBLE_V2_SCHEMA_VERSION = "active8-oof-ensemble-runtime-v1"
ENSEMBLE_V2_SEMANTIC_VERSION = "active8-purged-oof-chronological-ridge-v4"
ARTIFACT_SCHEMA_VERSION = "active8-oof-ensemble-serving-artifact-v1"
CALIBRATION_SCHEMA_VERSION = "active8-chronological-conformal-isotonic-v1"
SIGNAL_POLICY_VERSION = "active8-net-return-conformal-signal-policy-v1"
FEATURE_NAMES = tuple(
    [f"{model}.rank" for model in ACTIVE_ALPHA_MODELS]
    + [f"{model}.available" for model in ACTIVE_ALPHA_MODELS]
)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite_rank(value: object) -> float | None:
    try:
        rank = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(rank):
        return None
    return max(0.0, min(1.0, rank))


def _formal_model_scores(pred: dict) -> dict[str, float]:
    raw = pred.get("rank_scores") if isinstance(pred.get("rank_scores"), dict) else {}
    return {
        model: score
        for model in ACTIVE_ALPHA_MODELS
        if (score := _finite_rank(raw.get(model))) is not None
    }


def build_formal_model_input_contract(pred: dict | None) -> dict[str, Any]:
    prediction = pred if isinstance(pred, dict) else {}
    scores = _formal_model_scores(prediction)
    lineage = prediction.get("model_score_lineage") if isinstance(prediction.get("model_score_lineage"), dict) else {}
    required = [name for name in CORE_CROSS_SECTIONAL_ALPHA_MODELS]
    missing_core = [name for name in required if name not in scores]
    missing_optional = [name for name in OPTIONAL_SEQUENCE_ALPHA_MODELS if name not in scores]
    lineage_blockers: list[str] = []
    if lineage.get("schema_version") != MODEL_SCORE_LINEAGE_SCHEMA_VERSION:
        lineage_blockers.append("score_lineage_schema_mismatch")
    if lineage.get("semantic_version") != MODEL_SCORE_SEMANTIC_VERSION:
        lineage_blockers.append("score_semantic_mismatch")
    if lineage.get("target_semantic_version") != MODEL_TARGET_SEMANTIC_VERSION:
        lineage_blockers.append("target_semantic_mismatch")
    if lineage.get("complete") is not True:
        lineage_blockers.extend(str(value) for value in (lineage.get("blockers") or []))
    if len(required) < MIN_REQUIRED_CROSS_SECTIONAL_MODELS:
        lineage_blockers.append("required_cross_sectional_model_count_below_minimum")
    return {
        "schema_version": "formal-layer3-active8-input-contract-v4",
        "active_models": list(ACTIVE_ALPHA_MODELS),
        "required_models": required,
        "minimum_required_cross_sectional_models": MIN_REQUIRED_CROSS_SECTIONAL_MODELS,
        "optional_sequence_models": list(OPTIONAL_SEQUENCE_ALPHA_MODELS),
        "available_models": [name for name in ACTIVE_ALPHA_MODELS if name in scores],
        "missing_models": [name for name in ACTIVE_ALPHA_MODELS if name not in scores],
        "missing_core_models": missing_core,
        "missing_optional_models": missing_optional,
        "model_availability": {name: name in scores for name in ACTIVE_ALPHA_MODELS},
        "full_active8_coverage": len(scores) == len(ACTIVE_ALPHA_MODELS),
        "complete": not missing_core and not lineage_blockers,
        "coverage_policy": "core5-required-sequence-missingness-learned-v1",
        "finite_scores_required": True,
        "score_semantic_version": lineage.get("semantic_version"),
        "target_semantic_version": lineage.get("target_semantic_version"),
        "lineage_blockers": list(dict.fromkeys(lineage_blockers)),
    }


def _isotonic_predict(xs: list[float], ys: list[float], value: float) -> float:
    if len(xs) != len(ys) or not xs:
        raise RuntimeError("active8_ensemble_probability_thresholds_invalid")
    if value <= xs[0]:
        return float(ys[0])
    if value >= xs[-1]:
        return float(ys[-1])
    right = bisect_right(xs, value)
    left = right - 1
    span = xs[right] - xs[left]
    ratio = 1.0 if span <= 0.0 else (value - xs[left]) / span
    return float(ys[left] + ratio * (ys[right] - ys[left]))


def validate_active8_ensemble_artifact(payload: dict[str, Any], pool_models: dict[str, dict[str, Any]]) -> None:
    unsigned = {key: value for key, value in payload.items() if key != "payload_checksum"}
    checksum = hashlib.sha256(_canonical_json(unsigned).encode("utf-8")).hexdigest()
    fit = payload.get("fit") if isinstance(payload.get("fit"), dict) else {}
    validation = payload.get("validation") if isinstance(payload.get("validation"), dict) else {}
    policy = payload.get("signal_policy") if isinstance(payload.get("signal_policy"), dict) else {}
    if (
        payload.get("schema_version") != ARTIFACT_SCHEMA_VERSION
        or payload.get("ensemble_semantic_version") != ENSEMBLE_V2_SEMANTIC_VERSION
        or payload.get("calibration_schema_version") != CALIBRATION_SCHEMA_VERSION
        or checksum != str(payload.get("payload_checksum") or "")
        or list(payload.get("model_order") or []) != list(ACTIVE_ALPHA_MODELS)
        or list(payload.get("feature_names") or []) != list(FEATURE_NAMES)
        or fit.get("method") != "ridge_full_fit_after_heldout_chronological_oof_validation"
        or int(fit.get("outer_folds") or 0) < 5
        or len(fit.get("coefficients") or []) != len(FEATURE_NAMES)
        or validation.get("decision") != "PASS"
        or validation.get("failed_gates")
        or policy.get("schema_version") != SIGNAL_POLICY_VERSION
        or policy.get("top_k") is not None
        or policy.get("buy_rule") != "conformal_lower_bound_gt_zero"
        or policy.get("sell_rule") != "conformal_upper_bound_lt_zero"
    ):
        raise RuntimeError("active8_ensemble_artifact_contract_invalid")
    base = payload.get("base_artifacts") if isinstance(payload.get("base_artifacts"), dict) else {}
    if set(base) != set(ACTIVE_ALPHA_MODELS):
        raise RuntimeError("active8_ensemble_base_set_invalid")
    for model in ACTIVE_ALPHA_MODELS:
        expected = base.get(model) if isinstance(base.get(model), dict) else {}
        actual = pool_models.get(model) if isinstance(pool_models.get(model), dict) else {}
        actual_identity = {
            "artifact_id": str(actual.get("serving_artifact_id") or ""),
            "version": str(actual.get("version") or ""),
            "checksum": str(actual.get("checksum") or "").lower(),
        }
        expected_identity = {
            "artifact_id": str(expected.get("artifact_id") or ""),
            "version": str(expected.get("version") or ""),
            "checksum": str(expected.get("checksum") or "").lower(),
        }
        if actual_identity != expected_identity or actual.get("serving_eligible") is not True:
            raise RuntimeError(f"active8_ensemble_base_identity_mismatch:{model}")


def attach_ensemble_v2(
    pred: dict,
    artifact: dict[str, Any],
    pool_models: dict[str, dict[str, Any]],
) -> None:
    formal = build_formal_model_input_contract(pred)
    pred["formal_layer3_contract"] = formal
    if not formal["complete"]:
        pred["ensemble_v2_error"] = "formal_layer3_contract_incomplete"
        return
    validate_active8_ensemble_artifact(artifact, pool_models)
    scores = _formal_model_scores(pred)
    values = [scores.get(name, 0.5) for name in ACTIVE_ALPHA_MODELS]
    available = [1.0 if name in scores else 0.0 for name in ACTIVE_ALPHA_MODELS]
    vector = np.asarray([*values, *available], dtype=float)
    fit = artifact["fit"]
    expected_return = float(fit["intercept"] + np.dot(vector, fit["coefficients"]))
    calibration = artifact["calibration"]
    policy = artifact["signal_policy"]
    quantiles = calibration["absolute_residual_quantiles"]
    q90 = float(quantiles[str(float(policy["buy_coverage"]))])
    q95 = float(quantiles[str(float(policy["strong_coverage"]))])
    lower90, upper90 = expected_return - q90, expected_return + q90
    lower95, upper95 = expected_return - q95, expected_return + q95
    if lower95 > 0.0:
        signal = "STRONG_BUY"
    elif lower90 > 0.0:
        signal = "BUY"
    elif upper95 < 0.0:
        signal = "STRONG_SELL"
    elif upper90 < 0.0:
        signal = "SELL"
    else:
        signal = "HOLD"
    probability = _isotonic_predict(
        [float(value) for value in calibration["probability_x_thresholds"]],
        [float(value) for value in calibration["probability_y_thresholds"]],
        expected_return,
    )
    coefficient = [float(value) for value in fit["coefficients"]]
    influence = {
        model: abs(coefficient[index]) + abs(coefficient[index + len(ACTIVE_ALPHA_MODELS)])
        for index, model in enumerate(ACTIVE_ALPHA_MODELS)
    }
    total_influence = sum(influence.values())
    weights = {
        model: (value / total_influence if total_influence > 0.0 else 0.0)
        for model, value in influence.items()
    }
    contributing = [name for name in ACTIVE_ALPHA_MODELS if name in scores]
    confidence = probability if signal in {"BUY", "STRONG_BUY"} else 1.0 - probability if signal in {"SELL", "STRONG_SELL"} else max(probability, 1.0 - probability)
    pred["ensemble_v2"] = {
        "schema_version": ENSEMBLE_V2_SCHEMA_VERSION,
        "semantic_version": ENSEMBLE_V2_SEMANTIC_VERSION,
        "artifact_id": f"active8-ensemble:{artifact.get('cohort_id')}:{str(artifact.get('payload_checksum'))[:16]}",
        "artifact_checksum": artifact.get("payload_checksum"),
        "cohort_id": artifact.get("cohort_id"),
        "base_artifact_set_checksum": artifact.get("base_artifact_set_checksum"),
        "target_semantic_version": policy.get("target_semantic_version"),
        "lineage_status": "complete",
        "lineage_blockers": [],
        "signal": signal,
        "signal_source": "active8_ensemble_artifact",
        "confidence": round(max(0.0, min(1.0, confidence)), 6),
        "probability_positive_net_return": round(probability, 6),
        "avg_rank": round(probability, 6),
        "avg_rank_semantic": "compatibility_alias_probability_positive_net_return",
        "forecast_pct": round(expected_return, 8),
        "forecast_pct_source": "active8_ensemble_expected_net_return",
        "forecast_return_5bar": round(expected_return, 8),
        "forecast_return_5bar_source": "active8_ensemble_expected_net_return",
        "forecast_return_5bar_owner": "active8_ensemble_artifact",
        "forecast_horizon_bars": 5,
        "ml_expected_net_return": round(expected_return, 8),
        "expected_return": None,
        "expected_return_source": "allocator_ev_fusion_required",
        "expected_return_owner": "allocator_ev_fusion",
        "trade_expected_return_net_pct": None,
        "trade_expected_return_source": "allocator_ev_fusion_required",
        "interval_90": {"lower": lower90, "upper": upper90},
        "interval_95": {"lower": lower95, "upper": upper95},
        "contributing_models": contributing,
        "model_availability": {name: name in scores for name in ACTIVE_ALPHA_MODELS},
        "weights": {name: round(value, 8) for name, value in weights.items()},
        "weight_semantic": "learned_absolute_coefficient_influence_diagnostic_only",
        "weight_total": round(sum(weights.values()), 8),
        "formal_model_input_contract": formal,
        "signal_policy": policy,
        "validation": artifact.get("validation"),
        "top_k": None,
    }