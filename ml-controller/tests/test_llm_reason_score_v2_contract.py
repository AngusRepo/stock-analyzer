from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import llm_reason  # noqa: E402
from services.breeze2_reason_shadow import build_breeze2_reason_generation_payload_from_canonical  # noqa: E402


def test_llm_reason_generation_path_does_not_expose_anthropic_fallback():
    assert not hasattr(llm_reason, "ANTHROPIC_API_KEY")
    assert not hasattr(llm_reason, "_call_anthropic")


def _score_v2_payload() -> dict:
    return {
        "version": "score_v2",
        "weights": {
            "mlEdge": 25,
            "chipFlow": 25,
            "technicalStructure": 25,
            "fundamentalQuality": 25,
            "newsTheme": 0,
        },
        "components": {
            "mlEdge": 22,
            "chipFlow": 21,
            "technicalStructure": 20,
            "fundamentalQuality": 18,
            "newsTheme": 4,
        },
        "total": 85,
        "alphaAdjustment": 3,
        "finalScore": 88,
    }


def _candidate() -> dict:
    return {
        "symbol": "2330",
        "name": "TSMC",
        "signal": "BUY",
        "score": 10,
        "chip_score": 1,
        "tech_score": 1,
        "momentum_score": 0,
        "ml_score": 1,
        "score_components": _score_v2_payload(),
        "foreign_net_5d": 2.1,
        "trust_net_5d": 0.4,
        "rsi14": 60,
        "macd_hist": 1.2,
        "confidence": 0.81,
        "current_price": 900,
    }


def test_canonical_candidate_payload_prefers_score_v2_and_excludes_legacy_scores():
    payload = llm_reason.build_canonical_candidate_payload(_candidate())

    assert payload["schema_version"] == "stockvision-canonical-candidate-payload-v1"
    assert payload["score_components_status"] == "ok"
    assert payload["score_components"]["finalScore"] == 88
    assert payload["score_components"]["components"]["mlEdge"] == 22
    for legacy_key in ("score", "ml_score", "chip_score", "tech_score", "momentum_score"):
        assert legacy_key not in payload


def test_generate_recommendation_reasons_prompt_uses_canonical_payload_and_trade_plan(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, str] = {}

    async def fake_call_gemini(user_prompt: str, n_candidates: int, timeout: float):
        if "invalid_items=" not in user_prompt:
            captured["prompt"] = user_prompt
        if "invalid_items=" in user_prompt:
            captured["repair_prompt"] = user_prompt
            return json.dumps([
                {
                    "symbol": "2330",
                    "reason": "Score V2 reason",
                    "tradePlan": {
                        "bias": "bullish",
                        "entry": "頧撥蝣箄?",
                        "risk": "use system stop",
                        "target": "take profit near resistance",
                        "invalidation": "breaks support",
                        "positionSizing": "cap by allocator weight",
                        "timeHorizon": "3-10 sessions",
                        "catalyst": "chip and volume continuation",
                        "noTradeCondition": "skip gap-up chase",
                    },
                    "watchPoints": ["risk"],
                }
            ])
        return json.dumps([
            {
                "symbol": "2330",
                "reason": "Score V2 reason",
                "tradePlan": {"bias": "偏多", "entry": "轉強確認", "risk": "跌破支撐", "target": "壓力區"},
                "watchPoints": ["risk"],
            }
        ])

    monkeypatch.setattr(llm_reason, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(llm_reason, "_call_gemini", fake_call_gemini)

    result = asyncio.run(llm_reason.generate_recommendation_reasons([_candidate()], top_themes=["AI"]))

    assert result["2330"]["reason"] == "Score V2 reason"
    assert result["2330"]["provider"] == "gemini"
    assert result["2330"]["tradePlanStatus"] == "valid"
    assert result["2330"]["tradePlanRepairAttempted"] is True
    assert result["2330"]["tradePlan"]["entry"] == "轉強確認"
    assert "canonical_candidate_payload=" in captured["prompt"]
    assert "tradePlan_required_fields=" in captured["prompt"]
    assert "invalid_items=" in captured["repair_prompt"]
    assert '"schema_version":"stockvision-canonical-candidate-payload-v1"' in captured["prompt"]
    assert '"score_components"' in captured["prompt"]
    assert '"finalScore":88' in captured["prompt"]
    assert '"top_themes":["AI"]' in captured["prompt"]
    for legacy_key in ('"ml_score"', '"chip_score"', '"tech_score"', '"momentum_score"'):
        assert legacy_key not in captured["prompt"]


def test_gemini_and_breeze2_trade_plans_share_same_canonical_candidate_payload():
    canonical_candidates = llm_reason.build_canonical_candidate_payloads([_candidate()])
    gemini_request = llm_reason.build_gemini_trade_plan_request(canonical_candidates, top_themes=["AI"])
    breeze2_request = build_breeze2_reason_generation_payload_from_canonical(
        canonical_candidates,
        run_date="2026-06-21",
        execute_model=True,
    )

    assert gemini_request["provider_task"] == "gemini_trade_plan"
    assert breeze2_request["provider_task"] == "breeze2_trade_plan"
    assert gemini_request["candidates"] == breeze2_request["candidates"]
    assert gemini_request["candidates"][0]["schema_version"] == "stockvision-canonical-candidate-payload-v1"
    assert "score" not in gemini_request["candidates"][0]
    assert "ml_score" not in breeze2_request["candidates"][0]
