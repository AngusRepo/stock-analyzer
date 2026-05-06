"""
llm_debate_client.py — Multi-provider LLM client for the Debate service

Ported from worker/src/lib/debateTrader.ts callLLM.
ml-controller variant removes Layer 1 (Local Tunnel) and Layer 2 (Workers AI)
since those are Worker-only bindings. Priority:
  1. Gemini 3.1 Flash Lite (primary — cheap, fast, good zh-TW)
  2. Anthropic Claude Haiku 4.5 (fallback)

KV-driven config (ml-controller reads via CF_API_TOKEN → D1/KV):
  ml:config.debate_model — Anthropic model name override
  ml:config.debate_max_rounds — 1..3, default 2 (read by debate_service)
"""
from __future__ import annotations
import os
import logging
import time
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


GEMINI_API_KEY    = os.environ.get("GEMINI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

GEMINI_MODEL_DEFAULT    = "gemini-3.1-flash-lite-preview"
ANTHROPIC_MODEL_DEFAULT = "claude-haiku-4-5-20251001"

# CF Worker KV read (for debate_model override). ml-controller already has
# CF_API_TOKEN + KV ID via env.
CF_ACCOUNT_ID     = os.environ.get("CF_ACCOUNT_ID", "").strip()
CF_KV_NAMESPACE_ID = os.environ.get("CF_KV_NAMESPACE_ID", "").strip()
CF_API_TOKEN      = os.environ.get("CF_API_TOKEN", "")


# In-process cache for ml:config (5 min TTL matches TS)
_ml_config_cache: Optional[dict] = None
_ml_config_cached_at: float = 0.0
_ML_CONFIG_TTL = 5 * 60  # seconds


async def _get_ml_config(client: httpx.AsyncClient) -> dict:
    global _ml_config_cache, _ml_config_cached_at
    if _ml_config_cache is not None and (time.time() - _ml_config_cached_at) < _ML_CONFIG_TTL:
        return _ml_config_cache
    try:
        if not (CF_API_TOKEN and CF_ACCOUNT_ID and CF_KV_NAMESPACE_ID):
            _ml_config_cache = {}
            _ml_config_cached_at = time.time()
            return {}
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
            f"/storage/kv/namespaces/{CF_KV_NAMESPACE_ID}/values/ml:config"
        )
        resp = await client.get(
            url,
            headers={"Authorization": f"Bearer {CF_API_TOKEN}"},
            timeout=5.0,
        )
        if resp.status_code == 200:
            import json
            _ml_config_cache = json.loads(resp.text)
        else:
            _ml_config_cache = {}
    except Exception as e:
        logger.warning(f"[LLM-Debate] ml:config read failed: {e}")
        _ml_config_cache = {}
    _ml_config_cached_at = time.time()
    return _ml_config_cache


async def call_llm(
    system_prompt: str,
    user_prompt: str,
    temperature: float = 0.4,
    max_tokens: int = 512,
    client: Optional[httpx.AsyncClient] = None,
    ab_force: Optional[str] = None,
) -> tuple[str, str]:
    """Call LLM with multi-provider fallback.

    Returns (text, source) where source is 'gemini_api' or 'anthropic_api'.
    Raises RuntimeError if all providers unavailable.

    ab_force (#44 W5 Debate A/B): if 'gemini' skip Anthropic; if 'anthropic'
    skip Gemini. None = default fallback chain. Caller (run_buy_debate)
    passes deterministic hash(symbol + date) % 2 outcome.
    """
    close_client = False
    if client is None:
        client = httpx.AsyncClient()
        close_client = True

    try:
        # ── Layer 1: Gemini ─────────────────────────────────────────────────
        if GEMINI_API_KEY and ab_force != "anthropic":
            try:
                url = (
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
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
                if resp.status_code == 200:
                    data = resp.json()
                    cands = data.get("candidates") or []
                    if cands:
                        parts = (cands[0].get("content") or {}).get("parts") or []
                        if parts:
                            text = parts[0].get("text", "")
                            if text:
                                # #43 cost tracking (fire-and-forget)
                                try:
                                    from .cost_tracker import record_llm_call
                                    usage = data.get("usageMetadata") or {}
                                    await record_llm_call(
                                        "llm_debate", "gemini", GEMINI_MODEL_DEFAULT,
                                        int(usage.get("promptTokenCount", 0) or 0),
                                        int(usage.get("candidatesTokenCount", 0) or 0),
                                    )
                                except Exception:
                                    pass
                                return text, "gemini_api"
            except Exception as e:
                logger.warning(f"[LLM-Debate] Gemini failed: {e}")

        # ── Layer 2: Anthropic ──────────────────────────────────────────────
        if ANTHROPIC_API_KEY and ab_force != "gemini":
            try:
                cfg = await _get_ml_config(client)
                model = cfg.get("debate_model") or ANTHROPIC_MODEL_DEFAULT
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": ANTHROPIC_API_KEY,
                        "anthropic-version": "2023-06-01",
                    },
                    json={
                        "model": model,
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                        "system": system_prompt,
                        "messages": [{"role": "user", "content": user_prompt}],
                    },
                    timeout=30.0,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    content = data.get("content") or []
                    if content:
                        text = content[0].get("text", "")
                        if text:
                            # #43 cost tracking (fire-and-forget)
                            try:
                                from .cost_tracker import record_llm_call
                                usage = data.get("usage") or {}
                                await record_llm_call(
                                    "llm_debate", "anthropic", model,
                                    int(usage.get("input_tokens", 0) or 0),
                                    int(usage.get("output_tokens", 0) or 0),
                                )
                            except Exception:
                                pass
                            return text, "anthropic_api"
            except Exception as e:
                logger.warning(f"[LLM-Debate] Anthropic failed: {e}")

        raise RuntimeError("All LLM layers unavailable — debate skipped")
    finally:
        if close_client:
            await client.aclose()
