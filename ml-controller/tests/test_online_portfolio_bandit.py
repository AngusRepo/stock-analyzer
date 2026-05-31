import asyncio

import pytest

from routers.research_benchmark import OnlinePortfolioBanditL2Request, research_online_portfolio_bandit_l2_dry_run
from services.online_portfolio_bandit import build_online_portfolio_bandit_l2_packet


def _candidates():
    return [
        {"symbol": "A", "score": 96.0, "expected_return": 0.014},
        {"symbol": "B", "score": 94.0, "expected_return": 0.012},
        {"symbol": "C", "score": 91.0, "expected_return": 0.010},
        {"symbol": "D", "score": 88.0, "expected_return": 0.008},
        {"symbol": "E", "score": 85.0, "expected_return": 0.006},
        {"symbol": "F", "score": 82.0, "expected_return": 0.005},
    ]


def _return_history():
    return {
        "A": [0.03, -0.02, 0.025, -0.015, 0.02],
        "B": [0.012, 0.010, 0.011, 0.013, 0.010],
        "C": [0.009, 0.008, 0.010, 0.009, 0.011],
        "D": [0.006, 0.005, 0.007, 0.006, 0.005],
        "E": [0.004, 0.004, 0.005, 0.004, 0.005],
        "F": [0.003, 0.002, 0.003, 0.002, 0.003],
    }


def test_online_portfolio_bandit_l2_is_warm_started_and_non_mutating():
    packet = build_online_portfolio_bandit_l2_packet(
        candidates=_candidates(),
        return_history=_return_history(),
        reward_ledger=[],
    )

    assert packet["stage"] == "L2_paper_active"
    assert packet["selection_policy"] == "warm_start_constrained_ucb"
    assert packet["allocator_engine"] == "sparse_tangent_inverse_risk"
    assert packet["production_mutation_allowed"] is False
    assert packet["can_write_order"] is False
    assert packet["selected_arm"]["prior_samples"] > 0
    assert packet["selected_arm"]["samples"] > 0


def test_online_portfolio_bandit_uses_reward_ledger_to_select_allocator_knobs():
    packet = build_online_portfolio_bandit_l2_packet(
        candidates=_candidates(),
        return_history=_return_history(),
        reward_ledger=[
            {"policy_id": "OnlinePortfolioBandit", "arm_id": "conservative_diversified", "samples": 80, "reward_mean": 0.04},
            {"policy_id": "OnlinePortfolioBandit", "arm_id": "diversified_alpha", "samples": 80, "reward_mean": 0.001},
        ],
        exploration_alpha=0.01,
    )

    assert packet["selected_arm"]["arm_id"] == "conservative_diversified"
    assert packet["selected_arm"]["knobs"]["candidate_cap"] == 6
    assert packet["constraints"]["bandit_controls_allocator_knobs"] is True
    assert packet["constraints"]["bandit_controls_final_weights"] is False


def test_online_portfolio_bandit_keeps_sparse_tangent_as_weight_engine():
    packet = build_online_portfolio_bandit_l2_packet(
        candidates=_candidates(),
        return_history=_return_history(),
        reward_ledger=[
            {"policy_id": "OnlinePortfolioBandit", "arm_id": "high_score_conservative", "samples": 50, "reward_mean": 0.05},
        ],
        exploration_alpha=0.01,
    )

    weights = packet["paper_allocation"]["weights"]
    cash = packet["paper_allocation"]["cash_weight"]
    max_weight = packet["selected_arm"]["knobs"]["max_weight"]

    assert weights
    assert sum(weights.values()) + cash == pytest.approx(1.0)
    assert max(weights.values()) <= max_weight + 1e-9
    assert cash + 1e-9 >= packet["selected_arm"]["knobs"]["cash_buffer"]


def test_online_portfolio_bandit_l3_controls_allocator_knobs_without_paper_label():
    packet = build_online_portfolio_bandit_l2_packet(
        candidates=_candidates(),
        return_history=_return_history(),
        stage="L3_production_allocation_controller",
        candidate_cap_limit=3,
    )

    weights = packet["controlled_allocation"]["weights"]

    assert packet["allocation_role"] == "production_recommendation_allocation_controller"
    assert packet["constraints"]["production_controller_enabled"] is True
    assert packet["constraints"]["requires_paper_active_attribution"] is False
    assert packet["constraints"]["requires_wei_approval_for_L3_or_production"] is False
    assert packet["can_write_recommendation_allocation"] is True
    assert "paper_allocation" not in packet
    assert weights
    assert len(weights) <= 3


def test_online_portfolio_bandit_l2_route_is_non_mutating():
    packet = asyncio.run(research_online_portfolio_bandit_l2_dry_run(
        OnlinePortfolioBanditL2Request(
            candidates=_candidates(),
            return_history=_return_history(),
            reward_ledger=[],
        )
    ))

    assert packet["stage"] == "L2_paper_active"
    assert packet["production_mutation_allowed"] is False
    assert packet["can_submit_real_order"] is False
