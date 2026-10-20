from copy import deepcopy
import pytest
from services.timexer_daily_evidence import build, digest


def state():
    return {'run_date':'2026-10-19', 'producer_run_id':'fixture', 'modal_bundle_checksum':'bundle',
        'pipeline_modal_serving_context':{'created_at':'2026-10-19T12:00:00Z', 'serving_manifest_digest':'manifest',
            'serving_manifest':{'models':[{'model':'TimeXer','version':'fixed','status':'active',
                'effective_status':'degraded','health':{'offline_gate_decision':'DEGRADED'}}]}},
        'payloads':[{'symbol':s} for s in ('2330','2337','3004')],
        'predictions':{'2330':{'timexer':{'available':True},'rank_scores':{'TimeXer':0}},
            '2337':{'timexer':{'available':False,'reason':'sequence_too_short'}}}}


def test_daily_status_preserves_actual_degraded_and_all_missing_reasons():
    s=state();before=deepcopy(s);r=build(s)
    assert s==before
    assert r['model']['effective_status']=='degraded'
    assert r['available_count']==r['rank_observed_count']==1
    assert r['candidate_count']==3 and r['missing_count']==2
    assert r['missing_reasons']=={'prediction_missing':1,'sequence_too_short':1}
    assert r['checksum']==digest({k:v for k,v in r.items() if k!='checksum'})
    assert build(s)==r


def test_absent_context_is_explicit_and_never_inferred_as_degraded():
    s=state();s.pop('pipeline_modal_serving_context');r=build(s)
    assert r['context_status']=='serving_context_missing' and r['model'] is None
    s['pipeline_modal_serving_context']={'serving_manifest':{'models':[{'model':'DLinear'}]}}
    assert build(s)['context_status']=='not_in_frozen_roster'


def test_duplicate_manifest_is_not_silently_first_wins():
    s=state();rows=s['pipeline_modal_serving_context']['serving_manifest']['models'];rows.append(dict(rows[0]))
    with pytest.raises(ValueError,match='duplicate'):build(s)


def test_failed_run_has_durable_explicit_status_without_fabricated_degraded(monkeypatch):
    from services.timexer_daily_evidence import record_outcome
    from test_premarket_pipeline import Storage
    monkeypatch.setenv('GCS_BUCKET_NAME','local-fixture');storage=Storage()
    args=dict(day='2026-10-19',run_id='failed-before-l3',status='error',error_type='ValueError',client=storage)
    ref=record_outcome(**args)
    assert record_outcome(**args)==ref
    import json
    body=json.loads(storage.blob(ref['path']).download_as_bytes())
    assert body['pipeline_status']=='error' and body['observation_status']=='l3_evidence_not_recorded'
    assert body['model_evidence']['model'] is None and body['model_evidence']['available_count']==0
    assert body['model_evidence']['context_status']=='serving_context_missing'
    assert body['checksum']==digest({k:v for k,v in body.items() if k!='checksum'})


def test_terminal_outcome_reuses_frozen_status_and_rejects_changed_source(monkeypatch):
    import json
    from services import premarket_pipeline as pipeline
    from services.timexer_daily_evidence import record_outcome
    from test_premarket_pipeline import Storage
    monkeypatch.setenv('GCS_BUCKET_NAME','local-fixture');storage=Storage()
    evidence=build(state());sealed={'timexer_daily_evidence':evidence}
    path=pipeline.prefix('2026-10-19','fixture')+'/l3-receipt.json'
    storage.blob(path).upload_from_string(json.dumps(sealed),if_generation_match=0)
    result=record_outcome(day='2026-10-19',run_id='fixture',status='success',client=storage)
    body=json.loads(storage.blob(result['path']).download_as_bytes())
    assert body['model_evidence']['model']['effective_status']=='degraded'
    evidence['available_count']=999
    storage.blob(path).raw=json.dumps(sealed).encode()
    with pytest.raises(ValueError,match='source_mismatch'):
        record_outcome(day='2026-10-19',run_id='fixture',status='success',client=storage)


@pytest.mark.parametrize('raises',[False,True])
def test_actual_job_records_terminal_failure_before_worker_callback(monkeypatch,raises):
    import asyncio
    import pipeline_job_main as job
    from graphs import daily_pipeline_v2 as graph
    from services import pipeline_progress, allocator_contract_guard, timexer_daily_evidence
    calls=[]
    async def run(**kwargs):
        if raises:raise RuntimeError('fixture')
        return {'status':'error','error':'fixture-result'}
    async def report(*args,**kwargs):pass
    async def callback(payload):calls.append(('callback',payload))
    async def subtasks(*args,**kwargs):pass
    def record(**kwargs):
        calls.append(('receipt',kwargs))
        return {'path':'receipt.json','checksum':'a'*64}
    for name in ('PIPELINE_SAVED_L2_RESUME_MODE','PIPELINE_SAVED_PRE_L2_RESUME_MODE','PIPELINE_INPUT_CONTINUATION_MODE',
            'PIPELINE_PREMARKET_RESUME_MODE','PIPELINE_MODAL_CONTINUATION_MODE','PIPELINE_SNAPSHOT_RECOVERY_MODE',
            'PIPELINE_MODAL_PREDICTION_CALLBACK_ENABLED'):monkeypatch.setenv(name,'0')
    monkeypatch.setenv('PIPELINE_RUN_DATE','2026-10-19');monkeypatch.setenv('PIPELINE_PARENT_RUN_ID','fixture')
    monkeypatch.setattr(graph,'run_pipeline_v2',run)
    monkeypatch.setattr(pipeline_progress,'report',report)
    monkeypatch.setattr(allocator_contract_guard,'assert_allocator_contract_run_date',lambda *a,**k:None)
    monkeypatch.setattr(job,'_callback_worker',callback);monkeypatch.setattr(job,'_emit_subtask_callbacks',subtasks)
    monkeypatch.setattr(timexer_daily_evidence,'record_outcome',record)
    assert asyncio.run(job._run())==1
    assert [r[0] for r in calls]==['receipt','callback']
    assert calls[0][1]['status']=='error' and calls[0][1]['run_id']=='fixture'
    assert calls[1][1]['timexer_evidence_receipt']['path']=='receipt.json'
