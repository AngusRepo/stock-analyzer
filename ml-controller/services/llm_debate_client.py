"""
Gemini-only LLM client for the formal Debate service.

This ml-controller path intentionally does not use Anthropic fallback. The
recommendation/trade-plan contract is Gemini + Breeze2 side-by-side, while the
formal debate judge path is Gemini-only with deterministic local degradation in
debate_service when Gemini is unavailable.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL_DEFAULT = "gemini-3.5-flash"


async def call_llm(
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.4,
    max_tokens: int = 512,
    client: Optional[httpx.AsyncClient] = None,
    ab_force: Optional[str] = None,
) -> tuple[str, str]:
    """Call Gemini for formal debate.

    Returns (text, source) where source is ``gemini_api``.

    ``ab_force`` is retained for compatibility with older call sites. Non-Gemini
    values are ignored because the formal debate path no longer supports
    provider A/B routing.
    """
    close_client = False
    if client is None:
        client = httpx.AsyncClient()
        close_client = True

    try:
        if ab_force and ab_force != "gemini":
            logger.info("[LLM-Debate] ignoring ab_force=%s; Gemini-only policy active", ab_force)

        if not GEMINI_API_KEY:
            raise RuntimeError("Gemini debate LLM unavailable: GEMINI_API_KEY is not configured")

        try:
            url = (
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{GEMINI_MODEL_DEFAULT}:generateContent?key={GEMINI_API_KEY}"
            )
            resp = await client.post(
                url,
                headers={"Content-Type": "application/json"},
                json={
                    "systemInstruction": {"parts": [{"text": system_prompt}]},
                    "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                    "generationConfig": {
                        "temperature": temperature,
                        "maxOutputTokens": max_tokens,
                    },
                },
                timeout=30.0,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Gemini debate API returned HTTP {resp.status_code}")

            data = resp.json()
            cands = data.get("candidates") or []
            if not cands:
                raise RuntimeError("Gemini debate API returned no candidates")

            parts = (cands[0].get("content") or {}).get("parts") or []
            if not parts:
                raise RuntimeError("Gemini debate API returned no content parts")

            text = parts[0].get("text", "")
            if not text:
                raise RuntimeError("Gemini debate API returned empty text")

            try:
                from .cost_tracker import record_llm_call

                usage = data.get("usageMetadata") or {}
                await record_llm_call(
                    "llm_debate",
                    "gemini",
                    GEMINI_MODEL_DEFAULT,
                    int(usage.get("promptTokenCount", 0) or 0),
                    int(usage.get("candidatesTokenCount", 0) or 0),
                )
            except Exception:
                pass
            return text, "gemini_api"
        except Exception as exc:
            logger.warning("[LLM-Debate] Gemini failed: %s", exc)
            raise RuntimeError(
                "Gemini debate LLM unavailable; no secondary provider configured by policy"
            ) from exc
    finally:
        if close_client:
            await client.aclose()
