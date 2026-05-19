from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.langgraph_debate_contract import (  # noqa: E402
    LANGGRAPH_DEBATE_SCHEMA_VERSION,
    build_langgraph_debate_graph_contract,
    build_langgraph_debate_plan,
    validate_langgraph_debate_plan,
)


def _base_context() -> dict:
    return {
        "symbol": "2330",
        "ml": {
            "signal": "BUY",
            "confidence": 0.78,
            "model_disagreement": 0.18,
        },
        "quant": {
            "score": 82,
            "liquidity_score": 0.9,
            "price_location": "not_extended",
        },
        "theme": {
            "theme_score": 0.72,
            "fact_support": 0.82,
            "hype_risk": 0.24,
        },
        "risk": {
            "chase_risk": 0.22,
            "liquidity_risk": 0.1,
        },
        "regime": {
            "label": "bull",
            "confidence": 0.76,
        },
        "news": {
            "major_event": False,
        },
    }


def test_graph_contract_exposes_required_langgraph_agents_and_no_write_authority():
    contract = build_langgraph_debate_graph_contract()

    assert contract["schema_version"] == LANGGRAPH_DEBATE_SCHEMA_VERSION
    assert contract["orchestration"] == "langgraph_ready_contract"
    assert set(contract["agents"]) == {
        "bull_agent",
        "bear_agent",
        "risk_agent",
        "quant_agent",
        "theme_agent",
        "final_judge",
    }
    assert contract["policy"]["allowed_use"] == "decision_context_only"
    assert contract["policy"]["decision_authority"] == "advisory_to_decision_engine"
    assert contract["policy"]["can_write_daily_recommendations"] is False
    assert contract["policy"]["can_write_market_regime_state"] is False
    assert contract["policy"]["can_create_pending_buy"] is False
    assert contract["policy"]["can_create_paper_or_real_order"] is False


def test_debate_plan_marks_strong_low_risk_case_as_candidate_context_only():
    plan = build_langgraph_debate_plan(
        _base_context(),
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert plan["schema_version"] == LANGGRAPH_DEBATE_SCHEMA_VERSION
    assert plan["status"] == "planned"
    assert plan["allowed_use"] == "decision_context_only"
    assert plan["decision_effect"] == "advisory_only"
    assert plan["proposed_decision"] == "candidate"
    assert plan["decision_authority"] == "advisory_to_decision_engine"
    assert plan["write_authority"] == {
        "daily_recommendations": False,
        "market_regime_state": False,
        "pending_buy": False,
        "paper_order": False,
        "real_order": False,
    }
    assert plan["conditional_steps"] == []
    assert validate_langgraph_debate_plan(plan) == []


def test_debate_plan_routes_disagreement_hype_low_fact_support_and_major_news():
    context = _base_context()
    context["ml"]["model_disagreement"] = 0.52
    context["theme"]["theme_score"] = 0.88
    context["theme"]["fact_support"] = 0.31
    context["theme"]["hype_risk"] = 0.84
    context["news"]["major_event"] = True

    plan = build_langgraph_debate_plan(context)

    assert plan["proposed_decision"] == "human_review"
    assert "risk_agent_extra_round" in plan["conditional_steps"]
    assert "breeze2_semantic_fact_check" in plan["conditional_steps"]
    assert "bear_agent_strengthen_hype_risk" in plan["conditional_steps"]
    assert "human_in_the_loop_major_news" in plan["conditional_steps"]
    assert plan["tool_requests"] == [
        {
            "tool": "breeze2",
            "mode": "research_context_only",
            "reason": "theme_score_high_but_fact_support_low",
            "trigger": "morning_debate",
            "controller_route": "/breeze2/fact_check",
            "modal_function": "breeze2_research_context",
        }
    ]
    assert "fact_support_low" in plan["judge_inputs"]["risk_flags"]
    assert "hype_risk_high" in plan["judge_inputs"]["risk_flags"]
    assert validate_langgraph_debate_plan(plan) == []


def test_debate_plan_rejects_when_risk_dominates_even_if_ml_is_positive():
    context = _base_context()
    context["quant"]["score"] = 41
    context["risk"]["chase_risk"] = 0.91
    context["risk"]["liquidity_risk"] = 0.72

    plan = build_langgraph_debate_plan(context)

    assert plan["proposed_decision"] == "reject"
    assert "risk_block" in plan["judge_inputs"]["risk_flags"]
    assert plan["decision_effect"] == "advisory_only"


def test_validator_rejects_any_debate_plan_with_direct_write_or_live_authority():
    plan = build_langgraph_debate_plan(_base_context())
    plan["allowed_use"] = "direct_recommendation_input"
    plan["decision_effect"] = "rank_modifier"
    plan["write_authority"]["daily_recommendations"] = True
    plan["write_authority"]["real_order"] = True

    errors = validate_langgraph_debate_plan(plan)

    assert "allowed_use_must_be_decision_context_only" in errors
    assert "decision_effect_must_be_advisory_only" in errors
    assert "daily_recommendations_write_must_be_false" in errors
    assert "real_order_write_must_be_false" in errors
