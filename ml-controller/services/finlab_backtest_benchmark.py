from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


FINLAB_BACKTEST_BENCHMARK_SCHEMA_VERSION = "finlab-backtest-benchmark-v1"

DEFAULT_FINLAB_BACKTEST_TOLERANCES = {
    "annual_return": 0.15,
    "max_drawdown": 0.10,
    "sharpe": 0.50,
    "turnover_ratio": 2.00,
}

BENCHMARK_METRIC_ALIASES = {
    "annual_return": ("annual_return", "annualized_return", "cagr"),
    "max_drawdown": ("max_drawdown", "mdd"),
    "sharpe": ("sharpe", "sharpe_ratio"),
    "turnover_ratio": ("turnover_ratio", "turnover"),
}

DIRECT_DECISION_FIELDS = frozenset({
    "action",
    "alpha_adjustment",
    "buy_signal",
    "decision",
    "entry_signal",
    "exit_signal",
    "final_rank",
    "order_action",
    "order_qty",
    "pending_buy",
    "position_size",
    "rank",
    "recommendation",
    "recommendation_score",
    "score_modifier",
    "sell_signal",
    "signal",
    "target_position",
})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _metrics(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    nested = payload.get("metrics")
    if isinstance(nested, dict):
        return nested
    return payload


def _metric_value(payload: dict[str, Any], canonical_name: str) -> float | None:
    metrics = _metrics(payload)
    for key in BENCHMARK_METRIC_ALIASES[canonical_name]:
        value = _as_float(metrics.get(key))
        if value is not None:
            return value
    return None


def _direct_fields(payload: Any, *, prefix: str = "") -> list[str]:
    if isinstance(payload, dict):
        found: list[str] = []
        for key, value in payload.items():
            key_text = str(key)
            path = f"{prefix}.{key_text}" if prefix else key_text
            if key_text in DIRECT_DECISION_FIELDS:
                found.append(path)
            found.extend(_direct_fields(value, prefix=path))
        return found
    if isinstance(payload, list):
        found = []
        for index, value in enumerate(payload):
            found.extend(_direct_fields(value, prefix=f"{prefix}[{index}]" if prefix else f"[{index}]"))
        return found
    return []


def _metric_diffs(
    stockvision_backtest: dict[str, Any],
    finlab_benchmark: dict[str, Any],
    tolerances: dict[str, float],
) -> tuple[dict[str, Any], list[str]]:
    diffs: dict[str, Any] = {}
    variance_flags: list[str] = []
    for metric_name in BENCHMARK_METRIC_ALIASES:
        stockvision_value = _metric_value(stockvision_backtest, metric_name)
        finlab_value = _metric_value(finlab_benchmark, metric_name)
        if stockvision_value is None or finlab_value is None:
            continue
        abs_delta = round(abs(stockvision_value - finlab_value), 6)
        tolerance = float(tolerances.get(metric_name, DEFAULT_FINLAB_BACKTEST_TOLERANCES[metric_name]))
        within_tolerance = abs_delta <= tolerance
        diffs[metric_name] = {
            "stockvision": stockvision_value,
            "finlab": finlab_value,
            "abs_delta": abs_delta,
            "tolerance": tolerance,
            "within_tolerance": within_tolerance,
        }
        if not within_tolerance:
            variance_flags.append(metric_name)
    return diffs, variance_flags


def build_finlab_backtest_benchmark_report(
    stockvision_backtest: dict[str, Any],
    *,
    finlab_benchmark: dict[str, Any] | None,
    strategy_id: str,
    generated_at: str | None = None,
    tolerances: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_tolerances = {
        key: float(value)
        for key, value in {**DEFAULT_FINLAB_BACKTEST_TOLERANCES, **(tolerances or {})}.items()
    }
    direct_fields = sorted(_direct_fields(finlab_benchmark or {}))
    warnings: list[str] = []
    blocking_reasons: list[str] = []
    metric_diffs: dict[str, Any] = {}
    variance_flags: list[str] = []

    if finlab_benchmark is None:
        status = "missing_benchmark"
        warnings.append("finlab_benchmark_missing")
    else:
        metric_diffs, variance_flags = _metric_diffs(stockvision_backtest, finlab_benchmark, active_tolerances)
        if direct_fields:
            status = "blocked"
            blocking_reasons.append("direct_decision_fields_present")
        elif variance_flags:
            status = "warn"
            warnings.append("benchmark_variance_above_tolerance")
        else:
            status = "pass"

    report = {
        "schema_version": FINLAB_BACKTEST_BENCHMARK_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "strategy_id": strategy_id,
        "status": status,
        "allowed_use": "sanity_check_only",
        "decision_effect": "benchmark_only",
        "stockvision_backtest_authority": "production_truth",
        "finlab_backtest_authority": "external_sanity_check",
        "policy": {
            "stockvision_backtest_remains_source_of_truth": True,
            "finlab_result_cannot_write_recommendations": True,
            "finlab_result_cannot_promote_strategy": True,
            "finlab_result_cannot_create_paper_or_real_orders": True,
        },
        "tolerances": active_tolerances,
        "metric_diffs": metric_diffs,
        "variance_flags": variance_flags,
        "direct_decision_fields": direct_fields,
        "blocking_reasons": blocking_reasons,
        "warnings": warnings,
    }
    report["checksum"] = _sha256_json({
        "schema_version": report["schema_version"],
        "strategy_id": report["strategy_id"],
        "status": report["status"],
        "allowed_use": report["allowed_use"],
        "decision_effect": report["decision_effect"],
        "policy": report["policy"],
        "tolerances": report["tolerances"],
        "metric_diffs": report["metric_diffs"],
        "variance_flags": report["variance_flags"],
        "direct_decision_fields": report["direct_decision_fields"],
        "blocking_reasons": report["blocking_reasons"],
        "warnings": report["warnings"],
    })
    return report


def validate_finlab_backtest_benchmark_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != FINLAB_BACKTEST_BENCHMARK_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not report.get("checksum"):
        errors.append("checksum_missing")
    if report.get("allowed_use") != "sanity_check_only":
        errors.append("allowed_use_must_be_sanity_check_only")
    if report.get("decision_effect") != "benchmark_only":
        errors.append("decision_effect_must_be_benchmark_only")
    if report.get("stockvision_backtest_authority") != "production_truth":
        errors.append("stockvision_backtest_authority_invalid")
    if report.get("finlab_backtest_authority") != "external_sanity_check":
        errors.append("finlab_backtest_authority_invalid")
    if report.get("status") == "blocked" and "direct_decision_fields_present" not in report.get("blocking_reasons", []):
        errors.append("blocked_without_direct_decision_reason")
    metric_diffs = report.get("metric_diffs")
    if not isinstance(metric_diffs, dict):
        errors.append("metric_diffs_missing")
    direct_fields = report.get("direct_decision_fields")
    if not isinstance(direct_fields, list):
        errors.append("direct_decision_fields_missing")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy_missing")
    elif any(policy.get(key) is not True for key in (
        "stockvision_backtest_remains_source_of_truth",
        "finlab_result_cannot_write_recommendations",
        "finlab_result_cannot_promote_strategy",
        "finlab_result_cannot_create_paper_or_real_orders",
    )):
        errors.append("benchmark_policy_not_fail_closed")
    return errors
