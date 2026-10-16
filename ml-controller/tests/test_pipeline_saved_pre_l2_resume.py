from copy import deepcopy
import pytest
from services.paired_nav_journal import digest
from services.pipeline_saved_pre_l2_resume import validate_transition


def sample():
    original=dict(run_date='2026-10-16',producer_run_id='parent',active_stocks=[{'id':1}],
        payload_source_observations={'source_checksum':'frozen'},
        pipeline_modal_serving_context={'expected_source_sha':'a'*40,'models':{'v':'original'}},
        market_env={'old':'observed'},paired_nav_atomic_inputs={'original':True})
    resumed=deepcopy(original)
    resumed['pipeline_modal_serving_context']['expected_source_sha']='b'*40
    resumed['timexer_feature_source']={'status':'ready','source_receipt_checksum':'original'}
    report=dict(status='PASS',source_sha='b'*40,old_source_sha='a'*40,business_date='2026-10-16',
        parent_run_id='parent',formal_old_new_equal=True,readbacks_equal=True,retry_built_slates=0,
        feature_source=resumed['timexer_feature_source'])
    report['receipt_checksum']=digest(report)
    return original,resumed,report


def validate(original,resumed,report):
    return validate_transition(original,resumed,report,run_date='2026-10-16',run_id='parent',source_sha='b'*40)


def test_only_source_and_exact_completed_capture_are_added_without_mutating_original():
    original,resumed,report=sample();before=deepcopy(original)
    assert validate(original,resumed,report) is resumed
    assert original==before


@pytest.mark.parametrize('fault',['date','run','source','model','new_source','stock','raw','env','atomic','feature','hash','parity','pending','retry','existing_capture','continued'])
def test_rejects_drift_and_incomplete_acceptance(fault):
    original,resumed,report=sample()
    if fault=='date':resumed['run_date']='2026-10-17'
    elif fault=='run':resumed['producer_run_id']='other'
    elif fault=='source':original['pipeline_modal_serving_context']['expected_source_sha']='c'*40
    elif fault=='model':resumed['pipeline_modal_serving_context']['models']['v']='other'
    elif fault=='new_source':resumed['pipeline_modal_serving_context']['expected_source_sha']='c'*40
    elif fault=='stock':resumed['active_stocks'].append({'id':2})
    elif fault=='raw':resumed['payload_source_observations']['source_checksum']='changed'
    elif fault=='env':resumed['market_env']={}
    elif fault=='atomic':resumed.pop('paired_nav_atomic_inputs')
    elif fault=='feature':resumed['timexer_feature_source']={'other':True}
    elif fault=='hash':report['receipt_checksum']='0'*64
    elif fault=='parity':report['formal_old_new_equal']=False
    elif fault=='pending':report['status']='EXTERNAL_MEMORY_MEASUREMENT_REQUIRED'
    elif fault=='retry':report['retry_built_slates']=1
    elif fault=='existing_capture':original['timexer_feature_source']={'status':'ready'}
    elif fault=='continued':resumed['payloads']=[{'symbol':'A'}]
    if fault in ('parity','pending','retry'):report['receipt_checksum']=digest({k:v for k,v in report.items() if k!='receipt_checksum'})
    with pytest.raises(ValueError):validate(original,resumed,report)


@pytest.mark.parametrize('fault',[None,'registered','model_drift','claim_exists'])
def test_formal_resume_claims_once_only_after_contract_checks(monkeypatch,fault):
    import asyncio,gzip,hashlib,json
    from google.cloud import storage
    from services import paper_strategy_mode,pipeline_saved_l2_resume
    from services.pipeline_input_events import run_prefix
    from services.pipeline_saved_pre_l2_resume import resume_saved_pre_l2
    from graphs import daily_pipeline_v2 as graph
    original,resumed,report=sample();objects={};events=[]
    prefix='gs://test/'+run_prefix('parent','2026-10-16')+'checkpoints/'
    for key,value in [('original_state_uri',original),('recovery_state_uri',resumed)]:
        raw=gzip.compress(json.dumps({'schema_version':'pipeline-pre-l2-state-v1','state':value}).encode())
        uri=prefix+hashlib.sha256(raw).hexdigest()+'.json.gz';objects[uri.split('/',3)[3]]=raw;report[key]=uri
    report['receipt_checksum']=digest({k:v for k,v in report.items() if k!='receipt_checksum'})
    uri='gs://test/pipeline-v2/release-acceptance/'+'b'*40+'/full-input-'+report['receipt_checksum']+'.json'
    objects[uri.split('/',3)[3]]=json.dumps(report).encode()
    for key,value in dict(GCS_BUCKET_NAME='test',STOCKVISION_SOURCE_SHA='b'*40,PIPELINE_PRE_L2_ACCEPTANCE_URI=uri,PIPELINE_PRE_L2_ACCEPTANCE_SHA256=report['receipt_checksum']).items():monkeypatch.setenv(key,value)
    class Blob:
        generation=5
        def __init__(self,path):self.path=path
        def reload(self):pass
        def download_as_bytes(self,**kw):
            assert kw==dict(if_generation_match=5,checksum='crc32c');return objects[self.path]
        def exists(self):return fault=='registered'
        def upload_from_string(self,*args,**kw):
            assert kw['if_generation_match']==0;events.append('claim')
            if fault=='claim_exists':raise RuntimeError('already claimed')
    class Bucket:
        def blob(self,path):return Blob(path)
    class Client:
        def bucket(self,name):assert name=='test';return Bucket()
    monkeypatch.setattr(storage,'Client',Client)
    monkeypatch.setattr(graph,'assert_canonical_window_open',lambda day:events.append('window'))
    monkeypatch.setattr(paper_strategy_mode,'from_manifest',lambda *a,**k:True)
    async def attach(state):events.append('attach');return state['pipeline_modal_serving_context']
    def contract(*a,**kw):
        events.append('contract')
        if fault=='model_drift':raise ValueError('changed')
    async def resume(state):
        events.append('continue');assert state['market_env']==original['market_env'];return {'status':'deferred'}
    monkeypatch.setattr(graph,'_attach_pipeline_modal_serving_context',attach)
    monkeypatch.setattr(pipeline_saved_l2_resume,'validate_context_transition',contract)
    monkeypatch.setattr(graph,'_continue_pipeline_before_l2',resume)
    if fault:
        with pytest.raises((ValueError,RuntimeError)):asyncio.run(resume_saved_pre_l2(run_date='2026-10-16',run_id='parent'))
        assert 'continue' not in events
        if fault!='claim_exists':assert 'claim' not in events
    else:
        assert asyncio.run(resume_saved_pre_l2(run_date='2026-10-16',run_id='parent'))=={'status':'deferred'}
        assert events==['window','attach','contract','claim','continue']
