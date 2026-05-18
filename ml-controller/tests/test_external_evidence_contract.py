from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.external_evidence_contract import (  # noqa: E402
    build_external_evidence_packet,
    build_external_evidence_policy,
    build_external_evidence_source_registry,
    normalize_external_evidence_item,
    validate_external_evidence_packet,
)


def test_source_registry_keeps_external_evidence_traceable_and_non_alpha():
    registry = build_external_evidence_source_registry()
    by_id = {source["source_id"]: source for source in registry["sources"]}

    assert registry["schema_version"] == "external-evidence-contract-v1"
    assert by_id["finnhub_news"]["access_mode"] == "backend_only"
    assert by_id["finnhub_news"]["allowed_use"] == "event_context_only"
    assert by_id["gdelt_events"]["mode"] == "shadow"
    assert by_id["official_rss"]["authority"] == "official"
    assert by_id["company_ir_rss"]["authority"] == "first_party_company"
    assert all(source["direct_alpha_allowed"] is False for source in registry["sources"])


def test_normalized_evidence_item_preserves_url_source_and_entity_trace():
    item = normalize_external_evidence_item(
        {
            "source_id": "official_rss",
            "title": "TWSE trading halt notice",
            "url": "https://www.twse.com.tw/example.xml",
            "published_at": "2026-05-15T08:00:00+08:00",
            "symbols": ["2330", "2454"],
            "themes": ["trading_halt"],
            "tone": -0.4,
            "raw": {"guid": "abc"},
        }
    )

    payload = item.to_dict()
    assert payload["allowed_use"] == "official_event_audit"
    assert payload["decision_effect"] == "manual_review_or_context"
    assert payload["direct_alpha_allowed"] is False
    assert payload["trace"]["source_url"] == "https://www.twse.com.tw/example.xml"
    assert payload["trace"]["symbols"] == ["2330", "2454"]
    assert payload["features"]["tone"] == -0.4
    assert payload["features"]["themes"] == ["trading_halt"]


def test_gdelt_is_shadow_global_event_context_even_with_tone_and_themes():
    item = normalize_external_evidence_item(
        {
            "source_id": "gdelt_events",
            "title": "Global supply chain disruption",
            "url": "https://example.com/news",
            "published_at": "2026-05-15T00:00:00Z",
            "symbols": ["2330"],
            "tone": -3.2,
            "themes": ["SUPPLY_CHAIN", "SEMICONDUCTORS"],
        }
    )

    payload = item.to_dict()
    assert payload["allowed_use"] == "shadow_global_event_context"
    assert payload["decision_effect"] == "research_or_risk_context"
    assert payload["direct_alpha_allowed"] is False
    assert payload["promotion_gate"] == "entity_linking_noise_backtest_required"


def test_packet_validation_blocks_direct_alpha_and_missing_traceability():
    item = normalize_external_evidence_item(
        {
            "source_id": "finnhub_news",
            "title": "Company headline",
            "url": "https://example.com/a",
            "published_at": "2026-05-15T00:00:00Z",
            "source_quality_score": 0.8,
            "entity_linking_confidence": 0.9,
            "spam_filter_status": "clean",
        }
    ).to_dict()
    item["direct_alpha_allowed"] = True
    item["trace"]["source_url"] = ""

    errors = validate_external_evidence_packet({"items": [item]})

    assert errors == [
        "finnhub_news:direct_alpha_not_allowed",
        "finnhub_news:source_url_required",
    ]


def test_external_evidence_policy_blocks_frontend_keys_and_direct_trading():
    policy = build_external_evidence_policy()

    assert policy["frontend_api_keys_allowed"] is False
    assert policy["direct_trade_signal_allowed"] is False
    assert policy["required_cleaning_rules"] == [
        "dedup_by_canonical_url",
        "source_quality_score",
        "entity_linking_confidence",
        "spam_or_syndication_filter",
        "published_at_freshness_check",
    ]


def test_packet_builder_keeps_valid_items_and_quarantines_bad_items():
    packet = build_external_evidence_packet(
        [
            {
                "source_id": "finnhub_news",
                "title": "Company headline",
                "url": "https://finnhub.example/news/1",
                "published_at": "2026-05-16T00:00:00Z",
                "symbols": ["2330"],
                "source_quality_score": 0.84,
                "entity_linking_confidence": 0.92,
                "spam_filter_status": "clean",
            },
            {
                "source_id": "finnhub_news",
                "title": "Missing URL",
                "published_at": "2026-05-16T00:00:00Z",
                "source_quality_score": 0.84,
                "entity_linking_confidence": 0.92,
                "spam_filter_status": "clean",
            },
            {
                "source_id": "random_blog",
                "title": "Unknown source",
                "url": "https://random.example/news/1",
                "published_at": "2026-05-16T00:00:00Z",
                "source_quality_score": 0.4,
                "entity_linking_confidence": 0.4,
                "spam_filter_status": "clean",
            },
        ],
        generated_at="2026-05-16T01:00:00Z",
    )

    assert packet["schema_version"] == "external-evidence-contract-v1"
    assert packet["generated_at"] == "2026-05-16T01:00:00Z"
    assert packet["decision_effect"] == "context_manual_review_or_shadow_only"
    assert packet["direct_alpha_allowed"] is False
    assert len(packet["items"]) == 1
    assert packet["items"][0]["source_id"] == "finnhub_news"
    assert packet["quality_summary"] == {
        "total": 3,
        "accepted": 1,
        "rejected": 2,
        "by_source": {"finnhub_news": 2, "random_blog": 1},
    }
    assert [item["errors"] for item in packet["rejected_items"]] == [
        ["finnhub_news:source_url_required", "finnhub_news:dedup_key_required"],
        ["random_blog:source_id_not_allowed"],
    ]
    assert validate_external_evidence_packet(packet) == []


def test_packet_validation_requires_quality_cleaning_and_blocks_spam():
    item = normalize_external_evidence_item(
        {
            "source_id": "official_rss",
            "title": "Official notice",
            "url": "https://www.twse.com.tw/example.xml",
            "published_at": "2026-05-16T00:00:00Z",
            "spam_filter_status": "spam",
        }
    ).to_dict()

    errors = validate_external_evidence_packet({"items": [item]})

    assert errors == [
        "official_rss:source_quality_score_required",
        "official_rss:entity_linking_confidence_required",
        "official_rss:spam_filter_blocked",
    ]


def test_company_ir_requires_domain_allowlist_match_before_entering_packet():
    packet = build_external_evidence_packet(
        [
            {
                "source_id": "company_ir_rss",
                "title": "Company newsroom update",
                "url": "https://random-blog.example/stock/2330",
                "published_at": "2026-05-16T00:00:00Z",
                "symbols": ["2330"],
                "source_quality_score": 0.8,
                "entity_linking_confidence": 0.9,
                "spam_filter_status": "clean",
                "domain_allowlist_match": False,
            },
            {
                "source_id": "company_ir_rss",
                "title": "Company IR update",
                "url": "https://ir.example-company.com/news/1",
                "published_at": "2026-05-16T00:00:00Z",
                "symbols": ["2330"],
                "source_quality_score": 0.9,
                "entity_linking_confidence": 0.95,
                "spam_filter_status": "clean",
                "domain_allowlist_match": True,
            },
        ],
        generated_at="2026-05-16T01:00:00Z",
    )

    assert len(packet["items"]) == 1
    assert packet["items"][0]["trace"]["source_url"] == "https://ir.example-company.com/news/1"
    assert packet["rejected_items"][0]["errors"] == ["company_ir_rss:domain_allowlist_match_required"]
