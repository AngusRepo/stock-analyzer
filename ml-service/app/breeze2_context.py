from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import hashlib
import json


REPORT_SCHEMA_VERSION = "breeze2-research-context-v1"
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
    if parsed != parsed:
        return fallback
    return max(0.0, min(1.0, parsed))


def _theme(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("theme")
    return value if isinstance(value, dict) else {}


def _evidence(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("evidence_items") or []
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _source_type(item: dict[str, Any]) -> str:
    return str(item.get("source_type") or item.get("source") or "").lower()


def _has_trace(item: dict[str, Any]) -> bool:
    return bool(str(item.get("url") or item.get("source_url") or "").strip())


def _is_official(item: dict[str, Any]) -> bool:
    source_type = _source_type(item)
    return any(token in source_type for token in ("official", "exchange", "rss", "ir", "newsroom", "twse", "tpex"))


def _quality(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = _evidence(payload)
    traceable = sum(1 for item in evidence if _has_trace(item))
    official = sum(1 for item in evidence if _is_official(item))
    social = sum(1 for item in evidence if "social" in _source_type(item) or "forum" in _source_type(item))
    source_quality = 0.0
    if evidence:
        source_quality = max(0.0, min(1.0, 0.20 + min(0.35, 0.12 * traceable) + min(0.35, 0.18 * official) - (0.10 if social and not official else 0.0)))
    return {
        "evidence_count": len(evidence),
        "traceable_source_count": traceable,
        "official_source_count": official,
        "social_source_count": social,
        "source_quality": round(source_quality, 4),
    }


def _scores(payload: dict[str, Any], quality: dict[str, Any]) -> dict[str, float]:
    theme = _theme(payload)
    traceable = int(quality.get("traceable_source_count") or 0)
    official = int(quality.get("official_source_count") or 0)
    fact_support = max(
        _as_float(theme.get("fact_support"), 0.0),
        min(1.0, _as_float(quality.get("source_quality"), 0.0) + min(0.35, 0.10 * traceable + 0.15 * official)),
    )
    if not traceable:
        fact_support = min(fact_support, _as_float(theme.get("fact_support"), 0.0))
    hype_risk = _as_float(theme.get("hype_risk"), 0.0)
    if quality.get("social_source_count") and not official and fact_support < 0.45:
        hype_risk = max(hype_risk, 0.75)
    contradiction = max((_as_float(item.get("contradiction_risk"), 0.0) for item in _evidence(payload)), default=0.0)
    return {
        "fact_support": round(fact_support, 4),
        "hype_risk": round(hype_risk, 4),
        "source_quality": round(_as_float(quality.get("source_quality"), 0.0), 4),
        "contradiction_risk": round(contradiction, 4),
    }


def _flags(scores: dict[str, float], quality: dict[str, Any]) -> list[str]:
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


def _decision_context(scores: dict[str, float], flags: list[str]) -> str:
    if "evidence_missing" in flags:
        return "insufficient_evidence"
    if "fact_support_low" in flags or "hype_risk_high" in flags or "contradiction_risk_high" in flags:
        return "human_review"
    if scores["fact_support"] >= 0.65 and scores["source_quality"] >= 0.65 and scores["hype_risk"] < 0.50:
        return "candidate_context"
    return "watchlist_context"


def build_breeze2_research_context(payload: dict[str, Any]) -> dict[str, Any]:
    quality = _quality(payload)
    scores = _scores(payload, quality)
    flags = _flags(scores, quality)
    report = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "generated_at": _utc_now(),
        "symbol": payload.get("symbol"),
        "stock_name": payload.get("stock_name"),
        "trigger": payload.get("trigger") or "morning_debate",
        "reason": payload.get("reason") or "semantic_fact_check",
        "allowed_use": "research_context_only",
        "decision_effect": "advisory_only",
        "decision_authority": "advisory_to_decision_engine",
        "source_role": "semantic_context_sidecar",
        "primary_candidate_source_allowed": False,
        "intended_consumers": ["langgraph_debate", "decision_engine_context", payload.get("trigger") or "morning_debate"],
        "quality": quality,
        "scores": scores,
        "risk_flags": flags,
        "recommended_decision_context": _decision_context(scores, flags),
        "write_authority": dict(WRITE_AUTHORITY),
        "execution": {
            "executor": "modal_breeze2_research_context",
            "modal_function": "breeze2_research_context",
            "mutation_allowed": False,
        },
        "request_checksum": payload.get("checksum"),
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
