import json
from datetime import datetime,timezone
import pytest
from services import premarket_pipeline as owner
from services import premarket_publication as publication
from services import premarket_postclose as postclose
from test_premarket_pipeline import f, Jobs
from test_premarket_publication import prepared

AFTER=datetime(2026,10,2,6,20,tzinfo=timezone.utc)
BEFORE=datetime(2026,10,2,0,20,tzinfo=timezone.utc)

def queued(f,monkeypatch):
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    storage,state,_=prepared(f)
    receipt=owner.read_seal(state['run_date'],state['producer_run_id'],client=storage)
    owner.immutable(storage.blob(owner.prefix(state['run_date'],state['producer_run_id'])+'/morning-input.json'),
                    owner.json_bytes({'receipt':receipt,'context':state['premarket_context']}))
    publication.record(state,client=storage)
    work=postclose.enqueue(state,client=storage)
    return storage,state,work['work_gcs_uri']

def test_work_immutable_bound_to_actual_publication_and_original_context(f,monkeypatch):
    storage,state,uri=queued(f,monkeypatch)
    assert postclose.enqueue(state,client=storage)['work_gcs_uri']==uri
    result=postclose.read_work(uri,client=storage,now=AFTER)
    assert result['nav_maturity_credit']==0 and result['production_effect'] is False
    state['premarket_context']['checksum']='b'*64
    with pytest.raises(ValueError,match='context_mismatch'):postclose.enqueue(state,client=storage)

def test_before_close_cannot_execute_even_with_valid_morning_receipt(f,monkeypatch):
    storage,_,uri=queued(f,monkeypatch);jobs=Jobs()
    with pytest.raises(ValueError,match='before_market_close'):
        postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=BEFORE)
    assert jobs.calls==[]

def test_exact_dispatch_dedup_and_confirmed_failure_recovery(f,monkeypatch):
    storage,_,uri=queued(f,monkeypatch);jobs=Jobs()
    one=postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    again=postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    assert one['execution_name']==again['execution_name'] and len(jobs.calls)==1
    assert jobs.calls[0]['expected_source_sha']=='a'*40
    assert jobs.calls[0]['env_overrides']['PIPELINE_PREMARKET_POSTCLOSE_WORK_URI']==uri
    jobs.state='failed'
    two=postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    assert two['execution_name']!=one['execution_name'] and len(jobs.calls)==2

def test_unknown_dispatch_does_not_launch_again(f,monkeypatch):
    storage,_,uri=queued(f,monkeypatch);jobs=Jobs()
    def lost(**kwargs):jobs.calls.append(kwargs);raise TimeoutError('lost reply')
    jobs.run_job=lost
    with pytest.raises(TimeoutError):postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    result=postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    assert result['status']=='reconciliation_required' and len(jobs.calls)==1

@pytest.mark.parametrize('fault',['input','publication','work'])
def test_tampering_fails_before_job_dispatch(f,monkeypatch,fault):
    storage,state,uri=queued(f,monkeypatch);jobs=Jobs()
    root=owner.prefix(state['run_date'],state['producer_run_id'])
    key=(uri.split(storage.name+'/',1)[1] if fault=='work' else
         root+('/morning-input.json' if fault=='input' else '/serving-publication.json'))
    body=json.loads(storage.blob(key).raw);body['tampered']=True
    storage.blob(key).raw=owner.json_bytes(body)
    with pytest.raises(ValueError):postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    assert jobs.calls==[]

def test_missing_source_identity_cannot_dispatch_unbound_template(f,monkeypatch):
    storage,_,uri=queued(f,monkeypatch);monkeypatch.delenv('STOCKVISION_SOURCE_SHA');jobs=Jobs()
    with pytest.raises(ValueError,match='source_missing'):
        postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    assert jobs.calls==[]

def test_after_close_resume_cannot_rerun_formal_allocation_or_publication(f,monkeypatch):
    import asyncio
    storage,state,uri=queued(f,monkeypatch)
    root=owner.prefix(state['run_date'],state['producer_run_id'])
    state['pipeline_payload_identity']=owner.build_pipeline_payload_identity(state['payloads'])
    raw=owner.encode_pipeline_state_envelope({'schema_version':owner.STATE_SCHEMA_V2,'state':state})
    for name in owner.CURRENT_SERVING_PHASES:
        storage.blob(root+'/phases/'+name+'.json.gz').raw=raw
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):return AFTER
    monkeypatch.setattr(owner,'datetime',Clock)
    calls=[]
    def make(name,formal=False):
        async def node(value):
            if formal:pytest.fail('formal phase rerun after close: '+name)
            assert value['premarket_execution_scope']=='postclose'
            calls.append(name)
            return {'research_failure_preserved':True} if name=='node_postclose_atomic_research' else {}
        node.__name__=name
        return node
    nodes=[make(n,True) for n in owner.CURRENT_SERVING_PHASES]+[make(n) for n in owner.POSTCLOSE_PHASES]
    work=postclose.read_work(uri,client=storage,now=AFTER)
    def run():return asyncio.run(owner.resume(work['input_gcs_uri'],nodes=nodes,
        merge=lambda st,up:st.update(up),client=storage,postclose_only=True))
    assert run()['research_failure_preserved'] is True
    assert run()['research_failure_preserved'] is True
    assert calls==list(owner.POSTCLOSE_PHASES)
    storage.blob(root+'/phases/node_recommend.json.gz').raw=None
    with pytest.raises(ValueError,match='serving_not_sealed'):
        run()
