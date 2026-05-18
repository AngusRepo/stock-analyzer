from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.breeze2_research_context import (  # noqa: E402
    build_breeze2_modal_payload,
    build_breeze2_research_context_report,
    build_breeze2_screener_enrichment_payloads,
    validate_breeze2_research_context_report,
)


def test_breeze2_report_is_research_context_only_and_flags_low_fact_support():
    report = build_breeze2_research_context_report(
        {
            "symbol": "2330",
            "stock_name": "台積電",
            "trigger": "morning_debate",
            "reason": "theme_score_high_but_fact_support_low",
            "theme": {
                "name": "AI server",
                "theme_score": 0.88,
                "fact_support": 0.22,
                "hype_risk": 0.71,
            },
            "evidence_items": [
                {
                    "source": "social",
                    "title": "市場傳聞",
                    "snippet": "短線資金討論 AI 題材，但缺少正式來源。",
                }
            ],
        },
        generated_at="2026-05-17T09:00:00+08:00",
    )

    assert report["schema_version"] == "breeze2-research-context-v1"
    assert report["allowed_use"] == "research_context_only"
    assert report["decision_effect"] == "advisory_only"
    assert report["write_authority"] == {
        "daily_recommendations": False,
        "market_regime_state": False,
        "pending_buy": False,
        "paper_order": False,
        "real_order": False,
    }
    assert report["recommended_decision_context"] == "human_review"
    assert "fact_support_low" in report["risk_flags"]
    assert "traceable_source_missing" in report["risk_flags"]
    assert "hype_risk_high" in report["risk_flags"]
    assert validate_breeze2_research_context_report(report) == []


def test_breeze2_report_supports_screener_enrichment_without_becoming_primary_source():
    report = build_breeze2_research_context_report(
        {
            "symbol": "7820",
            "trigger": "screener_enrichment",
            "reason": "screener_shortlist_theme_validation",
            "theme": {
                "name": "advanced packaging",
                "theme_score": 0.78,
                "fact_support": 0.52,
                "hype_risk": 0.28,
            },
            "evidence_items": [
                {
                    "source": "official_ir",
                    "url": "https://example.com/company/newsroom/advanced-packaging",
                    "title": "Company newsroom update",
                    "snippet": "Company announced a verified capacity expansion.",
                    "source_type": "company_ir",
                },
                {
                    "source": "exchange_rss",
                    "url": "https://example.com/twse/rss/item",
                    "title": "Official exchange announcement",
                    "snippet": "Traceable official filing.",
                    "source_type": "official",
                },
            ],
        },
        generated_at="2026-05-17T09:05:00+08:00",
    )

    assert report["trigger"] == "screener_enrichment"
    assert "screener_enrichment" in report["intended_consumers"]
    assert report["source_role"] == "semantic_context_sidecar"
    assert report["primary_candidate_source_allowed"] is False
    assert report["recommended_decision_context"] in {"watchlist_context", "candidate_context"}
    assert report["quality"]["traceable_source_count"] == 2
    assert report["quality"]["official_source_count"] == 2
    assert validate_breeze2_research_context_report(report) == []


def test_breeze2_modal_payload_forces_non_mutating_scope_for_debate_and_screener():
    payload = build_breeze2_modal_payload(
        {
            "symbol": "2330",
            "trigger": "morning_debate",
            "reason": "theme_score_high_but_fact_support_low",
            "theme": {"theme_score": 0.9, "fact_support": 0.3},
        }
    )

    assert payload["schema_version"] == "breeze2-research-context-request-v1"
    assert payload["allowed_use"] == "research_context_only"
    assert payload["mutation_allowed"] is False
    assert payload["supported_triggers"] == ["morning_debate", "screener_enrichment"]
    assert payload["write_authority"] == {
        "daily_recommendations": False,
        "market_regime_state": False,
        "pending_buy": False,
        "paper_order": False,
        "real_order": False,
    }


def test_breeze2_screener_enrichment_planner_limits_to_semantic_risk_shortlist():
    payloads = build_breeze2_screener_enrichment_payloads(
        [
            {
                "symbol": "1111",
                "score": 92,
                "theme": {"theme_score": 0.88, "fact_support": 0.30, "hype_risk": 0.76},
            },
            {
                "symbol": "2222",
                "score": 89,
                "theme": {"theme_score": 0.82, "fact_support": 0.62, "hype_risk": 0.20},
            },
            {
                "symbol": "3333",
                "score": 40,
                "theme": {"theme_score": 0.50, "fact_support": 0.80, "hype_risk": 0.10},
            },
            {
                "symbol": "4444",
                "score": 86,
                "theme": {"theme_score": 0.55, "fact_support": 0.70, "hype_risk": 0.82},
            },
        ],
        max_candidates=2,
    )

    assert [payload["symbol"] for payload in payloads] == ["1111", "4444"]
    assert all(payload["trigger"] == "screener_enrichment" for payload in payloads)
    assert all(payload["mutation_allowed"] is False for payload in payloads)
    assert all(payload["allowed_use"] == "research_context_only" for payload in payloads)
