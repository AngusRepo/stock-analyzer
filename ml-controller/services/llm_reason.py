"""
llm_reason.py — Generate LLM recommendation reasons
2026-04-07 LangGraph A+B refactor
2026-04-10 C1 cost optimization: Sonnet → Gemini 3.1 Flash Lite ($24/月 → ~$1/月)

Primary: Gemini 3.1 Flash Lite (faster, cheaper, better JSON compliance)
Fallback: Claude Sonnet (if GEMINI_API_KEY not set or Gemini fails)
"""
from __future__ import annotations
import os
import re
import json
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-3.1-flash-lite-preview"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929"  # fallback
ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages"


def _build_stock_line(idx: int, c: dict) -> str:
    chip_amt = ((c.get("foreign_net_5d") or 0) + (c.get("trust_net_5d") or 0))
    rsi = c.get("rsi14")
    rsi_str = f"{rsi:.0f}" if rsi is not None else "N/A"
    conf_pct = (c.get("ml_confidence") or 0) * 100
    macd_h = c.get("macd_hist") or 0
    return (
        f"{idx + 1}. {c['symbol']} {c.get('name','')} | "
        f"signal={c.get('signal','N/A')} score={c.get('score',0)}"
        f"(籌碼{c.get('chip_score',0)}+技術{c.get('tech_score',0)}+ML{c.get('ml_score',0)}) | "
        f"ML投票{c.get('ml_models_up',0)}↑/{c.get('ml_models_down',0)}↓"
        f"(共{c.get('ml_models_total',0)}) conf={conf_pct:.0f}% | "
        f"RSI={rsi_str} MACD{'多' if macd_h > 0 else '空'} | "
        f"5日法人淨額{chip_amt:.1f}億 | 價{c.get('current_price','N/A')}"
    )


SYSTEM_PROMPT = """你是台灣股市資深分析師，負責為每日推薦清單撰寫具資訊量的推薦理由。
規則：
- 每支股票的 reason 限 120 字以內，需整合籌碼、技術、ML 三面向的重點
- watchPoints 給 3 條具體觀察重點，每條 60-100 字，必須含具體數字（價位/百分比/天數）
  例：「留意 58.8 月線支撐能否守住，跌破則 ATR 停損 56.08；上方 63.59 為 ML target1」
  例：「RSI 39 雖未進超賣，但連續 3 日量縮，需確認量能放大才轉強訊號」
  例：「外資 5 日淨買超 0.3 億偏弱，須觀察下週是否回補；投信若同步買進可加速推升」
- 語氣專業簡潔，不用「建議」「推薦」等字眼，改用「留意」「觀察」
- 若 ML 信心高(>0.6)，可強調模型共識；若低(<0.5)，強調需確認
- 必須回傳 JSON array，格式：[{"symbol":"2330","reason":"...","watchPoints":["...","...","..."]}]
- 長度必須和輸入股票數量完全一致"""


async def _call_gemini(user_prompt: str, n_candidates: int, timeout: float) -> Optional[str]:
    """Call Gemini 3.1 Flash Lite. Returns raw text or None on failure."""
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
            logger.warning(f"[llm_reason] Gemini HTTP {resp.status_code}: {resp.text[:200]}")
            return None
        data = resp.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if not text:
            logger.warning("[llm_reason] Gemini returned empty text")
            return None
        usage = data.get("usageMetadata", {})
        tokens_in = int(usage.get("promptTokenCount", 0) or 0)
        tokens_out = int(usage.get("candidatesTokenCount", 0) or 0)
        logger.info(
            f"[llm_reason] Gemini OK tokens in={tokens_in} out={tokens_out}"
        )
        # #43 cost tracking (fire-and-forget)
        try:
            from .cost_tracker import record_llm_call
            await record_llm_call(
                "llm_reason", "gemini", GEMINI_MODEL,
                tokens_in, tokens_out,
                meta={"n_candidates": n_candidates},
            )
        except Exception:
            pass
        return text
    except Exception as e:
        logger.warning(f"[llm_reason] Gemini error: {type(e).__name__}: {e!r}")
        return None


async def _call_anthropic(user_prompt: str, n_candidates: int, timeout: float, max_attempts: int) -> Optional[str]:
    """Call Claude Sonnet (fallback). Returns raw text or None on failure."""
    if not ANTHROPIC_API_KEY:
        return None
    import asyncio
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
                logger.error(f"[llm_reason] Anthropic HTTP {resp.status_code}: {resp.text[:300]}")
                return None
            data = resp.json()
            text_blocks = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
            raw = "\n".join(text_blocks)
            logger.info(f"[llm_reason] Anthropic fallback OK (attempt={attempt})")
            # #43 cost tracking (fire-and-forget)
            try:
                from .cost_tracker import record_llm_call
                usage = data.get("usage", {}) or {}
                await record_llm_call(
                    "llm_reason", "anthropic", ANTHROPIC_MODEL,
                    int(usage.get("input_tokens", 0) or 0),
                    int(usage.get("output_tokens", 0) or 0),
                    meta={"n_candidates": n_candidates, "attempt": attempt},
                )
            except Exception:
                pass
            return raw
        except httpx.RequestError as e:
            exc_type = type(e).__name__
            if attempt < max_attempts:
                backoff = 2 ** (attempt - 1)
                logger.warning(f"[llm_reason] Anthropic network error {attempt}/{max_attempts}, retry in {backoff}s: {exc_type}")
                await asyncio.sleep(backoff)
                continue
            logger.error(f"[llm_reason] Anthropic failed after {max_attempts} attempts: {exc_type}")
            return None
        except Exception as e:
            logger.error(f"[llm_reason] Anthropic unexpected: {type(e).__name__}: {e!r}")
            return None
    return None


def _parse_reasons(raw: str, n_candidates: int) -> dict[str, dict]:
    """Parse JSON array from raw LLM response text."""
    match = re.search(r"\[[\s\S]*\]", raw, re.DOTALL)
    if not match:
        logger.error(f"[llm_reason] No JSON array in response: {raw[:200]}")
        return {}
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as e:
        logger.error(f"[llm_reason] JSON parse failed: {e}")
        return {}

    result: dict[str, dict] = {}
    for item in parsed:
        symbol = item.get("symbol")
        reason = item.get("reason")
        if symbol and reason:
            result[symbol] = {
                "reason": reason[:200],
                "watchPoints": (item.get("watchPoints") or [])[:3],
            }
    return result


async def generate_recommendation_reasons(
    candidates: list[dict],
    top_themes: Optional[list[str]] = None,
    timeout: float = 60.0,
    max_attempts: int = 3,
) -> dict[str, dict]:
    """
    Generate LLM reasons for N candidates.

    Primary: Gemini 3.1 Flash Lite (fast, cheap, good JSON)
    Fallback: Claude Sonnet (if Gemini unavailable or fails)

    Returns: {symbol: {"reason": str, "watchPoints": list[str]}}
    """
    if not candidates:
        return {}
    if not GEMINI_API_KEY and not ANTHROPIC_API_KEY:
        logger.warning("[llm_reason] No API key set (GEMINI or ANTHROPIC), skipping")
        return {}

    stock_list = "\n".join(_build_stock_line(i, c) for i, c in enumerate(candidates))
    theme_hint = ""
    if top_themes:
        theme_hint = f"\n\n今日主流主題：{'、'.join(top_themes)}"

    user_prompt = (
        f"請為以下 {len(candidates)} 支推薦股票各寫一段推薦理由：\n"
        f"{stock_list}{theme_hint}"
    )

    # Layer 1: Gemini 3.1 Flash Lite
    raw = await _call_gemini(user_prompt, len(candidates), timeout)
    source = "gemini"

    # Layer 2: Claude Sonnet fallback
    if raw is None:
        logger.info("[llm_reason] Gemini unavailable, falling back to Anthropic")
        raw = await _call_anthropic(user_prompt, len(candidates), timeout, max_attempts)
        source = "anthropic"

    if raw is None:
        logger.error("[llm_reason] All LLM providers failed")
        return {}

    result = _parse_reasons(raw, len(candidates))
    logger.info(
        f"[llm_reason] Generated {len(result)}/{len(candidates)} reasons via {source}"
    )
    return result
