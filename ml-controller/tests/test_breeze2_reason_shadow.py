from __future__ import annotations

from pathlib import Path

from services.breeze2_reason_shadow import (
    breeze2_reason_shadow_metrics,
    build_breeze2_reason_generation_payload,
    build_breeze2_reason_shadow,
    build_breeze2_reason_shadow_for_candidates,
    coerce_breeze2_reason_generation_report,
)


def test_breeze2_shadow_reason_is_advisory_and_does_not_need_legacy_llm_provider():
    shadow = build_breeze2_reason_shadow(
        [
            {
                "symbol": "2330",
                "name": "台積電",
                "score": 82.5,
                "signal": "BUY",
                "reason": "template reason",
                "watch_points": ["Alpha bucket: breakout", "Market structure: uptrend"],
            }
        ],
        {
            "2330": {
                "schema_version": "breeze2-research-context-v1",
                "allowed_use": "research_context_only",
                "decision_effect": "advisory_only",
                "recommended_decision_context": "human_review",
                "scores": {
                    "fact_support": 0.31,
                    "hype_risk": 0.76,
                    "source_quality": 0.2,
                    "contradiction_risk": 0.0,
                },
                "risk_flags": ["fact_support_low", "hype_risk_high"],
                "quality": {"traceable_source_count": 1, "official_source_count": 0},
            }
        },
    )

    assert shadow["2330"]["source"] == "breeze2_shadow"
    assert shadow["2330"]["decision_effect"] == "advisory_only"
    assert shadow["2330"]["reason"].startswith("Breeze2 shadow")
    assert "人工複核" in shadow["2330"]["reason"]
    assert shadow["2330"]["tradePlan"]["bias"].startswith("台積電")
    assert any(point.startswith("breeze2:human_review") for point in shadow["2330"]["watchPoints"])
    assert "Alpha bucket: breakout" in shadow["2330"]["watchPoints"]


def test_breeze2_shadow_rejects_non_advisory_reports():
    shadow = build_breeze2_reason_shadow(
        [{"symbol": "2330", "name": "台積電"}],
        {
            "2330": {
                "schema_version": "breeze2-research-context-v1",
                "allowed_use": "primary_candidate_source",
                "decision_effect": "mutating",
            }
        },
    )

    assert shadow == {}


def test_breeze2_shadow_for_candidates_builds_local_context_and_metrics():
    shadow = build_breeze2_reason_shadow_for_candidates([
        {
            "symbol": "2317",
            "name": "鴻海",
            "score": 88,
            "reason": "AI server theme",
            "watch_points": ["buzz_evidence:AI server", "Alpha bucket: quality"],
            "theme": {"theme_score": 0.8, "fact_support": 0.3, "hype_risk": 0.75},
        }
    ])
    metrics = breeze2_reason_shadow_metrics(shadow)

    assert shadow["2317"]["source"] == "breeze2_shadow"
    assert metrics["count"] == 1
    assert metrics["contexts"]["human_review"] == 1
    assert metrics["risk_flags"]["fact_support_low"] == 1


def test_breeze2_reason_generation_payload_is_shadow_only():
    payload = build_breeze2_reason_generation_payload(
        [{
            "symbol": "2330",
            "name": "台積電",
            "score": 82,
            "score_components": {
                "version": "score_v2",
                "components": {"mlEdge": 20},
                "total": 20,
                "finalScore": 20,
            },
        }],
        run_date="2026-05-21",
    )

    assert payload["allowed_use"] == "reason_shadow_only"
    assert payload["decision_effect"] == "advisory_only"
    assert payload["execute_model"] is True
    assert payload["run_date"] == "2026-05-21"
    assert payload["candidates"][0]["symbol"] == "2330"
    assert payload["candidates"][0]["schema_version"] == "stockvision-canonical-candidate-payload-v1"
    assert payload["candidates"][0]["score_components_status"] == "ok"
    assert "score" not in payload["candidates"][0]


def test_coerce_breeze2_generation_report_requires_shadow_contract():
    shadow = coerce_breeze2_reason_generation_report({
        "schema_version": "breeze2-reason-generation-v1",
        "allowed_use": "reason_shadow_only",
        "decision_effect": "advisory_only",
        "primary_candidate_source_allowed": False,
        "reasons": {
            "2330": {
                "source": "breeze2_generation_shadow",
                "reason": "台積電受惠先進製程，但追價需看量能。",
                "tradePlan": {"bias": "偏多", "entry": "轉強確認", "risk": "跌破支撐", "target": "壓力區"},
                "watchPoints": ["觀察成交量", "留意外資", "跌破月線降風險"],
            }
        },
    })

    assert shadow["2330"]["source"] == "breeze2_generation_shadow"
    assert shadow["2330"]["decision_effect"] == "advisory_only"
    assert shadow["2330"]["tradePlan"]["entry"] == "轉強確認"
    assert shadow["2330"]["watchPoints"][0] == "觀察成交量"
    assert coerce_breeze2_reason_generation_report({"schema_version": "bad"}) == {}


def test_pipeline_keeps_breeze2_shadow_out_of_canonical_reason_writer():
    pipeline_path = Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py"
    pipeline = pipeline_path.read_text(encoding="utf-8")

    assert 'provider in {"context", "modal_generation"}' in pipeline
    assert 'or "modal_generation"' in pipeline
    assert "build_canonical_candidate_payloads(candidates)" in pipeline
    assert "generate_recommendation_reasons_from_payloads" in pipeline
    assert "build_breeze2_generation_shadow_for_canonical_payloads" in pipeline
    assert "asyncio.wait_for" in pipeline
    assert "BREEZE2_REASON_GENERATION_TIMEOUT_SECONDS" in pipeline
    assert "Breeze2 modal generation timed out" in pipeline
    assert "build_breeze2_reason_shadow_for_canonical_payloads" in pipeline
    assert "fallback to context shadow" in pipeline
    assert 'return {"llm_reasons": reasons, "breeze2_reason_shadow": breeze2_shadow}' in pipeline
    assert 'merge_llm_reasons_into_recommendations(final, state.get("llm_reasons") or {})' in pipeline
    assert 'merge_llm_reasons_into_recommendations(final, state.get("breeze2_reason_shadow")' not in pipeline
