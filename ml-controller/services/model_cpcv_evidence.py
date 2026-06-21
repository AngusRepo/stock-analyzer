"""Model-level CPCV evidence for lifecycle promotion governance."""

from __future__ import annotations

import math
from statistics import mean, pstdev
from typing import Any

from services.model_validation_policy import resolve_model_validation_policy


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


def _finite_or_none(value: Any) -> float | None:
    parsed = _as_float(value, math.nan)
    return parsed if math.isfinite(parsed) else None


def _clamp_ratio(value: float) -> float:
    return max(0.0, min(1.0, value))


def _finite_ratio_values(rows: list[dict[str, Any]], key: str) -> list[float]:
    values: list[float] = []
    for row in rows:
        if key not in row:
            continue
        value = _as_float(row.get(key), math.nan)
        if math.isfinite(value):
            values.append(_clamp_ratio(value))
    return values


def _coverage_stats(rows: list[dict[str, Any]], policy: dict[str, Any]) -> dict[str, Any]:
    coverage_values = _finite_ratio_values(rows, "coverage")
    coverage_mean = mean(coverage_values) if coverage_values else 0.0
    stats: dict[str, Any] = {
        "coverage_mean": coverage_mean,
        "coverage_gate_value": coverage_mean,
        "coverage_gate_semantics": "coverage_mean",
    }

    for key, out_key in (
        ("fold_share", "fold_share_mean"),
        ("sampled_coverage", "sampled_coverage_mean"),
        ("dataset_coverage", "dataset_coverage_mean"),
        ("date_coverage", "date_coverage_mean"),
        ("symbol_coverage", "symbol_coverage_mean"),
        ("node_coverage", "node_coverage_mean"),
        ("edge_coverage", "edge_coverage_mean"),
    ):
        values = _finite_ratio_values(rows, key)
        if values:
            stats[out_key] = mean(values)

    coverage_mode = str(policy.get("coverage_mode") or "").strip().lower()
    if coverage_mode != "sequence_window":
        return stats

    explicit_gate_keys = (
        "coverage_gate_value",
        "sequence_window_coverage",
        "valid_series_coverage",
        "union_oos_coverage",
        "oos_coverage",
    )
    for key in explicit_gate_keys:
        values = _finite_ratio_values(rows, key)
        if values:
            stats["coverage_gate_value"] = max(values)
            stats["coverage_gate_semantics"] = key
            return stats

    sampled_values = _finite_ratio_values(rows, "sampled_coverage")
    if sampled_values:
        stats["coverage_gate_value"] = mean(sampled_values)
        stats["coverage_gate_semantics"] = "sampled_coverage_mean"
        return stats

    fold_share_values = _finite_ratio_values(rows, "fold_share")
    if fold_share_values:
        stats["coverage_gate_value"] = _clamp_ratio(sum(fold_share_values))
        stats["coverage_gate_semantics"] = "fold_share_sum_capped"
        return stats

    # Compatibility for legacy sequence artifacts that stored each fold's
    # OOS partition share in `coverage` instead of prediction completeness.
    min_coverage = _as_float(policy.get("min_coverage"), 0.0)
    min_folds = max(1, _as_int(policy.get("min_folds"), 1))
    coverage_sum = sum(coverage_values)
    if (
        len(coverage_values) >= min_folds
        and coverage_mean < min_coverage
        and min_coverage <= coverage_sum <= 1.05
    ):
        stats["coverage_gate_value"] = _clamp_ratio(coverage_sum)
        stats["coverage_gate_semantics"] = "legacy_coverage_fold_share_sum_capped"
        return stats

    return stats


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


def _policy(
    policy: dict[str, Any] | None,
    *,
    model: str,
    family: str | None,
    regime: Any,
    stage: str,
    sample_count: int,
    fold_count: int,
    search_trials: int | None,
    coverage_mode: str | None,
    baseline_oos_ic: Any,
    champion_oos_ic: Any,
) -> dict[str, Any]:
    bundle = resolve_model_validation_policy(
        model_name=model,
        family=family,
        regime=regime,
        stage=stage,
        sample_count=sample_count,
        fold_count=fold_count,
        search_trials=search_trials,
        coverage_mode=coverage_mode,
        baseline_oos_ic=baseline_oos_ic,
        champion_oos_ic=champion_oos_ic,
        overrides={"cpcv": policy} if policy else None,
    )
    cpcv = dict(bundle["cpcv"])
    cpcv["policy_version"] = bundle["policy_version"]
    cpcv["policy_source"] = bundle["source"]
    return cpcv


def _foundation_forecast_policy(policy: dict[str, Any] | None) -> dict[str, Any]:
    bundle = resolve_model_validation_policy(
        model_name="TimesFM",
        family="foundation_sequence",
        stage="forecast_validation",
        overrides={"coverage": {"min_coverage": policy.get("min_coverage")}} if isinstance(policy, dict) and "min_coverage" in policy else None,
    )
    merged = {
        "min_samples": 30,
        "min_rank_ic": bundle["oos_ic"]["min_oos_ic_mean"],
        "min_direction_accuracy": 0.52,
        "min_coverage": bundle["coverage"]["min_coverage"],
        "max_abs_bias": 0.05,
        "policy_version": bundle["policy_version"],
        "policy_source": bundle["source"],
    }
    merged.update(policy or {})
    return merged


def build_model_cpcv_evidence(
    *,
    model: str,
    fold_metrics: list[dict[str, Any]],
    policy: dict[str, Any] | None = None,
    family: str | None = None,
    regime: Any = None,
    stage: str = "lifecycle",
    search_trials: int | None = None,
    coverage_mode: str | None = None,
    baseline_oos_ic: Any = None,
    champion_oos_ic: Any = None,
) -> dict[str, Any]:
    """Aggregate CPCV fold metrics into a lifecycle promotion packet.

    Expected fold fields are intentionally generic so tree, TabM, DLinear,
    PatchTST, iTransformer, and TimesFM adapters can all emit the same contract:
    `oos_ic` or `rank_ic`, `test_rows`, and optional `coverage`.
    """

    rows = []
    for fold in fold_metrics or []:
        ic = _as_float(fold.get("oos_ic", fold.get("rank_ic")), math.nan)
        test_rows = _as_int(fold.get("test_rows"), 0)
        coverage = _as_float(fold.get("coverage"), 1.0 if test_rows > 0 else 0.0)
        if math.isfinite(ic):
            normalized = {
                "fold_id": fold.get("fold_id"),
                "oos_ic": ic,
                "test_rows": test_rows,
                "coverage": coverage,
            }
            for key in (
                "sampled_coverage",
                "dataset_coverage",
                "fold_share",
                "direction_accuracy",
                "node_coverage",
                "edge_coverage",
                "date_coverage",
                "symbol_coverage",
                "coverage_gate_value",
                "sequence_window_coverage",
                "valid_series_coverage",
                "union_oos_coverage",
                "oos_coverage",
            ):
                if key in fold:
                    normalized[key] = fold.get(key)
            rows.append(normalized)

    ic_values = [row["oos_ic"] for row in rows]
    folds = len(rows)
    sample_count = sum(int(row.get("test_rows") or 0) for row in rows)
    p = _policy(
        policy,
        model=model,
        family=family,
        regime=regime,
        stage=stage,
        sample_count=sample_count,
        fold_count=folds,
        search_trials=search_trials,
        coverage_mode=coverage_mode,
        baseline_oos_ic=baseline_oos_ic,
        champion_oos_ic=champion_oos_ic,
    )
    ic_mean = mean(ic_values) if ic_values else 0.0
    ic_std = pstdev(ic_values) if len(ic_values) > 1 else 0.0
    positive_ratio = (
        sum(1 for value in ic_values if value > 0.0) / folds
        if folds
        else 0.0
    )
    min_test_rows = min((row["test_rows"] for row in rows), default=0)
    coverage = _coverage_stats(rows, p)
    coverage_mean = _as_float(coverage.get("coverage_mean"))
    coverage_gate_value = _as_float(coverage.get("coverage_gate_value"))

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
    if coverage_gate_value < _as_float(p["min_coverage"]):
        failed_gates.append("cpcv_coverage")

    decision = "PASS" if not failed_gates else "FAIL"
    evidence = {
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
        "coverage_gate_value": round(coverage_gate_value, 6),
        "coverage_gate_semantics": coverage.get("coverage_gate_semantics"),
        "family": p.get("family"),
        "regime": p.get("regime"),
        "stage": stage,
        "policy_version": p.get("policy_version"),
        "policy_source": p.get("policy_source"),
        "policy": p,
        "fold_metrics": rows,
    }
    for key, value in coverage.items():
        if key in evidence or value is None:
            continue
        evidence[key] = round(value, 6) if isinstance(value, float) else value
    return evidence


def build_foundation_forecast_validation_evidence(
    *,
    model: str = "TimesFM",
    predictions: list[dict[str, Any]],
    realized_returns: dict[str, Any] | list[dict[str, Any]],
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    p = _foundation_forecast_policy(policy)
    rows: list[dict[str, Any]] = []
    missing_outcomes: list[str] = []
    valid_predictions = 0

    def _row_key(row: dict[str, Any]) -> str:
        prediction_id = str(row.get("prediction_id") or row.get("id") or "").strip()
        if prediction_id:
            return f"id:{prediction_id}"
        symbol = str(row.get("symbol") or "").strip()
        prediction_date = str(row.get("prediction_date") or row.get("date") or "").strip()
        if symbol and prediction_date:
            return f"{symbol}|{prediction_date}"
        return symbol

    def _realized_for(prediction: dict[str, Any]) -> float | None:
        symbol = str(prediction.get("symbol") or "").strip()
        key = _row_key(prediction)
        if isinstance(realized_returns, dict):
            value = realized_returns.get(key)
            if value is None:
                value = realized_returns.get(symbol)
            if isinstance(value, dict):
                value = value.get("forward_return", value.get("realized_return"))
            parsed = _as_float(value, math.nan)
            return parsed if math.isfinite(parsed) else None
        for row in realized_returns or []:
            row_symbol = str(row.get("symbol") or "").strip()
            if _row_key(row) != key and row_symbol != symbol:
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
        realized = _realized_for(pred)
        if realized is None:
            missing_outcomes.append(symbol)
            continue
        predicted_direction = 1 if forecast_pct > 0 else -1 if forecast_pct < 0 else 0
        realized_direction = 1 if realized > 0 else -1 if realized < 0 else 0
        rows.append({
            "symbol": symbol,
            "prediction_date": pred.get("prediction_date"),
            "forecast_pct_source": pred.get("forecast_pct_source"),
            "forecast_pct": round(forecast_pct, 6),
            "realized_return": round(realized, 6),
            "direction_hit": bool(
                predicted_direction != 0
                and realized_direction != 0
                and predicted_direction == realized_direction
            ),
            "up_prob": _finite_or_none(pred.get("up_prob")),
            "confidence": _finite_or_none(pred.get("confidence")),
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
        failed_gates.append("foundation_outcome_missing")
    if samples < _as_int(p["min_samples"]):
        failed_gates.append("foundation_min_samples")
    if coverage < _as_float(p["min_coverage"]):
        failed_gates.append("foundation_coverage")
    if rank_ic < _as_float(p["min_rank_ic"]):
        failed_gates.append("foundation_rank_ic")
    if direction_accuracy < _as_float(p["min_direction_accuracy"]):
        failed_gates.append("foundation_direction_accuracy")
    if abs(bias) > _as_float(p["max_abs_bias"]):
        failed_gates.append("foundation_forecast_bias")

    decision = "PASS" if not failed_gates else "FAIL"
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "family": "foundation_time_series",
        "forecast_family": "foundation_time_series",
        "method": "foundation_forecast_rank_ic",
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
        "reason": f"{model} is validated by forecast/outcome evidence; retrain-style CPCV is not the default owner.",
    }
