"""Generate Score V2 recommendation reasons for Pipeline V2."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-3.1-flash-lite-preview"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929"
ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages"

SCORE_V2_WEIGHTS = {
    "mlEdge": 25.0,
    "chipFlow": 25.0,
    "technicalStructure": 25.0,
    "fundamentalQuality": 20.0,
    "newsTheme": 5.0,
}

SYSTEM_PROMPT = """你是台股投資研究助理，負責為每日推薦清單撰寫可驗證的推薦理由。

規則：
- 每支股票 reason 限 120 字內，必須使用 Score V2 的 finalScore 與五構面語意。
- 五構面為 ML Edge、Chip Flow、Technical Structure、Fundamental Quality、News/Theme。
- 不可宣稱保證獲利、絕對勝率或水晶球式預測；請用條件式、風險可控的語氣。
- watchPoints 最多 3 點，必須是具體風險、觀察價量或資料品質提醒。
- 必須只回傳 JSON array，格式：
  [{"symbol":"2330","reason":"...","watchPoints":["...","...","..."]}]
"""


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _round1(value: float) -> float:
    return math.floor(float(value) * 10 + 0.5) / 10


def _clamp(value: Any, maximum: float) -> float:
    return _round1(max(0.0, min(float(maximum), _number(value))))


def _parse_score_v2_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
    if isinstance(value, dict) and value.get("version") == "score_v2" and isinstance(value.get("components"), dict):
        return value
    return None


def _score_v2_payload(c: dict[str, Any]) -> dict[str, Any] | None:
    payload = _parse_score_v2_payload(c.get("score_v2"))
    if payload:
        return payload
    return None


def _component(payload: dict[str, Any], key: str) -> float:
    components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    return _clamp(components.get(key), SCORE_V2_WEIGHTS.get(key, 100.0))


def _score_context(c: dict[str, Any]) -> str:
    payload = _score_v2_payload(c)
    if payload is None:
        return "Score V2 finalScore=missing_score_v2; components=missing_score_v2"
    final_score = _clamp(payload.get("finalScore", payload.get("total")), 100.0)
    total = _clamp(payload.get("total"), 100.0)
    alpha = _round1(_number(payload.get("alphaAdjustment"), final_score - total))
    return (
        f"Score V2 finalScore={final_score:.1f}/100 "
        f"(base={total:.1f}, alpha={alpha:.1f}); "
        f"ML Edge={_component(payload, 'mlEdge'):.1f}/25, "
        f"Chip Flow={_component(payload, 'chipFlow'):.1f}/25, "
        f"Technical Structure={_component(payload, 'technicalStructure'):.1f}/25, "
        f"Fundamental Quality={_component(payload, 'fundamentalQuality'):.1f}/20, "
        f"News/Theme={_component(payload, 'newsTheme'):.1f}/5"
    )


def _build_stock_line(idx: int, c: dict[str, Any]) -> str:
    chip_amt = _number(c.get("foreign_net_5d")) + _number(c.get("trust_net_5d"))
    rsi = c.get("rsi14")
    rsi_str = f"{_number(rsi):.0f}" if rsi is not None else "N/A"
    conf_pct = _number(c.get("confidence", c.get("ml_confidence"))) * 100
    macd_h = _number(c.get("macd_hist"))
    vote_summary = c.get("ml_vote_summary_text") or c.get("ml_vote_summary") or "N/A"
    return (
        f"{idx + 1}. {c['symbol']} {c.get('name', '')} | "
        f"signal={c.get('signal', 'N/A')} | {_score_context(c)} | "
        f"ML vote={vote_summary}, conf={conf_pct:.0f}% | "
        f"RSI={rsi_str}, MACD={'positive' if macd_h > 0 else 'non-positive'} | "
        f"5d chip cash={chip_amt:.1f}B TWD | price={c.get('current_price', 'N/A')}"
    )


async def _call_gemini(user_prompt: str, n_candidates: int, timeout: float) -> Optional[str]:
    """Call Gemini. Returns raw text or None on failure."""
    if not GEMINI_API_KEY:
        return None
    url = f"{GEMINI_BASE}/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": min(4096, n_candidates * 400),
            "responseMimeType": "application/json",
        },
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=body, headers={"Content-Type": "application/json"})
        if resp.status_code != 200:
            logger.warning("[llm_reason] Gemini HTTP %s: %s", resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if not text:
            logger.warning("[llm_reason] Gemini returned empty text")
            return None
        usage = data.get("usageMetadata", {})
        tokens_in = int(usage.get("promptTokenCount", 0) or 0)
        tokens_out = int(usage.get("candidatesTokenCount", 0) or 0)
        logger.info("[llm_reason] Gemini OK tokens in=%s out=%s", tokens_in, tokens_out)
        try:
            from .cost_tracker import record_llm_call

            await record_llm_call(
                "llm_reason",
                "gemini",
                GEMINI_MODEL,
                tokens_in,
                tokens_out,
                meta={"n_candidates": n_candidates},
            )
        except Exception:
            pass
        return text
    except Exception as exc:
        logger.warning("[llm_reason] Gemini error: %s: %r", type(exc).__name__, exc)
        return None


async def _call_anthropic(user_prompt: str, n_candidates: int, timeout: float, max_attempts: int) -> Optional[str]:
    """Call Claude fallback. Returns raw text or None on failure."""
    if not ANTHROPIC_API_KEY:
        return None
    max_tokens = min(8192, n_candidates * 500)
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": max_tokens,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    for attempt in range(1, max_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(ANTHROPIC_BASE, headers=headers, json=body)
            if resp.status_code != 200:
                logger.error("[llm_reason] Anthropic HTTP %s: %s", resp.status_code, resp.text[:300])
                return None
            data = resp.json()
            text_blocks = [block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"]
            raw = "\n".join(text_blocks)
            logger.info("[llm_reason] Anthropic fallback OK (attempt=%s)", attempt)
            try:
                from .cost_tracker import record_llm_call

                usage = data.get("usage", {}) or {}
                await record_llm_call(
                    "llm_reason",
                    "anthropic",
                    ANTHROPIC_MODEL,
                    int(usage.get("input_tokens", 0) or 0),
                    int(usage.get("output_tokens", 0) or 0),
                    meta={"n_candidates": n_candidates, "attempt": attempt},
                )
            except Exception:
                pass
            return raw
        except httpx.RequestError as exc:
            if attempt < max_attempts:
                backoff = 2 ** (attempt - 1)
                logger.warning(
                    "[llm_reason] Anthropic network error %s/%s, retry in %ss: %s",
                    attempt,
                    max_attempts,
                    backoff,
                    type(exc).__name__,
                )
                await asyncio.sleep(backoff)
                continue
            logger.error("[llm_reason] Anthropic failed after %s attempts: %s", max_attempts, type(exc).__name__)
            return None
        except Exception as exc:
            logger.error("[llm_reason] Anthropic unexpected: %s: %r", type(exc).__name__, exc)
            return None
    return None


def _parse_reasons(raw: str, n_candidates: int) -> dict[str, dict]:
    """Parse JSON array from raw LLM response text."""
    match = re.search(r"\[[\s\S]*\]", raw, re.DOTALL)
    if not match:
        logger.error("[llm_reason] No JSON array in response: %s", raw[:200])
        return {}
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        logger.error("[llm_reason] JSON parse failed: %s", exc)
        return {}

    result: dict[str, dict] = {}
    for item in parsed:
        symbol = item.get("symbol")
        reason = item.get("reason")
        if symbol and reason:
            result[symbol] = {
                "reason": reason[:200],
                "watchPoints": (item.get("watchPoints") or item.get("watch_points") or [])[:3],
            }
    return result


async def generate_recommendation_reasons(
    candidates: list[dict],
    top_themes: Optional[list[str]] = None,
    timeout: float = 60.0,
    max_attempts: int = 3,
) -> dict[str, dict]:
    """
    Generate LLM reasons for recommendation candidates.

    Primary: Gemini. Fallback: Claude.
    Returns: {symbol: {"reason": str, "watchPoints": list[str]}}
    """
    if not candidates:
        return {}
    if not GEMINI_API_KEY and not ANTHROPIC_API_KEY:
        logger.warning("[llm_reason] No API key set (GEMINI or ANTHROPIC), skipping")
        return {}

    stock_list = "\n".join(_build_stock_line(i, c) for i, c in enumerate(candidates))
    theme_hint = f"\n\nTop themes: {', '.join(top_themes)}" if top_themes else ""
    user_prompt = (
        f"請為以下 {len(candidates)} 檔候選股票撰寫推薦理由。\n"
        f"{stock_list}{theme_hint}"
    )

    raw = await _call_gemini(user_prompt, len(candidates), timeout)
    source = "gemini"
    if raw is None:
        logger.info("[llm_reason] Gemini unavailable, falling back to Anthropic")
        raw = await _call_anthropic(user_prompt, len(candidates), timeout, max_attempts)
        source = "anthropic"

    if raw is None:
        logger.error("[llm_reason] All LLM providers failed")
        return {}

    result = _parse_reasons(raw, len(candidates))
    logger.info("[llm_reason] Generated %s/%s reasons via %s", len(result), len(candidates), source)
    return result
