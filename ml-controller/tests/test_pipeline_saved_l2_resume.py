from copy import deepcopy
import pytest
from services.pipeline_async_state_transport import build_pipeline_payload_identity
from services.pipeline_saved_l2_resume import validate_saved_state, validate_context_transition


def sample():
    state = {'run_date':'2026-10-08','producer_run_id':'canonical', 'payloads':[{'symbol':'A'}],
        'pipeline_modal_serving_context':{'schema_version':'pipeline-modal-serving-context-v1',
            'expected_source_sha':'a'*40,'created_at':'original','active_versions':{'PatchTST':'v1'},
            'serving_manifest':{'models':[{'checksum':'sealed'}]}},
        'pipeline_sequence_observations':{'metadata':{'checksum':'original'}},
        'payload_source_observations':{'stocks':[{'symbol':'A'}]},'timexer_feature_source':{'sha':'sealed'}}
    import hashlib,json
    state['pipeline_modal_serving_context']['serving_manifest_digest']=hashlib.sha256(json.dumps(state['pipeline_modal_serving_context']['serving_manifest'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    state['pipeline_payload_identity'] = build_pipeline_payload_identity(state['payloads'])
    return {'run_date':state['run_date'],'producer_run_id':'canonical','state':state}


def test_same_source_state_and_only_runtime_transition_allowed():
    packet = sample(); before = deepcopy(packet)
    state = validate_saved_state(packet,run_date='2026-10-08',run_id='canonical',source_sha='a'*40)
    new = {**state['pipeline_modal_serving_context'],'created_at':'now','expected_source_sha':'b'*40}
    validate_context_transition(state['pipeline_modal_serving_context'],new,runtime_source='b'*40)
    assert packet == before


@pytest.mark.parametrize('fault',['date','run','state_run','symbol','source','continued','resumed','sequence','sources','features'])
def test_saved_state_rejects_other_identity_missing_inputs_or_prior_continuation(fault):
    p=sample(); s=p['state']
    if fault=='date':p['run_date']='2026-10-09'
    elif fault=='run':p['producer_run_id']='other'
    elif fault=='state_run':s['producer_run_id']='other'
    elif fault=='symbol':s['payloads'][0]['symbol']='B'
    elif fault=='source':s['pipeline_modal_serving_context']['expected_source_sha']='c'*40
    elif fault=='continued':s['modal_prediction_bundle']={'status':'done'}
    elif fault=='resumed':s['saved_l2_resume']={'status':'started'}
    elif fault=='sequence':s.pop('pipeline_sequence_observations')
    elif fault=='sources':s.pop('payload_source_observations')
    elif fault=='features':s.pop('timexer_feature_source')
    with pytest.raises(ValueError):
        validate_saved_state(p,run_date='2026-10-08',run_id='canonical',source_sha='a'*40)


@pytest.mark.parametrize('fault',['version','manifest','field','runtime'])
def test_context_rejects_model_or_contract_drift(fault):
    old=sample()['state']['pipeline_modal_serving_context']; new=deepcopy(old)
    new.update(expected_source_sha='b'*40,created_at='now')
    if fault=='version':new['active_versions']['PatchTST']='v2'
    elif fault=='manifest':new['serving_manifest']['models'][0]['checksum']='other'
    elif fault=='field':new['additional_contract']=True
    elif fault=='runtime':new['expected_source_sha']='c'*40
    with pytest.raises(ValueError):validate_context_transition(old,new,runtime_source='b'*40)


@pytest.mark.parametrize('fault', [None, 'bad_sha', 'registered', 'claim_exists', 'builder'])
def test_resume_side_effect_order_and_fail_closed(monkeypatch, fault):
    import asyncio, hashlib, json, sys, types
    from google.cloud import storage
    from services import paper_strategy_mode
    from services.pipeline_saved_l2_resume import resume_saved_l2
    from services.pipeline_async_state_transport import STATE_SCHEMA_V2
    packet=sample(); packet['schema_version']=STATE_SCHEMA_V2
    raw=json.dumps(packet).encode(); events=[]
    uri='gs://test/pipeline-v2/async-modal-prediction/2026-10-08/canonical/partial_state.json.gz'
    for key,value in {'GCS_BUCKET_NAME':'test','PIPELINE_SAVED_L2_URI':uri,
        'PIPELINE_SAVED_L2_GENERATION':'123','PIPELINE_SAVED_L2_SHA256':hashlib.sha256(raw).hexdigest(),
        'PIPELINE_SAVED_L2_SOURCE_SHA':'a'*40,'STOCKVISION_SOURCE_SHA':'b'*40}.items():
        monkeypatch.setenv(key,value)
    if fault=='bad_sha':monkeypatch.setenv('PIPELINE_SAVED_L2_SHA256','0'*64)
    class Blob:
        def download_as_bytes(self, **kw):
            assert kw=={'if_generation_match':123}; events.append('read');return raw
        def exists(self):return fault=='registered'
        def upload_from_string(self,*args,**kw):
            assert kw['if_generation_match']==0;events.append('claim')
            if fault=='claim_exists':raise RuntimeError('already claimed')
    class Bucket:
        def blob(self,key,**kw):return Blob()
    monkeypatch.setattr(storage,'Client',lambda:types.SimpleNamespace(bucket=lambda name:Bucket()))
    monkeypatch.setattr(paper_strategy_mode,'from_manifest',lambda *a,**k:{'mode':'paper'})
    async def attach(state):
        new={**state['pipeline_modal_serving_context'],'expected_source_sha':'b'*40}
        state['pipeline_modal_serving_context']=new;return new
    async def build(state,**kw):
        events.append('build')
        if fault=='builder':raise ValueError('source gate')
        assert state['payloads']==packet['state']['payloads']
        return {'run_id':state['producer_run_id']}
    def write(state):events.append('write');return uri
    def spawn(request):events.append('spawn');assert request['state_gcs_uri']==uri;return {'function_call_id':'one'}
    graph=types.ModuleType('graphs.daily_pipeline_v2')
    graph.assert_canonical_window_open=lambda date:None
    graph._attach_pipeline_modal_serving_context=attach
    graph._build_pipeline_modal_prediction_payload=build
    graph._write_pipeline_async_state_artifact=write
    graph._spawn_pipeline_prediction_bundle_from_artifact=spawn
    monkeypatch.setitem(sys.modules,'graphs.daily_pipeline_v2',graph)
    call=lambda:asyncio.run(resume_saved_l2(run_date='2026-10-08',run_id='canonical'))
    if fault:
        with pytest.raises((ValueError,RuntimeError)):call()
        assert 'spawn' not in events and 'write' not in events
        if fault in ('bad_sha','registered'):assert 'claim' not in events
    else:
        assert call()['status']=='deferred'
        assert events==['read','claim','build','write','spawn']



def test_recapture_time_only_preserves_semantic_contract_but_receipt_changes_fail():
    import hashlib,json
    from services.paired_nav_journal import digest
    old=sample()['state']['pipeline_modal_serving_context']
    nav={'schema_version':'active8-nav-frozen-inference-v1','captured_at':'original','publication_receipt':{'sha':'pinned'}}
    old['serving_manifest']['active8_nav_inference']={**nav,'context_checksum':digest(nav)}
    checksum=lambda v:hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    old['serving_manifest_digest']=checksum(old['serving_manifest'])
    new=deepcopy(old);new['expected_source_sha']='b'*40
    nav={**nav,'captured_at':'fresh'}
    new['serving_manifest']['active8_nav_inference']={**nav,'context_checksum':digest(nav)}
    new['serving_manifest_digest']=checksum(new['serving_manifest'])
    validate_context_transition(old,new,runtime_source='b'*40)
    nav['publication_receipt']={'sha':'changed'}
    new['serving_manifest']['active8_nav_inference']={**nav,'context_checksum':digest(nav)}
    new['serving_manifest_digest']=checksum(new['serving_manifest'])
    with pytest.raises(ValueError,match='serving_contract_changed'):
        validate_context_transition(old,new,runtime_source='b'*40)
