from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


BACKTEST_REALITY_SCHEMA_VERSION = "backtest-reality-v1"

DEFAULT_BACKTEST_REALITY_POLICY = {
    "min_avg_daily_turnover_twd": 50_000_000.0,
    "max_order_participation_pct": 0.05,
    "max_total_transaction_cost_bps": 80.0,
    "max_slippage_bps": 30.0,
    "max_limit_lock_touch_pct": 0.02,
    "max_disposition_event_count": 0,
    "max_full_delivery_trade_count": 0,
    "max_abs_mae_p95_pct": 0.12,
    "min_mfe_to_abs_mae_ratio": 0.80,
    "max_turnover_ratio": 8.0,
    "min_walk_forward_windows": 4,
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _gate(name: str, passed: bool, *, reason: str, metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": name,
        "passed": bool(passed),
        "reason": reason,
        "metrics": {key: value for key, value in metrics.items() if value is not None},
    }


def _liquidity(metrics: dict[str, Any], policy: dict[str, float]) -> dict[str, Any]:
    adtv = _float(metrics.get("avg_daily_turnover_twd"))
    threshold = float(policy["min_avg_daily_turnover_twd"])
    passed = adtv is not None and adtv >= threshold
    return _gate(
        "liquidity",
        passed,
        reason="avg_daily_turnover_above_minimum" if passed else "avg_daily_turnover_missing_or_too_low",
        metrics={"avg_daily_turnover_twd": adtv, "min_avg_daily_turnover_twd": threshold},
    )


def _capacity(metrics: dict[str, Any], policy: dict[str, float]) -> tuple[dict[str, Any], dict[str, Any]]:
    adtv = _float(metrics.get("avg_daily_turnover_twd"))
    target_value = _float(metrics.get("target_order_value_twd"))
    participation = _float(metrics.get("max_order_participation_pct"))
    if participation is None and adtv and target_value is not None:
        participation = target_value / adtv
    max_participation = float(policy["max_order_participation_pct"])
    passed = participation is not None and participation <= max_participation
    capacity = {
        "avg_daily_turnover_twd": adtv,
        "target_order_value_twd": target_value,
        "participation_pct": participation,
        "max_participation_pct": max_participation,
        "estimated_daily_capacity_twd": adtv * max_participation if adtv is not None else None,
    }
    return capacity, _gate(
        "capacity",
        passed,
        reason="order_participation_within_capacity" if passed else "order_participation_missing_or_too_high",
        metrics=capacity,
    )


def _transaction_cost(metrics: dict[str, Any], policy: dict[str, float]) -> tuple[dict[str, Any], dict[str, Any]]:
    slippage = _float(metrics.get("estimated_slippage_bps"))
    fee_tax = _float(metrics.get("estimated_fee_tax_bps"))
    total = (slippage or 0.0) + (fee_tax or 0.0) if slippage is not None or fee_tax is not None else None
    passed = (
        slippage is not None
        and fee_tax is not None
        and slippage <= float(policy["max_slippage_bps"])
        and total is not None
        and total <= float(policy["max_total_transaction_cost_bps"])
    )
    cost = {
        "slippage_bps": slippage,
        "fee_tax_bps": fee_tax,
        "total_bps": total,
        "max_slippage_bps": float(policy["max_slippage_bps"]),
        "max_total_transaction_cost_bps": float(policy["max_total_transaction_cost_bps"]),
    }
    return cost, _gate(
        "transaction_cost",
        passed,
        reason="cost_within_policy" if passed else "cost_missing_or_too_high",
        metrics=cost,
    )


def _limit_lock(metrics: dict[str, Any], policy: dict[str, float]) -> dict[str, Any]:
    touch_pct = _float(metrics.get("limit_lock_touch_pct"))
    threshold = float(policy["max_limit_lock_touch_pct"])
    passed = touch_pct is not None and touch_pct <= threshold
    return _gate(
        "limit_lock",
        passed,
        reason="limit_lock_rate_within_policy" if passed else "limit_lock_rate_missing_or_too_high",
        metrics={"limit_lock_touch_pct": touch_pct, "max_limit_lock_touch_pct": threshold},
    )


def _restricted_market_gate(metrics: dict[str, Any], policy: dict[str, float], key: str, name: str) -> dict[str, Any]:
    count = _int(metrics.get(key))
    threshold = int(policy[f"max_{key}"])
    passed = count is not None and count <= threshold
    return _gate(
        name,
        passed,
        reason=f"{name}_within_policy" if passed else f"{name}_missing_or_blocked",
        metrics={key: count, f"max_{key}": threshold},
    )


def _mae_mfe(metrics: dict[str, Any], policy: dict[str, float]) -> tuple[dict[str, Any], dict[str, Any]]:
    mae = _float(metrics.get("mae_p95_pct"))
    mfe = _float(metrics.get("mfe_p50_pct"))
    abs_mae = abs(mae) if mae is not None else None
    ratio = (mfe / abs_mae) if mfe is not None and abs_mae and abs_mae > 0 else None
    max_mae = float(policy["max_abs_mae_p95_pct"])
    min_ratio = float(policy["min_mfe_to_abs_mae_ratio"])
    passed = abs_mae is not None and mfe is not None and ratio is not None and abs_mae <= max_mae and ratio >= min_ratio
    detail = {
        "mae_p95_pct": mae,
        "mfe_p50_pct": mfe,
        "abs_mae_p95_pct": abs_mae,
        "mfe_to_abs_mae_ratio": ratio,
        "max_abs_mae_p95_pct": max_mae,
        "min_mfe_to_abs_mae_ratio": min_ratio,
    }
    return detail, _gate(
        "mae_mfe",
        passed,
        reason="mae_mfe_shape_tradable" if passed else "mae_mfe_missing_or_unfavorable",
        metrics=detail,
    )


def _turnover(metrics: dict[str, Any], policy: dict[str, float]) -> dict[str, Any]:
    turnover = _float(metrics.get("turnover_ratio"))
    threshold = float(policy["max_turnover_ratio"])
    passed = turnover is not None and turnover <= threshold
    return _gate(
        "turnover",
        passed,
        reason="turnover_within_policy" if passed else "turnover_missing_or_too_high",
        metrics={"turnover_ratio": turnover, "max_turnover_ratio": threshold},
    )


def _walk_forward(metrics: dict[str, Any], policy: dict[str, float]) -> dict[str, Any]:
    wf = metrics.get("walk_forward") if isinstance(metrics.get("walk_forward"), dict) else {}
    windows = _int(wf.get("windows")) if wf else None
    passed_flag = bool(wf.get("passed") or wf.get("gate_pass")) if wf else False
    min_windows = int(policy["min_walk_forward_windows"])
    passed = passed_flag and windows is not None and windows >= min_windows
    return _gate(
        "walk_forward",
        passed,
        reason="walk_forward_oos_confirmed" if passed else "walk_forward_missing_or_failed",
        metrics={"passed": passed_flag, "windows": windows, "min_walk_forward_windows": min_windows, **wf},
    )


def build_backtest_reality_report(
    metrics: dict[str, Any],
    *,
    strategy_id: str,
    generated_at: str | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_policy = {**DEFAULT_BACKTEST_REALITY_POLICY, **(policy or {})}
    capacity, capacity_gate = _capacity(metrics, active_policy)
    transaction_cost, transaction_gate = _transaction_cost(metrics, active_policy)
    mae_mfe, mae_mfe_gate = _mae_mfe(metrics, active_policy)
    gates = [
        _liquidity(metrics, active_policy),
        capacity_gate,
        transaction_gate,
        _limit_lock(metrics, active_policy),
        _restricted_market_gate(metrics, active_policy, "disposition_event_count", "disposition"),
        _restricted_market_gate(metrics, active_policy, "full_delivery_trade_count", "full_delivery"),
        mae_mfe_gate,
        _turnover(metrics, active_policy),
        _walk_forward(metrics, active_policy),
    ]
    failed_gates = [gate["name"] for gate in gates if not gate["passed"]]
    status = "pass" if not failed_gates else "fail"
    report = {
        "schema_version": BACKTEST_REALITY_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "strategy_id": strategy_id,
        "status": status,
        "allowed_use": "promotion_candidate" if status == "pass" else "research_only",
        "policy": active_policy,
        "capacity": capacity,
        "transaction_cost": transaction_cost,
        "mae_mfe": mae_mfe,
        "gates": gates,
        "failed_gates": failed_gates,
        "warnings": [
            "backtest_result_not_tradable_until_reality_gates_pass"
        ] if failed_gates else [],
    }
    report["checksum"] = _sha256_json({
        "schema_version": report["schema_version"],
        "strategy_id": report["strategy_id"],
        "status": report["status"],
        "allowed_use": report["allowed_use"],
        "policy": report["policy"],
        "gates": report["gates"],
        "failed_gates": report["failed_gates"],
    })
    return report


def validate_backtest_reality_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != BACKTEST_REALITY_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not report.get("checksum"):
        errors.append("checksum_missing")
    gates = report.get("gates")
    if not isinstance(gates, list) or not gates:
        errors.append("gates_missing")
        return errors
    gate_names = {str(gate.get("name")) for gate in gates if isinstance(gate, dict)}
    required = {
        "liquidity",
        "capacity",
        "transaction_cost",
        "limit_lock",
        "disposition",
        "full_delivery",
        "mae_mfe",
        "turnover",
        "walk_forward",
    }
    missing = sorted(required - gate_names)
    if missing:
        errors.append(f"required_gates_missing:{','.join(missing)}")
    failed = report.get("failed_gates")
    if not isinstance(failed, list):
        errors.append("failed_gates_missing")
    if report.get("status") == "pass" and failed:
        errors.append("pass_with_failed_gates")
    if report.get("allowed_use") == "promotion_candidate" and report.get("status") != "pass":
        errors.append("promotion_without_pass")
    return errors
