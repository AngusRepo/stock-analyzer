import asyncio
import json

import httpx
import pytest

from services import debate_ab, llm_debate_client as llm, debate_service as debate
from services import workers_ai_debate_budget as budget
from services.debate_execution_scope import DebateExecutionPorts, private_debate_execution


@pytest.fixture(autouse=True)
def isolate_budget_meter(monkeypatch):
    async def reserve(**kwargs):
        return {'conservative_neurons': 100}
    monkeypatch.setattr(budget, 'reserve_call', reserve)
    monkeypatch.delenv('CF_WORKERS_AI_API_TOKEN', raising=False)


def test_assignment_fixed_and_can_disable_audit(monkeypatch):
    monkeypatch.setattr(debate_ab, '_ENABLED', True)
    assert {debate_ab.assign_model('2330', date=f'2026-09-{d:02d}') for d in range(1, 15)} == {llm.DEBATE_MODEL_POLICY}
    monkeypatch.setattr(debate_ab, '_ENABLED', False)
    assert debate_ab.assign_model('2330') is None


@pytest.mark.parametrize('role,model', [(role, llm.model_for_role(role)) for role in ('bull', 'bear', 'judge')])
def test_cloudflare_role_request_and_usage(monkeypatch, role, model):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'a' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'private-fixture')
    captured, usage = [], []
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'success': True, 'result': []})
        captured.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'Evidence'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 120, 'completion_tokens': 30}})
    async def sink(*values):
        usage.append(values)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            value = await llm.call_llm('system', 'input', client=client, role=role, cost_sink=sink)
            assert value == ('Evidence', 'cloudflare_workers_ai:' + model)
            assert not client.is_closed
    asyncio.run(scenario())
    assert len(captured) == 1
    assert str(captured[0].url) == 'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ai/v1/chat/completions'
    payload = json.loads(captured[0].content)
    assert payload['model'] == model
    assert payload['messages'] == [{'role': 'system', 'content': 'system'}, {'role': 'user', 'content': 'input'}]
    assert usage[0] == ('llm_debate', 'cloudflare_workers_ai', model, 120, 30)


@pytest.mark.parametrize('status,payload,error,attempts', [
    (429, {}, 'rate_or_capacity_limited', 1),
    (401, {}, 'http_401', 1),
    (503, {}, 'http_503', 2),
    (200, {}, 'empty_response', 1),
    (200, [], 'invalid_response', 1),
    (200, {'choices': [{'message': {'content': 'VERDICT: APPROVE CONVICTION: 80'}, 'finish_reason': 'length'}]}, 'incomplete_response', 1),
    (200, {'choices': [{'message': {'content': ''}, 'finish_reason': 'stop'}]}, 'incomplete_response', 1),
])
def test_provider_failure_never_falls_back(monkeypatch, status, payload, error, attempts):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'a' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'private-fixture')
    requests = []
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'success': True, 'result': []})
        requests.append(request)
        return httpx.Response(status, json=payload)
    async def sink(*args):
        pass
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(RuntimeError, match=error):
                await llm.call_llm('s', 'u', client=client, cost_sink=sink)
    asyncio.run(scenario())
    assert len(requests) == attempts
    assert all(json.loads(r.content)['model'] == llm.JUDGE_MODEL for r in requests)


def test_legacy_model_assignment_cannot_redirect_provider():
    with pytest.raises(ValueError, match='policy_mismatch'):
        asyncio.run(llm.call_llm('s', 'u', ab_force='anthropic'))


@pytest.mark.parametrize('failure_index', [None, 0, 1, 2, 3, 4])
def test_full_debate_required_turns_and_accurate_model_sources(failure_index):
    calls = []
    async def infer(system, user, *, role, **kwargs):
        index = len(calls)
        calls.append(role)
        if index == failure_index:
            raise RuntimeError('fixture_provider_failure')
        return ('VERDICT: APPROVE CONVICTION: 80\nEvidence checked.' if role == 'judge' else 'Evidence checked.',
                'cloudflare_workers_ai:' + kwargs['model'])
    async def audit(**values):
        pass
    async def scenario():
        with private_debate_execution(DebateExecutionPorts(2, infer, audit)):
            return await debate.run_buy_debate(symbol='2330', stock_name='fixture', signal='BUY',
                confidence=.7, reasoning='Evidence', client=object(), _session_date='2026-09-22')
    result = asyncio.run(scenario())
    expected = ['bull', 'bear', 'bull', 'bear', 'judge']
    if failure_index is not None:
        assert calls == expected[:failure_index + 1]
        assert result.terminal_status == 'retryable_error' and result.retryable
        assert result.rounds == failure_index
    else:
        assert calls == expected
        assert result.terminal_status == 'completed' and result.verdict == 'APPROVE'
    for turn in result.agent_turns:
        if turn['agent'] != 'theme':
            role = 'bear' if turn['agent'] == 'risk' else turn['agent']
            assert turn['source'] == 'cloudflare_workers_ai:' + llm.model_for_role(role, symbol='2330', session_date='2026-09-22', round_no=turn['round'])


def test_cache_changes_with_policy_context_and_freezes_round_setting(monkeypatch):
    keys, rounds, executions = [], [], []
    async def config(client):
        rounds.append(1)
        return 2
    async def read(client, key):
        keys.append(key)
    async def write(*args, **kwargs):
        pass
    async def run(**values):
        executions.append(values)
        return debate.DebateResult('REJECT', 0, 'retry', 'test', 0, 'retryable_error', True)
    monkeypatch.setattr(debate, '_read_max_rounds', config)
    monkeypatch.setattr(debate, '_kv_read', read)
    monkeypatch.setattr(debate, '_kv_write', write)
    monkeypatch.setattr(debate, 'run_buy_debate', run)
    async def scenario():
        for reason in ['first', 'second']:
            await debate.run_buy_debate_cached('2330', 'fixture', 'BUY', .7, reason, client=object())
    asyncio.run(scenario())
    assert len(set(keys)) == 2 and all(llm.DEBATE_MODEL_POLICY in k for k in keys)
    assert len(rounds) == 2 and all(v['_max_rounds'] == 2 for v in executions)


def test_daily_quota_stops_both_models_until_utc_reset(monkeypatch):
    account = 'c' * 32
    monkeypatch.setenv('CF_ACCOUNT_ID', account)
    monkeypatch.setenv('CF_API_TOKEN', 'fixture')
    monkeypatch.setattr(llm, '_EXHAUSTED_ACCOUNTS', {})
    calls = []
    def respond(request):
        calls.append(request.method)
        return httpx.Response(200, json={'success': True, 'result': []}) if request.method == 'GET' else httpx.Response(
            429, json={'errors': [{'code': 3036}]})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            for role in ('bull', 'bear'):
                with pytest.raises(RuntimeError, match='daily_free_quota_exhausted'):
                    await llm.call_llm('s', 'u', role=role, client=client)
            assert calls == ['POST']
            # A prior UTC date no longer blocks the next day's provider request.
            llm._EXHAUSTED_ACCOUNTS[account] = '2020-01-01'
            with pytest.raises(RuntimeError, match='daily_free_quota_exhausted'):
                await llm.call_llm('s', 'u', client=client)
            assert calls == ['POST', 'POST']
    asyncio.run(scenario())



def test_completed_rounds_are_reused_after_judge_quota_failure(monkeypatch):
    cache, calls = {}, []
    async def read(client, key):
        return cache.get(key)
    async def write(client, key, value, **kwargs):
        cache[key] = value
    async def config(client):
        return 2
    async def infer(system, user, *, role, **kwargs):
        calls.append(role)
        if role == 'judge' and calls.count('judge') == 1:
            raise RuntimeError('workers_ai_debate_daily_safe_budget_exhausted')
        return ('VERDICT: APPROVE CONVICTION: 80\nEvidence checked.' if role == 'judge' else 'Evidence checked.',
            'cloudflare_workers_ai:' + kwargs['model'])
    async def audit(**values):
        pass
    monkeypatch.setattr(debate, '_kv_read', read)
    monkeypatch.setattr(debate, '_kv_write', write)
    monkeypatch.setattr(debate, '_read_max_rounds', config)
    monkeypatch.setattr(debate, 'call_llm', infer)
    monkeypatch.setattr(debate_ab, 'log_debate', audit)
    async def scenario():
        arguments = dict(symbol='2330', stock_name='fixture', signal='BUY', confidence=.7, reasoning='Evidence', client=object())
        first = await debate.run_buy_debate_cached(**arguments)
        assert first.retryable and first.error_code == 'workers_ai_debate_daily_safe_budget_exhausted'
        second = await debate.run_buy_debate_cached(**arguments)
        assert second.terminal_status == 'completed'
        assert (await debate.run_buy_debate_cached(**arguments)).verdict == 'APPROVE'
    asyncio.run(scenario())
    assert calls == ['bull', 'bear', 'bull', 'bear', 'judge', 'judge']


def test_randomized_roles_are_balanced_and_stable_for_both_arms():
    draws = set()
    for index in range(100):
        identity = dict(symbol=str(1000 + index), session_date='2026-09-22')
        first = [llm.model_for_role(role, **identity, round_no=1) for role in ('bull', 'bear')]
        second = [llm.model_for_role(role, **identity, round_no=2) for role in ('bull', 'bear')]
        assert first == second[::-1]
        assert set(first) == set(llm.DEBATERS)
        assert first == [llm.model_for_role(role, **identity, round_no=1) for role in ('bull', 'bear')]
        draws.add(first[0])
    assert draws == set(llm.DEBATERS)
    assert llm.JUDGE_MODEL not in llm.DEBATERS


def test_invalid_judge_is_retried_without_repeating_successful_debaters(monkeypatch):
    cache, calls = {}, []
    async def read(client, key):
        return cache.get(key)
    async def write(client, key, value, **kwargs):
        cache[key] = value
    async def infer(system, user, *, role, **kwargs):
        calls.append(role)
        text = 'Evidence checked.'
        if role == 'judge' and calls.count('judge') > 1:
            text = 'VERDICT: REJECT CONVICTION: 30'
        return text, 'cloudflare_workers_ai:' + kwargs['model']
    monkeypatch.setattr(debate, '_kv_read', read)
    monkeypatch.setattr(debate, '_kv_write', write)
    monkeypatch.setattr(debate, 'call_llm', infer)
    monkeypatch.setattr(debate_ab, '_ENABLED', False)
    async def scenario():
        args = dict(symbol='2330', stock_name='fixture', signal='BUY', confidence=.7,
            reasoning='Evidence', client=object(), cache_key_date='2026-09-24')
        first = await debate.run_buy_debate_cached(**args)
        assert first.retryable and first.error_code == 'verdict_unparseable'
        second = await debate.run_buy_debate_cached(**args)
        assert second.terminal_status == 'completed' and second.verdict == 'REJECT'
    asyncio.run(scenario())
    assert calls == ['bull', 'bear', 'bull', 'bear', 'judge', 'judge']


def test_chinese_rebuttal_completes_without_accepting_truncation(monkeypatch):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'f' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'fixture')
    requests = []
    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        judge = payload['model'] == llm.JUDGE_MODEL
        # A representative 338-token Chinese answer exceeded the old R2 cap.
        needed = 18 if judge else 338
        complete = payload['max_tokens'] >= needed
        return httpx.Response(200, json={'choices': [{'message': {'content':
            'VERDICT: REJECT CONVICTION: 30\nInsufficient evidence.' if judge else '資料不足，需核實風險。'},
            'finish_reason': 'stop' if complete else 'length'}],
            'usage': {'prompt_tokens': 1248, 'completion_tokens': min(needed, payload['max_tokens'])}})
    async def audit(**kwargs): pass
    async def sink(*args): pass
    async def infer(system, user, **kwargs):
        kwargs.pop('assignment_date')
        return await llm.call_llm(system, user, cost_sink=sink, **kwargs)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with private_debate_execution(DebateExecutionPorts(2, infer, audit)):
                return await debate.run_buy_debate('SMOKE', 'fixture', 'BUY', .65, 'Evidence',
                    client=client, _session_date='2026-09-24')
    result = asyncio.run(scenario())
    assert result.terminal_status == 'completed' and result.rounds == 5
    assert len(requests) == 5
