"""OnlinePortfolioBandit allocator-knob controller.

The bandit chooses allocator knobs only. Final weights still come from the
sparse tangent inverse-risk allocator, and the packet cannot submit orders.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from services.portfolio_allocation import allocate_sparse_tangent_with_evidence

SCHEMA_VERSION = "online-portfolio-bandit-controller-v2"
REWARD_WINDOW_DAYS = 60
REWARD_HALF_LIFE_DAYS = 20.0


@dataclass(frozen=True)
class PortfolioBanditArm:
    arm_id: str
    candidate_cap: int
    max_weight: float
    cash_buffer: float
    min_trade_weight: float
    turnover_budget: float
    prior_reward_mean: float
    prior_samples: int


DEFAULT_ARMS: tuple[PortfolioBanditArm, ...] = (
    PortfolioBanditArm("diversified_alpha", 8, 0.28, 0.08, 0.03, 0.35, 0.0040, 24),
    PortfolioBanditArm("diversified_all_eligible", 12, 0.22, 0.10, 0.025, 0.30, 0.0030, 24),
    PortfolioBanditArm("liquidity_diversified", 10, 0.24, 0.12, 0.025, 0.25, 0.0035, 24),
    PortfolioBanditArm("conservative_diversified", 6, 0.20, 0.20, 0.04, 0.18, 0.0025, 24),
    PortfolioBanditArm("high_score_conservative", 5, 0.32, 0.18, 0.04, 0.20, 0.0030, 24),
)


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _to_int(value: object, default: int = 0) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError):
        return default
    return out if out >= 0 else default


def _decayed_reward_stats(history: list[dict[str, Any]]) -> dict[str, float] | None:
    valid = [
        row for row in history
        if isinstance(row, dict) and _to_float(row.get("reward"), float("nan")) == _to_float(row.get("reward"), float("nan"))
    ][-REWARD_WINDOW_DAYS:]
    if not valid:
        return None
    decay = math.log(2.0) / REWARD_HALF_LIFE_DAYS
    weights = [math.exp(-decay * age) for age in reversed(range(len(valid)))]
    rewards = [_to_float(row.get("reward"), 0.0) for row in valid]
    weight_sum = sum(weights)
    return {
        "samples": float(len(valid)),
        "effective_samples": weight_sum,
        "reward_mean": sum(weight * reward for weight, reward in zip(weights, rewards, strict=True)) / weight_sum,
    }


def _ledger_by_arm(reward_ledger: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in reward_ledger:
        policy_id = str(row.get("policy_id") or "OnlinePortfolioBandit").strip()
        if policy_id != "OnlinePortfolioBandit":
            continue
        arm_id = str(row.get("arm_id") or "").strip()
        if not arm_id:
            continue
        history = row.get("reward_history") if isinstance(row.get("reward_history"), list) else []
        decayed = _decayed_reward_stats(history)
        samples = _to_int((decayed or {}).get("samples", row.get("samples")), 0)
        reward_mean = _to_float((decayed or {}).get("reward_mean", row.get("reward_mean")), 0.0)
        if samples <= 0:
            continue
        out[arm_id] = {
            "samples": float(samples),
            "reward_mean": reward_mean,
            "effective_samples": float((decayed or {}).get("effective_samples", samples)),
            "reward_estimator": "sliding_window_exponential_decay" if decayed else "aggregate_fallback",
            "reward_window_days": REWARD_WINDOW_DAYS if decayed else None,
            "reward_half_life_days": REWARD_HALF_LIFE_DAYS if decayed else None,
            "reward_mean_r": _to_float(row.get("reward_mean_r"), 0.0),
            "reward_r_samples": float(_to_int(row.get("reward_r_samples"), 0)),
            "reward_source_counts": row.get("reward_source_counts") if isinstance(row.get("reward_source_counts"), dict) else {},
            "reward_policy": str(row.get("reward_policy") or "").strip(),
        }
    return out


def _warm_started_arm_stats(
    arm: PortfolioBanditArm,
    ledger: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    row = ledger.get(arm.arm_id, {})
    live_samples = int(row.get("samples", 0))
    live_reward_mean = _to_float(row.get("reward_mean"), 0.0)
    live_effective_samples = _to_float(row.get("effective_samples"), float(live_samples))
    total_samples = max(1.0, arm.prior_samples + live_effective_samples)
    reward_sum = arm.prior_reward_mean * arm.prior_samples + live_reward_mean * live_effective_samples
    return {
        "samples": total_samples,
        "reward_mean": reward_sum / total_samples,
        "prior_samples": float(arm.prior_samples),
        "live_samples": float(live_samples),
        "live_effective_samples": live_effective_samples,
        "live_reward_mean": live_reward_mean,
        "live_reward_mean_r": _to_float(row.get("reward_mean_r"), 0.0),
        "live_reward_r_samples": float(_to_int(row.get("reward_r_samples"), 0)),
        "reward_source_counts": row.get("reward_source_counts") if isinstance(row.get("reward_source_counts"), dict) else {},
        "reward_policy": str(row.get("reward_policy") or "").strip(),
        "reward_estimator": str(row.get("reward_estimator") or "aggregate_fallback"),
        "reward_window_days": row.get("reward_window_days"),
        "reward_half_life_days": row.get("reward_half_life_days"),
    }


def _ucb_score(stats: dict[str, float], total_samples: int, exploration_alpha: float) -> float:
    samples = max(1.0, stats["samples"])
    exploration = exploration_alpha * math.sqrt(math.log(max(2, total_samples)) / samples)
    return stats["reward_mean"] + exploration


def _normalize_to_exposure(
    weights: dict[str, float],
    *,
    target_exposure: float,
    min_trade_weight: float,
) -> dict[str, float]:
    target = max(0.0, min(1.0, target_exposure))
    kept = {
        symbol: max(0.0, _to_float(weight))
        for symbol, weight in weights.items()
        if _to_float(weight) >= min_trade_weight
    }
    total = sum(kept.values())
    if total <= 0:
        return {}
    return {symbol: (weight / total) * target for symbol, weight in kept.items()}


def _candidate_score(row: dict[str, Any]) -> float:
    return _to_float(row.get("score"), 0.0)


def _candidate_feature_summary(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    qualities: list[float] = []
    target_states: dict[str, int] = {}
    conditional_count = 0
    positive_edge_count = 0
    for row in candidates or []:
        quality = _to_float(row.get("allocator_edge_quality_score"), float("nan"))
        if math.isfinite(quality):
            qualities.append(quality)
        state = str(row.get("s12_target_quality_state") or "unknown").strip() or "unknown"
        target_states[state] = target_states.get(state, 0) + 1
        if row.get("conditional_admission_allowed") is True:
            conditional_count += 1
        if _to_float(row.get("expected_return"), 0.0) > 0:
            positive_edge_count += 1
    return {
        "schema_version": "opb-candidate-feature-summary-v1",
        "candidate_count": len(candidates or []),
        "positive_edge_count": positive_edge_count,
        "allocator_edge_quality_avg": round(sum(qualities) / len(qualities), 6) if qualities else None,
        "allocator_edge_quality_max": round(max(qualities), 6) if qualities else None,
        "conditional_admission_count": conditional_count,
        "s12_target_quality_state_counts": target_states,
        "learning_role": "candidate_features_recorded_for_opb_reward_attribution_not_direct_order_signal",
    }


def _is_production_controller_stage(stage: str) -> bool:
    normalized = str(stage or "").lower()
    return normalized.startswith("l3_") or "production" in normalized


def build_online_portfolio_bandit_l2_packet(
    *,
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    reward_ledger: list[dict[str, Any]] | None = None,
    exploration_alpha: float = 0.05,
    arms: tuple[PortfolioBanditArm, ...] = DEFAULT_ARMS,
    stage: str = "L2_paper_active",
    candidate_cap_limit: int | None = None,
    max_cluster_weight: float | None = None,
    cluster_edge_threshold: float | None = None,
    cluster_threshold_quantile: float = 0.9,
    allocation_objective: str = "mean_variance_alpha_utility",
    alpha_strength: float = 1.0,
    risk_aversion: float = 2.0,
    turnover_penalty: float = 0.0,
    l2_penalty: float = 0.0,
    utility_iterations: int = 180,
) -> dict[str, Any]:
    """Select allocator knobs with warm-start UCB and compute allocation weights."""

    ledger = _ledger_by_arm(reward_ledger or [])
    arm_rows: list[dict[str, Any]] = []
    total_samples = 0
    for arm in arms:
        stats = _warm_started_arm_stats(arm, ledger)
        total_samples += int(stats["samples"])
        arm_rows.append({"arm": arm, "stats": stats})

    scored: list[dict[str, Any]] = []
    for row in arm_rows:
        arm = row["arm"]
        stats = row["stats"]
        effective_candidate_cap = arm.candidate_cap
        if candidate_cap_limit is not None:
            effective_candidate_cap = max(1, min(arm.candidate_cap, int(candidate_cap_limit)))
        feasible_floor = min(0.70, 1.0 / effective_candidate_cap + 0.05)
        effective_max_weight = max(arm.max_weight, feasible_floor)
        scored.append({
            "arm_id": arm.arm_id,
            "ucb_score": _ucb_score(stats, total_samples, exploration_alpha),
            "reward_mean": stats["reward_mean"],
            "live_reward_mean": stats["live_reward_mean"],
            "live_reward_mean_r": stats["live_reward_mean_r"],
            "live_reward_r_samples": int(stats["live_reward_r_samples"]),
            "reward_source_counts": stats.get("reward_source_counts") or {},
            "reward_policy": stats.get("reward_policy") or None,
            "samples": int(stats["samples"]),
            "prior_samples": int(stats["prior_samples"]),
            "live_samples": int(stats["live_samples"]),
            "live_effective_samples": round(float(stats["live_effective_samples"]), 6),
            "reward_estimator": stats["reward_estimator"],
            "reward_window_days": stats["reward_window_days"],
            "reward_half_life_days": stats["reward_half_life_days"],
            "knobs": {
                "candidate_cap": effective_candidate_cap,
                "max_weight": effective_max_weight,
                "cash_buffer": arm.cash_buffer,
                "min_trade_weight": arm.min_trade_weight,
                "turnover_budget": arm.turnover_budget,
            },
        })
    scored.sort(key=lambda item: (item["ucb_score"], item["reward_mean"]), reverse=True)
    selected = scored[0] if scored else None
    selected_arm = next((arm for arm in arms if selected and arm.arm_id == selected["arm_id"]), None)

    ranked_candidates = sorted(candidates, key=_candidate_score, reverse=True)
    candidate_feature_summary = _candidate_feature_summary(ranked_candidates)
    raw_weights: dict[str, float] = {}
    final_weights: dict[str, float] = {}
    sparse_evidence: dict[str, Any] = {}
    cash_weight = 1.0
    if selected_arm is not None and ranked_candidates:
        knobs = selected.get("knobs", {}) if selected else {}
        sparse_evidence = allocate_sparse_tangent_with_evidence(
            ranked_candidates,
            return_history,
            top_k=int(knobs.get("candidate_cap") or selected_arm.candidate_cap),
            max_weight=float(knobs.get("max_weight") or selected_arm.max_weight),
            max_cluster_weight=max_cluster_weight,
            cluster_edge_threshold=cluster_edge_threshold,
            cluster_threshold_quantile=cluster_threshold_quantile,
            allocation_objective=allocation_objective,
            alpha_strength=alpha_strength,
            risk_aversion=risk_aversion,
            turnover_penalty=turnover_penalty,
            l2_penalty=l2_penalty,
            utility_iterations=utility_iterations,
        )
        raw_weights = dict(sparse_evidence.get("weights") or {})
        final_weights = _normalize_to_exposure(
            raw_weights,
            target_exposure=1.0 - selected_arm.cash_buffer,
            min_trade_weight=selected_arm.min_trade_weight,
        )
        cash_weight = max(0.0, 1.0 - sum(final_weights.values()))
        candidate_diagnostics = dict(sparse_evidence.get("candidate_diagnostics") or {})
        if candidate_diagnostics:
            candidates_by_symbol = {
                str(row.get("symbol") or "").strip(): row
                for row in ranked_candidates
                if str(row.get("symbol") or "").strip()
            }
            candidate_diagnostics = {
                symbol: {
                    **diagnostic,
                    "allocator_edge_quality_score": (
                        candidates_by_symbol.get(symbol, {}).get("allocator_edge_quality_score")
                    ),
                    "conditional_admission_allowed": (
                        candidates_by_symbol.get(symbol, {}).get("conditional_admission_allowed")
                    ),
                    "s12_target_quality_state": (
                        candidates_by_symbol.get(symbol, {}).get("s12_target_quality_state")
                    ),
                    "final_weight": round(float(final_weights.get(symbol, 0.0) or 0.0), 10),
                    "opb_cash_buffer_adjusted": True,
                }
                for symbol, diagnostic in candidate_diagnostics.items()
            }
            sparse_evidence = {
                **sparse_evidence,
                "candidate_diagnostics": candidate_diagnostics,
                "unallocated_cash_weight": round(cash_weight, 10),
                "opb_candidate_feature_summary": candidate_feature_summary,
            }

    allocation = {
        "weights": final_weights,
        "cash_weight": cash_weight,
        "raw_sparse_tangent_weights": raw_weights,
        "sparse_evidence": sparse_evidence,
    }
    production_controller = _is_production_controller_stage(stage)
    packet: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "stage": stage,
        "controller": "OnlinePortfolioBandit",
        "selection_policy": "warm_start_constrained_ucb",
        "allocator_engine": "sparse_tangent_inverse_risk",
        "allocation_role": (
            "production_recommendation_allocation_controller"
            if production_controller
            else "paper_evidence_only"
        ),
        "production_mutation_allowed": False,
        "can_write_recommendation_allocation": production_controller,
        "can_write_order": False,
        "can_submit_real_order": False,
        "selected_arm": selected,
        "arm_scores": scored,
        "controlled_allocation": allocation,
        "candidate_feature_summary": candidate_feature_summary,
        "constraints": {
            "bandit_controls_final_weights": False,
            "bandit_controls_allocator_knobs": True,
            "inherits_sparse_allocator_policy_knobs": True,
            "requires_paper_active_attribution": not production_controller,
            "requires_wei_approval_for_L3_or_production": not production_controller,
            "production_controller_enabled": production_controller,
        },
    }
    if not production_controller:
        packet["paper_allocation"] = allocation
    return packet
