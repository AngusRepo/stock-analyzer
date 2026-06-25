"""Portfolio allocation utilities.

The rank-topK equal-weight path is kept only as an offline benchmark baseline.
Production BUY selection is owned by sparse_tangent_inverse_risk, which returns
cash/empty weights when no candidate has a positive expected edge.
"""

from __future__ import annotations

import math
import statistics
from typing import Any

from services.similarity_evidence import (
    apply_cluster_exposure_cap,
    ledoit_wolf_covariance,
    similarity_components,
)

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
    return 0.0


def _sample_variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return statistics.variance(values)


def _aligned_return_matrix(symbols: list[str], return_history: dict[str, list[float]]) -> list[list[float]]:
    histories = {
        symbol: [_to_float(value) for value in return_history.get(symbol, [])]
        for symbol in symbols
    }
    common_len = min((len(values) for values in histories.values()), default=0)
    if common_len < 2:
        return []
    return [
        [histories[symbol][-common_len + idx] for symbol in symbols]
        for idx in range(common_len)
    ]


def _sample_covariance_matrix(matrix: list[list[float]], var_floor: float) -> list[list[float]]:
    n_obs = len(matrix)
    n_assets = len(matrix[0]) if matrix else 0
    if n_obs < 2 or n_assets == 0:
        return []
    means = [sum(row[col] for row in matrix) / n_obs for col in range(n_assets)]
    cov: list[list[float]] = []
    for left in range(n_assets):
        row: list[float] = []
        for right in range(n_assets):
            value = sum(
                (obs[left] - means[left]) * (obs[right] - means[right])
                for obs in matrix
            ) / max(n_obs - 1, 1)
            row.append(value)
        cov.append(row)
    for idx in range(n_assets):
        cov[idx][idx] = max(cov[idx][idx], var_floor) + var_floor
    return cov


def _diagonal_covariance_matrix(size: int, var_floor: float) -> list[list[float]]:
    if size <= 0:
        return []
    return [
        [var_floor if left == right else 0.0 for right in range(size)]
        for left in range(size)
    ]


def _solve_linear_system(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    n = len(vector)
    if n == 0 or len(matrix) != n or any(len(row) != n for row in matrix):
        return None
    augmented = [list(row) + [vector[idx]] for idx, row in enumerate(matrix)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda row: abs(augmented[row][col]))
        if abs(augmented[pivot][col]) < 1e-12:
            return None
        if pivot != col:
            augmented[col], augmented[pivot] = augmented[pivot], augmented[col]
        pivot_value = augmented[col][col]
        for j in range(col, n + 1):
            augmented[col][j] /= pivot_value
        for row in range(n):
            if row == col:
                continue
            factor = augmented[row][col]
            if factor == 0:
                continue
            for j in range(col, n + 1):
                augmented[row][j] -= factor * augmented[col][j]
    return [augmented[row][n] for row in range(n)]


def _long_only_tangent_raw(
    symbols: list[str],
    expected_returns: list[float],
    covariance: list[list[float]],
) -> dict[str, float]:
    active = [idx for idx, edge in enumerate(expected_returns) if edge > 0]
    raw = {symbol: 0.0 for symbol in symbols}
    while active:
        sub_cov = [[covariance[i][j] for j in active] for i in active]
        sub_mu = [expected_returns[i] for i in active]
        solution = _solve_linear_system(sub_cov, sub_mu)
        if solution is None:
            return {}
        positive = [(idx, weight) for idx, weight in zip(active, solution) if weight > 1e-12]
        if len(positive) == len(active):
            for idx, weight in positive:
                raw[symbols[idx]] = weight
            return raw
        active = [idx for idx, _ in positive]
    return {}


def _row_turnover_pressure(row: dict[str, Any]) -> float:
    for key in ("turnover_pressure", "turnover", "expected_turnover"):
        if key in row:
            return max(0.0, _to_float(row.get(key), 0.0))
    return 0.0


def _covariance_diag(covariance: list[list[float]], size: int, var_floor: float) -> list[float]:
    out: list[float] = []
    for idx in range(size):
        value = var_floor
        if idx < len(covariance) and idx < len(covariance[idx]):
            value = _to_float(covariance[idx][idx], var_floor)
        out.append(max(var_floor, value))
    return out


def _portfolio_variance(weights: list[float], covariance: list[list[float]]) -> float:
    total = 0.0
    for left, left_weight in enumerate(weights):
        if left_weight <= 0:
            continue
        row = covariance[left] if left < len(covariance) else []
        for right, right_weight in enumerate(weights):
            if right_weight <= 0 or right >= len(row):
                continue
            total += left_weight * right_weight * _to_float(row[right], 0.0)
    return max(0.0, total)


def _project_capped_budget(values: list[float], *, max_weight: float, budget: float = 1.0) -> list[float]:
    if not values:
        return []
    cap = max(0.0, min(1.0, float(max_weight)))
    budget = max(0.0, min(1.0, float(budget)))
    clipped = [min(cap, max(0.0, value)) for value in values]
    if sum(clipped) <= budget + 1e-12:
        return clipped
    low = min(value - cap for value in values)
    high = max(values)
    for _ in range(80):
        mid = (low + high) / 2.0
        projected = [min(cap, max(0.0, value - mid)) for value in values]
        if sum(projected) > budget:
            low = mid
        else:
            high = mid
    return [min(cap, max(0.0, value - high)) for value in values]


def _alpha_utility_raw(
    symbols: list[str],
    rows: list[dict[str, Any]],
    expected_returns: list[float],
    covariance: list[list[float]],
    *,
    max_weight: float,
    daily_vol_floor: float,
    alpha_strength: float = 1.0,
    risk_aversion: float = 2.0,
    turnover_penalty: float = 0.0,
    l2_penalty: float = 0.0,
    iterations: int = 180,
) -> tuple[dict[str, float], dict[str, dict[str, Any]], dict[str, Any]]:
    """Mean-variance utility allocator with cash allowed.

    This keeps alpha, covariance risk, and trading friction in one objective:
    alpha'w - risk_aversion*w'cov*w - turnover_penalty*turnover'w - l2*||w||2.
    """

    n = len(symbols)
    var_floor = max(1e-8, daily_vol_floor * daily_vol_floor)
    if n == 0:
        return {}, {}, {
            "objective": "mean_variance_alpha_utility_with_cash",
            "portfolio_expected_return": 0.0,
            "portfolio_variance": 0.0,
            "portfolio_volatility": 0.0,
            "portfolio_utility": 0.0,
        }
    alpha_strength = max(0.0, _to_float(alpha_strength, 1.0))
    risk_aversion = max(0.0, _to_float(risk_aversion, 2.0))
    turnover_penalty = max(0.0, _to_float(turnover_penalty, 0.0))
    l2_penalty = max(0.0, _to_float(l2_penalty, 0.0))
    iterations = max(40, min(500, int(iterations)))
    turnover = [_row_turnover_pressure(row) for row in rows]
    net_alpha = [
        max(0.0, alpha_strength * max(0.0, edge) - turnover_penalty * turnover[idx])
        for idx, edge in enumerate(expected_returns)
    ]
    if not any(value > 0 for value in net_alpha):
        diagnostics = {
            symbol: {
                "optimizer_objective": "mean_variance_alpha_utility_with_cash",
                "alpha_input": round(expected_returns[idx], 10),
                "alpha_strength": round(alpha_strength, 6),
                "net_alpha_after_cost": 0.0,
                "individual_variance": round(_covariance_diag(covariance, n, var_floor)[idx], 10),
                "individual_volatility": round(math.sqrt(_covariance_diag(covariance, n, var_floor)[idx]), 10),
                "risk_aversion": round(risk_aversion, 6),
                "risk_penalty_unit": 0.0,
                "turnover_pressure": round(turnover[idx], 8),
                "turnover_penalty": round(turnover_penalty, 8),
                "l2_penalty": round(l2_penalty, 8),
                "marginal_utility": 0.0,
                "final_weight": 0.0,
            }
            for idx, symbol in enumerate(symbols)
        }
        return {}, diagnostics, {
            "objective": "mean_variance_alpha_utility_with_cash",
            "portfolio_expected_return": 0.0,
            "portfolio_variance": 0.0,
            "portfolio_volatility": 0.0,
            "portfolio_utility": 0.0,
        }

    diag = _covariance_diag(covariance, n, var_floor)
    max_row_sum = max(
        sum(abs(_to_float(covariance[row][col], 0.0)) for col in range(min(n, len(covariance[row]))))
        if row < len(covariance) else diag[row]
        for row in range(n)
    )
    lipschitz = max(1e-6, (2.0 * risk_aversion * max_row_sum) + (2.0 * l2_penalty))
    step = min(25.0, max(0.05, 1.0 / lipschitz))
    weights = [0.0 for _ in range(n)]
    for _ in range(iterations):
        cov_w = [
            sum(
                _to_float(covariance[row][col], 0.0) * weights[col]
                for col in range(n)
                if row < len(covariance) and col < len(covariance[row])
            )
            for row in range(n)
        ]
        gradient = [
            net_alpha[idx] - (2.0 * risk_aversion * cov_w[idx]) - (2.0 * l2_penalty * weights[idx])
            for idx in range(n)
        ]
        proposal = [weights[idx] + step * gradient[idx] for idx in range(n)]
        next_weights = _project_capped_budget(proposal, max_weight=max_weight, budget=1.0)
        if max(abs(next_weights[idx] - weights[idx]) for idx in range(n)) < 1e-10:
            weights = next_weights
            break
        weights = next_weights

    raw = {
        symbol: weight
        for symbol, weight in zip(symbols, weights)
        if weight > 1e-8
    }
    cov_w = [
        sum(
            _to_float(covariance[row][col], 0.0) * weights[col]
            for col in range(n)
            if row < len(covariance) and col < len(covariance[row])
        )
        for row in range(n)
    ]
    portfolio_expected_return = sum(expected_returns[idx] * weights[idx] for idx in range(n))
    portfolio_variance = _portfolio_variance(weights, covariance)
    portfolio_turnover_cost = sum(turnover_penalty * turnover[idx] * weights[idx] for idx in range(n))
    portfolio_l2_cost = l2_penalty * sum(weight * weight for weight in weights)
    portfolio_utility = (
        sum(net_alpha[idx] * weights[idx] for idx in range(n))
        - risk_aversion * portfolio_variance
        - portfolio_l2_cost
    )
    diagnostics = {}
    for idx, symbol in enumerate(symbols):
        marginal_risk = 2.0 * risk_aversion * cov_w[idx]
        diagnostics[symbol] = {
            "optimizer_objective": "mean_variance_alpha_utility_with_cash",
            "alpha_input": round(expected_returns[idx], 10),
            "alpha_strength": round(alpha_strength, 6),
            "net_alpha_after_cost": round(net_alpha[idx], 10),
            "individual_variance": round(diag[idx], 10),
            "individual_volatility": round(math.sqrt(diag[idx]), 10),
            "risk_aversion": round(risk_aversion, 6),
            "risk_penalty_unit": round(risk_aversion * diag[idx], 10),
            "marginal_risk_penalty": round(marginal_risk, 10),
            "turnover_pressure": round(turnover[idx], 8),
            "turnover_penalty": round(turnover_penalty, 8),
            "turnover_penalty_unit": round(turnover_penalty * turnover[idx], 10),
            "l2_penalty": round(l2_penalty, 8),
            "marginal_utility": round(net_alpha[idx] - marginal_risk - (2.0 * l2_penalty * weights[idx]), 10),
            "final_weight": round(weights[idx], 10),
        }
    objective_packet = {
        "objective": "mean_variance_alpha_utility_with_cash",
        "alpha_strength": round(alpha_strength, 6),
        "risk_aversion": round(risk_aversion, 6),
        "turnover_penalty": round(turnover_penalty, 8),
        "l2_penalty": round(l2_penalty, 8),
        "portfolio_expected_return": round(portfolio_expected_return, 10),
        "portfolio_variance": round(portfolio_variance, 10),
        "portfolio_volatility": round(math.sqrt(portfolio_variance), 10),
        "portfolio_turnover_cost": round(portfolio_turnover_cost, 10),
        "portfolio_l2_cost": round(portfolio_l2_cost, 10),
        "portfolio_utility": round(portfolio_utility, 10),
        "cash_allowed": True,
        "budget_used": round(sum(weights), 10),
    }
    return raw, diagnostics, objective_packet


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
    return allocate_sparse_tangent_with_evidence(
        candidates,
        return_history,
        top_k=top_k,
        max_weight=max_weight,
        daily_vol_floor=daily_vol_floor,
    )["weights"]


def allocate_sparse_tangent_with_evidence(
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    *,
    top_k: int,
    max_weight: float = 0.55,
    max_cluster_weight: float | None = None,
    daily_vol_floor: float = 0.01,
    cluster_edge_threshold: float | None = None,
    cluster_threshold_quantile: float = 0.9,
    allocation_objective: str = "mean_variance_alpha_utility",
    alpha_strength: float = 1.0,
    risk_aversion: float = 2.0,
    turnover_penalty: float = 0.0,
    l2_penalty: float = 0.0,
    utility_iterations: int = 180,
) -> dict[str, Any]:
    """Long-only sparse alpha weights over the current candidate set.

    Expected return comes from candidate expected_return/predicted_return when
    available. The production objective keeps alpha, LedoitWolf covariance risk,
    and turnover friction in one utility. If covariance evidence is unavailable
    but positive edge exists, keep the diagonal variance-floor risk path instead
    of reverting to rank-topK. If positive edge is missing, return empty weights
    and keep cash.
    """
    # Production sparse allocation evaluates the full eligible candidate pool.
    # `top_k` is a maximum final holding count, not a pre-optimization rank gate.
    evaluated = sorted([row for row in candidates if _symbol(row)], key=_score, reverse=True)
    symbols = [_symbol(row) for row in evaluated]
    expected_returns = [max(0.0, _expected_return(row)) for row in evaluated]
    empty_evidence = {
        "weights": {},
        "candidate_pool_policy": "full_eligible_pool_before_sparse_selection",
        "evaluated_candidate_count": len(evaluated),
        "max_selected_count": max(1, int(top_k)),
        "similarity_evidence": similarity_components(
            symbols,
            return_history,
            weights={},
            edge_threshold=cluster_edge_threshold,
            threshold_quantile=cluster_threshold_quantile,
            daily_vol_floor=daily_vol_floor,
        ) if symbols else {
            "schema_version": "similarity-evidence-v1",
            "evidence_only": True,
            "method": "networkx_connected_components_abs_correlation",
            "node_count": 0,
            "edge_count": 0,
            "component_count": 0,
            "effective_independent_count": 0.0,
            "pairwise_corr_max": 0.0,
            "edge_threshold": 1.0,
            "edge_threshold_source": "empty_universe",
            "covariance_method": "empty_universe",
            "covariance_shrinkage": None,
            "observation_count": 0,
            "clusters": [],
            "symbol_cluster": {},
        },
        "cluster_penalty_applied": False,
        "max_cluster_weight": max_cluster_weight if max_cluster_weight is not None else max_weight,
        "unallocated_cash_weight": 1.0,
        "allocation_objective": allocation_objective,
        "objective_evidence": {
            "objective": "empty_or_no_positive_edge",
            "cash_allowed": True,
            "budget_used": 0.0,
        },
        "candidate_diagnostics": {},
    }
    if not any(value > 0 for value in expected_returns):
        return empty_evidence
    var_floor = max(1e-8, daily_vol_floor * daily_vol_floor)
    covariance_packet = ledoit_wolf_covariance(
        symbols,
        return_history,
        daily_vol_floor=daily_vol_floor,
    )
    covariance = covariance_packet.get("covariance") or _diagonal_covariance_matrix(len(symbols), var_floor)
    objective = str(allocation_objective or "mean_variance_alpha_utility").strip()
    if objective in {"mean_variance_alpha_utility", "alpha_utility_sparse"}:
        raw, candidate_diagnostics, objective_evidence = _alpha_utility_raw(
            symbols,
            evaluated,
            expected_returns,
            covariance,
            max_weight=max_weight,
            daily_vol_floor=daily_vol_floor,
            alpha_strength=alpha_strength,
            risk_aversion=risk_aversion,
            turnover_penalty=turnover_penalty,
            l2_penalty=l2_penalty,
            iterations=utility_iterations,
        )
    else:
        raw = _long_only_tangent_raw(symbols, expected_returns, covariance)
        diag = _covariance_diag(covariance, len(symbols), var_floor)
        candidate_diagnostics = {
            symbol: {
                "optimizer_objective": "sparse_tangent_inverse_risk_legacy",
                "alpha_input": round(expected_returns[idx], 10),
                "individual_variance": round(diag[idx], 10),
                "individual_volatility": round(math.sqrt(diag[idx]), 10),
                "final_weight": 0.0,
            }
            for idx, symbol in enumerate(symbols)
        }
        objective_evidence = {
            "objective": "sparse_tangent_inverse_risk_legacy",
            "cash_allowed": False,
            "budget_used": 1.0 if raw else 0.0,
        }
    if not any(value > 0 for value in raw.values()):
        return {
            **empty_evidence,
            "similarity_evidence": similarity_components(
                symbols,
                return_history,
                weights={},
                edge_threshold=cluster_edge_threshold,
                threshold_quantile=cluster_threshold_quantile,
                daily_vol_floor=daily_vol_floor,
            ),
            "unallocated_cash_weight": 1.0,
            "objective_evidence": objective_evidence,
            "candidate_diagnostics": candidate_diagnostics,
        }
    if objective in {"mean_variance_alpha_utility", "alpha_utility_sparse"}:
        weights = {
            symbol: min(max_weight, max(0.0, float(weight)))
            for symbol, weight in raw.items()
            if float(weight) > 1e-8
        }
    else:
        weights = _cap_and_renormalize(raw, max_weight=max_weight)
    selected_cap = max(1, int(top_k))
    if len(weights) > selected_cap:
        weights = dict(
            sorted(weights.items(), key=lambda item: (-item[1], item[0]))[:selected_cap]
        )
        if objective not in {"mean_variance_alpha_utility", "alpha_utility_sparse"}:
            weights = _cap_and_renormalize(weights, max_weight=max_weight)
    similarity = similarity_components(
        symbols,
        return_history,
        weights=weights,
        edge_threshold=cluster_edge_threshold,
        threshold_quantile=cluster_threshold_quantile,
        daily_vol_floor=daily_vol_floor,
    )
    capped_weights, cluster_penalty_applied = apply_cluster_exposure_cap(
        weights,
        similarity,
        max_cluster_weight=max_cluster_weight if max_cluster_weight is not None else max_weight,
        preserve_total_weight=objective in {"mean_variance_alpha_utility", "alpha_utility_sparse"},
    )
    if cluster_penalty_applied:
        similarity = similarity_components(
            symbols,
            return_history,
            weights=capped_weights,
            edge_threshold=cluster_edge_threshold,
            threshold_quantile=cluster_threshold_quantile,
            daily_vol_floor=daily_vol_floor,
        )
    unallocated_cash_weight = round(max(0.0, 1.0 - sum(capped_weights.values())), 10)
    for symbol, diagnostic in candidate_diagnostics.items():
        diagnostic["final_weight"] = round(float(capped_weights.get(symbol, 0.0) or 0.0), 10)
    return {
        "weights": capped_weights,
        "candidate_pool_policy": "full_eligible_pool_before_sparse_selection",
        "evaluated_candidate_count": len(evaluated),
        "max_selected_count": selected_cap,
        "similarity_evidence": {
            **similarity,
            "covariance_method": covariance_packet.get("covariance_method") or similarity.get("covariance_method"),
            "covariance_shrinkage": covariance_packet.get("covariance_shrinkage"),
            "observation_count": covariance_packet.get("observation_count"),
        },
        "cluster_penalty_applied": cluster_penalty_applied,
        "max_cluster_weight": max_cluster_weight if max_cluster_weight is not None else max_weight,
        "unallocated_cash_weight": unallocated_cash_weight,
        "allocation_objective": objective,
        "objective_evidence": {
            **objective_evidence,
            "budget_used": round(sum(capped_weights.values()), 10),
            "unallocated_cash_weight": unallocated_cash_weight,
        },
        "candidate_diagnostics": candidate_diagnostics,
    }


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
