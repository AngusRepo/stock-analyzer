"""Research-only direct allocation benchmark.

Compares a direct allocation candidate, such as a Signature-Informed
Transformer, against the current predict-then-optimize allocation output using
the same daily return panel.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

from services.portfolio_allocation import portfolio_metrics


SCHEMA_VERSION = "direct-allocation-benchmark-v1"


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


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _normalize_weights(weights: dict[str, Any]) -> dict[str, float]:
    cleaned = {
        str(symbol).strip(): max(0.0, _to_float(weight))
        for symbol, weight in weights.items()
        if str(symbol).strip()
    }
    total = sum(cleaned.values())
    if total <= 0:
        return {}
    return {symbol: weight / total for symbol, weight in cleaned.items()}


def _portfolio_returns_by_date(
    returns_by_date: dict[str, dict[str, Any]],
    weights_by_date: dict[str, dict[str, Any]],
    dates: list[str],
) -> list[float]:
    out: list[float] = []
    for dt in dates:
        returns = returns_by_date.get(dt, {})
        weights = _normalize_weights(weights_by_date.get(dt, {}))
        out.append(round(sum(weight * _to_float(returns.get(symbol)) for symbol, weight in weights.items()), 10))
    return out


def _average_turnover(weights_by_date: dict[str, dict[str, Any]], dates: list[str]) -> float:
    turnovers: list[float] = []
    previous: dict[str, float] | None = None
    for dt in dates:
        current = _normalize_weights(weights_by_date.get(dt, {}))
        if previous is None:
            previous = current
            continue
        symbols = set(previous) | set(current)
        turnovers.append(0.5 * sum(abs(current.get(symbol, 0.0) - previous.get(symbol, 0.0)) for symbol in symbols))
        previous = current
    if not turnovers:
        return 0.0
    return round(sum(turnovers) / len(turnovers), 8)


def _metric_delta(challenger: dict[str, float | None], baseline: dict[str, float | None], key: str) -> float | None:
    left = challenger.get(key)
    right = baseline.get(key)
    if left is None or right is None:
        return None
    return round(float(left) - float(right), 8)


def _detect_future_leakage(metadata_by_date: dict[str, dict[str, Any]] | None) -> list[dict[str, str]]:
    leaks: list[dict[str, str]] = []
    for return_date, meta in (metadata_by_date or {}).items():
        target = _parse_date(return_date)
        if not target:
            continue
        for key in ("as_of_date", "feature_end_date"):
            raw = _clean_text(meta.get(key))
            observed = _parse_date(raw)
            if observed and observed > target:
                leaks.append({"return_date": return_date, "field": key, "value": raw[:10]})
    return leaks


def build_direct_allocation_benchmark(
    *,
    returns_by_date: dict[str, dict[str, Any]],
    baseline_weights_by_date: dict[str, dict[str, Any]],
    candidate_weights_by_date: dict[str, dict[str, Any]],
    baseline_metadata_by_date: dict[str, dict[str, Any]] | None = None,
    candidate_metadata_by_date: dict[str, dict[str, Any]] | None = None,
    min_common_days: int = 6,
    min_sharpe_delta: float = 0.20,
    max_mdd_delta: float = 0.02,
    max_turnover_delta: float = 0.25,
) -> dict[str, Any]:
    dates = sorted(set(returns_by_date) & set(baseline_weights_by_date) & set(candidate_weights_by_date))
    baseline_returns = _portfolio_returns_by_date(returns_by_date, baseline_weights_by_date, dates)
    challenger_returns = _portfolio_returns_by_date(returns_by_date, candidate_weights_by_date, dates)
    baseline_metrics = portfolio_metrics(baseline_returns)
    challenger_metrics = portfolio_metrics(challenger_returns)
    baseline_turnover = _average_turnover(baseline_weights_by_date, dates)
    challenger_turnover = _average_turnover(candidate_weights_by_date, dates)

    blockers: list[str] = []
    leakage = _detect_future_leakage(baseline_metadata_by_date) + _detect_future_leakage(candidate_metadata_by_date)
    if leakage:
        blockers.append("future_leakage_detected")
    if len(dates) < min_common_days:
        blockers.append("insufficient_common_days")

    sharpe_delta = _metric_delta(challenger_metrics, baseline_metrics, "sharpe")
    max_drawdown_delta = _metric_delta(challenger_metrics, baseline_metrics, "max_drawdown")
    turnover_delta = round(challenger_turnover - baseline_turnover, 8)
    eligible = (
        not blockers
        and sharpe_delta is not None
        and max_drawdown_delta is not None
        and sharpe_delta >= min_sharpe_delta
        and max_drawdown_delta <= max_mdd_delta
        and turnover_delta <= max_turnover_delta
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked" if blockers else "ready_for_review",
        "decision_effect": "benchmark_gate_only",
        "blockers": blockers,
        "leakage_examples": leakage[:5],
        "common_days": len(dates),
        "baseline": {
            "method": "predict_then_optimize",
            "metrics": {**baseline_metrics, "average_turnover": baseline_turnover},
        },
        "challenger": {
            "method": "signature_informed_transformer_direct_allocation",
            "metrics": {**challenger_metrics, "average_turnover": challenger_turnover},
        },
        "decision": {
            "eligible_to_replace_predict_then_optimize": eligible,
            "accelerated_historical_replacement_allowed": eligible,
            "production_mutation_allowed": False,
            "sharpe_delta": sharpe_delta,
            "max_drawdown_delta": max_drawdown_delta,
            "turnover_delta": turnover_delta,
            "historical_replay_days": len(dates),
            "min_sharpe_delta": min_sharpe_delta,
            "max_mdd_delta": max_mdd_delta,
            "max_turnover_delta": max_turnover_delta,
        },
    }
