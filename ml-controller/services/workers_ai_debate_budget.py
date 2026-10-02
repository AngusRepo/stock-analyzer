"""Shared-account guard with distinct completed charges and unresolved holds.

Use max(provider high-water, opening baseline + locally settled charges), then
add every unresolved reservation. Successful charges are not added again to
provider-observed usage. Unknown outcomes retain the entire bound. Per-request
settlement is idempotent. The 8,000 guard and 10% measurement margin remain.
Analytics may lag unrelated account users: this guard is not a provider billing
cap, and other clients must share the same reservation policy.
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
DAY_SQL = """INSERT INTO workers_ai_debate_days_v2
 (account_id,utc_day,observed_neurons,baseline_neurons,legacy_hold,updated_at)
 VALUES (?,?,?,?,COALESCE((SELECT reserved_neurons FROM workers_ai_debate_budget_v1
 WHERE account_id=? AND utc_day=?),0),?)
 ON CONFLICT(account_id,utc_day) DO UPDATE SET
 observed_neurons=MAX(observed_neurons,excluded.observed_neurons),updated_at=excluded.updated_at"""
RESERVE_SQL = """INSERT INTO workers_ai_debate_calls_v2
 (request_id,account_id,utc_day,bound_neurons,created_at)
 SELECT ?,account_id,utc_day,?,? FROM workers_ai_debate_balances_v2
 WHERE account_id=? AND utc_day=? AND conservative_neurons+?<=?
 RETURNING request_id"""
SETTLE_SQL = """UPDATE workers_ai_debate_calls_v2 SET measured_neurons=?,completed_at=?
 WHERE request_id=? AND account_id=? AND utc_day=? AND bound_neurons=? AND measured_neurons IS NULL
 RETURNING measured_neurons"""


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


def settle_neurons(*, account: str, utc_day: str, request_id: str, bound: int, measured: int, query=None) -> dict:
    if type(bound) is not int or type(measured) is not int or bound <= 0 or measured <= 0 or not request_id:
        raise ValueError('workers_ai_debate_settlement_invalid')
    if query is None:
        from services.d1_domain_client import client_for_domain
        query = client_for_domain('ops').query
    rows = query(SETTLE_SQL, [measured, datetime.now(timezone.utc).isoformat(), request_id, account, utc_day, bound])
    if not rows:
        rows = query('SELECT measured_neurons FROM workers_ai_debate_calls_v2 WHERE request_id=? AND account_id=? AND utc_day=? AND bound_neurons=?',
                     [request_id, account, utc_day, bound])
    if len(rows) != 1 or rows[0]['measured_neurons'] != measured:
        raise RuntimeError('workers_ai_debate_settlement_unavailable')
    return query('SELECT * FROM workers_ai_debate_balances_v2 WHERE account_id=? AND utc_day=?', [account, utc_day])[0]


async def settle_call(*, account: str, utc_day: str, request_id: str, bound: int, model: str, usage: dict) -> None:
    measured = measured_call_neurons(model, usage)
    if measured is None:
        return
    try:
        await asyncio.to_thread(settle_neurons, account=account, utc_day=utc_day, request_id=request_id,
                                bound=bound, measured=measured)
    except Exception:
        logger.warning('[DebateBudget] settlement unavailable day=%s request=%s', utc_day, request_id)


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
    from uuid import uuid4
    if type(observed) not in (int, float) or not math.isfinite(observed) or observed < 0 or type(bound) is not int or bound <= 0:
        raise ValueError('workers_ai_debate_budget_request_invalid')
    if query is None:
        from services.d1_domain_client import client_for_domain
        query = client_for_domain('ops').query
    now = datetime.now(timezone.utc).isoformat()
    request_id = str(uuid4())
    try:
        # Persist even denied high-water observations. Admission is ONE atomic
        # INSERT ... SELECT over current charges, so parallel callers cannot
        # borrow the same headroom. No timeout ever releases a reservation.
        query(DAY_SQL, [account, utc_day, observed, observed, account, utc_day, now])
        admitted = query(RESERVE_SQL, [request_id, bound, now, account, utc_day, bound, STOP_NEURONS])
        row = query('SELECT * FROM workers_ai_debate_balances_v2 WHERE account_id=? AND utc_day=?', [account, utc_day])[0]
    except Exception:
        raise RuntimeError('workers_ai_debate_budget_store_unavailable') from None
    if len(admitted) != 1:
        logger.warning('[DebateBudget] stopped day=%s observed=%.2f completed=%s reserved=%s bound=%s stop=%s',
            utc_day, observed, row['completed_neurons'], row['reserved_neurons'], bound, STOP_NEURONS)
        raise RuntimeError('workers_ai_debate_daily_safe_budget_exhausted')
    if row['conservative_neurons'] >= WARN_NEURONS:
        logger.warning('[DebateBudget] warning day=%s conservative_neurons=%.2f warn=%s stop=%s',
            utc_day, row['conservative_neurons'], WARN_NEURONS, STOP_NEURONS)
    return {**row, 'request_id': request_id, 'reservation_neurons': bound,
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
