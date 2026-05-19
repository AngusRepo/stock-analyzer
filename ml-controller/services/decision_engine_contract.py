from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


DECISION_ENGINE_SCHEMA_VERSION = "decision-engine-v1"

REQUIRED_PRIMARY_INPUTS = ("screener", "ml", "regime", "risk")

SOURCE_ROLES = {
    "screener": "primary_candidate_source",
    "ml": "primary_prediction_source",
    "regime": "primary_market_context",
    "theme": "feature_context",
    "risk": "primary_guardrail",
    "finlab_preview": "preview_context_only",
    "langgraph_debate": "advisory_context_only",
    "human_flags": "override_gate",
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


def _section(inputs: dict[str, Any], key: str) -> dict[str, Any]:
    value = inputs.get(key)
    return value if isinstance(value, dict) else {}


def _present(inputs: dict[str, Any], key: str) -> bool:
    section = _section(inputs, key)
    return bool(section.get("present", bool(section)))


def _as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def build_decision_engine_contract() -> dict[str, Any]:
    contract = {
        "schema_version": DECISION_ENGINE_SCHEMA_VERSION,
        "owner": "stockvision_decision_engine",
        "required_primary_inputs": list(REQUIRED_PRIMARY_INPUTS),
        "source_roles": dict(SOURCE_ROLES),
        "external_bypass_policy": "external_tools_cannot_bypass_decision_engine",
        "allowed_decisions": ["no_trade", "watchlist", "candidate", "human_review"],
        "write_policy": {
            "can_write_decision_record": True,
            "can_create_pending_buy": False,
            "can_create_paper_order": False,
            "can_create_real_order": False,
            "paper_trade_requires_v4_25_contract": True,
            "execution_requires_v4_26_contract": True,
        },
    }
    contract["checksum"] = _sha256_json({
        "schema_version": contract["schema_version"],
        "owner": contract["owner"],
        "required_primary_inputs": contract["required_primary_inputs"],
        "source_roles": contract["source_roles"],
        "external_bypass_policy": contract["external_bypass_policy"],
        "allowed_decisions": contract["allowed_decisions"],
        "write_policy": contract["write_policy"],
    })
    return contract


def _missing_primary_inputs(inputs: dict[str, Any]) -> list[str]:
    return [key for key in REQUIRED_PRIMARY_INPUTS if not _present(inputs, key)]


def _external_candidate_claim(inputs: dict[str, Any]) -> bool:
    finlab = _section(inputs, "finlab_preview")
    debate = _section(inputs, "langgraph_debate")
    return (
        str(finlab.get("suggested_decision") or "").lower() == "candidate"
        or str(debate.get("proposed_decision") or "").lower() == "candidate"
    )


def _external_roles_safe(inputs: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    finlab = _section(inputs, "finlab_preview")
    if finlab and str(finlab.get("allowed_use") or "preview_only") != "preview_only":
        reasons.append("finlab_preview_not_preview_only")
    debate = _section(inputs, "langgraph_debate")
    if debate:
        if str(debate.get("allowed_use") or "decision_context_only") != "decision_context_only":
            reasons.append("langgraph_debate_not_context_only")
        if str(debate.get("decision_effect") or "advisory_only") != "advisory_only":
            reasons.append("langgraph_debate_not_advisory_only")
    return reasons


def _risk_reasons(inputs: dict[str, Any]) -> list[str]:
    risk = _section(inputs, "risk")
    reasons: list[str] = []
    if bool(risk.get("halt")) or bool(risk.get("blocked")):
        reasons.append(f"risk_halt:{risk.get('reason') or 'unspecified'}")
    if _as_float(risk.get("chase_risk")) >= 0.85:
        reasons.append("risk_chase_high")
    if _as_float(risk.get("liquidity_risk")) >= 0.75:
        reasons.append("risk_liquidity_high")
    return reasons


def _human_reasons(inputs: dict[str, Any]) -> list[str]:
    flags = _section(inputs, "human_flags")
    if not flags:
        return []
    if bool(flags.get("halt")):
        return [f"human_halt:{flags.get('reason') or 'manual'}"]
    if bool(flags.get("requires_review")):
        return [f"human_review_required:{flags.get('reason') or 'manual'}"]
    return []


def _primary_candidate_decision(inputs: dict[str, Any]) -> tuple[str, list[str]]:
    screener = _section(inputs, "screener")
    ml = _section(inputs, "ml")
    theme = _section(inputs, "theme")
    regime = _section(inputs, "regime")
    reasons: list[str] = []

    lane = str(screener.get("recommendation_lane") or "research_only")
    eligible_for_pending_buy = bool(screener.get("eligible_for_pending_buy", lane == "tradable"))
    if lane != "tradable" or not eligible_for_pending_buy:
        reasons.append(f"non_tradable_lane:{lane}")
        return "watchlist", reasons

    signal = str(ml.get("signal") or "").upper()
    confidence = _as_float(ml.get("confidence"))
    screener_score = _as_float(screener.get("score"))
    theme_score = _as_float(theme.get("theme_score"), 0.5)
    hype_risk = _as_float(theme.get("hype_risk"))
    fact_support = _as_float(theme.get("fact_support"), 1.0)
    regime_label = str(regime.get("label") or "unknown")

    if hype_risk >= 0.75 or fact_support <= 0.40:
        reasons.append("theme_requires_human_review")
        return "human_review", reasons
    if regime_label == "bear" and confidence < 0.85:
        reasons.append("bear_regime_requires_review_or_stronger_ml")
        return "human_review", reasons
    if signal in {"BUY", "STRONG_BUY"} and confidence >= 0.70 and screener_score >= 70 and theme_score >= 0.50:
        return "candidate", reasons
    if signal in {"BUY", "STRONG_BUY", "HOLD"} and screener_score >= 55:
        return "watchlist", reasons
    reasons.append("primary_evidence_too_weak")
    return "no_trade", reasons


def _allowed_next_steps(decision: str) -> list[str]:
    return {
        "candidate": ["decision_record", "pending_buy_review"],
        "watchlist": ["watchlist_review"],
        "human_review": ["request_human_review"],
        "no_trade": ["record_no_trade"],
    }[decision]


def build_decision_engine_decision(
    inputs: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    missing = _missing_primary_inputs(inputs)
    external_role_reasons = _external_roles_safe(inputs)
    external_claim = _external_candidate_claim(inputs)
    external_bypass_detected = bool(external_claim and missing)
    blocking_reasons = [f"missing_primary_input:{key}" for key in missing]
    blocking_reasons.extend(external_role_reasons)
    if external_bypass_detected:
        blocking_reasons.append("external_candidate_without_primary_sources")

    status = "evaluated"
    if missing:
        decision = "no_trade"
        status = "fail_closed"
    else:
        human_reasons = _human_reasons(inputs)
        risk_reasons = _risk_reasons(inputs)
        if any(reason.startswith("human_halt:") for reason in human_reasons):
            decision = "no_trade"
            status = "blocked"
            blocking_reasons.extend(human_reasons)
        elif risk_reasons:
            decision = "no_trade"
            status = "blocked"
            blocking_reasons.extend(risk_reasons)
        elif human_reasons:
            decision = "human_review"
            blocking_reasons.extend(human_reasons)
        elif external_role_reasons:
            decision = "human_review"
            status = "blocked"
        else:
            decision, primary_reasons = _primary_candidate_decision(inputs)
            blocking_reasons.extend(primary_reasons)

    report = {
        "schema_version": DECISION_ENGINE_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "symbol": inputs.get("symbol"),
        "status": status,
        "decision_owner": "stockvision_decision_engine",
        "decision": decision,
        "decision_effect": "decision_engine_owned",
        "source_roles": dict(SOURCE_ROLES),
        "required_primary_inputs": list(REQUIRED_PRIMARY_INPUTS),
        "missing_primary_inputs": missing,
        "external_bypass_detected": external_bypass_detected,
        "blocking_reasons": blocking_reasons,
        "allowed_next_steps": _allowed_next_steps(decision),
        "write_authority": dict(WRITE_AUTHORITY),
        "input_summary": {
            "screener_lane": _section(inputs, "screener").get("recommendation_lane"),
            "ml_signal": _section(inputs, "ml").get("signal"),
            "ml_confidence": _section(inputs, "ml").get("confidence"),
            "regime_label": _section(inputs, "regime").get("label"),
            "finlab_preview_status": _section(inputs, "finlab_preview").get("status"),
            "debate_proposed_decision": _section(inputs, "langgraph_debate").get("proposed_decision"),
        },
    }
    report["checksum"] = _sha256_json({
        "schema_version": report["schema_version"],
        "symbol": report["symbol"],
        "status": report["status"],
        "decision_owner": report["decision_owner"],
        "decision": report["decision"],
        "decision_effect": report["decision_effect"],
        "source_roles": report["source_roles"],
        "required_primary_inputs": report["required_primary_inputs"],
        "missing_primary_inputs": report["missing_primary_inputs"],
        "external_bypass_detected": report["external_bypass_detected"],
        "blocking_reasons": report["blocking_reasons"],
        "allowed_next_steps": report["allowed_next_steps"],
        "write_authority": report["write_authority"],
        "input_summary": report["input_summary"],
    })
    return report


def validate_decision_engine_decision(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != DECISION_ENGINE_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not report.get("checksum"):
        errors.append("checksum_missing")
    if report.get("decision_owner") != "stockvision_decision_engine":
        errors.append("decision_owner_must_be_stockvision_decision_engine")
    if report.get("decision_effect") != "decision_engine_owned":
        errors.append("decision_effect_must_be_decision_engine_owned")
    if report.get("decision") not in {"no_trade", "watchlist", "candidate", "human_review"}:
        errors.append("decision_invalid")
    if report.get("external_bypass_detected") and not report.get("blocking_reasons"):
        errors.append("external_bypass_without_blocking_reason")
    write = report.get("write_authority")
    if not isinstance(write, dict):
        errors.append("write_authority_missing")
    else:
        for key in WRITE_AUTHORITY:
            if write.get(key) is not False:
                errors.append(f"{key}_write_must_be_false")
    source_roles = report.get("source_roles")
    if not isinstance(source_roles, dict):
        errors.append("source_roles_missing")
    elif source_roles.get("finlab_preview") != "preview_context_only":
        errors.append("finlab_preview_role_invalid")
    return errors
