"""External evidence policy contract for StockVision V4.

External news/event sources are evidence, not alpha owners. This module keeps
official RSS, allowlisted company IR RSS, and GDELT outputs traceable and
non-trading until separate quality and promotion gates pass.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlparse


SCHEMA_VERSION = "external-evidence-contract-v1"
FORBIDDEN_DECISION_EFFECTS = {"trade_signal", "direct_alpha", "auto_order"}
BLOCKED_SPAM_STATUSES = {"spam", "syndicated_spam", "blocked"}


@dataclass(frozen=True)
class ExternalEvidenceItem:
    schema_version: str
    source_id: str
    source_kind: str
    title: str
    published_at: str
    allowed_use: str
    decision_effect: str
    direct_alpha_allowed: bool
    promotion_gate: str
    trace: dict[str, Any]
    features: dict[str, Any]
    cleaning: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def build_external_evidence_policy() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "frontend_api_keys_allowed": False,
        "direct_alpha_allowed": False,
        "direct_trade_signal_allowed": False,
        "decision_effect": "context_manual_review_or_shadow_only",
        "required_cleaning_rules": [
            "dedup_by_canonical_url",
            "source_quality_score",
            "entity_linking_confidence",
            "spam_or_syndication_filter",
            "published_at_freshness_check",
        ],
    }


def build_external_evidence_source_registry() -> dict[str, Any]:
    sources = [
        {
            "source_id": "official_rss",
            "source_kind": "official_rss",
            "provider": "TWSE_TPEX_FSC_MOEA",
            "access_mode": "backend_or_dagster_fetch",
            "authority": "official",
            "allowed_use": "official_event_audit",
            "decision_effect": "manual_review_or_context",
            "mode": "official_audit",
            "direct_alpha_allowed": False,
            "secret_policy": "no_secret_expected",
            "promotion_gate": "source_allowlist_and_event_taxonomy_required",
        },
        {
            "source_id": "company_ir_rss",
            "source_kind": "company_first_party",
            "provider": "Company IR RSS / Newsroom",
            "access_mode": "backend_or_dagster_fetch",
            "authority": "first_party_company",
            "allowed_use": "watchlist_first_party_context",
            "decision_effect": "watchlist_or_manual_review",
            "mode": "watchlist_context",
            "direct_alpha_allowed": False,
            "secret_policy": "no_secret_expected",
            "promotion_gate": "domain_allowlist_and_duplicate_filter_required",
        },
        {
            "source_id": "gdelt_events",
            "source_kind": "global_event_graph",
            "provider": "GDELT",
            "access_mode": "backend_or_dagster_fetch",
            "authority": "global_news_event_derived",
            "allowed_use": "shadow_global_event_context",
            "decision_effect": "research_or_risk_context",
            "mode": "shadow",
            "direct_alpha_allowed": False,
            "secret_policy": "no_frontend_key",
            "promotion_gate": "entity_linking_noise_backtest_required",
        },
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "policy": build_external_evidence_policy(),
        "sources": sources,
    }


def _source_by_id() -> dict[str, dict[str, Any]]:
    return {source["source_id"]: source for source in build_external_evidence_source_registry()["sources"]}


def _clean_list(values: Any) -> list[str]:
    if not isinstance(values, (list, tuple, set, frozenset)):
        return []
    return sorted({str(value).strip() for value in values if str(value).strip()})


def _as_float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _host_from_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed.netloc.lower()


def normalize_external_evidence_item(raw: dict[str, Any]) -> ExternalEvidenceItem:
    source_id = str(raw.get("source_id") or "unknown")
    source = _source_by_id().get(source_id, {})
    tone = _as_float_or_none(raw.get("tone"))
    source_url = str(raw.get("url") or raw.get("source_url") or "")
    raw_payload = raw.get("raw") if isinstance(raw.get("raw"), dict) else {}
    raw_id = (
        raw.get("id")
        or raw.get("guid")
        or raw_payload.get("guid")
        or raw_payload.get("id")
    )
    return ExternalEvidenceItem(
        schema_version=SCHEMA_VERSION,
        source_id=source_id,
        source_kind=str(source.get("source_kind") or raw.get("source_kind") or "unknown"),
        title=str(raw.get("title") or ""),
        published_at=str(raw.get("published_at") or ""),
        allowed_use=str(source.get("allowed_use") or "shadow_context"),
        decision_effect=str(source.get("decision_effect") or "context_only"),
        direct_alpha_allowed=False,
        promotion_gate=str(source.get("promotion_gate") or "manual_review_required"),
        trace={
            "source_url": source_url,
            "symbols": _clean_list(raw.get("symbols")),
            "provider": source.get("provider") or raw.get("provider") or "unknown",
            "authority": source.get("authority") or raw.get("authority") or "unknown",
            "raw_id": raw_id,
            "normalized_url_host": _host_from_url(source_url),
        },
        features={
            "tone": tone,
            "themes": _clean_list(raw.get("themes")),
            "language": raw.get("language"),
            "region": raw.get("region"),
        },
        cleaning={
            "dedup_key": raw.get("canonical_url") or raw.get("url") or raw.get("source_url") or "",
            "source_quality_score": raw.get("source_quality_score"),
            "entity_linking_confidence": raw.get("entity_linking_confidence"),
            "spam_filter_status": raw.get("spam_filter_status") or "not_evaluated",
            "domain_allowlist_match": bool(raw.get("domain_allowlist_match", False)),
        },
    )


def validate_external_evidence_item(item: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(item, dict):
        return ["item_invalid"]
    source_id = str(item.get("source_id") or "unknown")
    if source_id not in _source_by_id():
        errors.append(f"{source_id}:source_id_not_allowed")
    if item.get("direct_alpha_allowed") is True:
        errors.append(f"{source_id}:direct_alpha_not_allowed")
    if item.get("decision_effect") in FORBIDDEN_DECISION_EFFECTS:
        errors.append(f"{source_id}:decision_effect_not_allowed")
    trace = item.get("trace") if isinstance(item.get("trace"), dict) else {}
    if not trace.get("source_url"):
        errors.append(f"{source_id}:source_url_required")
    if not item.get("published_at"):
        errors.append(f"{source_id}:published_at_required")
    cleaning = item.get("cleaning") if isinstance(item.get("cleaning"), dict) else {}
    if not cleaning.get("dedup_key"):
        errors.append(f"{source_id}:dedup_key_required")
    source_quality_score = _as_float_or_none(cleaning.get("source_quality_score"))
    if source_quality_score is None:
        errors.append(f"{source_id}:source_quality_score_required")
    entity_linking_confidence = _as_float_or_none(cleaning.get("entity_linking_confidence"))
    if entity_linking_confidence is None:
        errors.append(f"{source_id}:entity_linking_confidence_required")
    if str(cleaning.get("spam_filter_status") or "").strip().lower() in BLOCKED_SPAM_STATUSES:
        errors.append(f"{source_id}:spam_filter_blocked")
    if source_id == "company_ir_rss" and cleaning.get("domain_allowlist_match") is not True:
        errors.append(f"{source_id}:domain_allowlist_match_required")
    return errors


def build_external_evidence_packet(raw_items: list[dict[str, Any]], generated_at: str) -> dict[str, Any]:
    accepted_items: list[dict[str, Any]] = []
    rejected_items: list[dict[str, Any]] = []
    by_source: dict[str, int] = {}

    for raw in raw_items:
        if not isinstance(raw, dict):
            by_source["unknown"] = by_source.get("unknown", 0) + 1
            rejected_items.append(
                {
                    "source_id": "unknown",
                    "title": "",
                    "errors": ["item_invalid"],
                    "trace": {},
                }
            )
            continue
        item = normalize_external_evidence_item(raw).to_dict()
        source_id = str(item.get("source_id") or "unknown")
        by_source[source_id] = by_source.get(source_id, 0) + 1
        errors = validate_external_evidence_item(item)
        if errors:
            rejected_items.append(
                {
                    "source_id": source_id,
                    "title": item.get("title") or "",
                    "errors": errors,
                    "trace": item.get("trace") if isinstance(item.get("trace"), dict) else {},
                }
            )
            continue
        accepted_items.append(item)

    policy = build_external_evidence_policy()
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "decision_effect": policy["decision_effect"],
        "direct_alpha_allowed": False,
        "items": accepted_items,
        "rejected_items": rejected_items,
        "quality_summary": {
            "total": len(raw_items),
            "accepted": len(accepted_items),
            "rejected": len(rejected_items),
            "by_source": by_source,
        },
    }


def validate_external_evidence_packet(packet: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if packet.get("direct_alpha_allowed") is True:
        errors.append("packet:direct_alpha_not_allowed")
    if packet.get("decision_effect") in FORBIDDEN_DECISION_EFFECTS:
        errors.append("packet:decision_effect_not_allowed")
    items = packet.get("items")
    if not isinstance(items, list):
        errors.append("items_missing")
        return errors
    for item in items:
        errors.extend(validate_external_evidence_item(item))
    return errors
