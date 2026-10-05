import asyncio
import json
from datetime import datetime,timezone
from types import SimpleNamespace
import pytest
from google.api_core.exceptions import NotFound,PreconditionFailed
from services import premarket_pipeline as m

class Blob:
    def __init__(self):self.raw=None;self.generation=0
    def upload_from_string(self,data,**kw):
        if kw.get('if_generation_match',self.generation)!=self.generation:raise PreconditionFailed('CAS')
        self.raw=data.encode() if isinstance(data,str) else data;self.generation+=1
    def download_as_bytes(self):
        if self.raw is None:raise NotFound('missing')
        return self.raw
    def reload(self):pass
    def exists(self):return self.raw is not None
class Storage:
    name='local-fixture'
    def __init__(self):self.blobs={}
    def bucket(self,name):assert name==self.name;return self
    def blob(self,path):return self.blobs.setdefault(path,Blob())
class Jobs:
    def __init__(self):self.calls=[];self.state='running'
    def run_job(self,**kw):self.calls.append(kw);return SimpleNamespace(execution_name='jobs/fixture-'+str(len(self.calls)))
    def pipeline_execution_status(self,**kw):return {'state':self.state,'execution_name':kw['execution_name']}
@pytest.fixture
def f(monkeypatch):
    monkeypatch.setenv('GCS_BUCKET_NAME','local-fixture')
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):return datetime(2026,10,2,0,0,tzinfo=timezone.utc)
    monkeypatch.setattr(m,'datetime',Clock)
    s=Storage()
    state={'run_date':'2026-10-01','producer_run_id':'root','payloads':[{'symbol':'2330'}],
        'predictions':{'2330':{'score':.5}},'metrics':{},'premarket_baseline':{
          'signal_date':'2026-10-01','available_at':'2026-10-01T14:00:00+00:00','sources':[]}}
    context={'trade_date':'2026-10-02','cutoff':'2026-10-02T00:00:00+00:00',
      'us':{'date':'2026-10-02','fetched_at':'2026-10-01T23:00:00+00:00','source_times':{'sox':'2026-10-01T20:00:00+00:00'},'sox_close':100},
      'news':{'date':'2026-10-02','cutoff':'2026-10-01T23:00:00+00:00','evidence_receipt':{'sha256':'f'*64},
        'evidence':[],'macro_evidence':{'taifex_night':{'date':'20261002','time':'050000','lastPrice':100,'changePct':1,'changePoints':1}}}}
    context['checksum']=m.digest(context)
    return s,state,context
def test_l3_seal_is_immutable_and_checksum_verified(f):
    s,state,c=f;r=m.seal_l3(state,client=s)
    assert m.seal_l3(state,client=s)==r
    assert m.load_state(r,client=s)['predictions']==state['predictions']
    state['predictions']['2330']['score']=.6
    with pytest.raises(ValueError,match='divergent'):m.seal_l3(state,client=s)
    r['checksum']='0'*64
    with pytest.raises(ValueError,match='seal_mismatch'):m.load_state(r,client=s)
def test_duplicate_dispatch_and_confirmed_failed_recovery(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs()
    one=m.dispatch(r,c,jobs_client=j,client=s)
    assert m.dispatch(r,c,jobs_client=j,client=s)==one
    assert len(j.calls)==1
    j.state='failed'
    two=m.dispatch(r,c,jobs_client=j,client=s)
    assert len(j.calls)==2 and two['execution_name']!=one['execution_name']
    assert j.calls[0]['env_overrides']['PIPELINE_MODAL_CONTINUATION_MODE']=='0'
def test_changed_morning_information_cannot_launch_second_plan(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    c['us']['sox_close']=101;c['checksum']=m.digest({k:v for k,v in c.items() if k!='checksum'})
    with pytest.raises(ValueError,match='immutable'):m.dispatch(r,c,jobs_client=j,client=s)
    assert len(j.calls)==1
def test_downstream_failure_resumes_receipts_without_second_l4(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI'];calls=[];fail=[True]
    async def l4(value):
        calls.append('l4');assert value['predictions']==state['predictions']
        assert value['premarket_information']['scores_modified'] is False
        return {'final_recommendations':[{'symbol':'2330'}]}
    async def publish(value):
        calls.append('publish')
        if fail[0]:fail[0]=False;raise RuntimeError('injected downstream fault')
        return {'published':True}
    def run():return asyncio.run(m.resume(uri,nodes=[l4,publish],merge=lambda st,up:st.update(up),client=s))
    with pytest.raises(RuntimeError):run()
    result=run();assert result['published'] is True
    assert calls==['l4','publish','publish']
    run();assert calls==['l4','publish','publish']
def test_cutoff_and_source_availability_fail_before_compute(f):
    s,state,c=f;r=m.seal_l3(state,client=s)
    m.validate_context(r,c,now=datetime(2026,10,2,0,44,59,tzinfo=timezone.utc))
    with pytest.raises(ValueError,match='cutoff'):m.validate_context(r,c,now=datetime(2026,10,2,0,45,tzinfo=timezone.utc))
    c['cutoff']='2026-10-02T00:01:00+00:00';c['checksum']=m.digest({k:v for k,v in c.items() if k!='checksum'})
    with pytest.raises(ValueError,match='stale'):m.dispatch(r,c,jobs_client=Jobs(),client=s)

def test_unknown_dispatch_never_launches_duplicate_compute(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs()
    class LostResponse(Jobs):
        def run_job(self,**kw):self.calls.append(kw);raise TimeoutError('lost response')
    j=LostResponse()
    with pytest.raises(TimeoutError):m.dispatch(r,c,jobs_client=j,client=s)
    result=m.dispatch(r,c,jobs_client=j,client=s)
    assert result['status']=='reconciliation_required' and len(j.calls)==1

def test_poll_does_not_download_large_l3_state_again(f,monkeypatch):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs()
    monkeypatch.setattr(m,'load_state',lambda *a,**kw:pytest.fail('poll downloaded large artifact'))
    m.dispatch(r,c,jobs_client=j,client=s)
    m.dispatch(r,c,jobs_client=j,client=s)
    assert len(j.calls)==1

def test_ambiguous_l4_completion_cannot_recompute(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI'];calls=[]
    async def node_recommend(value):calls.append(1);raise RuntimeError('lost allocation response')
    def run():return asyncio.run(m.resume(uri,nodes=[node_recommend],merge=lambda s,u:s.update(u),client=s))
    with pytest.raises(RuntimeError):run()
    with pytest.raises(ValueError,match='requires_reconciliation'):run()
    assert len(calls)==1

def test_postwrite_requires_serving_receipts_and_can_finish_after_allocation_cutoff(f,monkeypatch):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI']
    async def node_paired_nav_setup(value):return {'nav':'sealed'}
    async def node_export_dataset_snapshot(value):return {'snapshot':'deferred'}
    async def node_compute_sector_flow(value):return {'research':'complete'}
    def run(nodes,postwrite=False):return asyncio.run(m.resume(uri,nodes=nodes,
        merge=lambda st,up:st.update(up),client=s,postwrite_only=postwrite))
    with pytest.raises(ValueError,match='serving_not_sealed'):run([node_compute_sector_flow],True)
    run([node_paired_nav_setup,node_export_dataset_snapshot])
    class Late(datetime):
        @classmethod
        def now(cls,tz=None):return datetime(2026,10,2,0,46,tzinfo=timezone.utc)
    monkeypatch.setattr(m,'datetime',Late)
    assert run([node_compute_sector_flow],True)['research']=='complete'
    with pytest.raises(ValueError,match='allocation_cutoff'):run([node_compute_sector_flow])
    with pytest.raises(ValueError,match='phase_invalid'):run([node_paired_nav_setup],True)

def test_premarket_serving_callback_does_not_wait_for_next_session_research(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    seen=[]
    async def fake_resume(uri, *, nodes, merge):
        seen.extend(node.__name__ for node in nodes)
        return {'run_date':'2026-10-02','metrics':{},'paired_nav_collection':{}}
    monkeypatch.setattr(m,'resume',fake_resume)
    monkeypatch.setattr(graph,'_pipeline_terminal_result',lambda state, **kw:{'status':'completed'})
    assert asyncio.run(graph.run_pipeline_v2_from_premarket('gs://bucket/input'))['status']=='completed'
    assert seen==['node_compute_personas','node_recommend','node_llm_reasons','node_write_d1',
        'node_paired_nav_setup','node_export_dataset_snapshot']

def test_premarket_snapshot_stays_deferred_even_if_global_mode_is_blocking(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    monkeypatch.setenv('STOCKVISION_RESEARCH_SNAPSHOT_MODE','blocking')
    monkeypatch.setattr(graph,'_assert_pipeline_canonical_window',lambda state:None)
    result=asyncio.run(graph.node_export_dataset_snapshot({
        'run_date':'2026-10-02','producer_run_id':'parent-1','metrics':{},
        'premarket_context':{'trade_date':'2026-10-05'},
    }))
    assert result['metrics']['dataset_snapshot_export']['status']=='deferred'
    monkeypatch.setenv('STOCKVISION_EXPORT_RESEARCH_SNAPSHOT','0')
    result=asyncio.run(graph.node_export_dataset_snapshot({
        'run_date':'2026-10-02','producer_run_id':'parent-1','metrics':{},
        'premarket_context':{'trade_date':'2026-10-05'},
    }))
    assert result['metrics']['dataset_snapshot_export']['status']=='deferred'
    assert result['metrics']['dataset_snapshot_export']['snapshot_enabled'] is False
