from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import online_portfolio_bandit, recommendation_service  # noqa: E402


def _score_v2(final_score: float = 77.0, ml_edge: float = 12.0) -> dict:
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
        "mlEdgePolicy": {"signal": "BUY"},
        "coreFamilyEvidence": {
            "formal_model_contract_passed": True,
            "evidence_status": "sufficient_family_breadth",
            "active_family_count": 3,
        },
    }


def _continuity_row(symbol: str) -> dict:
    return {
        "symbol": symbol,
        "name": symbol,
        "score": 77.0,
        "signal": "HOLD",
        "signal_source": "ensemble_v2",
        "confidence": 0.72,
        "recommendation_lane": "tradable",
        "eligible_for_pending_buy": True,
        "has_buy_signal": 0,
        "score_components": _score_v2(),
        "watch_points": [],
        "s12_trade_ev": {"status": "setup_only", "s12_entry_context": {"htf_hard_block": False}},
    }


def _l4_alpha_ev(value: float) -> dict:
    return {
        "schema_version": "l4-alpha-ev-v1",
        "artifact_contract_version": recommendation_service.L4_ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": recommendation_service.L4_FEATURE_SEMANTIC_VERSION,
        "label_schema_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "expected_return_owner": "l4_alpha_ev",
        "expected_return_mean": value,
        "expected_return_source": "l4_alpha_ev:test_fixture",
        "promotion_state": "production_approved",
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "test_fixture",
        "model_version": "l4-test",
        "feature_snapshot_version": "l4-test-features",
        "trained_until": "2026-07-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
    }


def _formal_l4_row(symbol: str) -> dict:
    row = _continuity_row(symbol)
    row["l4_alpha_ev"] = _l4_alpha_ev(0.05)
    return row


def _validated_l4_prior() -> dict:
    return {
        "artifact_id": "opb_arm_prior:l4-test",
        "model_version": "opb-prior-l4-test",
        "expected_return_owner": "l4_alpha_ev",
        "source_expected_return_contract_version": recommendation_service.L4_ARTIFACT_CONTRACT_VERSION,
        "source_expected_return_semantic": recommendation_service.L4_EXPECTED_RETURN_SEMANTIC,
        "validation": {
            "decision": "PASS",
            "failed_checks": [],
            "production_control_approved": True,
            "evaluation_method": "full_information_deterministic_arm_replay",
            "incumbent_net_reward_non_degradation_passed": True,
            "diversity_non_degradation_passed": True,
            "turnover_cost_non_degradation_passed": True,
        },
        "arm_priors": [
            {
                "arm_id": arm.arm_id,
                "prior_reward_mean": arm.prior_reward_mean,
                "prior_samples": arm.prior_samples,
            }
            for arm in online_portfolio_bandit.DEFAULT_ARMS
        ],
    }


def test_continuity_allocator_cannot_turn_formal_hold_into_buy() -> None:
    row = _continuity_row("HOLD")
    row["score_components"]["mlEdgePolicy"]["signal"] = "HOLD"

    assert recommendation_service._can_promote_ranking_candidate(
        row,
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        alpha_policy={"allocation": {}},
    ) is False
    assert row["promotion_blocked_reason"] == "validated_l4_expected_return_unavailable"
    assert "formal_ml_continuity_admission" not in row


def test_risk_overlay_skip_blocks_allocator_even_for_formal_ml_buy() -> None:
    row = _continuity_row("RISK")
    row["alpha_context"] = {"risk_overlay": {"skip": True, "flags": ["low_liquidity"]}}

    assert recommendation_service._can_promote_ranking_candidate(
        row,
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        alpha_policy={"allocation": {}},
    ) is False
    assert row["promotion_blocked_reason"] == "risk_overlay_skip"


def test_sparse_capacity_is_a_maximum_not_a_forced_target(monkeypatch):
    monkeypatch.setattr(
        recommendation_service,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {"weights": {}, "candidate_diagnostics": {}},
    )
    allocated = recommendation_service._apply_sparse_tangent_buy_selection(
        [_continuity_row("EMPTY")],
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        {"allocation": {"engine": "sparse_tangent_inverse_risk", "controller": "SparseTangent"}},
        confidence_floor=0.60,
        return_history={},
    )
    assert allocated[0]["alpha_allocation"]["max_capacity_not_target"] is True
    assert allocated[0]["has_buy_signal"] == 0


def test_opb_without_validated_owner_prior_is_shadow_only(monkeypatch):
    monkeypatch.setattr(
        recommendation_service,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {"AAA": 1.0},
            "candidate_diagnostics": {},
            "allocation_objective": "deterministic_test",
        },
    )
    allocated = recommendation_service._apply_sparse_tangent_buy_selection(
        [_formal_l4_row("AAA")],
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        {"allocation": {"engine": "sparse_tangent_inverse_risk", "controller": "OnlinePortfolioBandit"}},
        confidence_floor=0.60,
        return_history={},
    )
    row = allocated[0]
    assert row["has_buy_signal"] == 1
    assert row["alpha_allocation"]["opb_controller"]["enabled"] is False
    assert row["alpha_allocation"]["opb_controller"]["status"] == "shadow_only"


def test_opb_empty_allocation_is_not_replaced_by_raw_sparse_weights(monkeypatch):
    monkeypatch.setattr(
        online_portfolio_bandit,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {"AAA": 0.01},
            "candidate_diagnostics": {},
        },
    )

    def forbidden_fallback(*args, **kwargs):
        raise AssertionError("authoritative empty OPB allocation must not fall back")

    monkeypatch.setattr(recommendation_service, "allocate_sparse_tangent_with_evidence", forbidden_fallback)
    allocated = recommendation_service._apply_sparse_tangent_buy_selection(
        [_formal_l4_row("AAA")],
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        {
            "allocation": {
                "engine": "sparse_tangent_inverse_risk",
                "controller": "OnlinePortfolioBandit",
                "opb_arm_prior": _validated_l4_prior(),
            }
        },
        confidence_floor=0.60,
        return_history={},
    )
    row = allocated[0]
    assert row["has_buy_signal"] == 0
    assert row["signal"] != "BUY"
    assert row["alpha_allocation"]["selected"] is False


def test_rfs_shadow_cannot_replace_sparse_production_weights(monkeypatch):
    monkeypatch.setattr(
        recommendation_service,
        "allocate_sparse_tangent_with_evidence",
        lambda candidates, return_history, **kwargs: {
            "weights": {"AAA": 1.0},
            "candidate_diagnostics": {},
            "allocation_objective": "deterministic_test",
        },
    )
    monkeypatch.setattr(
        recommendation_service,
        "build_rfs_implementable_frontier_shadow",
        lambda *args, **kwargs: {
            "schema_version": "rfs-implementable-frontier-shadow-v1",
            "method": "rfs_inspired_cost_aware_aim_portfolio",
            "status": "shadow_ready",
            "production_effect": False,
            "promotion_eligible": False,
            "validation_blockers": [],
            "weights": {"BBB": 1.0},
            "cost_by_symbol": {
                "BBB": {"delta_weight": 1.0, "estimated_cost": 0.01, "adv_twd": 1_000_000.0}
            },
            "metrics": {"challenger_net_utility": 1.0},
            "packet_checksum": "shadow-only",
        },
    )

    allocated = recommendation_service._apply_sparse_tangent_buy_selection(
        [_formal_l4_row("AAA"), _formal_l4_row("BBB")],
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        {"allocation": {"engine": "sparse_tangent_inverse_risk", "controller": "SparseTangent"}},
        confidence_floor=0.60,
        return_history={},
    )

    by_symbol = {row["symbol"]: row for row in allocated}
    assert by_symbol["AAA"]["has_buy_signal"] == 1
    assert by_symbol["BBB"]["has_buy_signal"] == 0
    assert by_symbol["BBB"]["alpha_allocation"]["rfs_shadow_challenger"]["challenger_aim_weight"] == 1.0
    assert by_symbol["BBB"]["alpha_allocation"]["rfs_shadow_challenger"]["production_effect"] is False


def test_rfs_packet_metadata_survives_zero_selected_rows(monkeypatch):
    monkeypatch.setattr(recommendation_service, "allocate_sparse_tangent_with_evidence",
                        lambda *a, **k: {"weights": {}, "candidate_diagnostics": {}})
    monkeypatch.setattr(recommendation_service, "build_rfs_implementable_frontier_shadow",
                        lambda *a, **k: {"status": "insufficient_evidence", "weights": {},
                          "source_expected_return_candidate_count": 2,
                          "validation_blockers": ["return_history_coverage_below_80pct"],
                          "packet_checksum": "full-packet"})
    rows = recommendation_service._apply_sparse_tangent_buy_selection(
        [_formal_l4_row("AAA"), _formal_l4_row("BBB")],
        {"promoteMinForecastPct": 0.0, "promoteMinMlEdge": 0.0},
        {"allocation": {"engine": "sparse_tangent_inverse_risk", "controller": "SparseTangent"}},
        confidence_floor=0.60, return_history={})
    for row in rows:
        assert row["has_buy_signal"] == 0
        packet = row["alpha_allocation"]["rfs_shadow_challenger"]
        assert packet["source_expected_return_candidate_count"] == 2
        assert packet["validation_blockers"] == ["return_history_coverage_below_80pct"]
        assert packet["production_effect"] is False


@pytest.mark.parametrize("signal", ["BUY", "STRONG_BUY", "HOLD", "SELL", "STRONG_SELL"])
def test_l4_selects_valid_ev_independently_of_ml_advice(signal):
    row = _formal_l4_row("AAA")
    row["signal"] = signal
    row["score_components"]["components"]["mlEdge"] = 0.0
    row["score_components"]["mlEdgePolicy"].update({
        "signal": signal, "signal_status": "policy_blocked",
        "qualifications": {"ranking": {"decision": "PASS"},
                           "directional": {"decision": "BLOCKED", "allowed_signals": []}},
    })
    allocated = recommendation_service._apply_sparse_tangent_buy_selection(
        [row], {}, {"allocation": {"controller": "SparseTangent"}},
        confidence_floor=.6, return_history={})
    result = allocated[0]
    assert result["has_buy_signal"] == 1
    assert result["signal"] == "BUY"
    assert result["signal_raw"] == signal
    assert result["ml_advisory"]["signal"] == signal
    assert result["alpha_allocation"]["expected_return_owner"] == "l4_alpha_ev"


@pytest.mark.parametrize("signal", ["BUY", "HOLD", "SELL"])
def test_ml_advice_cannot_replace_unavailable_l4_ev(signal):
    row = _continuity_row("AAA")
    row["signal"] = signal
    row["score_components"]["mlEdgePolicy"]["signal"] = signal
    result = recommendation_service._apply_sparse_tangent_buy_selection(
        [row], {}, {"allocation": {"controller": "SparseTangent"}},
        confidence_floor=.6, return_history={})[0]
    assert result["signal"] == "HOLD" and result["has_buy_signal"] == 0
    assert result["ml_advisory"]["signal"] == signal
    assert result["alpha_allocation"]["allocation_candidate_pool_size"] == 0
    assert result["promotion_blocked_reason"] == "validated_l4_expected_return_unavailable"


@pytest.mark.parametrize("failure", ["missing_family", "ranking_failed", "risk", "research", "negative_ev"])
def test_advisory_separation_does_not_bypass_quality_or_risk(failure):
    row = _formal_l4_row("AAA")
    if failure == "missing_family": row["score_components"].pop("coreFamilyEvidence")
    elif failure == "ranking_failed": row["score_components"]["mlEdgePolicy"]["qualifications"] = {"ranking": {"decision": "FAIL"}}
    elif failure == "risk": row["alpha_context"] = {"risk_overlay": {"skip": True}}
    elif failure == "research": row["eligible_for_pending_buy"] = False
    else: row["l4_alpha_ev"] = _l4_alpha_ev(-.01)
    result = recommendation_service._apply_sparse_tangent_buy_selection(
        [row], {}, {"allocation": {"controller": "SparseTangent"}},
        confidence_floor=.6, return_history={})[0]
    assert result["has_buy_signal"] == 0
    assert result["alpha_allocation"]["selected"] is False
