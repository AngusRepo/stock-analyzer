import asyncio,json
from datetime import datetime,timezone
import pytest
from services import premarket_pipeline as m
from services.historical_atomic_exclusion import ERRORS
from services.pipeline_async_state_transport import encode_pipeline_state_envelope,STATE_SCHEMA_V2
from test_premarket_pipeline import f,Jobs

def sealed(f,monkeypatch):
    s,state,context=f
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER','premarket_once_v1')
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):return datetime(2026,10,16,8,tzinfo=timezone.utc)
    monkeypatch.setattr(m,'datetime',Clock)
    state.update(run_date='2026-10-15',producer_run_id='root')
    context.update(trade_date='2026-10-16',cutoff='2026-10-16T12:44:01+08:00')
    context['checksum']=m.digest({k:v for k,v in context.items() if k!='checksum'})
    state['premarket_context']=context
    state['pipeline_payload_identity']=m.build_pipeline_payload_identity(state['payloads'])
    receipt=m.seal_l3(state,client=s);p=m.prefix(state['run_date'],state['producer_run_id'])
    m.immutable(s.blob(p+'/morning-input.json'),m.json_bytes({'receipt':receipt,'context':context}))
    for name in m.SERVING_PHASES:
        m.immutable(s.blob(p+'/phases/'+name+'.json.gz'),encode_pipeline_state_envelope({'schema_version':STATE_SCHEMA_V2,'state':state}))
    m.immutable(s.blob(p+'/nonretryable-inputs.json'),m.json_bytes(dict(run_id='root',l3_checksum=receipt['checksum'],
        context_checksum=context['checksum'],reason='frozen_historical_atomic_comparison_not_retryable',original_error='; '.join(sorted(ERRORS)))))
    return s,state,context,receipt,p

def test_completed_only_preserves_fence_deduplicates_and_never_executes_nodes(f,monkeypatch):
    s,state,c,r,p=sealed(f,monkeypatch);j=Jobs()
    with monkeypatch.context() as fresh:
        class FreshClock(datetime):
            @classmethod
            def now(cls,tz=None):return datetime(2026,10,16,5,tzinfo=timezone.utc)
        fresh.setattr(m,'datetime',FreshClock)
        with pytest.raises(ValueError,match='nonretryable'):m.dispatch(r,c,jobs_client=j,client=s)
    one=m.dispatch_terminal_reconciliation(r,c,jobs_client=j,client=s)
    assert m.dispatch_terminal_reconciliation(r,c,jobs_client=j,client=s)['execution_name']==one['execution_name']
    assert len(j.calls)==1 and j.calls[0]['reject_if_running'] is True
    monkeypatch.setenv('PIPELINE_PREMARKET_COMPLETED_ONLY','1')
    calls=[]
    async def forbidden(_):calls.append('node');raise AssertionError('phase rerun')
    nodes=[]
    for name in m.SERVING_PHASES:
        async def node(st):return await forbidden(st)
        node.__name__=name;nodes.append(node)
    restored=asyncio.run(m.resume('gs://'+s.name+'/'+p+'/morning-input.json',nodes=nodes,merge=lambda st,up:st.update(up),client=s))
    assert restored['predictions']==state['predictions'] and calls==[]
    assert json.loads(s.blob(p+'/nonretryable-inputs.json').raw)['reason']=='frozen_historical_atomic_comparison_not_retryable'

@pytest.mark.parametrize('fault',['gap','different_context','different_fence','other_day'])
def test_terminal_reconciliation_cannot_bypass_incomplete_or_changed_inputs(f,monkeypatch,fault):
    s,state,c,r,p=sealed(f,monkeypatch);j=Jobs()
    if fault=='gap':s.blob(p+'/phases/node_write_d1.json.gz').raw=None
    elif fault=='different_context':c['checksum']='d'*64
    elif fault=='different_fence':s.blob(p+'/nonretryable-inputs.json').raw=b'{}'
    elif fault=='other_day':c['trade_date']='2026-10-19'
    with pytest.raises(ValueError):m.dispatch_terminal_reconciliation(r,c,jobs_client=j,client=s)
    assert j.calls==[]

def test_completed_only_rechecks_all_phases_in_job_before_any_work(f,monkeypatch):
    s,state,c,r,p=sealed(f,monkeypatch);monkeypatch.setenv('PIPELINE_PREMARKET_COMPLETED_ONLY','1')
    s.blob(p+'/phases/node_write_d1.json.gz').raw=None
    nodes=[]
    for name in m.SERVING_PHASES:
        async def node(st):pytest.fail('must not rerun')
        node.__name__=name;nodes.append(node)
    with pytest.raises(ValueError,match='incomplete'):
        asyncio.run(m.resume('gs://'+s.name+'/'+p+'/morning-input.json',nodes=nodes,merge=lambda st,up:st.update(up),client=s))
