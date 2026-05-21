from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import llm_reason  # noqa: E402


def _score_v2_payload() -> dict:
    return {
        "version": "score_v2",
        "weights": {
            "mlEdge": 25,
            "chipFlow": 25,
            "technicalStructure": 25,
            "fundamentalQuality": 20,
            "newsTheme": 5,
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


def test_llm_reason_stock_line_prefers_score_v2_payload():
    line = llm_reason._build_stock_line(0, _candidate())

    assert "Score V2 finalScore=88.0/100" in line
    assert "ML Edge=22.0/25" in line
    assert "Chip Flow=21.0/25" in line
    assert "Technical Structure=20.0/25" in line
    assert "score=10" not in line
    assert "籌碼+技術+ML" not in line


@pytest.mark.asyncio
async def test_generate_recommendation_reasons_prompt_uses_score_v2(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, str] = {}

    async def fake_call_gemini(user_prompt: str, n_candidates: int, timeout: float):
        captured["prompt"] = user_prompt
        return json.dumps([
            {"symbol": "2330", "reason": "Score V2 reason", "watchPoints": ["risk"]}
        ])

    monkeypatch.setattr(llm_reason, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(llm_reason, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(llm_reason, "_call_gemini", fake_call_gemini)

    result = await llm_reason.generate_recommendation_reasons([_candidate()], top_themes=["AI"])

    assert result["2330"]["reason"] == "Score V2 reason"
    assert "Score V2 finalScore=88.0/100" in captured["prompt"]
    assert "News/Theme=4.0/5" in captured["prompt"]
    assert "Top themes: AI" in captured["prompt"]
    assert "chip+tech+ml" not in captured["prompt"]
