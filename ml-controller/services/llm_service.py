"""
services/llm_service.py - /recommend reason generation.

The endpoint is still supported, and prompts describe candidates with canonical
Score V2 vocabulary.
"""
from __future__ import annotations

import json
import logging
import math
import re
from typing import Any

import httpx

from services.recommend_score_v2_projection import ScoreV2RecommendationCandidate

logger = logging.getLogger(__name__)

SCORE_V2_WEIGHTS = {
    "mlEdge": 25.0,
    "chipFlow": 25.0,
    "technicalStructure": 25.0,
    "fundamentalQuality": 25.0,
    "newsTheme": 0.0,
}


def _score_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _round1(value: float) -> float:
    return round(float(value) * 10) / 10


def _clamp(value: Any, maximum: float) -> float:
    return _round1(max(0.0, min(float(maximum), _score_number(value))))


def _rescale(value: Any, old_max: float, new_max: float) -> float:
    if old_max <= 0:
        return 0.0
    return _clamp((_score_number(value) / old_max) * new_max, new_max)


def _project_score_v2(candidate: ScoreV2RecommendationCandidate) -> dict[str, Any]:
    """Fallback projection for direct callers that do not pass score_components."""
    components = {
        "mlEdge": _rescale(candidate.ml_score, 30.0, SCORE_V2_WEIGHTS["mlEdge"]),
        "chipFlow": _rescale(candidate.chip_score, 40.0, SCORE_V2_WEIGHTS["chipFlow"]),
        "technicalStructure": _rescale(candidate.tech_score, 30.0, SCORE_V2_WEIGHTS["technicalStructure"]),
        "fundamentalQuality": 0.0,
        "newsTheme": 0.0,
    }
    total = _round1(sum(components.values()))
    return {
        "version": "score_v2",
        "weights": SCORE_V2_WEIGHTS,
        "components": components,
        "total": total,
        "alphaAdjustment": 0.0,
        "finalScore": total,
        "formula": "score_v2_total + alphaAdjustment",
        "reasons": ["llm_service_storage_projection"],
    }


def _payload_for(candidate: ScoreV2RecommendationCandidate, payloads_by_symbol: dict[str, dict] | None) -> dict[str, Any]:
    payload = (payloads_by_symbol or {}).get(candidate.symbol)
    if isinstance(payload, dict) and payload.get("version") == "score_v2" and isinstance(payload.get("components"), dict):
        return payload
    return _project_score_v2(candidate)


def _component(payload: dict[str, Any], key: str) -> float:
    components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    return _clamp(components.get(key), SCORE_V2_WEIGHTS.get(key, 100.0))


def _final_score(payload: dict[str, Any]) -> float:
    return _clamp(payload.get("finalScore", payload.get("total")), 100.0)


def _confidence(value: float | None) -> str:
    return f"{value * 100:.0f}%" if value is not None else "N/A"


def _candidate_prompt_line(candidate: ScoreV2RecommendationCandidate, payload: dict[str, Any], index: int) -> str:
    components = (
        f"ML Edge {_component(payload, 'mlEdge'):.1f}/25, "
        f"Chip Flow {_component(payload, 'chipFlow'):.1f}/25, "
        f"Technical {_component(payload, 'technicalStructure'):.1f}/25, "
        f"Fundamental {_component(payload, 'fundamentalQuality'):.1f}/25, "
        f"News/Theme {_component(payload, 'newsTheme'):.1f}/0"
    )
    trend = ", ".join(
        [
            "MA5+" if candidate.above_ma5 else "MA5-",
            "MA20+" if candidate.above_ma20 else "MA20-",
            "MA60+" if candidate.above_ma60 else "MA60-",
        ]
    )
    return "\n".join(
        [
            f"[{index}] {candidate.symbol} {candidate.name} sector={candidate.sector or 'N/A'}",
            f"  Score V2 finalScore: {_final_score(payload):.1f}/100 (base {_score_number(payload.get('total')):.1f}, alpha {_score_number(payload.get('alphaAdjustment')):.1f})",
            f"  Score V2 components: {components}",
            f"  Chip flow evidence: foreign+trust 5d {candidate.total_chip_5d / 1e8:.2f}B TWD, foreign consecutive {candidate.foreign_consecutive}d",
            f"  Technical evidence: RSI14 {candidate.rsi14 if candidate.rsi14 is not None else 'N/A'}, MACD hist {candidate.macd_hist if candidate.macd_hist is not None else 'N/A'}, trend {trend}",
            f"  ML signal: {candidate.ml_signal or 'N/A'}, confidence {_confidence(candidate.ml_confidence)}",
        ]
    )


def generate_reasons(
    api_key: str,
    candidates: list[ScoreV2RecommendationCandidate],
    sectors: list[dict],
    score_payloads_by_symbol: dict[str, dict] | None = None,
) -> list[dict]:
    """Generate recommendation reasons with canonical Score V2 context."""
    top_sectors = "\n".join(
        f"{sector.get('sector', 'N/A')}: total_net={_score_number(sector.get('total_net')):.1f}, "
        f"avg_rsi={sector.get('avg_rsi') or 'N/A'}, breadth={sector.get('up_count', 0)}/{sector.get('stock_count', 0)}"
        for sector in sectors[:5]
    ) or "N/A"

    stock_list = "\n\n".join(
        _candidate_prompt_line(candidate, _payload_for(candidate, score_payloads_by_symbol), index)
        for index, candidate in enumerate(candidates, start=1)
    )

    prompt = (
        "你是台股投資研究助理。請根據 Score V2 的 finalScore 與四構面，"
        "為每檔股票產生精簡、可驗證、不可誇大勝率的推薦理由。\n\n"
        f"Sector context:\n{top_sectors}\n\n"
        f"Candidates:\n{stock_list}\n\n"
        "Output JSON array only. Each item format:\n"
        '[{"reason":"150字內，使用 Score V2 構面與具體證據",'
        '"watch_points":["風險或觀察點1","風險或觀察點2"]}]'
    )

    try:
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1500,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        resp.raise_for_status()
        text = resp.json()["content"][0]["text"]
        match = re.search(r"\[[\s\S]*\]", text)
        if match:
            return json.loads(match.group())
    except Exception as exc:
        logger.warning("LLM reason generation failed: %s", exc)

    return [
        {
            "reason": "Score V2 資料已建立，但 LLM 摘要暫時不可用；請以 finalScore、四構面與風險旗標人工覆核。",
            "watch_points": ["確認成交量與籌碼延續性", "等待收盤後資料驗證"],
        }
    ] * len(candidates)
