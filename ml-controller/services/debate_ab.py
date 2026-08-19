"""
Gemini-only debate routing + logging.

The previous implementation used deterministic Gemini/Anthropic A/B assignment.
Formal morning debate now keeps the same logging table but always assigns Gemini
when debate logging/routing is enabled.
"""

from __future__ import annotations

import datetime as _dt
import json as _json
import logging
import os
from typing import Optional

import httpx
from services.d1_domain_client import D1DataDomain, database_id_for_domain

logger = logging.getLogger(__name__)

_ENABLED = os.environ.get("DEBATE_AB_ENABLED", "true").lower() == "true"

_CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
_CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")


def _research_d1_url() -> str:
    database_id = database_id_for_domain(D1DataDomain.RESEARCH)
    return f'https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}/d1/database/{database_id}/query'


def assign_model(symbol: str, date: Optional[str] = None) -> Optional[str]:
    """Return 'gemini' when routing is enabled, or None when disabled."""
    _ = (symbol, date)
    if not _ENABLED:
        return None
    return "gemini"


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
    if not _ENABLED or not _CF_ACCOUNT_ID or not _CF_API_TOKEN:
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
                _research_d1_url(),
                json=payload,
                headers={
                    "Authorization": f"Bearer {_CF_API_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            if r.status_code != 200:
                logger.warning("[debate_ab] D1 insert failed %s: %s", r.status_code, r.text[:200])
    except Exception as e:  # noqa: BLE001
        logger.warning("[debate_ab] exception (non-fatal): %s", e)
