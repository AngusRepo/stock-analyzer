from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import online_portfolio_bandit  # noqa: E402
from services import recommendation_service  # noqa: E402
from services.online_portfolio_bandit import (  # noqa: E402
    PortfolioBanditArm,
    build_online_portfolio_bandit_l2_packet,
)
from services.recommendation_service import load_online_portfolio_bandit_reward_ledger  # noqa: E402


def _score_v2(final_score: float, ml_edge: float = 12.0) -> dict:
    return {
        "version": "score_v2",
        "components": {
            "mlEdge": ml_edge,
            "chipFlow": max(0.0, final_score - ml_edge),
            "technicalStructure": 0.0,
            "fundamentalQuality": 0.0,
            "newsTheme": 0.0,
        },
        "total": final_score,
        "finalScore": final_score,
    }


def _candidate(symbol: str, score: float, expected_return: float) -> dict:
    return {
        "symbol": symbol,
        "score": score,
        "expected_return": expected_return,
    }


def _recommendation_row(symbol: str, score: float, forecast_pct: float) -> dict:
    return {
        "symbol": symbol,
        "name": symbol,
        "score": score,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "confidence": 0.72,
        "ml_forecast_pct": forecast_pct,
        "trade_expected_return_net_pct": forecast_pct,
        "trade_expected_return_source": "s12_trade_ev_test",
        "recommendation_lane": "tradable",
        "eligible_for_pending_buy": True,
        "has_buy_signal": 0,
        "score_components": _score_v2(score),
        "watch_points": [],
    }


def test_online_portfolio_bandit_selects_ucb_arm_and_keeps_cash_buffer(monkeypatch):
    monkeypatch.setattr(
        online_portfolio_bandit,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {"AAA": 0.55, "BBB": 0.45},
            "candidate_diagnostics": {
                "AAA": {"alpha_input": 0.05, "marginal_utility": 0.01, "final_weight": 0.55},
                "BBB": {"alpha_input": 0.04, "marginal_utility": 0.01, "final_weight": 0.45},
            },
            "objective_evidence": {"objective": "mean_variance_alpha_utility_with_cash"},
        },
    )

    packet = build_online_portfolio_bandit_l2_packet(
        candidates=[
            _candidate("AAA", 90.0, 0.05),
            _candidate("BBB", 88.0, 0.04),
        ],
        return_history={},
        arms=(
            PortfolioBanditArm("cash_guard", 2, 0.50, 0.25, 0.0, 0.20, 0.020, 30),
            PortfolioBanditArm("risk_on", 2, 0.50, 0.00, 0.0, 0.35, 0.001, 30),
        ),
        exploration_alpha=0.0,
        stage="L3_production_allocation_controller",
    )

    weights = packet["controlled_allocation"]["weights"]
    assert packet["selected_arm"]["arm_id"] == "cash_guard"
    assert packet["can_write_recommendation_allocation"] is True
    assert packet["can_submit_real_order"] is False
    assert sum(weights.values()) == pytest.approx(0.75)
    assert packet["controlled_allocation"]["cash_weight"] == pytest.approx(0.25)


def test_online_portfolio_bandit_reward_ledger_can_override_static_prior(monkeypatch):
    monkeypatch.setattr(
        online_portfolio_bandit,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {"AAA": 1.0},
            "candidate_diagnostics": {
                "AAA": {"alpha_input": 0.05, "marginal_utility": 0.01, "final_weight": 1.0},
            },
            "objective_evidence": {"objective": "mean_variance_alpha_utility_with_cash"},
        },
    )

    packet = build_online_portfolio_bandit_l2_packet(
        candidates=[_candidate("AAA", 90.0, 0.05)],
        return_history={},
        reward_ledger=[
            {
                "policy_id": "OnlinePortfolioBandit",
                "arm_id": "cash_guard",
                "samples": 8,
                "reward_mean": 0.030,
                "reward_mean_r": 1.2,
                "reward_r_samples": 8,
                "reward_source_counts": {"trade_pnl_pct": 8},
                "reward_policy": "prefer_trade_pnl_pct_then_trade_pnl_r_scaled_by_s12_risk_then_actual_return_pct_fallback",
            }
        ],
        arms=(
            PortfolioBanditArm("cash_guard", 1, 1.00, 0.30, 0.0, 0.20, 0.000, 1),
            PortfolioBanditArm("risk_on", 1, 1.00, 0.00, 0.0, 0.35, 0.020, 1),
        ),
        exploration_alpha=0.0,
        stage="L3_production_allocation_controller",
    )

    assert packet["selected_arm"]["arm_id"] == "cash_guard"
    assert packet["selected_arm"]["live_samples"] == 8
    assert packet["selected_arm"]["live_reward_mean_r"] == pytest.approx(1.2)
    assert packet["selected_arm"]["reward_source_counts"] == {"trade_pnl_pct": 8}
    assert packet["controlled_allocation"]["cash_weight"] == pytest.approx(0.30)


def test_recommendation_service_uses_opb_packet_without_full_exposure_renormalization(monkeypatch):
    monkeypatch.setattr(
        online_portfolio_bandit,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {"AAA": 0.40, "BBB": 0.35, "CCC": 0.25},
            "candidate_diagnostics": {
                "AAA": {"alpha_input": 0.05, "marginal_utility": 0.011, "final_weight": 0.40},
                "BBB": {"alpha_input": 0.04, "marginal_utility": 0.009, "final_weight": 0.35},
                "CCC": {"alpha_input": 0.03, "marginal_utility": 0.007, "final_weight": 0.25},
            },
            "objective_evidence": {"objective": "mean_variance_alpha_utility_with_cash"},
        },
    )

    rows = [
        _recommendation_row("AAA", 90.0, 0.05),
        _recommendation_row("BBB", 88.0, 0.04),
        _recommendation_row("CCC", 86.0, 0.03),
    ]
    allocated = recommendation_service._apply_sparse_tangent_buy_selection(
        rows,
        {"enabled": True, "promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        {
            "allocation": {
                "engine": "sparse_tangent_inverse_risk",
                "controller": "OnlinePortfolioBandit",
                "buy_signal_count": 3,
            }
        },
        confidence_floor=0.60,
        return_history={},
    )

    buys = [row for row in allocated if row.get("has_buy_signal") == 1]
    assert {row["symbol"] for row in buys} == {"AAA", "BBB", "CCC"}
    total_weight = sum(float(row["allocation_weight"]) for row in buys)
    assert total_weight == pytest.approx(0.92)
    assert buys[0]["alpha_allocation"]["opb_controller"]["enabled"] is True
    assert buys[0]["alpha_allocation"]["sparse_diagnostics"]["controller_packet_enabled"] is True
    assert buys[0]["alpha_allocation"]["sparse_diagnostics"]["unallocated_cash_weight"] == pytest.approx(0.08)
    assert buys[0]["alpha_allocation"]["alpha_utility"]["alpha_input"] == pytest.approx(0.05)
    assert buys[0]["alpha_allocation"]["alpha_utility"]["opb_controller_diagnostics"] is True


def test_opb_reward_ledger_aggregates_daily_portfolio_reward_by_arm():
    def _allocation(arm_id: str, weight: float, risk_pct: float = 0.04) -> str:
        return json.dumps({
            "selected": True,
            "allocation_weight": weight,
            "s12_trade_ev": {
                "status": "loaded",
                "risk_pct": risk_pct,
                "trade_expected_return_net_pct": 0.03,
            },
            "opb_controller": {
                "enabled": True,
                "selected_arm": {"arm_id": arm_id},
            },
        })

    rows = [
        {
            "date": "2026-07-01",
            "stock_id": "AAA",
            "alpha_allocation": _allocation("diversified_alpha", 0.60),
            "trade_pnl_pct": 0.02,
            "trade_pnl_r": 0.50,
            "actual_return_pct": None,
        },
        {
            "date": "2026-07-01",
            "stock_id": "BBB",
            "alpha_allocation": _allocation("diversified_alpha", 0.40),
            "trade_pnl_pct": -0.01,
            "trade_pnl_r": -0.25,
            "actual_return_pct": None,
        },
        {
            "date": "2026-07-02",
            "stock_id": "CCC",
            "alpha_allocation": _allocation("diversified_alpha", 0.50),
            "trade_pnl_pct": None,
            "trade_pnl_r": None,
            "actual_return_pct": 0.04,
        },
    ]

    ledger = load_online_portfolio_bandit_reward_ledger(
        query_fn=lambda sql, params, timeout=30.0: rows,
    )

    assert len(ledger) == 1
    assert ledger[0]["arm_id"] == "diversified_alpha"
    assert ledger[0]["samples"] == 2
    assert ledger[0]["reward_mean"] == pytest.approx(((0.60 * 0.02 + 0.40 * -0.01) + 0.04) / 2)
    assert ledger[0]["reward_mean_r"] == pytest.approx((0.60 * 0.50 + 0.40 * -0.25) / 1.0)
    assert ledger[0]["reward_r_samples"] == 1
    assert ledger[0]["reward_source_counts"] == {"actual_return_pct_5bar_fallback": 1, "trade_pnl_pct": 2}
    assert ledger[0]["risk_pct_rows"] == 3
    assert ledger[0]["reward_policy"] == "prefer_trade_pnl_pct_then_trade_pnl_r_scaled_by_s12_risk_then_actual_return_pct_fallback"


def test_opb_reward_ledger_uses_trade_pnl_r_scaled_by_s12_risk_when_pct_missing():
    rows = [
        {
            "date": "2026-07-03",
            "stock_id": "AAA",
            "symbol": "AAA",
            "alpha_allocation": json.dumps({
                "selected": True,
                "allocation_weight": 1.0,
                "s12_trade_ev": {"status": "loaded", "risk_pct": 0.04},
                "opb_controller": {"enabled": True, "selected_arm": {"arm_id": "risk_on"}},
            }),
            "trade_pnl_pct": None,
            "trade_pnl_r": 2.0,
            "actual_return_pct": None,
        }
    ]

    calls: list[str] = []

    def query_fn(sql: str, params: list[object], timeout: float = 30.0) -> list[dict]:
        calls.append(sql)
        return rows

    ledger = load_online_portfolio_bandit_reward_ledger(query_fn=query_fn)

    assert calls and "p.trade_pnl_r" in calls[0]
    assert ledger[0]["arm_id"] == "risk_on"
    assert ledger[0]["reward_mean"] == pytest.approx(0.08)
    assert ledger[0]["reward_mean_r"] == pytest.approx(2.0)
    assert ledger[0]["reward_source_counts"] == {"trade_pnl_r_scaled_by_s12_risk_pct": 1}
