"""Implementable-frontier shadow challenger for the sparse allocator.

This is an RFS-inspired engineering implementation, not a claim of reproducing a
specific paper. It evaluates the full eligible pool, models incremental rebalance
cost from the incumbent target, and can never control production weights.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from services.portfolio_allocation import ledoit_wolf_covariance

SCHEMA_VERSION = "portfolio-ml-implementable-frontier-shadow-v2"
METHOD = "portfolio_ml_inspired_direct_weight_cost_aware_shadow"
FORMAL_EXPECTED_RETURN_OWNERS = {"l4_alpha_ev", "allocator_ev_fusion"}


def _finite(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _symbol(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or "").strip()


def _project_capped_budget(values: list[float], *, cap: float, budget: float = 1.0) -> list[float]:
    cap = max(0.0, min(1.0, float(cap)))
    budget = max(0.0, min(1.0, float(budget)))
    clipped = [min(cap, max(0.0, value)) for value in values]
    if sum(clipped) <= budget + 1e-12:
        return clipped
    low = min(value - cap for value in values)
    high = max(values)
    for _ in range(80):
        threshold = (low + high) / 2.0
        projected = [min(cap, max(0.0, value - threshold)) for value in values]
        if sum(projected) > budget:
            low = threshold
        else:
            high = threshold
    return [min(cap, max(0.0, value - high)) for value in values]


def _adv_twd(row: dict[str, Any]) -> float | None:
    for key in ("avg_daily_turnover_twd", "adv_twd", "adtv_twd"):
        value = _finite(row.get(key))
        if value is not None and value > 0:
            return value
    price = _finite(row.get("current_price"))
    volume = _finite(row.get("avg_volume_20") or row.get("average_volume_20"))
    if price is not None and price > 0 and volume is not None and volume > 0:
        return price * volume
    return None


def _covariance_packet(
    symbols: list[str],
    return_history: dict[str, list[float]],
    *,
    daily_vol_floor: float,
) -> tuple[list[list[float]], dict[str, Any]]:
    packet = ledoit_wolf_covariance(
        symbols,
        return_history,
        daily_vol_floor=daily_vol_floor,
    )
    covariance = packet.get("covariance")
    if not isinstance(covariance, list) or len(covariance) != len(symbols):
        floor = max(1e-8, daily_vol_floor * daily_vol_floor)
        covariance = [
            [floor if left == right else 0.0 for right in range(len(symbols))]
            for left in range(len(symbols))
        ]
    return covariance, packet


def _portfolio_variance(weights: list[float], covariance: list[list[float]]) -> float:
    return max(
        0.0,
        sum(
            weights[left] * weights[right] * float(covariance[left][right])
            for left in range(len(weights))
            for right in range(len(weights))
        ),
    )


def _effective_holdings(weights: list[float]) -> float:
    positive = [float(weight) for weight in weights if float(weight) > 0]
    gross = sum(positive)
    concentration = sum(weight * weight for weight in positive)
    return gross * gross / concentration if concentration > 0 else 0.0


def build_rfs_implementable_frontier_shadow(
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    *,
    incumbent_weights: dict[str, float] | None = None,
    inherited_weights: dict[str, float] | None = None,
    portfolio_ml_inputs: dict[str, Any] | None = None,
    portfolio_value_twd: float = 1_000_000.0,
    max_weight: float = 0.25,
    risk_aversion: float = 2.0,
    l2_penalty: float = 0.001,
    fee_bps: float = 9.0,
    half_spread_bps: float = 5.0,
    slippage_bps: float = 3.0,
    impact_coefficient_bps: float = 10.0,
    daily_vol_floor: float = 0.01,
    iterations: int = 240,
    comparison_only_shadow_alpha: bool = False,
    as_of_date: str | None = None,
) -> dict[str, Any]:
    """Build a cost-aware aim portfolio with production_effect fixed to false."""

    owner_eligible = sorted(
        [
            row
            for row in candidates
            if _symbol(row)
            and (
                str(row.get("expected_return_owner") or "") in FORMAL_EXPECTED_RETURN_OWNERS
                or (
                    comparison_only_shadow_alpha
                    and str(row.get("expected_return_owner") or "") == "portfolio_ml_shadow"
                )
            )
            and _finite(row.get("expected_return")) is not None
        ],
        key=_symbol,
    )
    owner_adv = {_symbol(row): _adv_twd(row) for row in owner_eligible}
    eligible = [row for row in owner_eligible if owner_adv[_symbol(row)] is not None]
    excluded_missing_adv = sorted({_symbol(row) for row in owner_eligible} - {_symbol(row) for row in eligible})
    symbols = [_symbol(row) for row in eligible]
    incumbent = incumbent_weights or {}
    inherited = inherited_weights
    portfolio_inputs = portfolio_ml_inputs if isinstance(portfolio_ml_inputs, dict) else {}
    multi_horizon_paths = portfolio_inputs.get("multi_horizon_expected_return_path") or {}

    def portfolio_expected_return(row: dict[str, Any]) -> float:
        symbol = _symbol(row)
        path = multi_horizon_paths.get(symbol) if isinstance(multi_horizon_paths, dict) else None
        if isinstance(path, dict):
            normalized: list[float] = []
            for horizon in (3, 5, 10):
                value = _finite(path.get(horizon) if horizon in path else path.get(str(horizon)))
                if value is not None:
                    normalized.append(value * (5.0 / horizon))
            if len(normalized) == 3:
                return sum(normalized) / len(normalized)
        return float(_finite(row.get("expected_return"), 0.0) or 0.0)

    expected = [portfolio_expected_return(row) for row in eligible]
    adv = [owner_adv[symbol] for symbol in symbols]
    history_covered = [symbol for symbol in symbols if len(return_history.get(symbol) or []) >= 20]
    validation_blockers: list[str] = []
    if not owner_eligible:
        validation_blockers.append("formal_expected_return_candidates_missing")
    elif not symbols:
        validation_blockers.append("tradability_evidence_candidates_missing")
    adv_coverage = (
        (len(owner_eligible) - len(excluded_missing_adv)) / len(owner_eligible)
        if owner_eligible else 0.0
    )
    history_coverage = len(history_covered) / len(symbols) if symbols else 0.0
    if adv_coverage < 0.8:
        validation_blockers.append("adv_coverage_below_80pct")
    if history_coverage < 0.8:
        validation_blockers.append("return_history_coverage_below_80pct")
    if inherited is None:
        validation_blockers.append("inherited_portfolio_weights_missing")
    inherited_outside_pool = sorted(
        symbol for symbol, weight in (inherited or {}).items()
        if float(weight or 0.0) > 0 and symbol not in symbols
    )
    if inherited_outside_pool:
        validation_blockers.append("inherited_positions_outside_tradeable_candidate_pool")
    portfolio_status = str(portfolio_inputs.get("status") or "missing")
    if portfolio_status != "shadow_ready":
        validation_blockers.extend(
            str(value) for value in (portfolio_inputs.get("validation_blockers") or ["portfolio_ml_inputs_not_ready"])
        )

    if not symbols:
        payload = {
            "schema_version": SCHEMA_VERSION,
            "method": METHOD,
            "as_of_date": as_of_date,
            "status": "insufficient_evidence",
            "production_effect": False,
            "promotion_eligible": False,
            "validation_blockers": validation_blockers,
            "candidate_pool_policy": "full_formal_expected_return_pool_no_hard_top_k",
        "source_expected_return_candidate_count": len(owner_eligible),
        "excluded_missing_adv_symbols": excluded_missing_adv,
        "inherited_positions_outside_pool": inherited_outside_pool,
            "weights": {},
        }
        payload["packet_checksum"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return payload

    covariance, covariance_evidence = _covariance_packet(
        symbols,
        return_history,
        daily_vol_floor=daily_vol_floor,
    )
    incumbent_target = _project_capped_budget(
        [max(0.0, float(incumbent.get(symbol, 0.0) or 0.0)) for symbol in symbols],
        cap=max_weight,
    )
    cost_reference = inherited if inherited is not None else incumbent
    w0 = _project_capped_budget(
        [max(0.0, float(cost_reference.get(symbol, 0.0) or 0.0)) for symbol in symbols],
        cap=max_weight,
    )
    weights = list(w0)
    portfolio_value = max(1.0, float(portfolio_value_twd))
    risk_aversion = max(0.0, float(risk_aversion))
    l2_penalty = max(0.0, float(l2_penalty))
    base_cost_rate = max(0.0, fee_bps + half_spread_bps + slippage_bps) / 10000.0
    impact_rate = max(0.0, impact_coefficient_bps) / 10000.0
    max_row_sum = max(
        sum(abs(float(value)) for value in row)
        for row in covariance
    )
    step = min(10.0, max(0.01, 1.0 / max(1e-6, 2.0 * risk_aversion * max_row_sum + 2.0 * l2_penalty)))

    for _ in range(max(40, min(500, int(iterations)))):
        cov_w = [
            sum(float(covariance[left][right]) * weights[right] for right in range(len(symbols)))
            for left in range(len(symbols))
        ]
        smooth_gradient: list[float] = []
        for idx, weight in enumerate(weights):
            delta = weight - w0[idx]
            sign = 1.0 if delta > 0 else (-1.0 if delta < 0 else 0.0)
            participation = (
                abs(delta) * portfolio_value / float(adv[idx])
                if adv[idx] is not None and float(adv[idx]) > 0
                else 0.0
            )
            nonlinear_marginal_cost = 1.5 * impact_rate * math.sqrt(max(0.0, participation))
            smooth_gradient.append(
                expected[idx]
                - 2.0 * risk_aversion * cov_w[idx]
                - 2.0 * l2_penalty * weight
                - sign * nonlinear_marginal_cost
            )
        unconstrained = [
            weights[idx] + step * smooth_gradient[idx]
            for idx in range(len(symbols))
        ]
        proposal = []
        for idx, value in enumerate(unconstrained):
            delta_from_incumbent = value - w0[idx]
            thresholded_delta = max(0.0, abs(delta_from_incumbent) - step * base_cost_rate)
            proposal.append(
                w0[idx]
                + (1.0 if delta_from_incumbent > 0 else -1.0) * thresholded_delta
                if delta_from_incumbent != 0
                else w0[idx]
            )
        next_weights = _project_capped_budget(proposal, cap=max_weight)
        if max(abs(next_weights[idx] - weights[idx]) for idx in range(len(symbols))) < 1e-10:
            weights = next_weights
            break
        weights = next_weights

    static_aim_weights = list(weights)
    direct_targets = portfolio_inputs.get("direct_weight_targets") or {}
    dynamic_speeds = portfolio_inputs.get("dynamic_trading_speeds") or {}
    if portfolio_status == "shadow_ready" and isinstance(direct_targets, dict):
        direct_aim = _project_capped_budget(
            [max(0.0, float(_finite(direct_targets.get(symbol), 0.0) or 0.0)) for symbol in symbols],
            cap=max_weight,
        )
        grown: list[float] = []
        for idx, symbol in enumerate(symbols):
            speed = max(0.05, min(1.0, float(_finite(dynamic_speeds.get(symbol), 0.25) or 0.25)))
            raw_delta = speed * (direct_aim[idx] - w0[idx])
            participation = (
                abs(raw_delta) * portfolio_value / float(adv[idx])
                if adv[idx] is not None and float(adv[idx]) > 0
                else 0.0
            )
            marginal_cost = base_cost_rate + impact_rate * math.sqrt(max(0.0, participation))
            directional_edge = expected[idx] if raw_delta > 0 else -expected[idx]
            if raw_delta != 0 and directional_edge <= marginal_cost:
                raw_delta = 0.0
            grown.append(w0[idx] + raw_delta)
        weights = _project_capped_budget(grown, cap=max_weight)

    deltas = [weights[idx] - w0[idx] for idx in range(len(symbols))]
    cost_by_symbol: dict[str, dict[str, Any]] = {}
    total_cost = 0.0
    for idx, symbol in enumerate(symbols):
        participation = (
            abs(deltas[idx]) * portfolio_value / float(adv[idx])
            if adv[idx] is not None and float(adv[idx]) > 0
            else None
        )
        nonlinear_rate = impact_rate * math.sqrt(max(0.0, participation or 0.0))
        cost = abs(deltas[idx]) * (base_cost_rate + nonlinear_rate)
        total_cost += cost
        cost_by_symbol[symbol] = {
            "delta_weight": round(deltas[idx], 10),
            "adv_twd": adv[idx],
            "participation_rate": round(participation, 10) if participation is not None else None,
            "linear_cost_rate": round(base_cost_rate, 10),
            "nonlinear_impact_rate": round(nonlinear_rate, 10),
            "estimated_cost": round(cost, 10),
        }

    incumbent_deltas = [incumbent_target[idx] - w0[idx] for idx in range(len(symbols))]
    incumbent_total_cost = 0.0
    for idx, delta in enumerate(incumbent_deltas):
        participation = (
            abs(delta) * portfolio_value / float(adv[idx])
            if adv[idx] is not None and float(adv[idx]) > 0
            else 0.0
        )
        incumbent_total_cost += abs(delta) * (
            base_cost_rate + impact_rate * math.sqrt(max(0.0, participation))
        )
    static_deltas = [static_aim_weights[idx] - w0[idx] for idx in range(len(symbols))]
    static_total_cost = 0.0
    for idx, delta in enumerate(static_deltas):
        participation = (
            abs(delta) * portfolio_value / float(adv[idx])
            if adv[idx] is not None and float(adv[idx]) > 0
            else 0.0
        )
        static_total_cost += abs(delta) * (
            base_cost_rate + impact_rate * math.sqrt(max(0.0, participation))
        )
    incumbent_expected = sum(incumbent_target[idx] * expected[idx] for idx in range(len(symbols)))
    static_expected = sum(static_aim_weights[idx] * expected[idx] for idx in range(len(symbols)))
    challenger_expected = sum(weights[idx] * expected[idx] for idx in range(len(symbols)))
    incumbent_variance = _portfolio_variance(incumbent_target, covariance)
    static_variance = _portfolio_variance(static_aim_weights, covariance)
    challenger_variance = _portfolio_variance(weights, covariance)
    incumbent_utility = incumbent_expected - risk_aversion * incumbent_variance - incumbent_total_cost
    static_utility = static_expected - risk_aversion * static_variance - static_total_cost
    challenger_utility = challenger_expected - risk_aversion * challenger_variance - total_cost
    weight_map = {
        symbol: round(weights[idx], 10)
        for idx, symbol in enumerate(symbols)
        if weights[idx] > 1e-8
    }
    incumbent_map = {
        symbol: round(incumbent_target[idx], 10)
        for idx, symbol in enumerate(symbols)
        if incumbent_target[idx] > 1e-8
    }
    payload = {
        "schema_version": SCHEMA_VERSION,
        "method": METHOD,
        "as_of_date": as_of_date,
        "status": "shadow_ready" if not validation_blockers else "shadow_observation_only",
        "production_effect": False,
        "promotion_eligible": False,
        "validation_blockers": validation_blockers,
        "candidate_pool_policy": "full_formal_expected_return_pool_no_hard_top_k",
        "source_expected_return_candidate_count": len(owner_eligible),
        "excluded_missing_adv_symbols": excluded_missing_adv,
        "inherited_positions_outside_pool": inherited_outside_pool,
        "formal_expected_return_owner_only": not comparison_only_shadow_alpha,
        "comparison_only_shadow_alpha_input": bool(comparison_only_shadow_alpha),
        "incumbent_role": "sparse_allocator_production_owner",
        "challenger_role": "portfolio_ml_direct_weight_shadow_with_sparse_projector",
        "paper_alignment": "portfolio_ml_inspired_not_exact_paper_replication",
        "cost_reference": (
            "inherited_portfolio_weights" if inherited is not None else "incumbent_target_placeholder"
        ),
        "research_components_not_yet_implemented": (
            [] if portfolio_status == "shadow_ready" else [
                "multi_horizon_expected_return_path",
                "grown_inherited_position",
                "learned_dynamic_trading_speed",
                "direct_portfolio_weight_ml",
            ]
        ),
        "portfolio_ml_inputs": {
            "schema_version": portfolio_inputs.get("schema_version"),
            "status": portfolio_status,
            "training_row_count": portfolio_inputs.get("training_row_count"),
            "training_date_count": portfolio_inputs.get("training_date_count"),
            "horizon_sample_counts": portfolio_inputs.get("horizon_sample_counts") or {},
            "production_effect": False,
        },
        "post_challenger_projector": "sparse_allocator_constraints_required_before_any_future_promotion",
        "weights": weight_map,
        "incumbent_weights": incumbent_map,
        "static_aim_weights": {
            symbol: round(static_aim_weights[idx], 10)
            for idx, symbol in enumerate(symbols)
            if static_aim_weights[idx] > 1e-8
        },
        "cost_by_symbol": cost_by_symbol,
        "metrics": {
            "candidate_count": len(symbols),
            "selected_count": len(weight_map),
            "adv_coverage_ratio": round(adv_coverage, 6),
            "return_history_coverage_ratio": round(history_coverage, 6),
            "turnover_l1": round(sum(abs(delta) for delta in deltas), 10),
            "estimated_incremental_rebalance_cost": round(total_cost, 10),
            "incumbent_rebalance_cost": round(incumbent_total_cost, 10),
            "incumbent_expected_return": round(incumbent_expected, 10),
            "challenger_expected_return": round(challenger_expected, 10),
            "incumbent_variance": round(incumbent_variance, 10),
            "challenger_variance": round(challenger_variance, 10),
            "incumbent_utility": round(incumbent_utility, 10),
            "challenger_net_utility": round(challenger_utility, 10),
            "incumbent_effective_holdings": round(_effective_holdings(incumbent_target), 6),
            "inherited_effective_holdings": round(_effective_holdings(w0), 6),
            "challenger_effective_holdings": round(_effective_holdings(weights), 6),
            "static_aim_selected_count": sum(weight > 1e-8 for weight in static_aim_weights),
            "static_aim_effective_holdings": round(_effective_holdings(static_aim_weights), 6),
            "static_aim_expected_return": round(static_expected, 10),
            "static_aim_variance": round(static_variance, 10),
            "static_aim_estimated_rebalance_cost": round(static_total_cost, 10),
            "static_aim_net_utility": round(static_utility, 10),
            "static_aim_unallocated_cash_weight": round(max(0.0, 1.0 - sum(static_aim_weights)), 10),
            "static_aim_turnover_l1": round(sum(abs(static_aim_weights[idx] - w0[idx]) for idx in range(len(symbols))), 10),
            "portfolio_ml_applied": portfolio_status == "shadow_ready",
            "unallocated_cash_weight": round(max(0.0, 1.0 - sum(weights)), 10),
        },
        "cost_model": {
            "semantic": "incremental_delta_weight_fee_spread_slippage_sqrt_adv_impact",
            "portfolio_value_twd": portfolio_value,
            "fee_bps": fee_bps,
            "half_spread_bps": half_spread_bps,
            "slippage_bps": slippage_bps,
            "impact_coefficient_bps": impact_coefficient_bps,
        },
        "covariance_evidence": {
            "method": covariance_evidence.get("covariance_method"),
            "shrinkage": covariance_evidence.get("covariance_shrinkage"),
            "observation_count": covariance_evidence.get("observation_count"),
        },
    }
    checksum_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    payload["packet_checksum"] = hashlib.sha256(checksum_payload.encode("utf-8")).hexdigest()
    return payload
