import asyncio
import json
import io
from datetime import datetime,timezone
from types import SimpleNamespace
import pytest
from google.api_core.exceptions import NotFound,PreconditionFailed
from services import premarket_pipeline as m

class Blob:
    def __init__(self):self.raw=None;self.generation=0;self.downloads=0
    def upload_from_string(self,data,**kw):
        if kw.get('if_generation_match',self.generation)!=self.generation:raise PreconditionFailed('CAS')
        self.raw=data.encode() if isinstance(data,str) else data;self.generation+=1
    def download_as_bytes(self):
        self.downloads+=1
        if self.raw is None:raise NotFound('missing')
        return self.raw
    def reload(self):
        if self.raw is None:raise NotFound('missing')
    def open(self, mode, **kw):
        assert mode=='rb' and kw['if_generation_match']==self.generation
        if self.raw is None:raise NotFound('missing')
        return io.BytesIO(self.raw)
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
        'evidence':[],'macro_evidence':{'taifex_night':{'date':'20261001','time':'050000','lastPrice':100,'changePct':1,'changePoints':1}}}}
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

@pytest.mark.parametrize('status,expected', [('failed','failed'), ('error','failed'),
    ('pre_l2_inputs_captured','ready'), ('awaiting_paired_l3_l4_release','waiting'), (None,'waiting')])
def test_l3_handoff_preserves_seal_but_reports_input_readiness(f,status,expected):
    s,state,_=f
    if status:state['paired_nav_atomic_inputs']={'status':status}
    receipt=m.seal_l3(state,client=s)
    result=m.l3_handoff_result(state,receipt)
    assert result['input_readiness']['atomic_inputs']==expected
    assert result['l3_receipt']==m.read_seal(state['run_date'],state['producer_run_id'],client=s)
    assert result['status']=='awaiting_premarket'
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
@pytest.mark.parametrize('status', ['running', 'ambiguous'])
def test_failed_process_with_unresolved_recommendation_is_parked_before_dispatch(f,status):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs()
    first=m.dispatch(r,c,jobs_client=j,client=s)
    root=m.prefix(r['run_date'],r['run_id'])
    s.blob(root+'/phases/node_compute_personas.json.gz').raw=b'already sealed'
    claim=s.blob(root+'/phases/node_recommend.claim.json')
    claim.upload_from_string(m.json_bytes({'input_checksum':c['checksum'],
        'phase':'node_recommend','status':status}))
    original=claim.raw;generation=claim.generation
    j.state='failed'
    for _ in range(2):
        result=m.dispatch(r,c,jobs_client=j,client=s)
        assert result['status']=='reconciliation_required'
        assert result['reason']=='premarket_phase_outcome_requires_reconciliation:node_recommend'
        assert result['execution_name']==first['execution_name']
    assert len(j.calls)==1 and claim.raw==original and claim.generation==generation

def test_failed_phase_can_retry_but_changed_phase_identity_cannot(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    root=m.prefix(r['run_date'],r['run_id'])
    claim=s.blob(root+'/phases/node_compute_personas.claim.json')
    claim.upload_from_string(m.json_bytes({'input_checksum':'wrong',
        'phase':'node_compute_personas','status':'failed'}))
    j.state='failed'
    with pytest.raises(ValueError,match='premarket_phase_identity_changed'):
        m.dispatch(r,c,jobs_client=j,client=s)
    assert len(j.calls)==1
    claim.raw=m.json_bytes({'input_checksum':c['checksum'],
        'phase':'node_compute_personas','status':'failed'})
    assert m.dispatch(r,c,jobs_client=j,client=s)['status']=='dispatched'
    assert len(j.calls)==2
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

def test_completed_phases_restore_only_latest_full_state(f,monkeypatch):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI'];calls=[]
    async def first(st):calls.append('first');return {'first':True}
    async def last(st):calls.append('last');return {'last':True}
    def run():return asyncio.run(m.resume(uri,nodes=[first,last],merge=lambda st,up:st.update(up),client=s))
    assert run()['last']
    monkeypatch.setattr(m,'build_information_delta',lambda **kwargs:pytest.fail('rebuilding sealed morning delta'))
    for blob in s.blobs.values():blob.downloads=0
    assert run()['first'] and calls==['first','last']
    assert s.blob(r['state_gcs_uri'].split(s.name+'/',1)[1]).downloads==0
    root=m.prefix(r['run_date'],r['run_id'])
    assert s.blob(root+'/phases/first.json.gz').downloads==0
    assert s.blob(root+'/phases/last.json.gz').downloads==1

def test_completed_phase_keeps_original_l3_identity_validation(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI']
    async def first(st):return {'done':True}
    run=lambda:asyncio.run(m.resume(uri,nodes=[first],merge=lambda st,up:st.update(up),client=s))
    run()
    key=m.prefix(r['run_date'],r['run_id'])+'/phases/first.json.gz'
    saved=m.decode_pipeline_state_envelope(s.blob(key).raw)
    saved['state']['predictions']['2330']['score']=.9
    s.blob(key).raw=m.encode_pipeline_state_envelope(saved)
    with pytest.raises(ValueError,match='checkpoint_source_changed'):run()

def test_gap_in_completed_checkpoints_is_rejected(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI']
    async def first(st):return {}
    async def last(st):return {}
    root=m.prefix(r['run_date'],r['run_id'])
    s.blob(root+'/phases/last.json.gz').raw=b'exists-but-no-predecessor'
    with pytest.raises(ValueError,match='checkpoint_gap'):
        asyncio.run(m.resume(uri,nodes=[first,last],merge=lambda st,up:None,client=s))


def test_recommendation_additions_keep_sealed_l3_source_and_full_restored_state(f):
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI']
    additions={key:{'test':key} for key in
               ('alpha_context','core_family_evidence','core_family_vote','alpha_allocation')}
    calls=[]
    async def node_recommend(st):
        calls.append('recommend');st['predictions']['2330'].update(additions);return {}
    run=lambda:asyncio.run(m.resume(uri,nodes=[node_recommend],merge=lambda st,up:st.update(up),client=s))
    run()
    assert run()['predictions']['2330']=={'score':.5,**additions}
    assert calls==['recommend']
    key=m.prefix(r['run_date'],r['run_id'])+'/phases/node_recommend.json.gz'
    saved=m.decode_pipeline_state_envelope(s.blob(key).raw)
    saved['state']['predictions']['2330']['score']=.9
    s.blob(key).raw=m.encode_pipeline_state_envelope(saved)
    with pytest.raises(ValueError,match='checkpoint_source_changed'):run()

def test_frozen_atomic_failure_blocks_expensive_redispatch_without_false_success(f):
    s,state,c=f
    state['paired_nav_atomic_inputs']={'status':'failed','reason':'paired_nav_source_or_capture_failed'}
    r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    state['premarket_context']=c
    result={'status':'error','critical_errors':['paired_nav:atomic_daily:paired_nav_source_or_capture_failed']}
    m.record_nonretryable_inputs(state,result,client=s)
    m.record_nonretryable_inputs(state,result,client=s)
    j.state='failed'
    with pytest.raises(ValueError,match='nonretryable_frozen_atomic_inputs'):
        m.dispatch(r,c,jobs_client=j,client=s)
    assert len(j.calls)==1 and result['status']=='error'

def test_transient_downstream_failure_does_not_create_permanent_input_block(f):
    s,state,c=f;r=m.seal_l3(state,client=s);state['premarket_context']=c
    m.record_nonretryable_inputs(state,{'status':'error','critical_errors':['temporary callback error']},client=s)
    key=m.prefix(r['run_date'],r['run_id'])+'/nonretryable-inputs.json'
    assert not s.blob(key).exists()
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


def _research_input(f):
    s,state,c=f;r=m.seal_l3(state,client=s)
    path=m.prefix(r['run_date'],r['run_id'])
    s.blob(path+'/morning-input.json').upload_from_string(m.json_bytes({'receipt':r,'context':c}))
    # Serving receipts are preconditions only; postwrite must not load them.
    for name in ('node_paired_nav_setup','node_export_dataset_snapshot'):
        s.blob(path+'/phases/'+name+'.json.gz').upload_from_string(b'serving sealed')
    return s,state,c,r,path,'gs://'+s.name+'/'+path+'/morning-input.json'


def test_postwrite_keeps_full_history_seal_and_serving_reader(f,monkeypatch):
    import hashlib
    from services.premarket_postwrite_state import POSTWRITE_SCHEMA
    row=f[1]['payloads'][0]
    row.update(prices=[{'date':str(i),'close':i+.25} for i in range(728)],
        indicators=[{str(k):i+k+.5 for k in range(29)} for i in range(709)],
        chips=[{'foreign_net':i-100} for i in range(728)])
    f[1]['payload_source_observations']={'2330':{'history':list(range(728))}}
    s,original,c,r,path,uri=_research_input(f)
    source=s.blob(r['state_gcs_uri'].split('/'+s.name+'/')[1])
    raw=source.raw
    serving=m.load_state(r,client=s)
    monkeypatch.setattr(source,'download_as_bytes',lambda:pytest.fail('full download in postwrite'))
    calls=[]
    async def node_compute_sector_flow(st):
        calls.append('sector')
        assert 'payloads' not in st and 'payload_source_observations' not in st
        assert st['pipeline_payload_identity']['count']==1
        return {'sector_flow_summary':{'status':'complete'}}
    async def node_compute_pit_residual_shadow(st):
        calls.append('pit');assert st['sector_flow_summary']['status']=='complete'
        return {'pit_residual_shadow_summary':{'status':'complete'}}
    def run():return asyncio.run(m.resume(uri,nodes=[node_compute_sector_flow,node_compute_pit_residual_shadow],
        merge=lambda st,up:st.update(up),client=s,postwrite_only=True))
    assert run()['pit_residual_shadow_summary']['status']=='complete'
    assert run()['pit_residual_shadow_summary']['status']=='complete'
    assert calls==['sector','pit']
    import gzip
    checkpoint=json.loads(gzip.decompress(s.blob(path+'/phases/node_compute_sector_flow.json.gz').raw))
    assert checkpoint['schema_version']==POSTWRITE_SCHEMA and checkpoint['source_receipt']==r
    assert len(s.blob(path+'/phases/node_compute_sector_flow.json.gz').raw)<4096
    assert source.raw==raw and hashlib.sha256(raw).hexdigest()==r['checksum']
    assert serving['payloads'][0]==row
    assert len(serving['payloads'][0]['prices'])==728
    assert len(serving['payloads'][0]['indicators'])==709
    assert len(serving['payloads'][0]['indicators'][-1])==29
    assert len(serving['payloads'][0]['chips'])==728
    assert m.decode_pipeline_state_envelope(raw)['state']==serving
    with pytest.raises(ValueError,match='schema_invalid'):
        m.decode_pipeline_state_envelope(s.blob(path+'/phases/node_compute_sector_flow.json.gz').raw)


def test_postwrite_resumes_old_full_checkpoint_then_retries_only_failed_node(f,monkeypatch):
    from services.pipeline_async_state_transport import STATE_SCHEMA_V2
    s,state,c,r,path,uri=_research_input(f)
    sealed=m.load_state(r,client=s)
    sealed.update(premarket_context=c,sector_flow_summary={'status':'old-complete'})
    old=s.blob(path+'/phases/node_compute_sector_flow.json.gz')
    old.upload_from_string(m.encode_pipeline_state_envelope({'schema_version':STATE_SCHEMA_V2,'state':sealed}))
    monkeypatch.setattr(old,'download_as_bytes',lambda:pytest.fail('old checkpoint full download'))
    calls=[]
    async def node_compute_sector_flow(st):pytest.fail('completed sector replayed')
    async def node_compute_pit_residual_shadow(st):
        assert 'payloads' not in st
        assert st['sector_flow_summary']['status']=='old-complete'
        calls.append('pit')
        if len(calls)==1:raise RuntimeError('injected research fault')
        return {'pit_residual_shadow_summary':{'status':'complete'}}
    def run():return asyncio.run(m.resume(uri,nodes=[node_compute_sector_flow,node_compute_pit_residual_shadow],
        merge=lambda st,up:st.update(up),client=s,postwrite_only=True))
    with pytest.raises(RuntimeError,match='injected'):run()
    assert run()['pit_residual_shadow_summary']['status']=='complete'
    run();assert calls==['pit','pit']


@pytest.mark.parametrize('damage',['checksum','gzip','identity','context','phase','source','run','checkpoint_roster'])
def test_postwrite_bad_seal_or_checkpoint_never_computes(f,damage):
    import gzip
    from services.premarket_postwrite_state import encode_postwrite_checkpoint
    s,state,c,r,path,uri=_research_input(f)
    source=s.blob(r['state_gcs_uri'].split('/'+s.name+'/')[1])
    projected=m.load_state(r,client=s,postwrite_only=True)
    projected['premarket_context']=c
    if damage=='checksum':source.raw+=b'\x00'
    elif damage=='gzip':source.raw=source.raw[:-8]
    elif damage=='identity':
        envelope=json.loads(gzip.decompress(source.raw));envelope['state']['payloads'][0]['symbol']='wrong'
        source.raw=m.encode_pipeline_state_envelope(envelope)
        import hashlib
        r['checksum']=hashlib.sha256(source.raw).hexdigest()
        s.blob(path+'/l3-receipt.json').raw=m.json_bytes(r)
        s.blob(path+'/morning-input.json').raw=m.json_bytes({'receipt':r,'context':c})
    else:
        envelope=json.loads(gzip.decompress(encode_postwrite_checkpoint(projected,r,
            phase='node_compute_sector_flow',context_checksum=c['checksum'])))
        if damage=='context':envelope['context_checksum']='wrong'
        if damage=='phase':envelope['phase']='node_compute_pit_residual_shadow'
        if damage=='source':envelope['source_receipt']['checksum']='wrong'
        if damage=='run':envelope['state']['run_date']='2026-01-01'
        if damage=='checkpoint_roster':envelope['state']['pipeline_payload_identity']['count']=999
        s.blob(path+'/phases/node_compute_sector_flow.json.gz').raw=m.encode_pipeline_state_envelope(envelope)
    async def node_compute_sector_flow(st):pytest.fail('corrupt input reached computation')
    with pytest.raises((ValueError,EOFError,gzip.BadGzipFile)):
        asyncio.run(m.resume(uri,nodes=[node_compute_sector_flow],merge=lambda st,up:st.update(up),
            client=s,postwrite_only=True))


def test_postwrite_legacy_v1_and_checkpoint_capacity_fail_closed(f):
    from services.premarket_postwrite_state import encode_postwrite_checkpoint,PROJECTION_LIMIT
    from services.pipeline_async_state_transport import STATE_SCHEMA_V1
    s,state,c,r,path,uri=_research_input(f)
    source=s.blob(r['state_gcs_uri'].split('/'+s.name+'/')[1])
    legacy={**state,'l3_payloads':state['payloads']}
    source.raw=m.encode_pipeline_state_envelope({'state':legacy,'schema_version':STATE_SCHEMA_V1})
    import hashlib
    r['checksum']=hashlib.sha256(source.raw).hexdigest()
    s.blob(path+'/l3-receipt.json').raw=m.json_bytes(r)
    projected=m.load_state(r,client=s,postwrite_only=True)
    assert projected['pipeline_payload_identity']['count']==1 and 'payloads' not in projected
    legacy['l3_payloads']=[{'symbol':'different'}]
    source.raw=m.encode_pipeline_state_envelope({'state':legacy,'schema_version':STATE_SCHEMA_V1})
    r['checksum']=hashlib.sha256(source.raw).hexdigest();s.blob(path+'/l3-receipt.json').raw=m.json_bytes(r)
    with pytest.raises(ValueError,match='legacy_mismatch'):m.load_state(r,client=s,postwrite_only=True)
    with pytest.raises(ValueError,match='history_forbidden'):
        encode_postwrite_checkpoint(state,r,phase='node_compute_sector_flow',context_checksum=c['checksum'])
    with pytest.raises(ValueError,match='bytes_exceeded'):
        encode_postwrite_checkpoint({**projected,'sector_flow_summary':{'large':'x'*(PROJECTION_LIMIT+1)}},
            r,phase='node_compute_sector_flow',context_checksum=c['checksum'])

def test_premarket_serving_callback_does_not_wait_for_next_session_research(monkeypatch,f):
    from graphs import daily_pipeline_v2 as graph
    from services import premarket_publication, premarket_postclose
    from test_premarket_publication import prepared
    _,state,_=prepared(f)
    state['paired_nav_collection']={'status':'failed','reason':'research_not_yet_executed'}
    seen=[]
    async def fake_resume(uri, *, nodes, merge, serving_only):
        assert serving_only is True
        seen.extend(node.__name__ for node in nodes)
        return state
    monkeypatch.setattr(m,'resume',fake_resume)
    monkeypatch.setattr(premarket_publication,'read',lambda *args,**kw:{'checksum':'a'*64})
    monkeypatch.setattr(premarket_postclose,'enqueue',lambda *args,**kw:{'status':'queued_postclose'})
    monkeypatch.setattr(graph,'_pipeline_terminal_result',lambda *a,**kw:pytest.fail('NAV terminal validator in morning'))
    result=asyncio.run(graph.run_pipeline_v2_from_premarket('gs://bucket/input'))
    assert result['status']=='completed' and result['postclose_research']['status']=='queued_postclose'
    assert seen==['node_compute_personas','node_recommend','node_write_d1']
    state['errors']=['d1_write:failed']
    assert asyncio.run(graph.run_pipeline_v2_from_premarket('gs://bucket/input'))['status']=='error'


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


def test_resume_reuses_verified_cold_file_between_nodes(f):
    from contextlib import contextmanager
    from services.paired_nav_read_cache import cached_verified_file, _scope
    import tempfile
    from pathlib import Path
    s,state,c=f;r=m.seal_l3(state,client=s);j=Jobs();m.dispatch(r,c,jobs_client=j,client=s)
    uri=j.calls[0]['env_overrides']['PIPELINE_PREMARKET_INPUT_GCS_URI'];reads=[];directories=[]
    @contextmanager
    def acquire():
        reads.append(1)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'payload';p.write_bytes(b'verified compressed source');yield str(p)
    async def first(value):
        with cached_verified_file('verified-original',acquire) as p:assert Path(p).read_bytes()
        directories.append(_scope.get().directory)
        return {}
    async def second(value):
        with cached_verified_file('verified-original',acquire) as p:assert Path(p).read_bytes()
        return {}
    asyncio.run(m.resume(uri,nodes=[first,second],merge=lambda st,up:st.update(up),client=s))
    assert reads==[1]
    assert not Path(directories[0]).exists()

@pytest.mark.parametrize('clock,expected',[('150000','2026-10-08T15:00:00+08:00'),('235959','2026-10-08T23:59:59+08:00'),('000000','2026-10-09T00:00:00+08:00'),('045953','2026-10-09T04:59:53+08:00'),('050000','2026-10-09T05:00:00+08:00')])
def test_night_opening_session_converts_to_civil_time(clock,expected):
    news={'evidence_receipt':{'sha256':'a'*64},'macro_evidence':{'taifex_night':{
        'date':'20261008','time':clock,'lastPrice':48705,'changePct':-1.32,'changePoints':-652}}}
    row=m.source_records(None,news,captured_at='2026-10-12T08:40:18+00:00')[-1]
    assert row['observed_at']==expected
    assert row['session']=='2026-10-08'
    assert row['available_at']=='2026-10-12T08:40:18+00:00'


def test_actual_oct12_night_source_passes_original_96h_and_future_still_fails():
    from services.premarket_information import build_information_delta
    news={'evidence_receipt':{'sha256':'a'*64},'macro_evidence':{'taifex_night':{
        'date':'20261008','time':'045953','lastPrice':48705,'changePct':-1.32,'changePoints':-652}}}
    cutoff='2026-10-12T08:40:18+00:00'
    records=m.source_records(None,news,captured_at=cutoff)
    baseline={'signal_date':'2026-10-08','available_at':'2026-10-12T03:00:00+00:00','l3_snapshot_id':'sealed','sources':[]}
    result=build_information_delta(baseline=baseline,current_records=records,cutoff=cutoff,
        trade_date='2026-10-12',required_sources=('taifex-night',),max_age_seconds={'taifex-night':96*3600})
    assert result['source_age_seconds']['taifex-night']==301225
    news['macro_evidence']['taifex_night']['date']='20261012'
    with pytest.raises(ValueError,match='future_information:taifex-night'):
        build_information_delta(baseline=baseline,current_records=m.source_records(None,news,captured_at=cutoff),
            cutoff=cutoff,trade_date='2026-10-12',required_sources=('taifex-night',),max_age_seconds={'taifex-night':96*3600})


def test_authorized_after_close_recovery_retains_actual_capture(monkeypatch):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER',m.OWNER)
    receipt={'run_date':'2026-10-08'}
    context={'trade_date':'2026-10-12','cutoff':'2026-10-12T08:40:18.152Z'}
    context['checksum']=m.digest(context)
    original=json.dumps(context,sort_keys=True)
    m.validate_context(receipt,context,now=datetime(2026,10,12,15,59,59,tzinfo=timezone.utc))
    assert json.dumps(context,sort_keys=True)==original
    with pytest.raises(ValueError,match='allocation_cutoff'):
        m.validate_context(receipt,context,now=datetime(2026,10,12,16,0,tzinfo=timezone.utc))
    context['checksum']='0'*64
    with pytest.raises(ValueError,match='checksum'):
        m.validate_context(receipt,context,now=datetime(2026,10,12,11,0,tzinfo=timezone.utc))


@pytest.mark.parametrize('signal,trade,cutoff,owner,error',[
    ('2026-10-09','2026-10-12','2026-10-12T08:40:18Z',m.OWNER,'allocation_cutoff'),
    ('2026-10-08','2026-10-13','2026-10-13T08:40:18Z',m.OWNER,'allocation_cutoff'),
    ('2026-10-08','2026-10-12','2026-10-12T05:29:59Z',m.OWNER,'context_stale'),
    ('2026-10-08','2026-10-12','2026-10-11T08:40:18Z',m.OWNER,'context_stale'),
    ('2026-10-08','2026-10-12','2026-10-12T12:00:00Z',m.OWNER,'context_stale'),
    ('2026-10-08','2026-10-12','2026-10-12T08:40:18Z','other','allocation_cutoff'),
])
def test_after_close_recovery_cannot_expand_scope(monkeypatch,signal,trade,cutoff,owner,error):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER',owner)
    context={'trade_date':trade,'cutoff':cutoff};context['checksum']=m.digest(context)
    now=datetime.fromisoformat(trade+'T11:00:00+00:00')
    with pytest.raises(ValueError,match=error):m.validate_context({'run_date':signal},context,now=now)


@pytest.mark.parametrize('signal,trade,time,owner,allowed',[
    ('2026-10-12','2026-10-13','00:45:00',m.OWNER,True),
    ('2026-10-12','2026-10-13','00:59:59',m.OWNER,True),
    ('2026-10-12','2026-10-13','01:00:00',m.OWNER,True),
    ('2026-10-12','2026-10-13','15:59:59',m.OWNER,True),
    ('2026-10-08','2026-10-13','00:45:00',m.OWNER,False),
    ('2026-10-12','2026-10-13','00:45:00','other',False),
    ('2026-10-13','2026-10-14','00:45:00',m.OWNER,False),
])
def test_oct13_recovery_is_date_owner_and_freshness_bound(monkeypatch,signal,trade,time,owner,allowed):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER',owner)
    context={'trade_date':trade,'cutoff':trade+'T'+time+'Z'}
    context['checksum']=m.digest(context)
    original=json.dumps(context,sort_keys=True)
    now=datetime.fromisoformat(trade+'T'+time+'+00:00')
    if allowed:
        m.validate_context({'run_date':signal},context,now=now)
        assert json.dumps(context,sort_keys=True)==original
        context['checksum']='0'*64
        with pytest.raises(ValueError,match='checksum'):
            m.validate_context({'run_date':signal},context,now=now)
        from datetime import timedelta
        context['cutoff']=(now-timedelta(minutes=106)).isoformat()
        context['checksum']=m.digest({k:v for k,v in context.items() if k!='checksum'})
        with pytest.raises(ValueError,match='context_stale'):
            m.validate_context({'run_date':signal},context,now=now)
    else:
        with pytest.raises(ValueError,match='allocation_cutoff'):
            m.validate_context({'run_date':signal},context,now=now)
