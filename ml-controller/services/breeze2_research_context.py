from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


BREEZE2_REQUEST_SCHEMA_VERSION = "breeze2-research-context-request-v1"
BREEZE2_REPORT_SCHEMA_VERSION = "breeze2-research-context-v1"
SUPPORTED_TRIGGERS = ["morning_debate", "screener_enrichment"]
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
    if parsed != parsed:  # NaN
        return fallback
    return max(0.0, min(1.0, parsed))


def _section(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def _evidence_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("evidence_items") or []
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _source_type(item: dict[str, Any]) -> str:
    return str(item.get("source_type") or item.get("source") or "").lower()


def _has_trace(item: dict[str, Any]) -> bool:
    return bool(str(item.get("url") or item.get("source_url") or "").strip())


def _is_official(item: dict[str, Any]) -> bool:
    source_type = _source_type(item)
    return any(token in source_type for token in ("official", "exchange", "rss", "ir", "newsroom", "twse", "tpex"))


def _quality(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = _evidence_items(payload)
    traceable_count = sum(1 for item in evidence if _has_trace(item))
    official_count = sum(1 for item in evidence if _is_official(item))
    social_count = sum(1 for item in evidence if "social" in _source_type(item) or "forum" in _source_type(item))
    evidence_count = len(evidence)

    source_quality = 0.0
    if evidence_count:
        source_quality = 0.20
        source_quality += min(0.35, 0.12 * traceable_count)
        source_quality += min(0.35, 0.18 * official_count)
        if social_count and not official_count:
            source_quality -= 0.10
    source_quality = max(0.0, min(1.0, source_quality))
    return {
        "evidence_count": evidence_count,
        "traceable_source_count": traceable_count,
        "official_source_count": official_count,
        "social_source_count": social_count,
        "source_quality": round(source_quality, 4),
    }


def _scores(payload: dict[str, Any], quality: dict[str, Any]) -> dict[str, float]:
    theme = _section(payload, "theme")
    theme_fact_support = _as_float(theme.get("fact_support"), 0.0)
    theme_hype_risk = _as_float(theme.get("hype_risk"), 0.0)
    source_quality = _as_float(quality.get("source_quality"), 0.0)
    official_count = int(quality.get("official_source_count") or 0)
    traceable_count = int(quality.get("traceable_source_count") or 0)

    evidence_boost = min(0.35, 0.10 * traceable_count + 0.15 * official_count)
    fact_support = max(theme_fact_support, min(1.0, source_quality + evidence_boost))
    if not traceable_count:
        fact_support = min(fact_support, theme_fact_support)
    hype_risk = theme_hype_risk
    if quality.get("social_source_count") and not official_count and fact_support < 0.45:
        hype_risk = max(hype_risk, 0.75)
    contradiction_risk = max(
        (_as_float(item.get("contradiction_risk"), 0.0) for item in _evidence_items(payload)),
        default=0.0,
    )
    return {
        "fact_support": round(fact_support, 4),
        "hype_risk": round(hype_risk, 4),
        "source_quality": round(source_quality, 4),
        "contradiction_risk": round(contradiction_risk, 4),
    }


def _risk_flags(scores: dict[str, float], quality: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    if scores["fact_support"] <= 0.45:
        flags.append("fact_support_low")
    if scores["hype_risk"] >= 0.70:
        flags.append("hype_risk_high")
    if scores["contradiction_risk"] >= 0.50:
        flags.append("contradiction_risk_high")
    if int(quality.get("traceable_source_count") or 0) == 0:
        flags.append("traceable_source_missing")
    if int(quality.get("evidence_count") or 0) == 0:
        flags.append("evidence_missing")
    return flags


def _recommended_context(scores: dict[str, float], risk_flags: list[str]) -> str:
    if "evidence_missing" in risk_flags:
        return "insufficient_evidence"
    if "fact_support_low" in risk_flags or "hype_risk_high" in risk_flags or "contradiction_risk_high" in risk_flags:
        return "human_review"
    if scores["fact_support"] >= 0.65 and scores["source_quality"] >= 0.65 and scores["hype_risk"] < 0.50:
        return "candidate_context"
    return "watchlist_context"


def build_breeze2_modal_payload(payload: dict[str, Any]) -> dict[str, Any]:
    trigger = str(payload.get("trigger") or "morning_debate")
    if trigger not in SUPPORTED_TRIGGERS:
        trigger = "morning_debate"
    request = {
        "schema_version": BREEZE2_REQUEST_SCHEMA_VERSION,
        "allowed_use": "research_context_only",
        "decision_effect": "advisory_only",
        "mutation_allowed": False,
        "supported_triggers": list(SUPPORTED_TRIGGERS),
        "write_authority": dict(WRITE_AUTHORITY),
        "symbol": payload.get("symbol"),
        "stock_name": payload.get("stock_name"),
        "trigger": trigger,
        "reason": payload.get("reason") or "semantic_fact_check",
        "theme": _section(payload, "theme"),
        "news": payload.get("news") if isinstance(payload.get("news"), (dict, list)) else {},
        "evidence_items": _evidence_items(payload),
        "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
    }
    request["checksum"] = _sha256_json(request)
    return request


def _candidate_priority(candidate: dict[str, Any]) -> float:
    theme = _section(candidate, "theme")
    score = _as_float(candidate.get("score"), 0.0)
    if score > 1.0:
        score = min(1.0, score / 100.0)
    theme_score = _as_float(theme.get("theme_score"), 0.0)
    fact_support = _as_float(theme.get("fact_support"), 1.0)
    hype_risk = _as_float(theme.get("hype_risk"), 0.0)
    low_fact = max(0.0, 1.0 - fact_support)
    return round((0.30 * score) + (0.30 * theme_score) + (0.25 * low_fact) + (0.15 * hype_risk), 6)


def _needs_screener_breeze2(candidate: dict[str, Any]) -> bool:
    theme = _section(candidate, "theme")
    score = _as_float(candidate.get("score"), 0.0)
    if score > 1.0:
        score = min(1.0, score / 100.0)
    theme_score = _as_float(theme.get("theme_score"), 0.0)
    fact_support = _as_float(theme.get("fact_support"), 1.0)
    hype_risk = _as_float(theme.get("hype_risk"), 0.0)
    return (
        score >= 0.70
        and (
            (theme_score >= 0.75 and fact_support <= 0.55)
            or hype_risk >= 0.70
            or bool(candidate.get("major_event"))
        )
    )


def build_breeze2_screener_enrichment_payloads(
    candidates: list[dict[str, Any]],
    *,
    max_candidates: int = 5,
) -> list[dict[str, Any]]:
    bounded = max(0, int(max_candidates or 0))
    if bounded <= 0:
        return []
    eligible = [candidate for candidate in candidates if isinstance(candidate, dict) and _needs_screener_breeze2(candidate)]
    ranked = sorted(eligible, key=_candidate_priority, reverse=True)[:bounded]
    payloads: list[dict[str, Any]] = []
    for candidate in ranked:
        payloads.append(build_breeze2_modal_payload({
            "symbol": candidate.get("symbol"),
            "stock_name": candidate.get("stock_name") or candidate.get("name"),
            "trigger": "screener_enrichment",
            "reason": "screener_shortlist_theme_validation",
            "theme": _section(candidate, "theme"),
            "news": candidate.get("news") if isinstance(candidate.get("news"), (dict, list)) else {},
            "evidence_items": _evidence_items(candidate),
            "metadata": {
                "screener_score": candidate.get("score"),
                "screener_rank": candidate.get("rank"),
                "recommendation_lane": candidate.get("recommendation_lane"),
            },
        }))
    return payloads


def build_breeze2_research_context_report(
    payload: dict[str, Any],
    *,
    generated_at: str | None = None,
    executor: str = "controller_local_contract",
) -> dict[str, Any]:
    request = build_breeze2_modal_payload(payload)
    quality = _quality(request)
    scores = _scores(request, quality)
    risk_flags = _risk_flags(scores, quality)
    report = {
        "schema_version": BREEZE2_REPORT_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "symbol": request.get("symbol"),
        "stock_name": request.get("stock_name"),
        "trigger": request["trigger"],
        "reason": request["reason"],
        "allowed_use": "research_context_only",
        "decision_effect": "advisory_only",
        "decision_authority": "advisory_to_decision_engine",
        "source_role": "semantic_context_sidecar",
        "primary_candidate_source_allowed": False,
        "intended_consumers": ["langgraph_debate", "decision_engine_context", request["trigger"]],
        "quality": quality,
        "scores": scores,
        "risk_flags": risk_flags,
        "recommended_decision_context": _recommended_context(scores, risk_flags),
        "write_authority": dict(WRITE_AUTHORITY),
        "execution": {
            "executor": executor,
            "modal_function": "breeze2_research_context",
            "mutation_allowed": False,
        },
        "request_checksum": request["checksum"],
    }
    report["checksum"] = _sha256_json({
        "schema_version": report["schema_version"],
        "symbol": report["symbol"],
        "trigger": report["trigger"],
        "reason": report["reason"],
        "allowed_use": report["allowed_use"],
        "decision_effect": report["decision_effect"],
        "source_role": report["source_role"],
        "primary_candidate_source_allowed": report["primary_candidate_source_allowed"],
        "quality": report["quality"],
        "scores": report["scores"],
        "risk_flags": report["risk_flags"],
        "recommended_decision_context": report["recommended_decision_context"],
        "write_authority": report["write_authority"],
        "execution": report["execution"],
        "request_checksum": report["request_checksum"],
    })
    return report


def validate_breeze2_research_context_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema_version") != BREEZE2_REPORT_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if report.get("allowed_use") != "research_context_only":
        errors.append("allowed_use_must_be_research_context_only")
    if report.get("decision_effect") != "advisory_only":
        errors.append("decision_effect_must_be_advisory_only")
    if report.get("source_role") != "semantic_context_sidecar":
        errors.append("source_role_must_be_semantic_context_sidecar")
    if report.get("primary_candidate_source_allowed") is not False:
        errors.append("primary_candidate_source_must_be_false")
    if report.get("write_authority") != WRITE_AUTHORITY:
        errors.append("write_authority_must_be_false")
    execution = report.get("execution")
    if not isinstance(execution, dict) or execution.get("mutation_allowed") is not False:
        errors.append("execution_must_be_non_mutating")
    if not report.get("checksum"):
        errors.append("checksum_missing")
    return errors
