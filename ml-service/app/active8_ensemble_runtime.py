"""Runtime for the immutable Active-8 OOF ensemble artifact."""
from __future__ import annotations

import hashlib
import json
from bisect import bisect_right
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .model_serving_contract import ALPHA_PREDICTION_MODELS

ARTIFACT_SCHEMA_VERSION = "active8-oof-ensemble-serving-artifact-v1"
ENSEMBLE_SEMANTIC_VERSION = "active8-purged-oof-chronological-nonnegative-ridge-v5"
CALIBRATION_SCHEMA_VERSION = "active8-chronological-conformal-isotonic-v1"
SIGNAL_POLICY_VERSION = "active8-net-return-conformal-signal-policy-v1"
FEATURE_NAMES = tuple(
    [f"{model}.rank" for model in ALPHA_PREDICTION_MODELS]
    + [f"{model}.available" for model in ALPHA_PREDICTION_MODELS]
)
CORE_MODELS = tuple(ALPHA_PREDICTION_MODELS[:5])


class Active8EnsembleContractError(RuntimeError):
    pass


@dataclass(frozen=True)
class Active8EnsembleResult:
    signal: Literal["STRONG_BUY", "BUY", "HOLD", "SELL", "STRONG_SELL"]
    direction: Literal["up", "down", "neutral"]
    confidence: float
    consensus: float
    forecast_pct: float
    forecast_range: dict[str, float]
    models: list[dict[str, Any]]
    entry_price: float
    stop_loss: None
    target1: None
    target2: None
    reasoning: str
    signal_strength: int
    evidence: dict[str, Any]


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _payload_checksum(payload: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in payload.items() if key != "payload_checksum"}
    return hashlib.sha256(_canonical_json(unsigned).encode("utf-8")).hexdigest()


def _isotonic_predict(x_thresholds: list[float], y_thresholds: list[float], value: float) -> float:
    if len(x_thresholds) != len(y_thresholds) or not x_thresholds:
        raise Active8EnsembleContractError("active8_ensemble_probability_thresholds_invalid")
    if value <= x_thresholds[0]:
        return float(y_thresholds[0])
    if value >= x_thresholds[-1]:
        return float(y_thresholds[-1])
    right = bisect_right(x_thresholds, value)
    left = right - 1
    span = x_thresholds[right] - x_thresholds[left]
    ratio = 1.0 if span <= 0.0 else (value - x_thresholds[left]) / span
    return float(y_thresholds[left] + ratio * (y_thresholds[right] - y_thresholds[left]))


def validate_active8_ensemble_artifact(
    payload: dict[str, Any],
    *,
    pool_models: dict[str, dict[str, Any]],
) -> None:
    if not isinstance(payload, dict):
        raise Active8EnsembleContractError("active8_ensemble_payload_not_object")
    if payload.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
        raise Active8EnsembleContractError("active8_ensemble_schema_invalid")
    if payload.get("ensemble_semantic_version") != ENSEMBLE_SEMANTIC_VERSION:
        raise Active8EnsembleContractError("active8_ensemble_semantic_invalid")
    if payload.get("calibration_schema_version") != CALIBRATION_SCHEMA_VERSION:
        raise Active8EnsembleContractError("active8_ensemble_calibration_schema_invalid")
    expected_checksum = str(payload.get("payload_checksum") or "")
    if len(expected_checksum) != 64 or expected_checksum != _payload_checksum(payload):
        raise Active8EnsembleContractError("active8_ensemble_payload_checksum_invalid")
    if list(payload.get("model_order") or []) != list(ALPHA_PREDICTION_MODELS):
        raise Active8EnsembleContractError("active8_ensemble_model_order_invalid")
    if list(payload.get("feature_names") or []) != list(FEATURE_NAMES):
        raise Active8EnsembleContractError("active8_ensemble_feature_contract_invalid")

    fit = payload.get("fit") if isinstance(payload.get("fit"), dict) else {}
    coefficients = fit.get("coefficients")
    if (
        fit.get("method") != "nonnegative_rank_ridge_full_fit_after_heldout_chronological_oof_validation"
        or fit.get("rank_coefficient_constraint") != "nonnegative"
        or int(fit.get("outer_folds") or 0) < 5
        or not isinstance(coefficients, list)
        or len(coefficients) != len(FEATURE_NAMES)
        or not all(np.isfinite(float(value)) for value in coefficients)
        or any(float(value) < -1e-12 for value in coefficients[: len(ALPHA_PREDICTION_MODELS)])
        or not np.isfinite(float(fit.get("intercept")))
    ):
        raise Active8EnsembleContractError("active8_ensemble_fit_contract_invalid")
    validation = payload.get("validation") if isinstance(payload.get("validation"), dict) else {}
    if (
        validation.get("decision") != "PASS"
        or validation.get("method") != "chronological_oof_calibration_then_later_validation"
        or validation.get("failed_gates")
        or int(validation.get("validation_dates") or 0) < 5
        or int(validation.get("validation_rows") or 0) < 200
        or float(validation.get("rank_ic_equal_date_market_lcb90") or 0.0) <= 0.0
        or float(validation.get("top_bottom_net_return_spread_lcb90") or 0.0) <= 0.0
    ):
        raise Active8EnsembleContractError("active8_ensemble_validation_not_promotion_grade")
    policy = payload.get("signal_policy") if isinstance(payload.get("signal_policy"), dict) else {}
    if (
        policy.get("schema_version") != SIGNAL_POLICY_VERSION
        or policy.get("target_semantic_version")
        != "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
        or policy.get("buy_rule") != "conformal_lower_bound_gt_zero"
        or policy.get("sell_rule") != "conformal_upper_bound_lt_zero"
        or policy.get("top_k") is not None
        or float(policy.get("net_return_zero_boundary")) != 0.0
    ):
        raise Active8EnsembleContractError("active8_ensemble_signal_policy_invalid")
    calibration = payload.get("calibration") if isinstance(payload.get("calibration"), dict) else {}
    quantiles = calibration.get("absolute_residual_quantiles")
    if not isinstance(quantiles, dict):
        raise Active8EnsembleContractError("active8_ensemble_conformal_quantiles_missing")
    for coverage_name in (str(float(policy["buy_coverage"])), str(float(policy["strong_coverage"]))):
        if coverage_name not in quantiles or float(quantiles[coverage_name]) < 0.0:
            raise Active8EnsembleContractError("active8_ensemble_conformal_quantile_invalid")

    selected = payload.get("selected_models")
    excluded = payload.get("excluded_models")
    if (
        not isinstance(selected, list)
        or not selected
        or len(selected) != len(set(selected))
        or not set(selected).issubset(set(ALPHA_PREDICTION_MODELS))
        or not isinstance(excluded, list)
        or set(excluded) != set(ALPHA_PREDICTION_MODELS) - set(selected)
    ):
        raise Active8EnsembleContractError("active8_ensemble_selected_model_set_invalid")
    observation = (
        payload.get("observation_artifacts")
        if isinstance(payload.get("observation_artifacts"), dict)
        else {}
    )
    if set(observation) != set(ALPHA_PREDICTION_MODELS):
        raise Active8EnsembleContractError("active8_ensemble_observation_artifact_set_invalid")
    base = payload.get("base_artifacts") if isinstance(payload.get("base_artifacts"), dict) else {}
    if set(base) != set(selected):
        raise Active8EnsembleContractError("active8_ensemble_base_artifact_set_invalid")
    for model_name in excluded:
        index = list(ALPHA_PREDICTION_MODELS).index(model_name)
        if (
            abs(float(coefficients[index])) > 1e-12
            or abs(float(coefficients[index + len(ALPHA_PREDICTION_MODELS)])) > 1e-12
        ):
            raise Active8EnsembleContractError(
                f"active8_ensemble_excluded_model_has_weight:{model_name}"
            )
    for model_name in selected:
        expected = base[model_name]
        actual = pool_models.get(model_name)
        if not isinstance(expected, dict) or not isinstance(actual, dict):
            raise Active8EnsembleContractError(f"active8_ensemble_base_artifact_missing:{model_name}")
        identity = {
            "artifact_id": str(actual.get("serving_artifact_id") or ""),
            "version": str(actual.get("version") or ""),
            "checksum": str(actual.get("checksum") or "").lower(),
        }
        expected_identity = {
            "artifact_id": str(expected.get("artifact_id") or ""),
            "version": str(expected.get("version") or ""),
            "checksum": str(expected.get("checksum") or "").lower(),
        }
        if identity != expected_identity:
            raise Active8EnsembleContractError(f"active8_ensemble_base_artifact_mismatch:{model_name}")
        if actual.get("serving_eligible") is not True:
            raise Active8EnsembleContractError(f"active8_ensemble_base_artifact_not_serving:{model_name}")


def score_active8_ensemble(
    *,
    rank_scores: dict[str, float],
    artifact: dict[str, Any],
    pool_models: dict[str, dict[str, Any]],
    current_price: float,
) -> Active8EnsembleResult:
    validate_active8_ensemble_artifact(artifact, pool_models=pool_models)
    missing_core = [name for name in CORE_MODELS if name not in rank_scores]
    if missing_core:
        raise Active8EnsembleContractError(
            "active8_ensemble_core_score_missing:" + ",".join(missing_core)
        )
    vector: list[float] = []
    availability: dict[str, bool] = {}
    for model_name in ALPHA_PREDICTION_MODELS:
        available = model_name in rank_scores and np.isfinite(float(rank_scores.get(model_name, 0.5)))
        availability[model_name] = available
        vector.append(float(np.clip(rank_scores.get(model_name, 0.5), 0.0, 1.0)))
    vector.extend(1.0 if availability[name] else 0.0 for name in ALPHA_PREDICTION_MODELS)
    fit = artifact["fit"]
    expected_return = float(fit["intercept"] + np.dot(vector, fit["coefficients"]))
    policy = artifact["signal_policy"]
    calibration = artifact["calibration"]
    quantiles = calibration["absolute_residual_quantiles"]
    q_buy = float(quantiles[str(float(policy["buy_coverage"]))])
    q_strong = float(quantiles[str(float(policy["strong_coverage"]))])
    lower_buy, upper_buy = expected_return - q_buy, expected_return + q_buy
    lower_strong, upper_strong = expected_return - q_strong, expected_return + q_strong
    if lower_strong > 0.0:
        signal, direction = "STRONG_BUY", "up"
    elif lower_buy > 0.0:
        signal, direction = "BUY", "up"
    elif upper_strong < 0.0:
        signal, direction = "STRONG_SELL", "down"
    elif upper_buy < 0.0:
        signal, direction = "SELL", "down"
    else:
        signal, direction = "HOLD", "neutral"
    probability_up = _isotonic_predict(
        [float(value) for value in calibration["probability_x_thresholds"]],
        [float(value) for value in calibration["probability_y_thresholds"]],
        expected_return,
    )
    confidence = probability_up if direction == "up" else 1.0 - probability_up if direction == "down" else max(probability_up, 1.0 - probability_up)
    selected_models = list(artifact["selected_models"])
    available_scores = [float(rank_scores[name]) for name in selected_models if availability[name]]
    bullish = sum(value > 0.5 for value in available_scores)
    bearish = len(available_scores) - bullish
    consensus = (
        max(bullish, bearish) / len(available_scores)
        if available_scores
        else 0.0
    )
    strength = {"STRONG_BUY": 5, "BUY": 4, "HOLD": 0, "SELL": 4, "STRONG_SELL": 5}[signal]
    return Active8EnsembleResult(
        signal=signal,
        direction=direction,
        confidence=round(float(np.clip(confidence, 0.0, 1.0)), 6),
        consensus=round(consensus, 6),
        forecast_pct=round(expected_return, 8),
        forecast_range={
            "low": round(current_price * (1.0 + lower_strong), 4),
            "high": round(current_price * (1.0 + upper_strong), 4),
        },
        models=[{
            "name": name,
            "model_name": name,
            "rank_score": round(float(rank_scores.get(name, 0.5)), 6),
            "available": availability[name],
            "direction": "up" if float(rank_scores.get(name, 0.5)) > 0.5 else "down",
        } for name in ALPHA_PREDICTION_MODELS],
        entry_price=round(current_price, 4),
        stop_loss=None,
        target1=None,
        target2=None,
        reasoning=(
            f"Active8 OOF net return={expected_return:.4%}; "
            f"90% interval=[{lower_buy:.4%},{upper_buy:.4%}]; "
            f"95% interval=[{lower_strong:.4%},{upper_strong:.4%}]"
        ),
        signal_strength=strength,
        evidence={
            "schema_version": "active8-ensemble-runtime-evidence-v1",
            "artifact_checksum": artifact["payload_checksum"],
            "cohort_id": artifact["cohort_id"],
            "base_artifact_set_checksum": artifact["base_artifact_set_checksum"],
            "expected_net_return": expected_return,
            "probability_positive_net_return": probability_up,
            "availability": availability,
            "signal_policy": policy,
        },
    )