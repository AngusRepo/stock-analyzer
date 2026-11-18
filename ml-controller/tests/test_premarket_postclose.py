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
            return {'research_failure_preserved':True} if name=='node_compute_pit_residual_shadow' else {}
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


# --- 14:20 D1 peak: the export waits for the post-verify chain, bounded by a deadline ---
from datetime import timedelta

RUN='pipeline-dispatch:2026-10-01:run'

def test_dispatch_lowers_export_threads_and_sets_the_quiet_deadline(f,monkeypatch):
    storage,_,uri=queued(f,monkeypatch);jobs=Jobs()
    postclose.dispatch_one(uri,client=storage,jobs_client=jobs,now=AFTER)
    env=jobs.calls[0]['env_overrides']
    work=postclose.read_work(uri,client=storage,now=AFTER)
    assert env['DATASET_SNAPSHOT_QUERY_WORKERS']=='2'
    assert env['DATASET_SNAPSHOT_EXPORT_QUIET_DEADLINE']==f"{work['trade_date']}T14:50:00+08:00"

def _ops(stage=None, learning=None, fail=False):
    calls=[]
    def query(sql, params):
        calls.append(sql)
        if fail: raise RuntimeError('d1_overloaded')
        if 'pipeline_stage_runs' in sql: return [stage] if stage else []
        return [learning] if learning else []
    return query, calls

@pytest.mark.parametrize(('stage','learning','quiet'),[
    (None,None,False),
    ({'status':'running','canonical_run_id':RUN},None,False),
    ({'status':'success','canonical_run_id':RUN},None,True),
    ({'status':'error','canonical_run_id':RUN},None,True),
    ({'status':'success','canonical_run_id':'other-run'},None,False),
    ({'status':'waiting','canonical_run_id':RUN},{'status':'running','canonical_run_id':RUN},False),
    ({'status':'waiting','canonical_run_id':RUN},{'status':'success','canonical_run_id':RUN},True),
    ({'status':'waiting','canonical_run_id':RUN},{'status':'error','canonical_run_id':RUN},True),
    ({'status':'waiting','canonical_run_id':RUN},{'status':'success','canonical_run_id':'other-run'},False),
])
def test_post_verify_quiet_needs_this_runs_chain_and_learning_to_stop(stage,learning,quiet):
    query,_=_ops(stage,learning)
    assert postclose.post_verify_quiet('2026-10-01',RUN,query=query) is quiet

class Clock:
    def __init__(self,start): self.t=start;self.sleeps=[]
    def now(self): return self.t
    def sleep(self,seconds): self.sleeps.append(seconds);self.t+=timedelta(seconds=seconds)

START=datetime(2026,10,2,6,26,tzinfo=timezone.utc)  # 14:26 TW, research done

def test_quiet_chain_releases_the_export_at_once():
    clock=Clock(START);query,_=_ops({'status':'success','canonical_run_id':RUN})
    assert postclose.wait_for_export_window('2026-10-01',RUN,'2026-10-02T14:50:00+08:00',
        query=query,now=clock.now,sleep=clock.sleep)=='quiet'
    assert clock.sleeps==[]

@pytest.mark.parametrize('fail',[False,True])
def test_busy_or_unreadable_chain_waits_only_until_the_deadline(fail):
    clock=Clock(START);query,_=_ops({'status':'running','canonical_run_id':RUN},fail=fail)
    assert postclose.wait_for_export_window('2026-10-01',RUN,'2026-10-02T14:50:00+08:00',
        query=query,now=clock.now,sleep=clock.sleep)=='deadline'
    assert clock.t==datetime(2026,10,2,6,50,tzinfo=timezone.utc)
    assert max(clock.sleeps)<=postclose.EXPORT_QUIET_POLL_SECONDS

def test_late_research_is_capped_by_the_max_wait():
    clock=Clock(datetime(2026,10,2,5,0,tzinfo=timezone.utc));query,_=_ops()
    assert postclose.wait_for_export_window('2026-10-01',RUN,'2026-10-02T14:50:00+08:00',
        query=query,now=clock.now,sleep=clock.sleep)=='deadline'
    assert clock.t-datetime(2026,10,2,5,0,tzinfo=timezone.utc)==timedelta(seconds=postclose.EXPORT_QUIET_MAX_WAIT_SECONDS)

@pytest.mark.parametrize('deadline',['','not-a-date','2026-10-02T14:50:00'])
def test_invalid_deadline_does_not_wait(deadline):
    clock=Clock(START);query,calls=_ops()
    assert postclose.wait_for_export_window('2026-10-01',RUN,deadline,query=query,now=clock.now,sleep=clock.sleep)=='deadline_invalid'
    assert calls==[] and clock.sleeps==[]

def test_passed_deadline_exports_without_reading():
    clock=Clock(datetime(2026,10,2,7,0,tzinfo=timezone.utc));query,calls=_ops()
    assert postclose.wait_for_export_window('2026-10-01',RUN,'2026-10-02T14:50:00+08:00',
        query=query,now=clock.now,sleep=clock.sleep)=='deadline'
    assert calls==[]

def test_default_ops_reader_routing_failure_still_reaches_the_deadline(monkeypatch):
    from services import d1_domain_client
    def broken(domain): raise RuntimeError('D1 database id missing: ops')
    monkeypatch.setattr(d1_domain_client,'client_for_domain',broken)
    clock=Clock(START)
    assert postclose.wait_for_export_window('2026-10-01',RUN,'2026-10-02T14:50:00+08:00',
        now=clock.now,sleep=clock.sleep)=='deadline'
