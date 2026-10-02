import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

import httpx
import pytest
from services import workers_ai_debate_budget as budget, llm_debate_client as llm

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def database(tmp_path):
    path = tmp_path / 'budget.db'
    with sqlite3.connect(path) as db:
        db.executescript((ROOT / 'worker/domain-migrations/ops/0019_workers_ai_debate_budget.sql').read_text(encoding='utf-8'))
        db.executescript((ROOT / 'worker/domain-migrations/ops/0022_workers_ai_debate_ledger.sql').read_text(encoding='utf-8'))
    def query(sql, params):
        with sqlite3.connect(path, timeout=20) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(sql, params).fetchall()]
    return query


def test_atomic_budget_cannot_oversubscribe_and_utc_days_are_separate(database):
    def attempt(_):
        try:
            return budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=6500, bound=100, query=database)
        except RuntimeError as exc:
            assert str(exc) == 'workers_ai_debate_daily_safe_budget_exhausted'
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(attempt, range(30)))
    assert sum(r is not None for r in rows) == 15
    state = database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]
    assert state['observed_neurons'] + state['reserved_neurons'] == 8000
    assert budget.reserve_neurons(account='a', utc_day='2026-09-23', observed=0, bound=100, query=database)['conservative_neurons'] == 100


def test_usage_high_water_never_falls_and_failures_keep_reservations(database, caplog):
    budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=6000, bound=300, query=database)
    row = budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=1000, bound=300, query=database)
    assert row['conservative_neurons'] == 6600
    assert '[DebateBudget] warning' in caplog.text
    with pytest.raises(RuntimeError, match='safe_budget_exhausted'):
        budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=7999, bound=2, query=database)


def test_completed_usage_settles_bound_without_touching_other_inflight_calls(database):
    first = budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=1606, bound=500, query=database)
    second = budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=1606, bound=400, query=database)
    assert second['conservative_neurons'] == 2506
    settled = budget.settle_neurons(account='a', utc_day='2026-09-22', request_id=first['request_id'], bound=500, measured=75, query=database)
    assert settled['reserved_neurons'] == 400
    assert settled['completed_neurons'] == 75
    assert budget.measured_call_neurons(llm.MISTRAL_MODEL,
        {'prompt_tokens': 250, 'completion_tokens': 100}) is not None
    assert budget.measured_call_neurons(llm.MISTRAL_MODEL,
        {'prompt_tokens': 0, 'completion_tokens': 0}) is None
    assert budget.measured_call_neurons(llm.MISTRAL_MODEL,
        {'prompt_tokens': '250', 'completion_tokens': 100}) is None


def test_four_candidate_twenty_turns_fit_after_measured_settlement(database):
    for _ in range(20):
        reserved = budget.reserve_neurons(account='a', utc_day='2026-09-22',
                                          observed=1606, bound=350, query=database)
        assert reserved['reservation_neurons'] == 350
        budget.settle_neurons(account='a', utc_day='2026-09-22',
                              request_id=reserved['request_id'], bound=350, measured=90, query=database)
    row = database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]
    assert row['reserved_neurons'] == 0
    assert row['completed_neurons'] == 1800
    assert row['conservative_neurons'] == 3406


def test_large_prompt_is_charged_not_truncated():
    model = llm.MISTRAL_MODEL
    short = budget.estimate_call_neurons(model, [{'role': 'user', 'content': 'x'}], 512)
    long = budget.estimate_call_neurons(model, [{'role': 'user', 'content': 'x' * 50000}], 512)
    assert long > short * 10


@pytest.mark.parametrize('body', [
    {'data': None, 'errors': [{'message': 'not authorized'}]},
    {'data': {'viewer': {'accounts': []}}},
    {'data': {'viewer': {'accounts': [{'aiInferenceAdaptiveGroups': [{'sum': {'totalNeurons': -1}}]}]}}},
    {'data': {'viewer': {'accounts': [{'aiInferenceAdaptiveGroups': [{'sum': {'totalNeurons': '100'}}]}]}}},
    {'data': {'viewer': {'accounts': [{'aiInferenceAdaptiveGroups': None}]}}},
])
def test_unknown_account_usage_never_reaches_model(monkeypatch, body):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'd' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'fixture-secret')
    monkeypatch.delenv('CF_WORKERS_AI_API_TOKEN', raising=False)
    calls = []
    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(200, json=body)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(RuntimeError, match='account_usage_unavailable'):
                await llm.call_llm('s', 'u', client=client)
    asyncio.run(scenario())
    assert calls == ['https://api.cloudflare.com/client/v4/graphql']


def test_real_quota_guard_reserves_each_http_retry(monkeypatch, database):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'd' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'fixture-secret')
    monkeypatch.delenv('CF_WORKERS_AI_API_TOKEN', raising=False)
    original = budget.reserve_neurons
    original_settle = budget.settle_neurons
    monkeypatch.setattr(budget, 'reserve_neurons', lambda **kwargs: original(**kwargs, query=database))
    monkeypatch.setattr(budget, 'settle_neurons', lambda **kwargs: original_settle(**kwargs, query=database))
    requests, usage = [], []
    def respond(request):
        if str(request.url).endswith('/graphql'):
            assert datetime.now(timezone.utc).date().isoformat() in json.loads(request.content)['query']
            return httpx.Response(200, json={'errors': None, 'data': {'viewer': {'accounts': [
                {'aiInferenceAdaptiveGroups': [{'sum': {'totalNeurons': 500}}]}]}}})
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(503, json={})
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': 'Evidence'}}],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 10}})
    async def sink(*values):
        usage.append(values)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            assert (await llm.call_llm('s', 'u', client=client, role='bull', model=llm.MISTRAL_MODEL, cost_sink=sink))[0] == 'Evidence'
    asyncio.run(scenario())
    bound = budget.estimate_call_neurons(llm.MISTRAL_MODEL,
        [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'u'}], 512)
    measured = budget.measured_call_neurons(llm.MISTRAL_MODEL,
        {'prompt_tokens': 10, 'completion_tokens': 10})
    assert database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]['reserved_neurons'] == bound
    assert database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]['completed_neurons'] == measured
    assert len(usage) == 1



def test_incomplete_response_settles_known_usage_but_remains_retryable(monkeypatch, database):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'd' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'fixture-secret')
    monkeypatch.delenv('CF_WORKERS_AI_API_TOKEN', raising=False)
    original = budget.reserve_neurons
    original_settle = budget.settle_neurons
    monkeypatch.setattr(budget, 'reserve_neurons', lambda **kwargs: original(**kwargs, query=database))
    monkeypatch.setattr(budget, 'settle_neurons', lambda **kwargs: original_settle(**kwargs, query=database))
    def respond(request):
        if str(request.url).endswith('/graphql'):
            return httpx.Response(200, json={'data': {'viewer': {'accounts': [
                {'aiInferenceAdaptiveGroups': [{'sum': {'totalNeurons': 500}}]}]}}})
        return httpx.Response(200, json={'choices': [
            {'finish_reason': 'length', 'message': {'content': 'incomplete'}}],
            'usage': {'prompt_tokens': 250, 'completion_tokens': 512}})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(RuntimeError, match='incomplete_response'):
                await llm.call_llm('s', 'u', client=client, role='bear', model=llm.MISTRAL_MODEL,
                                   cost_sink=lambda *_: asyncio.sleep(0))
    asyncio.run(scenario())
    measured = budget.measured_call_neurons(llm.MISTRAL_MODEL,
        {'prompt_tokens': 250, 'completion_tokens': 512})
    assert database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]['reserved_neurons'] == 0
    assert database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]['completed_neurons'] == measured


def test_denied_observation_is_persisted_and_cannot_reopen_on_lower_analytics(database):
    budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=500, bound=100, query=database)
    for observed in (9000, 500):
        with pytest.raises(RuntimeError, match='safe_budget_exhausted'):
            budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=observed, bound=100, query=database)
    row = database('SELECT * FROM workers_ai_debate_balances_v2', [])[0]
    assert row['observed_neurons'] == 9000 and row['reserved_neurons'] == 100
    assert row['conservative_neurons'] == 9100



def test_quota_policy_change_invalidates_native_execution_identity(tmp_path, monkeypatch):
    from services.native_paper_sandbox import native_execution_identity
    runner = tmp_path / 'fixture.cjs'
    runner.write_bytes(b'fixture;')
    before = native_execution_identity(runner)
    read = Path.read_bytes
    def changed(path):
        value = read(path)
        return value + b'\n# changed quota policy' if path.name == 'workers_ai_debate_budget.py' else value
    monkeypatch.setattr(Path, 'read_bytes', changed)
    assert native_execution_identity(runner) != before


def test_provider_catchup_does_not_count_completed_calls_twice(database):
    first = budget.reserve_neurons(account='a', utc_day='2026-10-02', observed=0, bound=5000, query=database)
    budget.settle_neurons(account='a', utc_day='2026-10-02', request_id=first['request_id'], bound=5000, measured=4090, query=database)
    next_call = budget.reserve_neurons(account='a', utc_day='2026-10-02', observed=3515.6, bound=623, query=database)
    assert next_call['conservative_neurons'] == 4713
    assert next_call['completed_neurons'] == 4090
    assert next_call['reserved_neurons'] == 623


def test_settlement_is_idempotent_and_wrong_identity_cannot_release_another_call(database):
    first = budget.reserve_neurons(account='a', utc_day='2026-10-02', observed=0, bound=500, query=database)
    second = budget.reserve_neurons(account='a', utc_day='2026-10-02', observed=0, bound=500, query=database)
    args=dict(account='a', utc_day='2026-10-02', request_id=first['request_id'], bound=500, measured=100, query=database)
    budget.settle_neurons(**args); again=budget.settle_neurons(**args)
    assert again['completed_neurons']==100 and again['reserved_neurons']==500
    for changes in ({'measured':101}, {'request_id':'unknown'}, {'account':'other'}, {'bound':501}):
        with pytest.raises(RuntimeError, match='settlement_unavailable'):
            budget.settle_neurons(**{**args,**changes})
    assert database('SELECT measured_neurons FROM workers_ai_debate_calls_v2 WHERE request_id=?',[second['request_id']])[0]['measured_neurons'] is None


def test_legacy_hold_is_not_automatically_cleared(database):
    database("INSERT INTO workers_ai_debate_budget_v1 VALUES('a','2026-10-02',3515.6,4090,'now',623,0)",[])
    with pytest.raises(RuntimeError, match='safe_budget_exhausted'):
        budget.reserve_neurons(account='a',utc_day='2026-10-02',observed=3515.6,bound=623,query=database)
    row=database('SELECT * FROM workers_ai_debate_balances_v2',[])[0]
    assert row['legacy_hold']==4090 and row['completed_neurons']==0
    assert row['conservative_neurons']==7605.6
