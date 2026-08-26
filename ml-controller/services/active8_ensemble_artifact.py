"""Pure Active-8 OOF ensemble training and validation.

All model parameters come from label-resolved chronological OOF rows.  The
calibration slice precedes the validation slice; validation never selects or
fits the final parameters.  Full-fit parameters are emitted only after the
held-out chronological validation passes.
"""
from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_right
from collections import defaultdict
from typing import Any

import numpy as np

from services.active8_oof_stacker import (
    ACTIVE8_MODELS,
    MIN_STACKER_TRAIN_DATES,
    MIN_STACKER_TRAIN_ROWS,
    STACKER_FEATURE_NAMES,
    STACKER_SEMANTIC_VERSION,
    _fit_ridge,
    _select_regularization,
    _spearman,
    build_chronological_oof_stack,
)

ARTIFACT_SCHEMA_VERSION = "active8-oof-ensemble-serving-artifact-v1"
CALIBRATION_SCHEMA_VERSION = "active8-chronological-conformal-isotonic-v1"
SIGNAL_POLICY_VERSION = "active8-net-return-conformal-signal-policy-v1"
BUY_COVERAGE = 0.90
STRONG_COVERAGE = 0.95
MIN_VALIDATION_DATES = 5
MIN_VALIDATION_ROWS = 200


class Active8EnsembleValidationError(ValueError):
    """Terminal evidence rejection with machine-readable validation truth."""

    def __init__(self, validation: dict[str, Any]):
        self.validation = dict(validation)
        failed = ",".join(str(item) for item in validation.get("failed_gates") or [])
        super().__init__("active8_ensemble_validation_failed:" + failed)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def payload_checksum(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def finite_sample_quantile(values: np.ndarray, coverage: float) -> float:
    ordered = np.sort(np.asarray(values, dtype=float).reshape(-1))
    if len(ordered) == 0 or not 0.0 < coverage < 1.0:
        raise ValueError("active8_ensemble_conformal_contract_invalid")
    rank = min(len(ordered), max(1, math.ceil((len(ordered) + 1) * coverage)))
    return float(ordered[rank - 1])


def _fit_isotonic(prediction: np.ndarray, target: np.ndarray) -> tuple[list[float], list[float]]:
    from sklearn.isotonic import IsotonicRegression

    x = np.asarray(prediction, dtype=float).reshape(-1)
    y = (np.asarray(target, dtype=float).reshape(-1) > 0.0).astype(float)
    if len(x) < MIN_VALIDATION_ROWS or len(np.unique(x)) < 2:
        raise ValueError("active8_ensemble_probability_calibration_insufficient")
    model = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    model.fit(x, y)
    return model.X_thresholds_.astype(float).tolist(), model.y_thresholds_.astype(float).tolist()


def isotonic_predict(x_thresholds: list[float], y_thresholds: list[float], value: float) -> float:
    if len(x_thresholds) != len(y_thresholds) or not x_thresholds:
        raise ValueError("active8_ensemble_probability_thresholds_invalid")
    if value <= x_thresholds[0]:
        return float(y_thresholds[0])
    if value >= x_thresholds[-1]:
        return float(y_thresholds[-1])
    right = bisect_right(x_thresholds, value)
    left = right - 1
    span = x_thresholds[right] - x_thresholds[left]
    ratio = 1.0 if span <= 0.0 else (value - x_thresholds[left]) / span
    return float(y_thresholds[left] + ratio * (y_thresholds[right] - y_thresholds[left]))


def _daily_spread(rows: list[dict[str, Any]]) -> tuple[float, int]:
    grouped: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    for row in rows:
        grouped[(row["prediction_date"], row["market_segment"])].append(
            (float(row["ensemble_raw"]), float(row["target_return"]))
        )
    daily: dict[str, list[float]] = defaultdict(list)
    for (prediction_date, _market), values in grouped.items():
        values.sort(key=lambda item: item[0])
        count = max(1, math.ceil(len(values) * 0.20))
        if len(values) < count * 2:
            continue
        daily[prediction_date].append(
            sum(target for _score, target in values[-count:]) / count
            - sum(target for _score, target in values[:count]) / count
        )
    spreads = [sum(values) / len(values) for values in daily.values() if values]
    return (float(np.mean(spreads)) if spreads else 0.0, len(spreads))


def _base_identity(base_artifacts: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], str]:
    if set(base_artifacts) != set(ACTIVE8_MODELS):
        raise ValueError("active8_ensemble_base_artifact_set_incomplete")
    normalized: dict[str, Any] = {}
    for model_name in ACTIVE8_MODELS:
        row = base_artifacts[model_name]
        identity = {
            "artifact_id": str(row.get("artifact_id") or "").strip(),
            "version": str(row.get("version") or "").strip(),
            "checksum": str(row.get("checksum") or "").strip().lower(),
            "candidate_type": str(row.get("candidate_type") or "").strip(),
        }
        if (
            not identity["artifact_id"]
            or not identity["version"]
            or not identity["checksum"].startswith("sha256:")
            or len(identity["checksum"].removeprefix("sha256:")) != 64
            or identity["candidate_type"] != "oof_full_fit_release"
        ):
            raise ValueError(f"active8_ensemble_base_artifact_identity_invalid:{model_name}")
        normalized[model_name] = identity
    return normalized, hashlib.sha256(canonical_json(normalized).encode("utf-8")).hexdigest()


def build_active8_ensemble_artifact(
    prediction_rows: list[dict[str, Any]],
    *,
    base_artifacts: dict[str, dict[str, Any]],
    cohort_id: str,
    source_manifest_checksum: str,
    knowledge_cutoff_date: str,
) -> dict[str, Any]:
    if len(source_manifest_checksum) != 64 or len(knowledge_cutoff_date) != 10 or not cohort_id:
        raise ValueError("active8_ensemble_lineage_identity_invalid")
    stack_rows, stack_evidence = build_chronological_oof_stack(prediction_rows)
    resolved = [
        row for row in stack_rows
        if str(row.get("label_known_date") or "")[:10] <= knowledge_cutoff_date
        and len(row.get("stacker_features") or []) == len(STACKER_FEATURE_NAMES)
    ]
    dates = sorted({row["prediction_date"] for row in resolved})
    folds = sorted({row["fold_id"] for row in resolved})
    if len(resolved) < MIN_STACKER_TRAIN_ROWS or len(dates) < MIN_STACKER_TRAIN_DATES:
        raise ValueError("active8_ensemble_full_fit_evidence_insufficient")
    if len(folds) < 5:
        raise ValueError("active8_ensemble_outer_folds_insufficient")

    honest = [row for row in resolved if row.get("eligible_for_efficacy") is True]
    honest_dates = sorted({row["prediction_date"] for row in honest})
    if len(honest) < MIN_VALIDATION_ROWS * 2 or len(honest_dates) < 10:
        raise ValueError("active8_ensemble_chronological_oof_evidence_insufficient")
    split_index = max(MIN_STACKER_TRAIN_DATES, math.floor(len(honest_dates) * 0.60))
    calibration_dates = set(honest_dates[:split_index])
    validation_dates = set(honest_dates[split_index:])
    calibration_rows = [row for row in honest if row["prediction_date"] in calibration_dates]
    validation_rows = [row for row in honest if row["prediction_date"] in validation_dates]
    if len(calibration_rows) < MIN_VALIDATION_ROWS or len(validation_rows) < MIN_VALIDATION_ROWS:
        raise ValueError("active8_ensemble_chronological_split_rows_insufficient")
    if len(validation_dates) < MIN_VALIDATION_DATES:
        raise ValueError("active8_ensemble_chronological_validation_dates_insufficient")

    cal_prediction = np.asarray([row["ensemble_raw"] for row in calibration_rows], dtype=float)
    cal_target = np.asarray([row["target_return"] for row in calibration_rows], dtype=float)
    residual = np.abs(cal_target - cal_prediction)
    q_buy = finite_sample_quantile(residual, BUY_COVERAGE)
    q_strong = finite_sample_quantile(residual, STRONG_COVERAGE)
    iso_x, iso_y = _fit_isotonic(cal_prediction, cal_target)

    val_prediction = np.asarray([row["ensemble_raw"] for row in validation_rows], dtype=float)
    val_target = np.asarray([row["target_return"] for row in validation_rows], dtype=float)
    probability = np.asarray([isotonic_predict(iso_x, iso_y, value) for value in val_prediction])
    spread, spread_dates = _daily_spread(validation_rows)
    buy_mask = val_prediction - q_buy > 0.0
    sell_mask = val_prediction + q_buy < 0.0
    directional = np.concatenate([val_target[buy_mask], -val_target[sell_mask]])
    directional_mean = float(np.mean(directional)) if len(directional) else None
    validation = {
        "schema_version": "active8-oof-ensemble-validation-v1",
        "method": "chronological_oof_calibration_then_later_validation",
        "calibration_dates": len(calibration_dates),
        "calibration_rows": len(calibration_rows),
        "validation_dates": len(validation_dates),
        "validation_rows": len(validation_rows),
        "rank_ic": _spearman(val_prediction, val_target),
        "top_bottom_net_return_spread": spread,
        "spread_dates": spread_dates,
        "buy_interval_empirical_coverage": float(np.mean(np.abs(val_target - val_prediction) <= q_buy)),
        "strong_interval_empirical_coverage": float(np.mean(np.abs(val_target - val_prediction) <= q_strong)),
        "probability_brier": float(np.mean((probability - (val_target > 0.0).astype(float)) ** 2)),
        "directional_signal_rows": int(len(directional)),
        "directional_signal_net_mean": directional_mean,
        "failed_gates": [],
    }
    if validation["rank_ic"] <= 0.0:
        validation["failed_gates"].append("chronological_validation_rank_ic_non_positive")
    if spread <= 0.0 or spread_dates < MIN_VALIDATION_DATES:
        validation["failed_gates"].append("chronological_validation_spread_non_positive")
    if validation["buy_interval_empirical_coverage"] < BUY_COVERAGE - 0.05:
        validation["failed_gates"].append("buy_conformal_coverage_below_policy")
    if validation["strong_interval_empirical_coverage"] < STRONG_COVERAGE - 0.05:
        validation["failed_gates"].append("strong_conformal_coverage_below_policy")
    if directional_mean is not None and directional_mean <= 0.0:
        validation["failed_gates"].append("directional_signal_net_mean_non_positive")
    validation["decision"] = "PASS" if not validation["failed_gates"] else "FAIL"
    if validation["decision"] != "PASS":
        raise Active8EnsembleValidationError(validation)

    x = np.asarray([row["stacker_features"] for row in resolved], dtype=float)
    y = np.asarray([row["target_return"] for row in resolved], dtype=float)
    fit_dates = np.asarray([row["prediction_date"] for row in resolved], dtype=object)
    regularization = _select_regularization(x, y, fit_dates)
    coefficients, intercept = _fit_ridge(x, y, regularization)
    all_prediction = np.asarray([row["ensemble_raw"] for row in honest], dtype=float)
    all_target = np.asarray([row["target_return"] for row in honest], dtype=float)
    all_residual = np.abs(all_target - all_prediction)
    all_iso_x, all_iso_y = _fit_isotonic(all_prediction, all_target)
    base_identity, base_checksum = _base_identity(base_artifacts)
    payload = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "ensemble_semantic_version": STACKER_SEMANTIC_VERSION,
        "calibration_schema_version": CALIBRATION_SCHEMA_VERSION,
        "signal_policy": {
            "schema_version": SIGNAL_POLICY_VERSION,
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
            "net_return_zero_boundary": 0.0,
            "buy_coverage": BUY_COVERAGE,
            "strong_coverage": STRONG_COVERAGE,
            "buy_rule": "conformal_lower_bound_gt_zero",
            "sell_rule": "conformal_upper_bound_lt_zero",
            "top_k": None,
        },
        "cohort_id": cohort_id,
        "source_manifest_checksum": source_manifest_checksum,
        "knowledge_cutoff_date": knowledge_cutoff_date,
        "base_artifacts": base_identity,
        "base_artifact_set_checksum": base_checksum,
        "feature_names": list(STACKER_FEATURE_NAMES),
        "model_order": list(ACTIVE8_MODELS),
        "fit": {
            "method": "ridge_full_fit_after_heldout_chronological_oof_validation",
            "regularization": regularization,
            "intercept": float(intercept),
            "coefficients": coefficients.astype(float).tolist(),
            "train_rows": len(resolved),
            "train_dates": len(dates),
            "outer_folds": len(folds),
        },
        "calibration": {
            "absolute_residual_quantiles": {
                str(BUY_COVERAGE): finite_sample_quantile(all_residual, BUY_COVERAGE),
                str(STRONG_COVERAGE): finite_sample_quantile(all_residual, STRONG_COVERAGE),
            },
            "probability_x_thresholds": all_iso_x,
            "probability_y_thresholds": all_iso_y,
            "oof_rows": len(honest),
            "oof_dates": len(honest_dates),
        },
        "validation": validation,
        "stacker_evidence": {
            "schema_version": stack_evidence.get("schema_version"),
            "efficacy_rows": stack_evidence.get("efficacy_rows"),
            "eligible_candidate_coverage": stack_evidence.get("eligible_candidate_coverage"),
            "missing_by_model": stack_evidence.get("missing_by_model"),
        },
    }
    payload["payload_checksum"] = payload_checksum(payload)
    return payload