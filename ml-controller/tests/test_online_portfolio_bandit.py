from __future__ import annotations

import json
import sqlite3
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


def _fusion_policy_value_artifact() -> dict:
    return {
        "artifact_contract_version": "allocator-ev-fusion-contract-v13",
        "feature_semantic_version": "allocator-ev-fusion-s12-policy-value-day-t-causal-v4-lineage-bound",
        "label_schema_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_primary",
        "promotion_tier": "primary",
        "primary_expected_return_allowed": True,
        "validation_packet": {"decision": "PASS"},
        "expected_return_semantic": "execution_probability_times_conditional_replay_net_return",
        "resolver_method": "test_day_t_policy_value",
        "model_version": "fusion-v13-opb-test",
        "feature_snapshot_version": "fusion-v13-test-features",
        "trained_until": "2026-07-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "policy_value_head_count": 2,
        "policy_value_heads": ["execution_probability_model", "conditional_execution_return_model"],
        "conditional_execution_return_model": {
            "status": "fitted", "decision": "PASS", "intercept": 0.0,
            "coefficients": {"market_heat_expected_return": 1.0, "l4_expected_return": 0.0},
        },
        "execution_probability_model": {
            "status": "fitted", "decision": "PASS", "link_function": "identity", "intercept": 1.0,
            "coefficients": {"l4_available": 0.0},
        },
        "output_clip": {"min": -0.08, "max": 0.08},
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
        "market_heat_expected_return": forecast_pct,
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
            PortfolioBanditArm("cash_guard", 2, 0.50, 0.25, 0.0, 0.020, 30),
            PortfolioBanditArm("risk_on", 2, 0.50, 0.00, 0.0, 0.001, 30),
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


def test_online_portfolio_bandit_forwards_sparse_allocator_policy_knobs(monkeypatch):
    observed: dict[str, object] = {}

    def fake_allocate(candidates, return_history, **kwargs):
        observed.update(kwargs)
        return {
            "weights": {"AAA": 0.5},
            "candidate_diagnostics": {
                "AAA": {"alpha_input": 0.05, "marginal_utility": 0.01, "final_weight": 0.5},
            },
            "objective_evidence": {"objective": kwargs.get("allocation_objective")},
        }

    monkeypatch.setattr(online_portfolio_bandit, "allocate_sparse_tangent_with_evidence", fake_allocate)

    packet = build_online_portfolio_bandit_l2_packet(
        candidates=[_candidate("AAA", 90.0, 0.05)],
        return_history={},
        arms=(PortfolioBanditArm("policy_arm", 1, 1.0, 0.0, 0.0, 0.020, 30),),
        exploration_alpha=0.0,
        stage="L3_production_allocation_controller",
        max_cluster_weight=0.33,
        cluster_edge_threshold=0.72,
        cluster_threshold_quantile=0.8,
        allocation_objective="alpha_utility_sparse",
        alpha_strength=1.25,
        risk_aversion=3.5,
        turnover_penalty=0.04,
        l2_penalty=0.02,
        utility_iterations=240,
    )

    assert observed["max_cluster_weight"] == pytest.approx(0.33)
    assert observed["cluster_edge_threshold"] == pytest.approx(0.72)
    assert observed["cluster_threshold_quantile"] == pytest.approx(0.8)
    assert observed["allocation_objective"] == "alpha_utility_sparse"
    assert observed["alpha_strength"] == pytest.approx(1.25)
    assert observed["risk_aversion"] == pytest.approx(3.5)
    assert observed["turnover_penalty"] == pytest.approx(0.04)
    assert observed["l2_penalty"] == pytest.approx(0.02)
    assert observed["utility_iterations"] == 240
    assert packet["constraints"]["inherits_sparse_allocator_policy_knobs"] is True
    assert packet["constraints"]["bandit_controls_candidate_count"] is False
    assert packet["constraints"]["hard_top_k_enabled"] is False


def test_online_portfolio_bandit_records_allocator_edge_quality_features(monkeypatch):
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
        candidates=[{
            **_candidate("AAA", 90.0, 0.05),
            "allocator_edge_quality_score": 83.5,
            "conditional_admission_allowed": True,
            "s12_target_quality_state": "structure_targets",
        }],
        return_history={},
        arms=(PortfolioBanditArm("quality_arm", 1, 1.0, 0.0, 0.0, 0.020, 30),),
        exploration_alpha=0.0,
        stage="L3_production_allocation_controller",
    )

    summary = packet["candidate_feature_summary"]
    diagnostics = packet["controlled_allocation"]["sparse_evidence"]["candidate_diagnostics"]["AAA"]
    assert summary["allocator_edge_quality_avg"] == pytest.approx(83.5)
    assert summary["conditional_admission_count"] == 1
    assert summary["s12_target_quality_state_counts"] == {"structure_targets": 1}
    assert diagnostics["allocator_edge_quality_score"] == pytest.approx(83.5)
    assert diagnostics["conditional_admission_allowed"] is True
    assert diagnostics["s12_target_quality_state"] == "structure_targets"


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
                "reward_policy": "executed_trade_pnl_pct_then_trade_pnl_r_scaled_by_s12_risk_censored_otherwise",
            }
        ],
        arms=(
            PortfolioBanditArm("cash_guard", 1, 1.00, 0.30, 0.0, 0.000, 1),
            PortfolioBanditArm("risk_on", 1, 1.00, 0.00, 0.0, 0.020, 1),
        ),
        exploration_alpha=0.0,
        stage="L3_production_allocation_controller",
    )

    assert packet["selected_arm"]["arm_id"] == "cash_guard"
    assert packet["selected_arm"]["live_samples"] == 8
    assert packet["selected_arm"]["live_reward_mean_r"] == pytest.approx(1.2)
    assert packet["selected_arm"]["reward_source_counts"] == {"trade_pnl_pct": 8}
    assert packet["controlled_allocation"]["cash_weight"] == pytest.approx(0.30)


def test_online_portfolio_bandit_uses_recent_decayed_rewards_over_stale_aggregate(monkeypatch):
    monkeypatch.setattr(
        online_portfolio_bandit,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {"weights": {"AAA": 1.0}},
    )
    history = [
        {"date": f"2026-06-{day:02d}", "reward": 0.04 if day <= 10 else -0.04}
        for day in range(1, 21)
    ]
    packet = build_online_portfolio_bandit_l2_packet(
        candidates=[_candidate("AAA", 90.0, 0.05)],
        return_history={},
        reward_ledger=[{
            "policy_id": "OnlinePortfolioBandit",
            "arm_id": "stale_winner",
            "samples": 100,
            "reward_mean": 0.05,
            "reward_history": history,
        }],
        arms=(
            PortfolioBanditArm("stale_winner", 1, 1.0, 0.0, 0.0, 0.0, 1),
            PortfolioBanditArm("stable", 1, 1.0, 0.0, 0.0, 0.005, 20),
        ),
        exploration_alpha=0.0,
    )

    stale = next(row for row in packet["arm_scores"] if row["arm_id"] == "stale_winner")
    assert stale["live_reward_mean"] < 0.0
    assert stale["reward_estimator"] == "sliding_window_exponential_decay"
    assert packet["selected_arm"]["arm_id"] == "stable"


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
            },
            "allocator_ev_fusion": _fusion_policy_value_artifact(),
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
            "canonical_selection_return_pct": 0.04,
        },
    ]

    ledger = load_online_portfolio_bandit_reward_ledger(
        query_fn=lambda sql, params, timeout=30.0: rows,
    )

    assert len(ledger) == 1
    assert ledger[0]["arm_id"] == "diversified_alpha"
    assert ledger[0]["samples"] == 2
    first_day_reward = 0.60 * 0.02 + 0.40 * -0.01
    second_day_reward = 0.04 - 0.0018
    assert ledger[0]["reward_mean"] == pytest.approx((first_day_reward + second_day_reward) / 2.0)
    assert ledger[0]["reward_mean_r"] == pytest.approx((0.60 * 0.50 + 0.40 * -0.25) / 1.0)
    assert ledger[0]["reward_r_samples"] == 1
    assert ledger[0]["reward_source_counts"] == {
        "canonical_adjusted_five_session_selection_return_net_cost": 1,
        "trade_pnl_pct": 2,
    }
    assert ledger[0]["risk_pct_rows"] == 3
    assert ledger[0]["reward_history"] == [
        {"date": "2026-07-01", "reward": pytest.approx(0.008), "reward_r": pytest.approx(0.2)},
        {"date": "2026-07-02", "reward": pytest.approx(0.0382), "reward_r": None},
    ]
    assert ledger[0]["reward_policy"] == (
        "verified_trade_pnl_pct_then_trade_pnl_r_scaled_by_s12_risk_then_"
        "canonical_adjusted_five_session_selection_return_net_18bps"
    )


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


def test_opb_reward_ledger_query_is_point_in_time_bounded():
    observed: dict[str, object] = {}

    def query_fn(sql: str, params: list[object], timeout: float = 30.0) -> list[dict]:
        observed["sql"] = sql
        observed["params"] = params
        return []

    ledger = load_online_portfolio_bandit_reward_ledger(
        as_of_date="2026-07-09",
        lookback_days=30,
        query_fn=query_fn,
    )

    assert ledger == []
    assert "dr.date < ?" in str(observed["sql"])
    assert "p.model_name = 'ensemble'" in str(observed["sql"])
    assert "date(ph.exit_date) <= date(?)" in str(observed["sql"])
    assert "price_horizon_labels_v1" in str(observed["sql"])
    assert "LEAD(" not in str(observed["sql"])
    assert "ROW_NUMBER() OVER" in str(observed["sql"])
    assert "datetime(p.generated_at) < datetime(timing.entry_date || ' 01:00:00')" in str(observed["sql"])
    assert observed["params"] == [
        "2026-06-09", "2026-07-09", "2026-07-09", "2026-06-09",
        "2026-07-09", "2026-07-09", "2026-07-09", 5000,
    ]


def test_opb_reward_ledger_sql_materializes_canonical_adjusted_selection_outcome():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE price_horizon_labels_v1 (
          stock_id INTEGER,
          price_date TEXT,
          entry_date TEXT,
          entry_raw_open REAL,
          entry_adjustment_factor REAL,
          exit_date TEXT,
          exit_raw_close REAL,
          exit_adjustment_factor REAL,
          outcome_known_date TEXT,
          source TEXT,
          projection_version TEXT
        );
        CREATE TABLE daily_recommendations (
          date TEXT, stock_id INTEGER, symbol TEXT, rank INTEGER, alpha_allocation TEXT
        );
        CREATE TABLE predictions (
          id INTEGER PRIMARY KEY, stock_id INTEGER, prediction_date TEXT, model_name TEXT,
          generated_at TEXT, trade_pnl_pct REAL, trade_pnl_r REAL, verified_at TEXT,
          verification_label_known_date TEXT
        );
        """
    )
    conn.execute(
        """
        INSERT INTO price_horizon_labels_v1 VALUES (
          1, '2026-07-01', '2026-07-02', 100.0, 1.0,
          '2026-07-08', 110.0, 1.0, '2026-07-08',
          'stock_prices:finlab_primary_canonical_mirror', 'price_horizon_v3_canonical_reference_identity'
        )
        """
    )
    allocation = json.dumps({
        "selected": True,
        "allocation_weight": 1.0,
        "opb_controller": {"enabled": True, "selected_arm": {"arm_id": "risk_on"}},
    })
    conn.execute(
        "INSERT INTO daily_recommendations VALUES ('2026-07-01', 1, 'AAA', 1, ?)",
        (allocation,),
    )
    conn.execute(
        """
        INSERT INTO predictions (
          id, stock_id, prediction_date, model_name, generated_at,
          trade_pnl_pct, trade_pnl_r, verified_at, verification_label_known_date
        ) VALUES (1, 1, '2026-07-01', 'ensemble', '2026-07-01 13:00:00', NULL, NULL, NULL, NULL)
        """
    )

    def query_fn(sql: str, params: list[object], timeout: float = 30.0) -> list[dict]:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    ledger = load_online_portfolio_bandit_reward_ledger(
        as_of_date="2026-07-09",
        lookback_days=30,
        query_fn=query_fn,
    )

    assert len(ledger) == 1
    assert ledger[0]["samples"] == 1
    assert ledger[0]["reward_mean"] == pytest.approx(0.0982)
    assert ledger[0]["reward_source_counts"] == {
        "canonical_adjusted_five_session_selection_return_net_cost": 1,
    }
