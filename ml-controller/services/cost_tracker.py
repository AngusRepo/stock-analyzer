"""
cost_tracker.py #43 Cost Tracking (2026-04-21)

Records LLM + Modal cost events into D1 `cost_events` table via CF REST API.
Fire-and-forget: failures never block the caller.

Rationale (ship-day):
  QuantaAlpha POC burned $1.43+ ephemeral + persistent Modal cost with zero
  visibility. Production LLM spend ($24/mo -> $1/mo after #45 migration, but
  growing again post Debate FinMem) also needs tracking. All instrumented
  calls record here so Wei + Discord alerts can see daily / monthly spend.

Pricing table (USD per 1M tokens, input / output, 2026-04 rates):
  claude-sonnet-4-6:          3.00 / 15.00
  claude-opus-4-7:           15.00 / 75.00
  gemini-3.1-flash-lite:      0.075 / 0.30
  gemini-2.5-flash-lite:      0.10 / 0.40
  deepseek-v3:                0.14 / 0.28
  gemma-27b (via Gemini API): 0.05 / 0.10  (approximate)

Modal cost estimation (CPU-only functions, post-discount):
  $0.000136 per CPU-second
  Memory adds ~$0.0000148 per GB-second (ignored as small)
"""

from __future__ import annotations

import datetime as _dt
import json as _json
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
_CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
_CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
_CF_D1_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}"
    f"/d1/database/{_CF_D1_DB_ID}/query"
) if _CF_ACCOUNT_ID and _CF_D1_DB_ID else ""

# Price per 1K tokens (simpler math vs per-1M)
_PRICE_PER_1K: dict[str, tuple[float, float]] = {
    "claude-sonnet-4-6":              (0.003, 0.015),
    "claude-sonnet-4-5-20250929":     (0.003, 0.015),
    "claude-opus-4-7":                (0.015, 0.075),
    "gemini-3.1-flash-lite":          (0.000075, 0.00030),
    "gemini-3.1-flash-lite-preview":  (0.000075, 0.00030),
    "gemini-2.5-flash-lite":          (0.0001, 0.00040),
    "deepseek-v3":                    (0.00014, 0.00028),
    "gemma-27b":                      (0.00005, 0.00010),
}

_MODAL_CPU_SEC_PRICE = 0.000136


def _est_llm_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    """Estimate LLM cost in USD. Falls back to 0 for unknown models."""
    if not model:
        return 0.0
    # Normalise: strip suffixes like '-20250929'
    key = model.lower().strip()
    # Try exact match first, then prefix match.
    rate = _PRICE_PER_1K.get(key)
    if rate is None:
        for k, v in _PRICE_PER_1K.items():
            if key.startswith(k):
                rate = v
                break
    if rate is None:
        return 0.0
    pi, po = rate
    return (tokens_in / 1000.0) * pi + (tokens_out / 1000.0) * po


def _est_modal_cost(compute_sec: float, cpu: float = 1.0) -> float:
    """Rough Modal CPU-second cost (ignore memory)."""
    return max(0.0, float(compute_sec) * float(cpu) * _MODAL_CPU_SEC_PRICE)


async def _record(
    source: str,
    provider: Optional[str],
    model: Optional[str],
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    compute_sec: float = 0.0,
    est_usd: float = 0.0,
    meta: Optional[dict] = None,
) -> None:
    """Insert one cost event. Fire-and-forget — logs warning on failure."""
    if not _CF_D1_URL or not _CF_API_TOKEN:
        logger.debug("[cost_tracker] skip — CF env not configured")
        return

    now = _dt.datetime.now(_dt.timezone.utc)
    tw_date = (now + _dt.timedelta(hours=8)).date().isoformat()
    payload = {
        "sql": (
            "INSERT INTO cost_events "
            "(ts, date, source, provider, model, tokens_in, tokens_out, compute_sec, est_usd, meta) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        "params": [
            now.isoformat(),
            tw_date,
            source,
            provider,
            model,
            int(tokens_in),
            int(tokens_out),
            float(compute_sec),
            float(est_usd),
            _json.dumps(meta) if meta else None,
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                _CF_D1_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {_CF_API_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if r.status_code != 200:
                logger.warning(f"[cost_tracker] D1 insert failed {r.status_code}: {r.text[:200]}")
    except Exception as e:  # noqa: BLE001 — fire-and-forget
        logger.warning(f"[cost_tracker] exception (non-fatal): {e}")


async def record_llm_call(
    source: str,
    provider: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    meta: Optional[dict] = None,
) -> None:
    """Record one LLM API call. Caller picks source label (e.g. 'llm_reason',
    'llm_debate', 'llm_newsanalyst'). provider = 'anthropic'/'gemini'/etc."""
    est = _est_llm_cost(model, tokens_in, tokens_out)
    await _record(
        source, provider, model,
        tokens_in=tokens_in, tokens_out=tokens_out,
        est_usd=est, meta=meta,
    )


async def record_modal_call(
    source: str,
    function_name: str,
    compute_sec: float,
    cpu: float = 1.0,
    meta: Optional[dict] = None,
) -> None:
    """Record one Modal function invocation."""
    est = _est_modal_cost(compute_sec, cpu)
    await _record(
        source, "modal", function_name,
        compute_sec=compute_sec, est_usd=est, meta=meta,
    )


def record_llm_call_sync(
    source: str,
    provider: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    meta: Optional[dict] = None,
) -> None:
    """Blocking version (requests-based) for code paths that can't await."""
    import requests
    if not _CF_D1_URL or not _CF_API_TOKEN:
        return
    est = _est_llm_cost(model, tokens_in, tokens_out)
    now = _dt.datetime.now(_dt.timezone.utc)
    tw_date = (now + _dt.timedelta(hours=8)).date().isoformat()
    try:
        requests.post(
            _CF_D1_URL,
            json={
                "sql": (
                    "INSERT INTO cost_events "
                    "(ts, date, source, provider, model, tokens_in, tokens_out, compute_sec, est_usd, meta) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
                ),
                "params": [
                    now.isoformat(), tw_date, source, provider, model,
                    int(tokens_in), int(tokens_out), est,
                    _json.dumps(meta) if meta else None,
                ],
            },
            headers={
                "Authorization": f"Bearer {_CF_API_TOKEN}",
                "Content-Type": "application/json",
            },
            timeout=5.0,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[cost_tracker.sync] exception (non-fatal): {e}")
