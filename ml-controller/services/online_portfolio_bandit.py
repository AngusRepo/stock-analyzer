"""L2 paper-active OnlinePortfolioBandit controller.

The bandit chooses allocator knobs only. Final weights still come from the
sparse tangent inverse-risk allocator, and the packet cannot mutate production.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from services.portfolio_allocation import allocate_sparse_tangent


SCHEMA_VERSION = "online-portfolio-bandit-l2-v1"


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
    PortfolioBanditArm("diversified_alpha", 8, 0.28, 0.08, 0.03, 0.35, 0.004, 24),
    PortfolioBanditArm("diversified_all_eligible", 12, 0.22, 0.10, 0.025, 0.30, 0.003, 24),
    PortfolioBanditArm("liquidity_diversified", 10, 0.24, 0.12, 0.025, 0.25, 0.0035, 24),
    PortfolioBanditArm("conservative_diversified", 6, 0.20, 0.20, 0.04, 0.18, 0.0025, 24),
    PortfolioBanditArm("high_score_conservative", 5, 0.32, 0.18, 0.04, 0.20, 0.003, 24),
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


def _ledger_by_arm(reward_ledger: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for row in reward_ledger:
        policy_id = str(row.get("policy_id") or "OnlinePortfolioBandit").strip()
        if policy_id != "OnlinePortfolioBandit":
            continue
        arm_id = str(row.get("arm_id") or "").strip()
        if not arm_id:
            continue
        samples = _to_int(row.get("samples"), 0)
        reward_mean = _to_float(row.get("reward_mean"), 0.0)
        if samples <= 0:
            continue
        out[arm_id] = {"samples": float(samples), "reward_mean": reward_mean}
    return out


def _warm_started_arm_stats(
    arm: PortfolioBanditArm,
    ledger: dict[str, dict[str, float]],
) -> dict[str, float]:
    row = ledger.get(arm.arm_id, {})
    live_samples = int(row.get("samples", 0))
    live_reward_mean = _to_float(row.get("reward_mean"), 0.0)
    total_samples = max(1, arm.prior_samples + live_samples)
    reward_sum = arm.prior_reward_mean * arm.prior_samples + live_reward_mean * live_samples
    return {
        "samples": float(total_samples),
        "reward_mean": reward_sum / total_samples,
        "prior_samples": float(arm.prior_samples),
        "live_samples": float(live_samples),
    }


def _ucb_score(stats: dict[str, float], total_samples: int, exploration_alpha: float) -> float:
    samples = max(1.0, stats["samples"])
    exploration = exploration_alpha * math.sqrt(math.log(max(2, total_samples)) / samples)
    return stats["reward_mean"] + exploration


def _normalize_to_exposure(weights: dict[str, float], *, target_exposure: float, min_trade_weight: float) -> dict[str, float]:
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


def build_online_portfolio_bandit_l2_packet(
    *,
    candidates: list[dict[str, Any]],
    return_history: dict[str, list[float]],
    reward_ledger: list[dict[str, Any]] | None = None,
    exploration_alpha: float = 0.05,
    arms: tuple[PortfolioBanditArm, ...] = DEFAULT_ARMS,
) -> dict[str, Any]:
    """Select allocator knobs with warm-start UCB and compute paper weights."""

    ledger = _ledger_by_arm(reward_ledger or [])
    arm_rows: list[dict[str, Any]] = []
    total_samples = 0
    for arm in arms:
        stats = _warm_started_arm_stats(arm, ledger)
        total_samples += int(stats["samples"])
        arm_rows.append({"arm": arm, "stats": stats})

    scored = []
    for row in arm_rows:
        arm = row["arm"]
        stats = row["stats"]
        score = _ucb_score(stats, total_samples, exploration_alpha)
        scored.append({
            "arm_id": arm.arm_id,
            "ucb_score": score,
            "reward_mean": stats["reward_mean"],
            "samples": int(stats["samples"]),
            "prior_samples": int(stats["prior_samples"]),
            "live_samples": int(stats["live_samples"]),
            "knobs": {
                "candidate_cap": arm.candidate_cap,
                "max_weight": arm.max_weight,
                "cash_buffer": arm.cash_buffer,
                "min_trade_weight": arm.min_trade_weight,
                "turnover_budget": arm.turnover_budget,
            },
        })
    scored.sort(key=lambda item: (item["ucb_score"], item["reward_mean"]), reverse=True)
    selected = scored[0] if scored else None
    selected_arm = next((arm for arm in arms if selected and arm.arm_id == selected["arm_id"]), None)

    ranked_candidates = sorted(candidates, key=_candidate_score, reverse=True)
    raw_weights: dict[str, float] = {}
    final_weights: dict[str, float] = {}
    cash_weight = 1.0
    if selected_arm is not None and ranked_candidates:
        raw_weights = allocate_sparse_tangent(
            ranked_candidates,
            return_history,
            top_k=selected_arm.candidate_cap,
            max_weight=selected_arm.max_weight,
        )
        final_weights = _normalize_to_exposure(
            raw_weights,
            target_exposure=1.0 - selected_arm.cash_buffer,
            min_trade_weight=selected_arm.min_trade_weight,
        )
        cash_weight = max(0.0, 1.0 - sum(final_weights.values()))

    return {
        "schema_version": SCHEMA_VERSION,
        "stage": "L2_paper_active",
        "controller": "OnlinePortfolioBandit",
        "selection_policy": "warm_start_constrained_ucb",
        "allocator_engine": "sparse_tangent_inverse_risk",
        "production_mutation_allowed": False,
        "can_write_order": False,
        "can_submit_real_order": False,
        "selected_arm": selected,
        "arm_scores": scored,
        "paper_allocation": {
            "weights": final_weights,
            "cash_weight": cash_weight,
            "raw_sparse_tangent_weights": raw_weights,
        },
        "constraints": {
            "bandit_controls_final_weights": False,
            "bandit_controls_allocator_knobs": True,
            "requires_paper_active_attribution": True,
            "requires_wei_approval_for_L3_or_production": True,
        },
    }
