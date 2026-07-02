"""Model-level validation evidence for Modal training flows."""

from __future__ import annotations

import math
from statistics import mean, pstdev
from typing import Any, Callable

import numpy as np
from scipy.stats import spearmanr

from .model_validation_policy import resolve_model_validation_policy
from .purged_cv import CombinatorialPurgedCV


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


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "y", "on"}


def _normal_segment(value: Any) -> str:
    text = str(value or "").strip().upper()
    if text in {"TSE", "TWSE", "LISTED"}:
        return "LISTED"
    if text in {"OTC", "TPEx".upper(), "TPEX"}:
        return "OTC"
    return text


def _segment_ic_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    buckets: dict[str, list[float]] = {}
    counts: dict[str, int] = {}

    def add(segment: Any, ic_value: Any, test_rows: Any = None) -> None:
        key = _normal_segment(segment)
        ic = _as_float(ic_value, math.nan)
        if not key or not math.isfinite(ic):
            return
        buckets.setdefault(key, []).append(ic)
        counts[key] = counts.get(key, 0) + _as_int(test_rows, 0)

    for row in rows:
        if row.get("market_segment") or row.get("segment"):
            add(row.get("market_segment") or row.get("segment"), row.get("oos_ic"), row.get("test_rows"))
        for dict_key in ("segment_oos_ic", "segment_ic", "segment_rank_ic"):
            payload = row.get(dict_key)
            if not isinstance(payload, dict):
                continue
            for segment, value in payload.items():
                if isinstance(value, dict):
                    add(
                        segment,
                        value.get("oos_ic", value.get("rank_ic", value.get("ic"))),
                        value.get("test_rows", value.get("rows", value.get("samples"))),
                    )
                else:
                    add(segment, value, row.get("test_rows"))

    return {
        segment: {
            "oos_ic_mean": round(mean(values), 6),
            "folds": len(values),
            "test_rows": counts.get(segment, 0),
        }
        for segment, values in sorted(buckets.items())
        if values
    }


def _tail_fold_stats(rows: list[dict[str, Any]], guard: dict[str, Any]) -> dict[str, Any]:
    tail_folds = max(1, _as_int(guard.get("tail_folds"), 3))
    tail_rows = rows[-tail_folds:]
    values = [_as_float(row.get("oos_ic"), math.nan) for row in tail_rows]
    values = [value for value in values if math.isfinite(value)]
    positive_ratio = sum(1 for value in values if value > 0.0) / len(values) if values else 0.0
    return {
        "tail_folds": tail_folds,
        "observed_tail_folds": len(values),
        "tail_oos_ic_mean": round(mean(values), 6) if values else 0.0,
        "tail_positive_fold_ratio": round(positive_ratio, 6),
    }


def _return_quality_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    all_zero_days = 0
    max_zero_ratio = 0.0
    observed = 0
    for row in rows:
        if _as_bool(row.get("all_zero_actual_return_day")) or _as_bool(row.get("actual_return_all_zero")):
            all_zero_days += 1
            observed += 1
        for key in ("actual_return_zero_ratio", "zero_return_ratio", "target_zero_ratio"):
            if key not in row:
                continue
            value = _as_float(row.get(key), math.nan)
            if math.isfinite(value):
                observed += 1
                max_zero_ratio = max(max_zero_ratio, _clamp_ratio(value))
    return {
        "observed_rows": observed,
        "all_zero_actual_return_days": all_zero_days,
        "max_actual_return_zero_ratio": round(max_zero_ratio, 6),
    }


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
        overrides={"cpcv": policy} if policy else None,
    )
    cpcv = dict(bundle["cpcv"])
    cpcv["policy_version"] = bundle["policy_version"]
    cpcv["policy_source"] = bundle["source"]
    return cpcv


def rank_ic(preds: np.ndarray, y_actual: np.ndarray) -> float:
    if len(preds) < 10 or np.std(preds) < 1e-10 or np.std(y_actual) < 1e-10:
        return 0.0
    rho, _ = spearmanr(preds, y_actual)
    return float(rho) if not np.isnan(rho) else 0.0


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
) -> dict[str, Any]:
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
                "actual_return_zero_ratio",
                "zero_return_ratio",
                "target_zero_ratio",
            ):
                if key in fold:
                    normalized[key] = fold.get(key)
            for key in (
                "market_segment",
                "segment",
                "segment_oos_ic",
                "segment_ic",
                "segment_rank_ic",
                "all_zero_actual_return_day",
                "actual_return_all_zero",
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
    )
    ic_mean = mean(ic_values) if ic_values else 0.0
    ic_std = pstdev(ic_values) if len(ic_values) > 1 else 0.0
    positive_ratio = sum(1 for value in ic_values if value > 0.0) / folds if folds else 0.0
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

    tail_stats: dict[str, Any] | None = None
    tail_guard = p.get("tail_fold_guard") if isinstance(p.get("tail_fold_guard"), dict) else {}
    if _as_bool(tail_guard.get("enabled")) and rows:
        tail_stats = _tail_fold_stats(rows, tail_guard)
        if tail_stats["observed_tail_folds"] < _as_int(tail_guard.get("tail_folds"), 3):
            failed_gates.append("cpcv_tail_fold_count")
        if tail_stats["tail_oos_ic_mean"] < _as_float(tail_guard.get("min_tail_oos_ic_mean"), 0.0):
            failed_gates.append("cpcv_tail_oos_ic")
        if tail_stats["tail_positive_fold_ratio"] < _as_float(tail_guard.get("min_tail_positive_fold_ratio"), 0.50):
            failed_gates.append("cpcv_tail_positive_fold_ratio")

    segment_stats = _segment_ic_stats(rows)
    segment_guard = p.get("segment_ic_guard") if isinstance(p.get("segment_ic_guard"), dict) else {}
    if _as_bool(segment_guard.get("enabled")) and segment_stats:
        min_segment_ic = _as_float(segment_guard.get("min_segment_ic_mean"), 0.0)
        min_segment_rows = _as_int(segment_guard.get("min_segment_test_rows"), 0)
        for stats in segment_stats.values():
            if stats.get("test_rows", 0) < min_segment_rows:
                continue
            if stats.get("oos_ic_mean", 0.0) < min_segment_ic:
                failed_gates.append("cpcv_segment_ic")
                break

    return_quality_stats = _return_quality_stats(rows)
    return_guard = p.get("return_quality_guard") if isinstance(p.get("return_quality_guard"), dict) else {}
    if _as_bool(return_guard.get("enabled")) and return_quality_stats["observed_rows"]:
        if _as_bool(return_guard.get("exclude_all_zero_return_days")) and return_quality_stats["all_zero_actual_return_days"] > 0:
            failed_gates.append("cpcv_actual_return_all_zero_day")
        if return_quality_stats["max_actual_return_zero_ratio"] >= _as_float(return_guard.get("max_zero_return_ratio"), 0.98):
            failed_gates.append("cpcv_actual_return_zero_ratio")

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
    if tail_stats is not None:
        evidence["tail_fold_stats"] = tail_stats
    if segment_stats:
        evidence["segment_ic_stats"] = segment_stats
    if return_quality_stats["observed_rows"]:
        evidence["return_quality_stats"] = return_quality_stats
    for key, value in coverage.items():
        if key in evidence or value is None:
            continue
        evidence[key] = round(value, 6) if isinstance(value, float) else value
    return evidence


def build_model_cpcv_adapter_missing_evidence(
    *,
    model: str,
    family: str,
    adapter: str,
    cost_estimate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "family": family,
        "method": "family_specific_cpcv_adapter_missing",
        "decision": "FAIL",
        "passed": False,
        "failed_gates": ["cpcv_adapter_missing"],
        "folds": 0,
        "oos_ic_mean": 0.0,
        "oos_ic_std": 0.0,
        "positive_fold_ratio": 0.0,
        "min_test_rows": 0,
        "coverage_mean": 0.0,
        "adapter": adapter,
        "cost_estimate": cost_estimate or {},
        "reason": (
            "Non-tree models need family-specific CPCV fit_predict adapters; "
            "do not promote without explicit validation evidence."
        ),
    }


def build_model_cpcv_adapter_error_evidence(
    *,
    model: str,
    family: str,
    adapter: str,
    error: str,
    cost_estimate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "family": family,
        "method": "family_specific_cpcv_adapter_error",
        "decision": "FAIL",
        "passed": False,
        "failed_gates": ["cpcv_adapter_error"],
        "folds": 0,
        "oos_ic_mean": 0.0,
        "oos_ic_std": 0.0,
        "positive_fold_ratio": 0.0,
        "min_test_rows": 0,
        "coverage_mean": 0.0,
        "adapter": adapter,
        "error": error,
        "cost_estimate": cost_estimate or {},
        "reason": "Family-specific CPCV adapter failed; do not promote without validation evidence.",
    }


def fit_predict_ft_transformer_cpcv(
    X: np.ndarray,
    y: np.ndarray,
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    *,
    params: dict[str, Any] | None = None,
) -> np.ndarray:
    """Retired adapter kept fail-closed for stale policy payloads."""
    raise RuntimeError("FT-Transformer CPCV adapter is retired; use TabM artifact evidence")


def evaluate_model_cpcv_rank_ic(
    *,
    model: str,
    X: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    fit_predict: Callable[[np.ndarray, np.ndarray], np.ndarray],
    n_groups: int,
    n_test_groups: int,
    embargo_days: int,
    min_train_groups: int = 2,
    embargo_pct: float | None = None,
    max_embargo_days: int | None = 20,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cv = CombinatorialPurgedCV(
        n_groups=n_groups,
        n_test_groups=n_test_groups,
        embargo_days=embargo_days,
        embargo_pct=embargo_pct,
        max_embargo_days=max_embargo_days,
        min_train_groups=min_train_groups,
    )
    fold_metrics: list[dict[str, Any]] = []
    for fold_id, (train_idx, test_idx) in enumerate(cv.split(X, y, dates), start=1):
        preds = np.asarray(fit_predict(train_idx, test_idx), dtype=float).reshape(-1)
        y_test = np.asarray(y[test_idx], dtype=float).reshape(-1)
        if len(preds) != len(y_test):
            raise ValueError(
                f"{model} CPCV fold {fold_id} returned {len(preds)} preds for {len(y_test)} rows"
            )
        finite_mask = np.isfinite(preds) & np.isfinite(y_test)
        coverage = float(finite_mask.mean()) if len(finite_mask) else 0.0
        ic = rank_ic(preds[finite_mask], y_test[finite_mask]) if finite_mask.any() else 0.0
        fold_metrics.append(
            {
                "fold_id": fold_id,
                "oos_ic": ic,
                "test_rows": int(len(test_idx)),
                "coverage": coverage,
            }
        )
    return build_model_cpcv_evidence(model=model, fold_metrics=fold_metrics, policy=policy)
