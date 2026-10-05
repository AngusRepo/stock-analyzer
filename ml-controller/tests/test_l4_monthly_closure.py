import asyncio
from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace
import pytest
from services import l4_monthly_closure as closure
from test_l4_tabpack_monthly import Bucket


@pytest.fixture
def data(monkeypatch):
    from services import l4_oof_index_receipt
    from scripts import l4_distribution_refresh_job as refresh
    models = ['m'+str(i) for i in range(8)]
    manifest = {'cohort_id':'cohort', 'manifest_checksum':'a'*64, 'model_set':models,
        'test_window_days':10, 'end_date':'2026-09-11', 'windows':[{'window_id':0, 'oof_fold_ready':True,
        'missing_oof_models':[], 'fold_blockers':[], 'model_metrics':{m:{'status':'ready','oof_artifact':m,'artifact_checksum':'a'*64} for m in models}}]}
    bucket = Bucket()
    terminal = {'gcs_prefix':'prep', 'stages':{'release_model_completion':{'status':'complete','models_completed':8,
        'models_required':8,'receipts':{m:{'artifact_path':m,'checksum':'x'} for m in models}}}}
    raw = json.dumps(terminal).encode();bucket.saved['terminal'] = raw
    bucket.saved.update({m:b'weights' for m in models})
    fit = {'status':'completed','retry_required':False,'cohort_id':'cohort','knowledge_cutoff_date':'2026-10-04',
        'release_models':models, 'missing_models':[], 'offline_failed_models':[], 'training_failed_models':[],
        'terminal_payload_path':'terminal','terminal_payload_checksum':hashlib.sha256(raw).hexdigest(),
        'release_registry':{'ensemble_candidate':{'artifact_id':'parent'}}}
    result = {'cadence':'monthly','status':'materialized','promoted':False,'knowledge_cutoff_date':'2026-10-04',
        'calendar':{'cutoff':'2026-10-04','prep_gcs_prefix':'prep','prep_manifest_checksum':'b'*64,
            'mature_max_date':'2026-09-22','deferred_oof_dates':['2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-21','2026-09-22']},
        'full_fit_dispatch':fit,'l4_distribution_refresh':{'run_key':'c'*64,'artifact_checksum':'d'*64}}
    monkeypatch.setattr(l4_oof_index_receipt,'reuse_index',lambda *a:{'max_date':'2026-09-11','fold_artifact_rows':8,'prediction_dates':10})
    monkeypatch.setattr(refresh,'load_target_parent',lambda *a:({}, {'cohort_id':'cohort'}))
    monkeypatch.setattr(closure,'completed_candidate',lambda *a,**kw:{'artifact_checksum':'d'*64,'run_key':'c'*64})
    return result,manifest,bucket


def test_complete_monthly_keeps_tail_and_has_no_daily_credit(data):
    result,manifest,bucket=data
    evidence=closure.build(result,manifest,bucket,object())
    assert evidence['status']=='complete' and len(evidence['deferred_oof_dates'])==7
    assert evidence['daily_freshness_credit'] is False and evidence['promoted'] is False
    import oof_materialize_job_main as job
    result['physical_prediction_coverage']={'max_date':'2026-09-11'}
    assert job._oof_freshness_evidence(result)['status']=='failed'


@pytest.mark.parametrize('defect', ['model','window','tail','fit','candidate','scope','date','artifact'])
def test_incomplete_training_cannot_close(data,defect):
    result,manifest,bucket=data
    if defect=='model':manifest['windows'][0]['model_metrics'].pop('m1')
    if defect=='window':manifest['windows'][0]['oof_fold_ready']=False
    if defect=='tail':result['calendar']['deferred_oof_dates']=[]
    if defect=='fit':result['full_fit_dispatch']['missing_models']=['m1']
    if defect=='candidate':result['l4_distribution_refresh']['artifact_checksum']='wrong'
    if defect=='scope':result['cadence']='daily'
    if defect=='date':result['full_fit_dispatch']['knowledge_cutoff_date']='2026-10-05'
    if defect=='artifact':bucket.saved.pop('m1')
    with pytest.raises(ValueError):closure.build(result,manifest,bucket,object())


def test_completed_reuse_never_calls_dispatch_if_receipt_missing():
    with pytest.raises(ValueError,match='missing'):
        closure.completed_candidate(Bucket(),'a'*64,identity={},manifest_checksum='b'*64,as_of='2026-10-04')


def test_completed_reuse_rejects_other_parent_date_and_manifest(monkeypatch):
    from services import l4_tabpack_dispatch
    bucket=Bucket();key='a'*64
    candidate={'cadence':'monthly','challenger_training_source':{'as_of':'2026-10-04'},
        'training_source':{'source_manifest_checksum':'b'*64}}
    bucket.saved['l4_distribution/tabpack_runs/'+key+'/completed.json']=b'{}'
    bucket.saved['candidate']=json.dumps(candidate).encode()
    monkeypatch.setattr(l4_tabpack_dispatch,'dispatch',lambda *a:{'artifact_path':'candidate'})
    monkeypatch.setattr(closure,'validate_bundle',lambda c,**kw: (_ for _ in ()).throw(ValueError('parent')) if kw['l3_identity']!={'id':'parent'} else None)
    for kwargs in [dict(identity={},manifest_checksum='b'*64,as_of='2026-10-04'),
                   dict(identity={'id':'parent'},manifest_checksum='c'*64,as_of='2026-10-04'),
                   dict(identity={'id':'parent'},manifest_checksum='b'*64,as_of='2026-10-05')]:
        with pytest.raises(ValueError):closure.completed_candidate(bucket,key,**kwargs)


def test_monthly_job_requires_receipt_but_daily_remains_strict(monkeypatch):
    import oof_materialize_job_main as job
    callbacks=[]
    result={'status':'materialized','materialization_owner':'native_l3_new_l4','calendar':{'mature_max_date':'2026-09-22'},
        'physical_prediction_coverage':{'max_date':'2026-09-11'},
        'monthly_training_closure':{'schema_version':closure.SCHEMA,'status':'complete','receipt_checksum':'a'*64,
            'as_of':'2026-10-04','daily_freshness_credit':False}}
    async def execute(**kw):return result
    async def callback(payload):callbacks.append(payload)
    monkeypatch.setattr(job,'_execute_lifecycle',execute);monkeypatch.setattr(job,'_callback_worker',callback)
    monkeypatch.setenv('OOF_MATERIALIZE_END_DATE','2026-10-04');monkeypatch.setenv('OOF_MATERIALIZE_MODE','oof_lifecycle')
    for cadence,expected in [('monthly',0),('daily',1)]:
        monkeypatch.setenv('OOF_MATERIALIZE_CADENCE',cadence)
        assert asyncio.run(job._run())==expected
        assert callbacks[-1]['metadata']['oof_freshness']['status']=='failed'
    result.pop('monthly_training_closure');monkeypatch.setenv('OOF_MATERIALIZE_CADENCE','monthly')
    assert asyncio.run(job._run())==1


def test_monthly_callback_allows_bounded_artifact_readback(monkeypatch):
    import oof_materialize_job_main as job
    from routers import pipeline
    calls=[]
    async def callback(payload,client=None):calls.append(client.timeout.read if client else None)
    monkeypatch.setattr(pipeline,'_callback_worker',callback)
    asyncio.run(job._callback_worker({'task':'active8-oof-monthly','metadata':{'monthly_training_closure':{'status':'complete'}}}))
    asyncio.run(job._callback_worker({'task':'active8-oof-daily'}))
    assert calls==[150.0,None]
