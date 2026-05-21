from __future__ import annotations

from app.breeze2_reason_generation import (
    build_breeze2_reason_generation_prompt,
    build_fallback_breeze2_reason_generation,
    parse_breeze2_reason_generation_text,
    validate_breeze2_reason_generation_report,
)


def _payload() -> dict:
    return {
        "candidates": [
            {
                "symbol": "2330",
                "name": "台積電",
                "signal": "BUY",
                "score": 82.5,
                "score_components": {
                    "version": "score_v2",
                    "components": {
                        "mlEdge": 20,
                        "chipFlow": 18,
                        "technicalStructure": 16,
                        "fundamentalQuality": 12,
                        "newsTheme": 3,
                    },
                },
                "reason": "template reason",
                "watch_points": ["Alpha bucket: breakout", "Market structure: uptrend"],
            }
        ],
        "run_date": "2026-05-21",
    }


def test_prompt_contract_is_taiwan_finance_json_and_non_mutating():
    prompt = build_breeze2_reason_generation_prompt(_payload())

    assert "繁體中文" in prompt
    assert "台灣股市" in prompt
    assert "不得下單" in prompt
    assert '"symbol"' in prompt
    assert '"watchPoints"' in prompt
    assert "2330" in prompt


def test_parse_breeze2_reason_generation_text_extracts_bounded_json():
    parsed = parse_breeze2_reason_generation_text(
        """
        [
          {
            "symbol": "2330",
            "reason": "台積電受惠先進製程與AI伺服器需求，但追價需看量能。",
            "watchPoints": ["觀察量能是否續增", "留意外資買賣超", "破月線降風險", "第四點應被截斷"]
          }
        ]
        """
    )

    assert parsed["2330"]["reason"].startswith("台積電")
    assert parsed["2330"]["watchPoints"] == ["觀察量能是否續增", "留意外資買賣超", "破月線降風險"]


def test_fallback_report_is_shadow_only_and_validates():
    report = build_fallback_breeze2_reason_generation(_payload(), model_id="MediaTek-Research/Llama-Breeze2-3B-Instruct-v0_1")

    assert report["schema_version"] == "breeze2-reason-generation-v1"
    assert report["allowed_use"] == "reason_shadow_only"
    assert report["decision_effect"] == "advisory_only"
    assert report["primary_candidate_source_allowed"] is False
    assert report["model_id"] == "MediaTek-Research/Llama-Breeze2-3B-Instruct-v0_1"
    assert "2330" in report["reasons"]
    assert validate_breeze2_reason_generation_report(report) == []
