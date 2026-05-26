"""Research-only conformal uncertainty and Kelly/CVaR risk gate."""

from __future__ import annotations

import math
from datetime import date
from typing import Any


SCHEMA_VERSION = "conformal-risk-gate-v1"


def _clean_text(value: object) -> str:
    return str(value or "").strip()


def _parse_date(value: object) -> date | None:
    raw = _clean_text(value)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _to_float(value: object, default: float | None = None) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _key(row: dict[str, Any]) -> tuple[str, str]:
    return (
        _clean_text(row.get("symbol")),
        _clean_text(row.get("label_date") or row.get("date") or row.get("return_date")),
    )


def _detect_future_leakage(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    leaks: list[dict[str, str]] = []
    for row in rows:
        label_raw = _key(row)[1]
        label_dt = _parse_date(label_raw)
        if not label_dt:
            continue
        for key in ("as_of_date", "feature_end_date"):
            raw = _clean_text(row.get(key))
            observed = _parse_date(raw)
            if observed and observed > label_dt:
                leaks.append({"label_date": label_raw, "field": key, "value": raw[:10]})
    return leaks


def _cvar_5(returns: list[float]) -> float | None:
    if not returns:
        return None
    sorted_returns = sorted(returns)
    count = max(1, math.ceil(len(sorted_returns) * 0.05))
    worst = sorted_returns[:count]
    return round(abs(sum(worst) / len(worst)), 8)


def build_conformal_risk_gate(
    *,
    prediction_rows: list[dict[str, Any]],
    realized_rows: list[dict[str, Any]],
    target_coverage: float = 0.90,
    max_tail_loss_rate: float = 0.10,
    max_cvar_5: float = 0.08,
    tail_loss_threshold: float = -0.05,
    min_samples: int = 30,
) -> dict[str, Any]:
    realized = {_key(row): _to_float(row.get("realized_return", row.get("return"))) for row in realized_rows}
    paired: list[tuple[dict[str, Any], float]] = []
    for row in prediction_rows:
        value = realized.get(_key(row))
        if value is not None:
            paired.append((row, value))

    blockers: list[str] = []
    leakage = _detect_future_leakage(prediction_rows)
    if leakage:
        blockers.append("future_leakage_detected")
    if len(paired) < min_samples:
        blockers.append("insufficient_labeled_predictions")

    covered = 0
    widths: list[float] = []
    kelly_values: list[float] = []
    realized_values: list[float] = []
    for row, realized_return in paired:
        lower = _to_float(row.get("lower", row.get("lower_bound")))
        upper = _to_float(row.get("upper", row.get("upper_bound")))
        if lower is None or upper is None:
            continue
        realized_values.append(realized_return)
        if lower <= realized_return <= upper:
            covered += 1
        widths.append(max(0.0, upper - lower))
        kelly = _to_float(row.get("kelly_pct"))
        if kelly is not None:
            kelly_values.append(kelly)

    denominator = len(realized_values)
    coverage = round(covered / denominator, 8) if denominator else None
    tail_loss_rate = (
        round(sum(1 for value in realized_values if value <= tail_loss_threshold) / denominator, 8)
        if denominator
        else None
    )
    cvar_5 = _cvar_5(realized_values)
    avg_width = round(sum(widths) / len(widths), 8) if widths else None
    avg_kelly = round(sum(kelly_values) / len(kelly_values), 8) if kelly_values else None
    coverage_pass = coverage is not None and coverage >= target_coverage
    tail_pass = tail_loss_rate is not None and tail_loss_rate <= max_tail_loss_rate
    cvar_pass = cvar_5 is not None and cvar_5 <= max_cvar_5
    eligible = not blockers and coverage_pass and tail_pass and cvar_pass

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked" if blockers else "ready_for_review",
        "decision_effect": "risk_gate_only",
        "blockers": blockers,
        "leakage_examples": leakage[:5],
        "metrics": {
            "samples": len(paired),
            "coverage": coverage,
            "target_coverage": target_coverage,
            "average_interval_width": avg_width,
            "tail_loss_rate": tail_loss_rate,
            "tail_loss_threshold": tail_loss_threshold,
            "cvar_5": cvar_5,
            "average_candidate_kelly_pct": avg_kelly,
        },
        "decision": {
            "eligible_to_attach_uncertainty_overlay": eligible,
            "production_mutation_allowed": False,
            "kelly_action": "keep_candidate_kelly_cap" if eligible else "dampen_or_disable_kelly",
            "coverage_pass": coverage_pass,
            "tail_loss_pass": tail_pass,
            "cvar_5_pass": cvar_pass,
            "max_tail_loss_rate": max_tail_loss_rate,
            "max_cvar_5": max_cvar_5,
        },
    }
