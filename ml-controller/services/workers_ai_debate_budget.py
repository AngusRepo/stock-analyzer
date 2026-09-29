"""Shared-account debate guard: fresh analytics + atomic conservative reservation.

Analytics can lag and excludes in-flight requests. Failed or ambiguous requests
retain their full reservation. A completed response with valid usage settles to
measured neurons plus a safety margin. The daily row still adds reservations to
the analytics high-water mark, so it remains conservative. Other account clients
must respect the same free-allocation policy; a 2,000-neuron buffer is not a
provider billing hard cap.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import logging
import math
import time

import httpx

logger = logging.getLogger(__name__)
WARN_NEURONS = 6_000
STOP_NEURONS = 8_000
FREE_NEURONS = 10_000
MODEL_RATES = {
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': (26668, 204805),
    '@cf/mistralai/mistral-small-3.1-24b-instruct': (31876, 50488),
    '@cf/openai/gpt-oss-20b': (18182, 27273),
}
RESERVE_SQL = """INSERT INTO workers_ai_debate_budget_v1
    (account_id,utc_day,observed_neurons,reserved_neurons,updated_at,
     last_request_neurons,last_request_admitted)
    VALUES (?,?,?,CASE WHEN ?+?<=? THEN ? ELSE 0 END,?,?,CASE WHEN ?+?<=? THEN 1 ELSE 0 END)
    ON CONFLICT(account_id,utc_day) DO UPDATE SET
      observed_neurons=MAX(observed_neurons,excluded.observed_neurons),
      reserved_neurons=reserved_neurons+CASE
        WHEN MAX(observed_neurons,excluded.observed_neurons)+reserved_neurons+excluded.last_request_neurons<=?
        THEN excluded.last_request_neurons ELSE 0 END,
      updated_at=excluded.updated_at,
      last_request_neurons=excluded.last_request_neurons,
      last_request_admitted=CASE
        WHEN MAX(observed_neurons,excluded.observed_neurons)+reserved_neurons+excluded.last_request_neurons<=?
        THEN 1 ELSE 0 END
    RETURNING observed_neurons,reserved_neurons,last_request_admitted"""


SETTLE_SQL = """UPDATE workers_ai_debate_budget_v1
    SET reserved_neurons=reserved_neurons-?+?, updated_at=?
    WHERE account_id=? AND utc_day=? AND reserved_neurons>=?
    RETURNING reserved_neurons"""


def measured_call_neurons(model: str, usage: dict) -> int | None:
    if model not in MODEL_RATES or not isinstance(usage, dict):
        return None
    prompt = usage.get('prompt_tokens')
    completion = usage.get('completion_tokens')
    if (type(prompt) is not int or type(completion) is not int
            or prompt < 0 or completion < 0 or prompt + completion == 0):
        return None
    rate_in, rate_out = MODEL_RATES[model]
    return max(1, math.ceil(1.1 * (prompt * rate_in + completion * rate_out) / 1_000_000))


def settle_neurons(*, account: str, utc_day: str, bound: int, measured: int, query=None) -> dict:
    if type(bound) is not int or type(measured) is not int or bound <= 0 or measured <= 0:
        raise ValueError('workers_ai_debate_settlement_invalid')
    if query is None:
        from services.d1_domain_client import client_for_domain
        query = client_for_domain('ops').query
    rows = query(SETTLE_SQL, [bound, measured, datetime.now(timezone.utc).isoformat(),
                              account, utc_day, bound])
    if len(rows) != 1:
        raise RuntimeError('workers_ai_debate_settlement_unavailable')
    return rows[0]


async def settle_call(*, account: str, utc_day: str, bound: int, model: str, usage: dict) -> None:
    measured = measured_call_neurons(model, usage)
    if measured is None:
        return
    try:
        await asyncio.to_thread(settle_neurons, account=account, utc_day=utc_day,
                                bound=bound, measured=measured)
    except Exception:
        # The original reservation remains in place when settlement is uncertain.
        logger.warning('[DebateBudget] settlement unavailable day=%s', utc_day)


def estimate_call_neurons(model: str, messages: list[dict], max_tokens: int) -> int:
    if model not in MODEL_RATES or type(max_tokens) is not int or not 1 <= max_tokens <= 2048:
        raise ValueError('workers_ai_debate_budget_request_invalid')
    # UTF-8 byte count is conservative for these byte-fallback tokenizers;
    # add room for chat framing, then a further 25% estimation margin.
    input_bound = len(json.dumps(messages, ensure_ascii=False).encode('utf-8')) + 1024
    rate_in, rate_out = MODEL_RATES[model]
    return math.ceil(1.25 * (input_bound * rate_in + max_tokens * rate_out) / 1_000_000)


async def read_account_usage(client, account: str, token: str, utc_day: str) -> float:
    query = ('{viewer{accounts(filter:{accountTag:' + json.dumps(account) + '}){'
        'aiInferenceAdaptiveGroups(limit:100,filter:{date:' + json.dumps(utc_day) + '})'
        '{count sum{totalNeurons}}}}}')
    started = time.monotonic()
    try:
        response = await client.post('https://api.cloudflare.com/client/v4/graphql',
            headers={'Authorization': 'Bearer ' + token}, json={'query': query}, timeout=10.0)
        if response.status_code != 200:
            raise ValueError('http')
        data = response.json()
        if data.get('errors'):
            raise ValueError('graphql')
        accounts = data['data']['viewer']['accounts']
        if len(accounts) != 1:
            raise ValueError('account')
        groups = accounts[0]['aiInferenceAdaptiveGroups']
        if not isinstance(groups, list) or len(groups) >= 100:
            raise ValueError('incomplete_groups')
        values = [g['sum']['totalNeurons'] for g in groups]
        if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values):
            raise ValueError('invalid_neurons')
        if time.monotonic() - started > 15 or datetime.now(timezone.utc).date().isoformat() != utc_day:
            raise ValueError('stale_read')
        return float(sum(values))
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise RuntimeError('workers_ai_debate_account_usage_unavailable') from None


def reserve_neurons(*, account: str, utc_day: str, observed: float, bound: int, query=None) -> dict:
    if query is None:
        from services.d1_domain_client import client_for_domain
        query = client_for_domain('ops').query
    now = datetime.now(timezone.utc).isoformat()
    try:
        rows = query(RESERVE_SQL, [account, utc_day, observed, observed, bound, STOP_NEURONS, bound, now, bound,
            observed, bound, STOP_NEURONS, STOP_NEURONS, STOP_NEURONS])
    except Exception:
        raise RuntimeError('workers_ai_debate_budget_store_unavailable') from None
    if len(rows) != 1 or rows[0].get('last_request_admitted') != 1:
        logger.warning('[DebateBudget] stopped day=%s observed=%.2f bound=%s stop=%s',
            utc_day, observed, bound, STOP_NEURONS)
        raise RuntimeError('workers_ai_debate_daily_safe_budget_exhausted')
    row = rows[0]
    effective = row['observed_neurons'] + row['reserved_neurons']
    if effective >= WARN_NEURONS:
        logger.warning('[DebateBudget] warning day=%s conservative_neurons=%.2f warn=%s stop=%s',
            utc_day, effective, WARN_NEURONS, STOP_NEURONS)
    return {**row, 'utc_day': utc_day, 'reservation_neurons': bound, 'conservative_neurons': effective,
        'warn_neurons': WARN_NEURONS, 'stop_neurons': STOP_NEURONS}


async def reserve_call(*, client, account: str, token: str, model: str, messages: list[dict], max_tokens: int):
    day = datetime.now(timezone.utc).date().isoformat()
    bound = estimate_call_neurons(model, messages, max_tokens)
    observed = await read_account_usage(client, account, token, day)
    result = await asyncio.to_thread(reserve_neurons, account=account, utc_day=day,
        observed=observed, bound=bound)
    if datetime.now(timezone.utc).date().isoformat() != day:
        raise RuntimeError('workers_ai_debate_budget_day_changed')
    return result
