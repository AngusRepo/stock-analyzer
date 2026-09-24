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
    state = database('SELECT * FROM workers_ai_debate_budget_v1', [])[0]
    assert state['observed_neurons'] + state['reserved_neurons'] == 8000
    assert budget.reserve_neurons(account='a', utc_day='2026-09-23', observed=0, bound=100, query=database)['conservative_neurons'] == 100


def test_usage_high_water_never_falls_and_failures_keep_reservations(database, caplog):
    budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=6000, bound=300, query=database)
    row = budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=1000, bound=300, query=database)
    assert row['conservative_neurons'] == 6600
    assert '[DebateBudget] warning' in caplog.text
    with pytest.raises(RuntimeError, match='safe_budget_exhausted'):
        budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=7999, bound=2, query=database)


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
    monkeypatch.setattr(budget, 'reserve_neurons', lambda **kwargs: original(**kwargs, query=database))
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
    assert database('SELECT * FROM workers_ai_debate_budget_v1', [])[0]['reserved_neurons'] == 2 * bound
    assert len(usage) == 1



def test_denied_observation_is_persisted_and_cannot_reopen_on_lower_analytics(database):
    budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=500, bound=100, query=database)
    for observed in (9000, 500):
        with pytest.raises(RuntimeError, match='safe_budget_exhausted'):
            budget.reserve_neurons(account='a', utc_day='2026-09-22', observed=observed, bound=100, query=database)
    row = database('SELECT * FROM workers_ai_debate_budget_v1', [])[0]
    assert row['observed_neurons'] == 9000 and row['reserved_neurons'] == 100
    assert row['last_request_admitted'] == 0



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
