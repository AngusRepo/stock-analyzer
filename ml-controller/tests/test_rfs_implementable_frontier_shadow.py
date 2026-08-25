from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rfs_implementable_frontier_shadow import (  # noqa: E402
    _effective_holdings,
    build_rfs_implementable_frontier_shadow,
)


def _candidate(symbol: str, edge: float, adv_twd: float) -> dict:
    return {
        "symbol": symbol,
        "expected_return": edge,
        "expected_return_owner": "l4_alpha_ev",
        "avg_daily_turnover_twd": adv_twd,
    }


def _history(symbols: list[str]) -> dict[str, list[float]]:
    return {
        symbol: [((idx % 7) - 3) * 0.001 + offset * 0.0001 for idx in range(40)]
        for offset, symbol in enumerate(symbols)
    }


def test_effective_holdings_normalizes_partial_invested_budget():
    assert _effective_holdings([0.10, 0.10, 0.0]) == 2.0

def test_rfs_shadow_is_full_pool_deterministic_and_never_production():
    symbols = ["AAA", "BBB", "CCC", "DDD"]
    candidates = [_candidate(symbol, 0.03 - idx * 0.001, 100_000_000.0) for idx, symbol in enumerate(symbols)]

    first = build_rfs_implementable_frontier_shadow(
        candidates,
        _history(symbols),
        incumbent_weights={},
        max_weight=0.25,
    )
    second = build_rfs_implementable_frontier_shadow(
        candidates,
        _history(symbols),
        incumbent_weights={},
        max_weight=0.25,
    )

    assert first["production_effect"] is False
    assert first["promotion_eligible"] is False
    assert first["candidate_pool_policy"] == "full_formal_expected_return_pool_no_hard_top_k"
    assert set(first["weights"]) == set(symbols)
    assert first["packet_checksum"] == second["packet_checksum"]


def test_rfs_shadow_penalizes_low_adv_nonlinear_impact():
    candidates = [
        _candidate("LIQUID", 0.025, 1_000_000_000.0),
        _candidate("ILLIQUID", 0.025, 1_000_000.0),
    ]
    packet = build_rfs_implementable_frontier_shadow(
        candidates,
        _history(["LIQUID", "ILLIQUID"]),
        incumbent_weights={},
        portfolio_value_twd=10_000_000.0,
        max_weight=0.8,
        impact_coefficient_bps=50.0,
    )

    assert packet["weights"]["LIQUID"] >= packet["weights"].get("ILLIQUID", 0.0)
    assert (
        packet["cost_by_symbol"]["ILLIQUID"]["nonlinear_impact_rate"]
        > packet["cost_by_symbol"]["LIQUID"]["nonlinear_impact_rate"]
    )


def test_missing_adv_cannot_receive_a_new_position_without_top_k():
    candidates = [
        _candidate("LIQUID", 0.02, 100_000_000.0),
        {"symbol": "NO_ADV", "expected_return": 0.03, "expected_return_owner": "l4_alpha_ev"},
    ]
    packet = build_rfs_implementable_frontier_shadow(
        candidates,
        _history(["LIQUID", "NO_ADV"]),
        inherited_weights={},
        portfolio_ml_inputs={"status": "shadow_ready"},
    )

    assert "NO_ADV" not in packet["weights"]
    assert packet["source_expected_return_candidate_count"] == 2
    assert packet["excluded_missing_adv_symbols"] == ["NO_ADV"]
    assert packet["candidate_pool_policy"] == "full_formal_expected_return_pool_no_hard_top_k"


def test_inherited_position_outside_tradeable_pool_fails_closed():
    packet = build_rfs_implementable_frontier_shadow(
        [_candidate("AAA", 0.02, 100_000_000.0)],
        _history(["AAA"]),
        inherited_weights={"OLD": 0.20},
        portfolio_ml_inputs={"status": "shadow_ready"},
    )

    assert packet["status"] == "shadow_observation_only"
    assert "inherited_positions_outside_tradeable_candidate_pool" in packet["validation_blockers"]
    assert packet["inherited_positions_outside_pool"] == ["OLD"]

def test_portfolio_ml_long_only_never_buys_negative_expected_return():
    candidate = {
        "symbol": "NEG",
        "expected_return": -0.03,
        "expected_return_owner": "portfolio_ml_shadow",
        "avg_daily_turnover_twd": 100_000_000.0,
    }
    inputs = {
        "status": "shadow_ready",
        "multi_horizon_expected_return_path": {"NEG": {3: -0.018, 5: -0.03, 10: -0.06}},
        "direct_weight_targets": {"NEG": 0.20},
        "dynamic_trading_speeds": {"NEG": 1.0},
    }

    packet = build_rfs_implementable_frontier_shadow(
        [candidate],
        _history(["NEG"]),
        inherited_weights={},
        portfolio_ml_inputs=inputs,
        comparison_only_shadow_alpha=True,
    )

    assert packet["weights"] == {}
    assert packet["metrics"]["challenger_expected_return"] == 0.0

def test_rfs_shadow_cost_is_based_on_delta_weight_not_gross_exposure():
    candidate = _candidate("AAA", 0.02, 100_000_000.0)
    packet = build_rfs_implementable_frontier_shadow(
        [candidate],
        _history(["AAA"]),
        incumbent_weights={"AAA": 0.25},
        max_weight=0.25,
    )

    assert packet["cost_by_symbol"]["AAA"]["delta_weight"] == 0.0
    assert packet["metrics"]["turnover_l1"] == 0.0
    assert packet["metrics"]["estimated_incremental_rebalance_cost"] == 0.0


def test_rfs_shadow_fails_closed_without_formal_expected_return_owner():
    packet = build_rfs_implementable_frontier_shadow(
        [{"symbol": "AAA", "expected_return": 0.02, "expected_return_owner": "ml_continuity"}],
        _history(["AAA"]),
    )

    assert packet["status"] == "insufficient_evidence"
    assert packet["weights"] == {}
    assert packet["production_effect"] is False
    assert "formal_expected_return_candidates_missing" in packet["validation_blockers"]

def test_portfolio_ml_shadow_alpha_requires_explicit_comparison_opt_in():
    candidate = {
        "symbol": "AAA",
        "expected_return": 0.02,
        "expected_return_owner": "portfolio_ml_shadow",
        "avg_daily_turnover_twd": 100_000_000.0,
    }
    inputs = {
        "status": "shadow_ready",
        "multi_horizon_expected_return_path": {
            "AAA": {3: 0.012, 5: 0.020, 10: 0.040},
        },
        "direct_weight_targets": {"AAA": 0.20},
        "dynamic_trading_speeds": {"AAA": 0.50},
    }

    rejected = build_rfs_implementable_frontier_shadow(
        [candidate],
        _history(["AAA"]),
        inherited_weights={},
        portfolio_ml_inputs=inputs,
    )
    accepted = build_rfs_implementable_frontier_shadow(
        [candidate],
        _history(["AAA"]),
        inherited_weights={},
        portfolio_ml_inputs=inputs,
        comparison_only_shadow_alpha=True,
    )

    assert rejected["status"] == "insufficient_evidence"
    assert accepted["comparison_only_shadow_alpha_input"] is True
    assert accepted["formal_expected_return_owner_only"] is False
    assert accepted["production_effect"] is False
    assert accepted["promotion_eligible"] is False
