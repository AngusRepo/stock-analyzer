"""Existing date-cluster tail guard shared by the two packaged services.

Keep the packaged copies byte-identical (enforced by the parity test).
No new thresholds: numerical defaults and HAC calculation are extracted unchanged.
"""
from __future__ import annotations

import math
from statistics import NormalDist, mean
from typing import Any

import numpy as np

def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "y", "on"}


def _newey_west_mean_uncertainty(
    values: list[float],
    *,
    confidence_level: float,
) -> dict[str, Any]:
    array = np.asarray([value for value in values if math.isfinite(value)], dtype=float)
    count = int(len(array))
    if not count:
        return {
            "mean": 0.0,
            "standard_error": math.inf,
            "lower_confidence_bound": -math.inf,
            "upper_confidence_bound": math.inf,
            "hac_lags": 0,
        }
    point = float(np.mean(array))
    if count == 1:
        standard_error = math.inf
        lags = 0
    else:
        centered = array - point
        lags = min(count - 1, max(0, int(4 * (count / 100.0) ** (2.0 / 9.0))))
        long_run_variance = float(np.dot(centered, centered) / count)
        for lag in range(1, lags + 1):
            covariance = float(np.dot(centered[lag:], centered[:-lag]) / count)
            long_run_variance += 2.0 * (1.0 - lag / (lags + 1.0)) * covariance
        standard_error = math.sqrt(max(0.0, long_run_variance) / count)
    confidence = max(0.50, min(0.999, float(confidence_level)))
    critical = NormalDist().inv_cdf(confidence)
    margin = critical * standard_error
    return {
        "mean": point,
        "standard_error": standard_error,
        "lower_confidence_bound": point - margin,
        "upper_confidence_bound": point + margin,
        "hac_lags": lags,
    }


def _tail_date_cluster_values(rows: list[dict[str, Any]]) -> list[float]:
    by_date: dict[str, list[float]] = {}
    for row in rows:
        clusters = row.get("date_cluster_ics")
        if not isinstance(clusters, list):
            continue
        for item in clusters:
            if not isinstance(item, dict):
                continue
            cluster_date = str(item.get("date") or "").strip()
            value = _as_float(item.get("rank_ic", item.get("ic")), math.nan)
            if cluster_date and math.isfinite(value):
                by_date.setdefault(cluster_date, []).append(value)
    return [mean(by_date[cluster_date]) for cluster_date in sorted(by_date)]


def _tail_fold_stats(rows: list[dict[str, Any]], guard: dict[str, Any]) -> dict[str, Any]:
    tail_folds = max(1, _as_int(guard.get("tail_folds"), 3))
    tail_rows = rows[-tail_folds:]
    fold_values = [_as_float(row.get("oos_ic"), math.nan) for row in tail_rows]
    fold_values = [value for value in fold_values if math.isfinite(value)]
    positive_ratio = sum(1 for value in fold_values if value > 0.0) / len(fold_values) if fold_values else 0.0
    date_cluster_values = _tail_date_cluster_values(tail_rows)
    uncertainty_values = date_cluster_values or fold_values
    uncertainty = _newey_west_mean_uncertainty(
        uncertainty_values,
        confidence_level=_as_float(guard.get("confidence_level"), 0.90),
    )
    return {
        "tail_folds": tail_folds,
        "observed_tail_folds": len(fold_values),
        "tail_oos_ic_mean": round(mean(fold_values), 6) if fold_values else 0.0,
        "tail_positive_fold_ratio": round(positive_ratio, 6),
        "uncertainty_source": "date_cluster_rank_ic" if date_cluster_values else "fold_rank_ic_fallback",
        "date_cluster_count": len(date_cluster_values),
        "uncertainty_mean": round(float(uncertainty["mean"]), 6),
        "hac_standard_error": round(float(uncertainty["standard_error"]), 6) if math.isfinite(uncertainty["standard_error"]) else None,
        "lower_confidence_bound": round(float(uncertainty["lower_confidence_bound"]), 6) if math.isfinite(uncertainty["lower_confidence_bound"]) else None,
        "upper_confidence_bound": round(float(uncertainty["upper_confidence_bound"]), 6) if math.isfinite(uncertainty["upper_confidence_bound"]) else None,
        "confidence_level": _as_float(guard.get("confidence_level"), 0.90),
        "hac_lags": int(uncertainty["hac_lags"]),
    }


def evaluate_tail_fold_guard(
    rows: list[dict[str, Any]], tail_guard: dict[str, Any], *, stage: str,
) -> tuple[dict[str, Any] | None, list[str], list[str]]:
    failed_gates: list[str] = []
    warning_gates: list[str] = []
    tail_stats: dict[str, Any] | None = None
    if _as_bool(tail_guard.get("enabled")) and rows:
        tail_stats = _tail_fold_stats(rows, tail_guard)
        required = stage == "promotion" and _as_bool(tail_guard.get("required_for_serving_promotion"))
        minimum_clusters = max(1, _as_int(tail_guard.get("min_date_clusters"), 10))
        ic_floor = _as_float(tail_guard.get("min_tail_oos_ic_mean"), 0.0)
        if tail_stats["observed_tail_folds"] < _as_int(tail_guard.get("tail_folds"), 3):
            (failed_gates if required else warning_gates).append("cpcv_tail_fold_count")
        if tail_stats["date_cluster_count"] < minimum_clusters:
            (failed_gates if required else warning_gates).append("cpcv_tail_uncertainty_evidence")
        else:
            upper_bound = tail_stats.get("upper_confidence_bound")
            if upper_bound is not None and float(upper_bound) < ic_floor:
                (failed_gates if required else warning_gates).append("cpcv_tail_oos_ic")
            elif tail_stats["uncertainty_mean"] < ic_floor:
                warning_gates.append("cpcv_tail_oos_ic_uncertain")
        if tail_stats["tail_positive_fold_ratio"] < _as_float(tail_guard.get("min_tail_positive_fold_ratio"), 0.50):
            warning_gates.append("cpcv_tail_positive_fold_ratio")

    return tail_stats, failed_gates, warning_gates
