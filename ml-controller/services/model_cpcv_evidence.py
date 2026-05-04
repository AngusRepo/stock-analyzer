"""Model-level CPCV evidence for lifecycle promotion governance."""

from __future__ import annotations

import math
from statistics import mean, pstdev
from typing import Any


MODEL_CPCV_EVIDENCE_SCHEMA_VERSION = "model-cpcv-evidence-v1"


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


def _rank(values: list[float]) -> list[float]:
    indexed = sorted(enumerate(values), key=lambda item: item[1])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(indexed):
        j = i
        while j + 1 < len(indexed) and indexed[j + 1][1] == indexed[i][1]:
            j += 1
        rank = (i + j + 2) / 2.0
        for k in range(i, j + 1):
            ranks[indexed[k][0]] = rank
        i = j + 1
    return ranks


def _spearman(predicted: list[float], actual: list[float]) -> float:
    if len(predicted) < 2 or len(predicted) != len(actual):
        return 0.0
    rx = _rank(predicted)
    ry = _rank(actual)
    mx = mean(rx)
    my = mean(ry)
    num = sum((x - mx) * (y - my) for x, y in zip(rx, ry))
    den_x = math.sqrt(sum((x - mx) ** 2 for x in rx))
    den_y = math.sqrt(sum((y - my) ** 2 for y in ry))
    den = den_x * den_y
    return num / den if den > 0 else 0.0


def _policy(policy: dict[str, Any] | None) -> dict[str, Any]:
    merged = {
        "min_folds": 5,
        "min_test_rows": 100,
        "min_oos_ic_mean": 0.0,
        "min_positive_fold_ratio": 0.55,
        "max_oos_ic_std": 0.20,
        "min_coverage": 0.60,
    }
    merged.update(policy or {})
    return merged


def _chronos_policy(policy: dict[str, Any] | None) -> dict[str, Any]:
    merged = {
        "min_samples": 30,
        "min_rank_ic": 0.0,
        "min_direction_accuracy": 0.52,
        "min_coverage": 0.60,
        "max_abs_bias": 0.05,
    }
    merged.update(policy or {})
    return merged


def build_model_cpcv_evidence(
    *,
    model: str,
    fold_metrics: list[dict[str, Any]],
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Aggregate CPCV fold metrics into a lifecycle promotion packet.

    Expected fold fields are intentionally generic so tree, FT, DLinear,
    PatchTST, and Chronos adapters can all emit the same contract:
    `oos_ic` or `rank_ic`, `test_rows`, and optional `coverage`.
    """

    p = _policy(policy)
    rows = []
    for fold in fold_metrics or []:
        ic = _as_float(fold.get("oos_ic", fold.get("rank_ic")), math.nan)
        test_rows = _as_int(fold.get("test_rows"), 0)
        coverage = _as_float(fold.get("coverage"), 1.0 if test_rows > 0 else 0.0)
        if math.isfinite(ic):
            rows.append(
                {
                    "fold_id": fold.get("fold_id"),
                    "oos_ic": ic,
                    "test_rows": test_rows,
                    "coverage": coverage,
                }
            )

    ic_values = [row["oos_ic"] for row in rows]
    coverage_values = [row["coverage"] for row in rows]
    folds = len(rows)
    ic_mean = mean(ic_values) if ic_values else 0.0
    ic_std = pstdev(ic_values) if len(ic_values) > 1 else 0.0
    positive_ratio = (
        sum(1 for value in ic_values if value > 0.0) / folds
        if folds
        else 0.0
    )
    min_test_rows = min((row["test_rows"] for row in rows), default=0)
    coverage_mean = mean(coverage_values) if coverage_values else 0.0

    failed_gates: list[str] = []
    if folds < _as_int(p["min_folds"]):
        failed_gates.append("cpcv_fold_count")
    if min_test_rows < _as_int(p["min_test_rows"]):
        failed_gates.append("cpcv_test_rows")
    if ic_mean < _as_float(p["min_oos_ic_mean"]):
        failed_gates.append("cpcv_oos_ic")
    if positive_ratio < _as_float(p["min_positive_fold_ratio"]):
        failed_gates.append("cpcv_positive_fold_ratio")
    if ic_std > _as_float(p["max_oos_ic_std"]):
        failed_gates.append("cpcv_ic_instability")
    if coverage_mean < _as_float(p["min_coverage"]):
        failed_gates.append("cpcv_coverage")

    decision = "PASS" if not failed_gates else "FAIL"
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "method": "purged_cpcv_rank_ic",
        "decision": decision,
        "passed": decision == "PASS",
        "failed_gates": failed_gates,
        "folds": folds,
        "oos_ic_mean": round(ic_mean, 6),
        "oos_ic_std": round(ic_std, 6),
        "positive_fold_ratio": round(positive_ratio, 6),
        "min_test_rows": min_test_rows,
        "coverage_mean": round(coverage_mean, 6),
        "policy": p,
        "fold_metrics": rows,
    }


def build_chronos_forecast_validation_evidence(
    *,
    predictions: list[dict[str, Any]],
    realized_returns: dict[str, Any] | list[dict[str, Any]],
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    p = _chronos_policy(policy)
    rows: list[dict[str, Any]] = []
    missing_outcomes: list[str] = []
    valid_predictions = 0

    def _realized_for(symbol: str) -> float | None:
        if isinstance(realized_returns, dict):
            value = realized_returns.get(symbol)
            if isinstance(value, dict):
                value = value.get("forward_return", value.get("realized_return"))
            parsed = _as_float(value, math.nan)
            return parsed if math.isfinite(parsed) else None
        for row in realized_returns or []:
            if str(row.get("symbol") or "") != symbol:
                continue
            parsed = _as_float(row.get("forward_return", row.get("realized_return")), math.nan)
            return parsed if math.isfinite(parsed) else None
        return None

    for pred in predictions or []:
        symbol = str(pred.get("symbol") or "").strip()
        forecast_pct = _as_float(pred.get("forecast_pct"), math.nan)
        if not symbol or not math.isfinite(forecast_pct) or pred.get("error"):
            continue
        valid_predictions += 1
        realized = _realized_for(symbol)
        if realized is None:
            missing_outcomes.append(symbol)
            continue
        predicted_direction = 1 if forecast_pct > 0 else -1 if forecast_pct < 0 else 0
        realized_direction = 1 if realized > 0 else -1 if realized < 0 else 0
        rows.append({
            "symbol": symbol,
            "forecast_pct": round(forecast_pct, 6),
            "realized_return": round(realized, 6),
            "direction_hit": bool(
                predicted_direction != 0
                and realized_direction != 0
                and predicted_direction == realized_direction
            ),
            "up_prob": _as_float(pred.get("up_prob"), math.nan),
            "confidence": _as_float(pred.get("confidence"), math.nan),
        })

    samples = len(rows)
    coverage = samples / valid_predictions if valid_predictions else 0.0
    rank_ic = _spearman(
        [row["forecast_pct"] for row in rows],
        [row["realized_return"] for row in rows],
    ) if samples else 0.0
    direction_accuracy = sum(1 for row in rows if row["direction_hit"]) / samples if samples else 0.0
    bias = mean([row["forecast_pct"] - row["realized_return"] for row in rows]) if samples else 0.0

    failed_gates: list[str] = []
    if missing_outcomes:
        failed_gates.append("chronos_outcome_missing")
    if samples < _as_int(p["min_samples"]):
        failed_gates.append("chronos_min_samples")
    if coverage < _as_float(p["min_coverage"]):
        failed_gates.append("chronos_coverage")
    if rank_ic < _as_float(p["min_rank_ic"]):
        failed_gates.append("chronos_rank_ic")
    if direction_accuracy < _as_float(p["min_direction_accuracy"]):
        failed_gates.append("chronos_direction_accuracy")
    if abs(bias) > _as_float(p["max_abs_bias"]):
        failed_gates.append("chronos_forecast_bias")

    decision = "PASS" if not failed_gates else "FAIL"
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": "Chronos",
        "family": "foundation_time_series",
        "forecast_family": "foundation_time_series",
        "method": "chronos_forecast_rank_ic",
        "decision": decision,
        "passed": decision == "PASS",
        "failed_gates": failed_gates,
        "folds": 1 if samples else 0,
        "samples": samples,
        "oos_ic_mean": round(rank_ic, 6),
        "oos_ic_std": 0.0,
        "positive_fold_ratio": 1.0 if rank_ic > 0 else 0.0,
        "min_test_rows": samples,
        "coverage_mean": round(coverage, 6),
        "direction_accuracy": round(direction_accuracy, 6),
        "forecast_bias": round(bias, 6),
        "valid_predictions": valid_predictions,
        "missing_outcome_symbols": missing_outcomes[:50],
        "policy": p,
        "fold_metrics": [{
            "fold_id": "forecast_validation",
            "oos_ic": round(rank_ic, 6),
            "test_rows": samples,
            "coverage": round(coverage, 6),
        }] if samples else [],
        "sample_rows": rows[:100],
        "retrain_required": False,
        "reason": "Chronos is validated by forecast/outcome evidence; retrain-style CPCV is not the default owner.",
    }
