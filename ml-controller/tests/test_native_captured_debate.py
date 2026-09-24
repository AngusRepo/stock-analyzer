import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from services import debate_service, llm_debate_client
from services.native_paper_debate import NativeCapturedDebate, NativeWorkersAIRead
from services.native_paper_source_capture import NativeSourceCapture, ImmutableNativeObjects
from test_native_paper_source_capture import Bucket


def test_nested_original_debate_seals_rounds_and_reuses_them_after_restart(monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError('formal IO reached')
    monkeypatch.setattr(debate_service, '_kv_read', forbidden)
    monkeypatch.setattr(debate_service, '_kv_write', forbidden)
    calls = []
    def provider(request):
        calls.append(request)
        return {'text': 'VERDICT: APPROVE | CONVICTION: 70\nVerified.' if len(calls) == 5 else 'Balanced evidence.',
                'source': 'cloudflare_workers_ai:' + request['model'], 'usage': []}
    now = datetime(2026, 9, 7, tzinfo=timezone.utc)
    objects = ImmutableNativeObjects(Bucket())
    capture = NativeSourceCapture(objects=objects, clock=lambda: now, domain_queries={},
                                  inference_reads={'native_debate_llm': provider})
    debate = NativeCapturedDebate(source_capture=capture, max_rounds=2,
        session_date='2026-09-07', model_name=llm_debate_client.DEBATE_MODEL_POLICY)
    request = {'body': json.dumps({'candidates': [{'symbol': '2330', 'stock_name': 'fixture',
        'signal': 'BUY', 'confidence': .7, 'reasoning': 'Frozen input', 'cache_key_date': '2026-09-07'}]})}
    frame = {'input_id': 'test-native-debate', 'stage': 'morning', 'observed_at': now.isoformat()}
    first = debate.read_native(request, frame)
    body = json.loads(first['body'])
    assert body['results'][0]['verdict'] == 'APPROVE'
    assert len(calls) == 5 and len(body['private_audits']) == 1
    assert [c['role'] for c in calls] == ['bull', 'bear', 'bull', 'bear', 'judge']
    assert calls[0]['model'] == calls[3]['model']
    assert calls[1]['model'] == calls[2]['model']
    assert calls[0]['model'] != calls[1]['model']
    assert calls[4]['model'] == llm_debate_client.JUDGE_MODEL
    def no_provider(*args):
        raise AssertionError('retry requested fresh inference')
    debate.source_capture = NativeSourceCapture(objects=objects, clock=lambda: now + timedelta(days=1),
        domain_queries={}, inference_reads={'native_debate_llm': no_provider})
    assert debate.read_native(request, frame) == first


def test_original_llm_private_cost_sink_and_sanitized_transport_error(monkeypatch, caplog):
    monkeypatch.setenv('CF_ACCOUNT_ID', 'a' * 32)
    monkeypatch.setenv('CF_API_TOKEN', 'fixture-do-not-log')
    from services import workers_ai_debate_budget as budget
    async def reserve(**kwargs):
        return {}
    monkeypatch.setattr(budget, 'reserve_call', reserve)
    usage = []
    async def sink(*args):
        usage.append(args)
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'success': True, 'result': []})
        return httpx.Response(200, json={'choices': [{'message': {'content': 'fixture'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 12, 'completion_tokens': 3}})
    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await llm_debate_client.call_llm('s', 'u', client=client, cost_sink=sink)
            assert result == ('fixture', 'cloudflare_workers_ai:' + llm_debate_client.JUDGE_MODEL)
    asyncio.run(execute())
    assert usage[0][-2:] == (12, 3)
    def outage(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'success': True, 'result': []})
        raise httpx.ReadTimeout(str(request.url), request=request)
    async def fail():
        async with httpx.AsyncClient(transport=httpx.MockTransport(outage)) as client:
            with pytest.raises(RuntimeError, match='unavailable'):
                await llm_debate_client.call_llm('s', 'u', client=client, cost_sink=sink)
    asyncio.run(fail())
    assert 'fixture-do-not-log' not in caplog.text


def test_private_provider_rejects_boolean_temperature():
    with pytest.raises(ValueError, match='contract_invalid'):
        NativeWorkersAIRead()({'model': llm_debate_client.JUDGE_MODEL, 'role': 'judge',
            'system': 's', 'user': 'u', 'temperature': True, 'max_tokens': 32})
