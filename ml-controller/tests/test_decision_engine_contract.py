from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.decision_engine_contract import (  # noqa: E402
    DECISION_ENGINE_SCHEMA_VERSION,
    build_decision_engine_contract,
    build_decision_engine_decision,
    validate_decision_engine_decision,
)


def _inputs() -> dict:
    return {
        "symbol": "2330",
        "screener": {
            "present": True,
            "recommendation_lane": "tradable",
            "score": 84,
            "eligible_for_pending_buy": True,
        },
        "ml": {
            "present": True,
            "signal": "BUY",
            "confidence": 0.78,
        },
        "regime": {
            "present": True,
            "label": "bull",
            "confidence": 0.74,
        },
        "theme": {
            "present": True,
            "theme_score": 0.68,
            "fact_support": 0.80,
            "hype_risk": 0.20,
        },
        "risk": {
            "present": True,
            "halt": False,
            "chase_risk": 0.21,
            "liquidity_risk": 0.12,
        },
        "finlab_preview": {
            "present": True,
            "allowed_use": "preview_only",
            "status": "pass",
        },
        "langgraph_debate": {
            "present": True,
            "allowed_use": "decision_context_only",
            "decision_effect": "advisory_only",
            "proposed_decision": "candidate",
        },
        "human_flags": {
            "halt": False,
            "requires_review": False,
        },
    }


def test_decision_engine_contract_declares_single_owner_and_external_advisory_sources():
    contract = build_decision_engine_contract()

    assert contract["schema_version"] == DECISION_ENGINE_SCHEMA_VERSION
    assert contract["owner"] == "stockvision_decision_engine"
    assert set(contract["required_primary_inputs"]) == {"screener", "ml", "regime", "risk"}
    assert contract["source_roles"]["finlab_preview"] == "preview_context_only"
    assert contract["source_roles"]["langgraph_debate"] == "advisory_context_only"
    assert contract["source_roles"]["human_flags"] == "override_gate"
    assert contract["external_bypass_policy"] == "external_tools_cannot_bypass_decision_engine"
    assert contract["write_policy"]["can_create_real_order"] is False
    assert contract["write_policy"]["can_create_paper_order"] is False


def test_strong_primary_evidence_becomes_candidate_but_still_has_no_order_write_authority():
    decision = build_decision_engine_decision(
        _inputs(),
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert decision["schema_version"] == DECISION_ENGINE_SCHEMA_VERSION
    assert decision["decision_owner"] == "stockvision_decision_engine"
    assert decision["decision"] == "candidate"
    assert decision["decision_effect"] == "decision_engine_owned"
    assert decision["external_bypass_detected"] is False
    assert decision["allowed_next_steps"] == ["decision_record", "pending_buy_review"]
    assert decision["write_authority"] == {
        "daily_recommendations": False,
        "market_regime_state": False,
        "pending_buy": False,
        "paper_order": False,
        "real_order": False,
    }
    assert validate_decision_engine_decision(decision) == []


def test_external_finlab_or_debate_candidate_cannot_bypass_missing_primary_sources():
    inputs = _inputs()
    inputs["screener"]["present"] = False
    inputs["ml"]["present"] = False
    inputs["finlab_preview"].update({
        "status": "pass",
        "suggested_decision": "candidate",
    })
    inputs["langgraph_debate"]["proposed_decision"] = "candidate"

    decision = build_decision_engine_decision(inputs)

    assert decision["decision"] == "no_trade"
    assert decision["status"] == "fail_closed"
    assert decision["external_bypass_detected"] is True
    assert "missing_primary_input:screener" in decision["blocking_reasons"]
    assert "missing_primary_input:ml" in decision["blocking_reasons"]
    assert "external_candidate_without_primary_sources" in decision["blocking_reasons"]
    assert validate_decision_engine_decision(decision) == []


def test_human_flags_and_major_risk_force_human_review_or_reject():
    review_inputs = _inputs()
    review_inputs["human_flags"]["requires_review"] = True
    review_inputs["human_flags"]["reason"] = "major_news"

    review = build_decision_engine_decision(review_inputs)

    assert review["decision"] == "human_review"
    assert "human_review_required:major_news" in review["blocking_reasons"]

    reject_inputs = _inputs()
    reject_inputs["risk"]["halt"] = True
    reject_inputs["risk"]["reason"] = "kill_switch"

    rejected = build_decision_engine_decision(reject_inputs)

    assert rejected["decision"] == "no_trade"
    assert rejected["status"] == "blocked"
    assert "risk_halt:kill_switch" in rejected["blocking_reasons"]


def test_emerging_or_non_tradable_lane_stays_watchlist_even_with_good_ml():
    inputs = _inputs()
    inputs["screener"]["recommendation_lane"] = "emerging_watchlist"
    inputs["screener"]["eligible_for_pending_buy"] = False

    decision = build_decision_engine_decision(inputs)

    assert decision["decision"] == "watchlist"
    assert "non_tradable_lane:emerging_watchlist" in decision["blocking_reasons"]
    assert decision["allowed_next_steps"] == ["watchlist_review"]


def test_validator_rejects_tampered_decision_with_external_owner_or_write_authority():
    decision = build_decision_engine_decision(_inputs())
    decision["decision_owner"] = "finlab_preview"
    decision["decision_effect"] = "external_rank_modifier"
    decision["write_authority"]["real_order"] = True
    decision["write_authority"]["pending_buy"] = True

    errors = validate_decision_engine_decision(decision)

    assert "decision_owner_must_be_stockvision_decision_engine" in errors
    assert "decision_effect_must_be_decision_engine_owned" in errors
    assert "real_order_write_must_be_false" in errors
    assert "pending_buy_write_must_be_false" in errors
