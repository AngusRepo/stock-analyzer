"""Cloudflare-only formal debate inference; no fallback to another provider.

Every attempt first checks account-wide analytics and atomically reserves
a conservative budget. Missing quota evidence stops inference."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)
MISTRAL_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct"
GPT_OSS_MODEL = "@cf/openai/gpt-oss-20b"
JUDGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
DEBATE_MODEL_POLICY = "workers-ai-swapped-two-rounds-llama-judge-v2"
_EXHAUSTED_ACCOUNTS: dict[str, str] = {}

DEBATERS = (MISTRAL_MODEL, GPT_OSS_MODEL)


def model_for_role(role: str, *, symbol: str = "", session_date: str = "", round_no: int = 1) -> str:
    """Reproducible random draw shared by retries and A/B; second round swaps."""
    if role == "judge":
        return JUDGE_MODEL
    if role not in ("bull", "bear") or round_no not in (1, 2):
        raise ValueError("debate_role_invalid")
    draw = hashlib.sha256(f"{DEBATE_MODEL_POLICY}|{session_date}|{symbol}".encode()).digest()[0] & 1
    return DEBATERS[draw ^ (round_no - 1) ^ (role == "bear")]


def validate_role_model(role: str, model: str) -> str:
    if (role == "judge" and model == JUDGE_MODEL
            or role in ("bull", "bear") and model in DEBATERS):
        return model
    raise ValueError("debate_role_model_invalid")


def provider_error_code(exc: Exception, fallback: str) -> str:
    value = str(exc)
    return value if re.fullmatch(r'workers_ai_debate_[a-z0-9_]+', value) else fallback


def _quota_exhausted(response) -> bool:
    try:
        body = response.json()
        errors = body.get('errors') or [body.get('error') or {}]
        return any(str(e.get('code')) == '3036' for e in errors if isinstance(e, dict))
    except (ValueError, AttributeError, TypeError):
        return False


async def call_llm(
    system_prompt: str, user_prompt: str, temperature: float = 0.4,
    max_tokens: int = 512, client: Optional[httpx.AsyncClient] = None,
    ab_force: Optional[str] = None, cost_sink=None, role: str = "judge", model: str | None = None,
) -> tuple[str, str]:
    model = validate_role_model(role, model or model_for_role(role))
    # Legacy experiment labels cannot silently redirect the provider.
    if ab_force not in (None, DEBATE_MODEL_POLICY):
        raise ValueError("debate_model_policy_mismatch")
    account = os.environ.get("CF_ACCOUNT_ID", "").strip()
    token = (os.environ.get("CF_WORKERS_AI_API_TOKEN", "") or os.environ.get("CF_API_TOKEN", "")).strip()
    if not account or not token:
        raise RuntimeError("workers_ai_debate_credentials_missing")
    if not re.fullmatch(r"[0-9a-f]{32}", account):
        raise RuntimeError("workers_ai_debate_account_invalid")
    utc_day = datetime.now(timezone.utc).date().isoformat()
    if _EXHAUSTED_ACCOUNTS.get(account) == utc_day:
        raise RuntimeError("workers_ai_debate_daily_free_quota_exhausted")
    owned = client is None
    client = client or httpx.AsyncClient()
    try:
        body = {"model": model, "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}],
            "temperature": temperature, "stream": False,
            # GPT-OSS needs room for reasoning as well as its final answer.
            "max_tokens": max(2048, max_tokens) if model == GPT_OSS_MODEL else max_tokens}
        if model == GPT_OSS_MODEL:
            body['reasoning_effort'] = 'low'
        url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions"
        response = None
        for attempt in range(2):
            from .workers_ai_debate_budget import reserve_call
            await reserve_call(client=client, account=account, token=token, model=model,
                messages=body['messages'], max_tokens=body['max_tokens'])
            try:
                response = await client.post(url, headers={"Authorization": f"Bearer {token}"},
                    json=body, timeout=45.0)
            except httpx.HTTPError:
                # Ambiguous timeouts are not immediately retried/billed twice.
                raise RuntimeError("workers_ai_debate_transport_unavailable") from None
            if response.status_code not in (502, 503, 504) or attempt:
                break
            await asyncio.sleep(0.5)
        if response.status_code == 429:
            if _quota_exhausted(response):
                _EXHAUSTED_ACCOUNTS[account] = utc_day
                raise RuntimeError("workers_ai_debate_daily_free_quota_exhausted")
            raise RuntimeError("workers_ai_debate_rate_or_capacity_limited")
        if response.status_code != 200:
            raise RuntimeError(f"workers_ai_debate_http_{response.status_code}")
        try:
            data = response.json()
        except ValueError:
            raise RuntimeError("workers_ai_debate_invalid_json") from None
        if not isinstance(data, dict):
            raise RuntimeError("workers_ai_debate_invalid_response")
        # OpenAI-compatible endpoint is the common contract for BOTH models.
        choices = data.get("choices") or []
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise RuntimeError("workers_ai_debate_empty_response")
        choice = choices[0]
        usage = data.get("usage") or {}
        values = ('llm_debate', 'cloudflare_workers_ai', model,
            int(usage.get('prompt_tokens') or 0), int(usage.get('completion_tokens') or 0))
        if cost_sink is not None:
            await cost_sink(*values)
        else:
            try:
                from .cost_tracker import record_llm_call
                await record_llm_call(*values)
            except Exception:
                logger.warning("[LLM-Debate] usage recording unavailable")
        text = (choice.get("message") or {}).get("content")
        if choice.get("finish_reason") != "stop" or not isinstance(text, str) or not text.strip():
            raise RuntimeError("workers_ai_debate_incomplete_response")
        return text.strip(), "cloudflare_workers_ai:" + model
    finally:
        if owned:
            await client.aclose()
