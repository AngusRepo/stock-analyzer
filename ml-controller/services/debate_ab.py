"""
debate_ab.py — #44 W5 Debate A/B routing + logging (2026-04-21)

Deterministic hash-based assignment: same symbol always gets same model on
the same day, rotates across days. 50/50 split between Gemini Flash Lite
(primary / cheap) and Claude Haiku (fallback / more reliable reasoning).

Logs every debate invocation (model, verdict, conviction, summary_len) to
D1 `debate_ab_log` for later stats via /api/admin/debate-ab/stats.

Toggle via env DEBATE_AB_ENABLED (default True in prod). When False, all
calls use default fallback chain, no routing, no D1 logging.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json as _json
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_ENABLED = os.environ.get("DEBATE_AB_ENABLED", "true").lower() == "true"

_CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
_CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
_CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
_CF_D1_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}"
    f"/d1/database/{_CF_D1_DB_ID}/query"
) if _CF_ACCOUNT_ID and _CF_D1_DB_ID else ""


def assign_model(symbol: str, date: Optional[str] = None) -> Optional[str]:
    """Return 'gemini' or 'anthropic' deterministically, or None if A/B off."""
    if not _ENABLED:
        return None
    d = date or _dt.datetime.now(_dt.timezone.utc).astimezone(
        _dt.timezone(_dt.timedelta(hours=8))
    ).date().isoformat()
    h = hashlib.sha256(f"{symbol}:{d}".encode("utf-8")).digest()
    # Use first byte, even → gemini, odd → anthropic
    return "gemini" if (h[0] % 2 == 0) else "anthropic"


async def log_debate(
    symbol: str,
    model_assigned: str,
    model_actual: Optional[str],
    verdict: Optional[str],
    conviction_score: Optional[float],
    summary_len: int,
    debate_rounds: int,
    tokens_in: int = 0,
    tokens_out: int = 0,
    meta: Optional[dict] = None,
) -> None:
    """Fire-and-forget D1 insert to debate_ab_log."""
    if not _ENABLED or not _CF_D1_URL or not _CF_API_TOKEN:
        return
    now = _dt.datetime.now(_dt.timezone.utc)
    tw_date = (now + _dt.timedelta(hours=8)).date().isoformat()
    payload = {
        "sql": (
            "INSERT INTO debate_ab_log "
            "(ts, date, symbol, model_assigned, model_actual, verdict, "
            " conviction_score, summary_len, debate_rounds, tokens_in, tokens_out, meta) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ),
        "params": [
            now.isoformat(),
            tw_date,
            symbol,
            model_assigned,
            model_actual,
            verdict,
            conviction_score,
            int(summary_len),
            int(debate_rounds),
            int(tokens_in),
            int(tokens_out),
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
                logger.warning(f"[debate_ab] D1 insert failed {r.status_code}: {r.text[:200]}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[debate_ab] exception (non-fatal): {e}")
