"""Offline portfolio allocation benchmark utilities.

This module compares the current rank-topK equal-weight behavior against a
sparse tangent-style inverse-risk allocation. It does not place orders, mutate
production config, or promote a challenger.
"""

from __future__ import annotations

import math
import statistics
from typing import Any


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _symbol(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or "").strip()


def _score(row: dict[str, Any]) -> float:
    return _to_float(row.get("score"), 0.0)


def _expected_return(row: dict[str, Any]) -> float:
    explicit = row.get("expected_return")
    if explicit is None:
        explicit = row.get("predicted_return")
    if explicit is not None:
        return _to_float(explicit, 0.0)
    return max(0.0, (_score(row) - 50.0) / 5000.0)


def _sample_variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return statistics.variance(values)


def _ranked_candidates(candidates: list[dict[str, Any]], top_k: int) -> list[dict[str, Any]]:
    cleaned = [row for row in candidates if _symbol(row)]
    return sorted(cleaned, key=_score, reverse=True)[: max(1, int(top_k))]


def _normalize(raw: dict[str, float]) -> dict[str, float]:
    total = sum(max(0.0, value) for value in raw.values())
    if total <= 0:
        count = len(raw)
        return {symbol: 1.0 / count for symbol in raw} if count else {}
    return {symbol: max(0.0, value) / total for symbol, value in raw.items()}


def _cap_and_renormalize(weights: dict[str, float], max_weight: float) -> dict[str, float]:
    if not weights:
        return {}
    cap = min(1.0, max(0.01, float(max_weight)))
    remaining = dict(weights)
    capped: dict[str, float] = {}
    budget = 1.0
    while remaining:
        normalized = _normalize(remaining)
        breaches = {symbol: weight for symbol, weight in normalized.items() if weight * budget > cap}
        if not breaches:
            for symbol, weight in normalized.items():
                capped[symbol] = weight * budget
            break
        for symbol in breaches:
            capped[symbol] = cap
            remaining.pop(symbol, None)
            budget -= cap
        if budget <= 0:
            break
    return _normalize(capped)


def allocate_rank_topk_equal_weight(
    candidates: list[dict[str, Any]],
    *,
    top_k: int,
) -> dict[str, float]:
    selected = _ranked_candidates(candidates, top_k)
    if not selected:
        return {}
    weight = 1.0 / len(selected)
    return {_symbol(row): weight for row in selected}


def allocate_sparse_tangent(
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    *,
    top_k: int,
    max_weight: float = 0.55,
    daily_vol_floor: float = 0.01,
) -> dict[str, float]:
    """Sparse tangent approximation over the current rank topK candidate set.

    Expected return comes from candidate expected_return/predicted_return when
    available. Risk uses realized return variance with a volatility floor so a
    flat low-edge series cannot dominate the portfolio.
    """
    selected = _ranked_candidates(candidates, top_k)
    raw: dict[str, float] = {}
    var_floor = max(1e-8, daily_vol_floor * daily_vol_floor)
    for row in selected:
        symbol = _symbol(row)
        history = [_to_float(value) for value in return_history.get(symbol, [])]
        variance = max(var_floor, _sample_variance(history))
        raw[symbol] = max(0.0, _expected_return(row)) / variance
    if not any(value > 0 for value in raw.values()):
        return allocate_rank_topk_equal_weight(candidates, top_k=top_k)
    return _cap_and_renormalize(raw, max_weight=max_weight)


def portfolio_returns(weights: dict[str, float], return_history: dict[str, list[float]]) -> list[float]:
    if not weights:
        return []
    histories = {
        symbol: [_to_float(value) for value in return_history.get(symbol, [])]
        for symbol in weights
    }
    n = min((len(values) for values in histories.values()), default=0)
    if n <= 0:
        return []
    out: list[float] = []
    for idx in range(n):
        out.append(sum(weights[symbol] * histories[symbol][idx] for symbol in weights))
    return out


def portfolio_metrics(returns: list[float], periods_per_year: int = 252) -> dict[str, float | None]:
    if not returns:
        return {
            "n": 0,
            "mean_return": None,
            "annualized_return": None,
            "volatility": None,
            "sharpe": None,
            "max_drawdown": None,
        }
    mean_return = statistics.mean(returns)
    volatility = statistics.stdev(returns) if len(returns) >= 2 else 0.0
    sharpe = (mean_return / volatility) * math.sqrt(periods_per_year) if volatility > 0 else None
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in returns:
        equity *= 1.0 + value
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak)
    compounded = math.prod(1.0 + value for value in returns)
    annualized = compounded ** (periods_per_year / len(returns)) - 1.0
    return {
        "n": len(returns),
        "mean_return": round(mean_return, 8),
        "annualized_return": round(annualized, 8),
        "volatility": round(volatility, 8),
        "sharpe": round(sharpe, 6) if sharpe is not None else None,
        "max_drawdown": round(max_drawdown, 8),
    }


def _metric_delta(challenger: dict[str, float | None], baseline: dict[str, float | None], key: str) -> float | None:
    left = challenger.get(key)
    right = baseline.get(key)
    if left is None or right is None:
        return None
    return round(float(left) - float(right), 8)


def _weight_hhi(weights: dict[str, float]) -> float:
    return round(sum(weight * weight for weight in weights.values()), 8)


def build_portfolio_allocation_benchmark(
    *,
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    top_k: int,
    max_weight: float = 0.55,
    min_sharpe_delta: float = 0.20,
    max_mdd_delta: float = 0.02,
) -> dict[str, Any]:
    baseline_weights = allocate_rank_topk_equal_weight(candidates, top_k=top_k)
    challenger_weights = allocate_sparse_tangent(
        candidates,
        return_history,
        top_k=top_k,
        max_weight=max_weight,
    )
    baseline_metrics = portfolio_metrics(portfolio_returns(baseline_weights, return_history))
    challenger_metrics = portfolio_metrics(portfolio_returns(challenger_weights, return_history))
    sharpe_delta = _metric_delta(challenger_metrics, baseline_metrics, "sharpe")
    max_drawdown_delta = _metric_delta(challenger_metrics, baseline_metrics, "max_drawdown")
    eligible = (
        sharpe_delta is not None
        and max_drawdown_delta is not None
        and sharpe_delta >= min_sharpe_delta
        and max_drawdown_delta <= max_mdd_delta
    )
    return {
        "schema_version": "portfolio-allocation-benchmark-v1",
        "baseline": {
            "method": "rank_topk_equal_weight",
            "weights": baseline_weights,
            "weight_hhi": _weight_hhi(baseline_weights),
            "metrics": baseline_metrics,
        },
        "challenger": {
            "method": "sparse_tangent_inverse_risk",
            "weights": challenger_weights,
            "weight_hhi": _weight_hhi(challenger_weights),
            "metrics": challenger_metrics,
        },
        "decision": {
            "eligible_to_replace_rank_topk": eligible,
            "production_mutation_allowed": False,
            "sharpe_delta": sharpe_delta,
            "max_drawdown_delta": max_drawdown_delta,
            "min_sharpe_delta": min_sharpe_delta,
            "max_mdd_delta": max_mdd_delta,
        },
    }
