from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


LANGGRAPH_DEBATE_SCHEMA_VERSION = "langgraph-debate-v1"

AGENTS = {
    "bull_agent": {
        "role": "argue_for_upside",
        "inputs": ["ml", "quant", "theme", "regime"],
        "output": "bull_case",
    },
    "bear_agent": {
        "role": "argue_for_downside_and_failure_modes",
        "inputs": ["risk", "theme", "news", "regime"],
        "output": "bear_case",
    },
    "risk_agent": {
        "role": "evaluate_chase_risk_liquidity_hype_and_event_risk",
        "inputs": ["risk", "theme", "news", "regime"],
        "output": "risk_flags",
    },
    "quant_agent": {
        "role": "summarize_model_and_factor_evidence",
        "inputs": ["ml", "quant", "regime"],
        "output": "quant_case",
    },
    "theme_agent": {
        "role": "evaluate_theme_strength_fact_support_and_hype",
        "inputs": ["theme", "news"],
        "output": "theme_case",
    },
    "final_judge": {
        "role": "synthesize_debate_for_decision_engine",
        "inputs": ["bull_case", "bear_case", "risk_flags", "quant_case", "theme_case"],
        "output": "proposed_decision_context",
    },
}

WRITE_AUTHORITY = {
    "daily_recommendations": False,
    "market_regime_state": False,
    "pending_buy": False,
    "paper_order": False,
    "real_order": False,
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def _section(context: dict[str, Any], key: str) -> dict[str, Any]:
    value = context.get(key)
    return value if isinstance(value, dict) else {}


def build_langgraph_debate_graph_contract() -> dict[str, Any]:
    edges = [
        {"from": "start", "to": "quant_agent"},
        {"from": "start", "to": "theme_agent"},
        {"from": "start", "to": "risk_agent"},
        {"from": "quant_agent", "to": "bull_agent"},
        {"from": "theme_agent", "to": "bull_agent"},
        {"from": "risk_agent", "to": "bear_agent"},
        {"from": "theme_agent", "to": "bear_agent"},
        {"from": "bull_agent", "to": "final_judge"},
        {"from": "bear_agent", "to": "final_judge"},
        {"from": "risk_agent", "to": "final_judge"},
        {"from": "final_judge", "to": "decision_engine_context"},
    ]
    contract = {
        "schema_version": LANGGRAPH_DEBATE_SCHEMA_VERSION,
        "orchestration": "langgraph_ready_contract",
        "agents": AGENTS,
        "edges": edges,
        "conditional_edges": [
            {
                "condition": "ml.model_disagreement>=0.35",
                "route": "risk_agent_extra_round",
            },
            {
                "condition": "theme.theme_score>=0.75 and theme.fact_support<=0.45",
                "route": "breeze2_semantic_fact_check",
            },
            {
                "condition": "theme.hype_risk>=0.70",
                "route": "bear_agent_strengthen_hype_risk",
            },
            {
                "condition": "news.major_event=true",
                "route": "human_in_the_loop_major_news",
            },
        ],
        "policy": {
            "allowed_use": "decision_context_only",
            "decision_authority": "advisory_to_decision_engine",
            "can_write_daily_recommendations": False,
            "can_write_market_regime_state": False,
            "can_create_pending_buy": False,
            "can_create_paper_or_real_order": False,
        },
    }
    contract["checksum"] = _sha256_json({
        "schema_version": contract["schema_version"],
        "orchestration": contract["orchestration"],
        "agents": contract["agents"],
        "edges": contract["edges"],
        "conditional_edges": contract["conditional_edges"],
        "policy": contract["policy"],
    })
    return contract


def _conditional_steps(context: dict[str, Any]) -> tuple[list[str], list[dict[str, str]]]:
    ml = _section(context, "ml")
    theme = _section(context, "theme")
    news = _section(context, "news")
    steps: list[str] = []
    tool_requests: list[dict[str, str]] = []

    if _as_float(ml.get("model_disagreement")) >= 0.35:
        steps.append("risk_agent_extra_round")
    if _as_float(theme.get("theme_score")) >= 0.75 and _as_float(theme.get("fact_support"), 1.0) <= 0.45:
        steps.append("breeze2_semantic_fact_check")
        tool_requests.append({
            "tool": "breeze2",
            "mode": "research_context_only",
            "reason": "theme_score_high_but_fact_support_low",
            "trigger": "morning_debate",
            "controller_route": "/breeze2/fact_check",
            "modal_function": "breeze2_research_context",
        })
    if _as_float(theme.get("hype_risk")) >= 0.70:
        steps.append("bear_agent_strengthen_hype_risk")
    if bool(news.get("major_event")):
        steps.append("human_in_the_loop_major_news")
    return steps, tool_requests


def _risk_flags(context: dict[str, Any], conditional_steps: list[str]) -> list[str]:
    quant = _section(context, "quant")
    theme = _section(context, "theme")
    risk = _section(context, "risk")
    flags: list[str] = []
    if _as_float(theme.get("fact_support"), 1.0) <= 0.45:
        flags.append("fact_support_low")
    if _as_float(theme.get("hype_risk")) >= 0.70:
        flags.append("hype_risk_high")
    if _as_float(risk.get("chase_risk")) >= 0.80 or _as_float(risk.get("liquidity_risk")) >= 0.65:
        flags.append("risk_block")
    if _as_float(quant.get("score")) < 50:
        flags.append("quant_score_weak")
    if "human_in_the_loop_major_news" in conditional_steps:
        flags.append("major_news_human_review")
    return flags


def _proposed_decision(context: dict[str, Any], risk_flags: list[str]) -> str:
    ml = _section(context, "ml")
    quant = _section(context, "quant")
    theme = _section(context, "theme")
    news = _section(context, "news")

    if "risk_block" in risk_flags:
        return "reject"
    if bool(news.get("major_event")) or "fact_support_low" in risk_flags or "hype_risk_high" in risk_flags:
        return "human_review"

    confidence = _as_float(ml.get("confidence"))
    quant_score = _as_float(quant.get("score"))
    theme_score = _as_float(theme.get("theme_score"))
    signal = str(ml.get("signal") or "").upper()
    if signal in {"BUY", "STRONG_BUY"} and confidence >= 0.70 and quant_score >= 70 and theme_score >= 0.55:
        return "candidate"
    if signal in {"BUY", "STRONG_BUY", "HOLD"} and quant_score >= 55:
        return "watchlist"
    return "reject"


def build_langgraph_debate_plan(
    context: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    graph = build_langgraph_debate_graph_contract()
    conditional_steps, tool_requests = _conditional_steps(context)
    risk_flags = _risk_flags(context, conditional_steps)
    proposed_decision = _proposed_decision(context, risk_flags)
    active_agents = list(AGENTS)
    if "risk_agent_extra_round" in conditional_steps:
        active_agents.append("risk_agent:extra_round")
    if "bear_agent_strengthen_hype_risk" in conditional_steps:
        active_agents.append("bear_agent:hype_rebuttal")

    plan = {
        "schema_version": LANGGRAPH_DEBATE_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "status": "planned",
        "symbol": context.get("symbol"),
        "allowed_use": "decision_context_only",
        "decision_effect": "advisory_only",
        "decision_authority": "advisory_to_decision_engine",
        "graph_checksum": graph["checksum"],
        "active_agents": active_agents,
        "conditional_steps": conditional_steps,
        "tool_requests": tool_requests,
        "proposed_decision": proposed_decision,
        "judge_inputs": {
            "risk_flags": risk_flags,
            "ml_signal": _section(context, "ml").get("signal"),
            "ml_confidence": _section(context, "ml").get("confidence"),
            "quant_score": _section(context, "quant").get("score"),
            "theme_score": _section(context, "theme").get("theme_score"),
            "regime_label": _section(context, "regime").get("label"),
        },
        "allowed_decisions": ["watchlist", "candidate", "human_review", "reject"],
        "write_authority": dict(WRITE_AUTHORITY),
    }
    plan["checksum"] = _sha256_json({
        "schema_version": plan["schema_version"],
        "status": plan["status"],
        "symbol": plan["symbol"],
        "allowed_use": plan["allowed_use"],
        "decision_effect": plan["decision_effect"],
        "decision_authority": plan["decision_authority"],
        "active_agents": plan["active_agents"],
        "conditional_steps": plan["conditional_steps"],
        "tool_requests": plan["tool_requests"],
        "proposed_decision": plan["proposed_decision"],
        "judge_inputs": plan["judge_inputs"],
        "allowed_decisions": plan["allowed_decisions"],
        "write_authority": plan["write_authority"],
    })
    return plan


def validate_langgraph_debate_plan(plan: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if plan.get("schema_version") != LANGGRAPH_DEBATE_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not plan.get("checksum"):
        errors.append("checksum_missing")
    if plan.get("allowed_use") != "decision_context_only":
        errors.append("allowed_use_must_be_decision_context_only")
    if plan.get("decision_effect") != "advisory_only":
        errors.append("decision_effect_must_be_advisory_only")
    if plan.get("decision_authority") != "advisory_to_decision_engine":
        errors.append("decision_authority_must_be_advisory_to_decision_engine")
    if plan.get("proposed_decision") not in {"watchlist", "candidate", "human_review", "reject"}:
        errors.append("proposed_decision_invalid")
    write = plan.get("write_authority")
    if not isinstance(write, dict):
        errors.append("write_authority_missing")
    else:
        for key in WRITE_AUTHORITY:
            if write.get(key) is not False:
                errors.append(f"{key}_write_must_be_false")
    active = plan.get("active_agents")
    if not isinstance(active, list):
        errors.append("active_agents_missing")
    else:
        missing = sorted(set(AGENTS) - {str(agent).split(":", 1)[0] for agent in active})
        if missing:
            errors.append(f"required_agents_missing:{','.join(missing)}")
    return errors
