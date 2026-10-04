import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import numpy as np
import pytest
from test_pipeline_input_events import Bucket, Jobs
from services import l4_oof_index_receipt as index, oof_prep_events as prep, pipeline_input_events as events
from services import l4_tabpack_handoff as handoff
from services.l4_distribution import digest
from app import l4_tabpack_stages as stages


def index_fixture():
    manifest = {'cohort_id':'c', 'manifest_checksum':'a'*64, 'windows':[{}], 'model_set':['one']}
    row = {'status':'ready','artifact_manifest_checksum':'a'*64,'expected_models':1,
           'expected_folds':1,'completed_folds':1,'prediction_rows':4,'prediction_dates':2}
    folds = [{'fold_id':'w0','model_name':'one','artifact_checksum':'b'*64}]
    client = SimpleNamespace(query=lambda sql,args: [row] if 'FROM active8_oof_cohorts ' in sql else folds)
    return manifest, row, folds, client


def test_index_reuses_only_exact_unchanged_db_projection():
    manifest, row, folds, client = index_fixture()
    bucket, summary = Bucket(), {'status':'ready','prediction_dates':2,'min_date':'2026-01-01','max_date':'2026-01-02'}
    assert index.reuse_index(manifest,bucket,client) is None
    index.seal_index(manifest,summary,bucket,client)
    assert index.reuse_index(manifest,bucket,client) == summary
    folds[0]['artifact_checksum'] = 'c'*64
    with pytest.raises(ValueError,match='receipt_mismatch'):
        index.reuse_index(manifest,bucket,client)


def test_index_rejects_db_loss_and_corrupt_receipt():
    manifest, row, folds, client = index_fixture()
    bucket=Bucket();index.seal_index(manifest,{'status':'ready'},bucket,client)
    row['completed_folds']=0
    with pytest.raises(ValueError,match='projection_incomplete'): index.reuse_index(manifest,bucket,client)
    row['completed_folds']=1
    receipt=json.loads(bucket.blob(index._path(manifest)).raw)
    receipt['index']['status']='forged'
    bucket.blob(index._path(manifest)).raw=json.dumps(receipt).encode()
    with pytest.raises(ValueError,match='receipt_mismatch'): index.reuse_index(manifest,bucket,client)


def test_continuation_skips_ooF_load_and_writes_and_never_calls_nav(monkeypatch):
    from services import l4_oof_lifecycle as lifecycle, active8_oof_cohort_materializer as materializer
    from routers import walk_forward
    manifest={'cohort_id':'c','manifest_checksum':'a'*64, 'end_date':'2026-01-02'}
    monkeypatch.setattr(materializer,'load_verified_oof_manifest',lambda *a,**k:(manifest,None))
    monkeypatch.setattr(index,'reuse_index',lambda *a:{'prediction_dates':2,'min_date':'2026-01-01','max_date':'2026-01-02'})
    monkeypatch.setattr(materializer,'load_oof_prediction_rows',lambda *a,**k:pytest.fail('duplicate OOF download'))
    monkeypatch.setattr(lifecycle,'persist_base_index',lambda **k:pytest.fail('duplicate index write'))
    monkeypatch.setattr(walk_forward,'_materialize_nav_with_reviews',lambda **k:pytest.fail('legacy NAV coupling'))
    async def waiting(**kwargs):return {'status':'pending','retry_required':True}
    monkeypatch.setattr(walk_forward,'dispatch_oof_full_fit_training',waiting)
    result=asyncio.run(lifecycle.materialize_native_base(manifest_path='fixture',cohort_id='c',as_of='2026-01-10',
        cadence='monthly',dry_run=False,dispatch_full_fit=True,poll_only=True,bucket=Bucket(),client=None))
    assert result['status']=='pending' and result['promotion_allowed'] is False
    assert result['paired_nav_maturity']['accounting_verified'] is False


@pytest.fixture
def event_store(monkeypatch):
    store=Bucket()
    monkeypatch.setattr(events,'bucket',lambda:store)
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    monkeypatch.setenv('ML_CONTROLLER_PUBLIC_URL','https://controller.invalid')
    monkeypatch.setenv('OOF_MATERIALIZE_RUN_ID','monthly:test')
    monkeypatch.setenv('OOF_MATERIALIZE_SCHEDULER_TICKET_ID','ticket')
    monkeypatch.setenv('OOF_MATERIALIZE_SCHEDULER_RUN_ID','scheduler-run')
    return store


def stage_context():return prep.prep_context(cadence='monthly',end_date='2026-10-04',profile='exo')


def test_adjusted_dispatch_nonblocking_and_watchdog_reuses(monkeypatch,event_store):
    from services import modal_client
    calls=[]
    monkeypatch.setattr(modal_client,'_lookup',lambda _:SimpleNamespace(spawn=lambda p:calls.append(p) or SimpleNamespace(object_id='fc')))
    request={'output_gcs_prefix':'adjusted/exact'}
    with stage_context():
        with pytest.raises(events.InputDeferred) as deferred: prep.adjusted_result(request)
        path=deferred.value.path
        with pytest.raises(events.InputDeferred): prep.adjusted_result(request)
        assert len(calls)==1
        stage=events.load_stage(event_store,path)
        events.put_once(event_store,path.replace('request.json','result.json'),{'status':'ready',
            'request_checksum':events.digest(events.encoded(stage)), 'result':{'status':'ready',**request}})
        prep.reconcile_current()
        assert prep.adjusted_result(request)=={'status':'ready',**request}
    jobs=Jobs();jobs.get_active_execution=lambda:None
    assert prep.dispatch_ready(path,store=event_store,jobs=jobs)['status']=='dispatched'
    assert prep.dispatch_ready(path,store=event_store,jobs=jobs)['idempotent'] is True
    assert len(jobs.calls)==1
    env=jobs.calls[0]['env_overrides']
    assert env['OOF_MATERIALIZE_SCHEDULER_TICKET_ID']=='ticket' and env['OOF_MATERIALIZE_RUN_ID']=='monthly:test'


def test_adjusted_lost_launch_and_overdue_do_not_spawn_again(monkeypatch,event_store):
    from services import modal_client
    calls=[]
    def lost(p):calls.append(p);raise TimeoutError()
    monkeypatch.setattr(modal_client,'_lookup',lambda _:SimpleNamespace(spawn=lost))
    with stage_context():
        with pytest.raises(events.InputDeferred) as deferred:prep.adjusted_result({'output_gcs_prefix':'exact'})
        path=deferred.value.path
        with pytest.raises(events.InputDeferred):prep.reconcile_current()
        blob=event_store.blob(path.replace('request.json','launch.json'))
        record=json.loads(blob.raw);record['created_at']=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
        blob.raw=json.dumps(record).encode()
        with pytest.raises(ValueError,match='completion_timeout'):prep.reconcile_current()
    assert len(calls)==1


def test_cpu_adjustment_publishes_before_callback_and_duplicate_never_rebuilds(event_store):
    from app.oof_adjusted_prep_event import run
    with stage_context():_,path,stage=events.register('adjusted',{'output_gcs_prefix':'exact'})
    calls=[]
    def rebuild(spec):calls.append(spec);return {**spec,'status':'idempotent_ready'}
    payload={'stage_path':path}
    first=run(payload,token='',bucket=event_store,rebuild=rebuild)
    assert first['status']=='ready'
    assert run(payload,token='',bucket=event_store,rebuild=rebuild)==first and len(calls)==1


def tp_payload():return {'expected_source_sha':'a'*40,'run_key':'c'*64,'training_recipe':stages.RECIPE}


def test_cpu_stage_failure_terminal_and_gpu_never_dispatched(monkeypatch):
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    bucket=Bucket();calls=[]
    def fail(*a):calls.append(True);raise ValueError('causal-gap')
    monkeypatch.setattr(stages,'prepare_stage',fail)
    monkeypatch.setattr(stages,'launch',lambda *a:pytest.fail('GPU must not launch'))
    with pytest.raises(ValueError,match='causal-gap'):stages.run_stage(tp_payload(),'prepare',bucket=bucket)
    assert stages.run_stage(tp_payload(),'prepare',bucket=bucket)['status']=='failed' and len(calls)==1


def test_completed_cpu_preparation_recovers_missing_gpu_handoff_without_refit(monkeypatch):
    from services import modal_client
    bucket=Bucket();payload=tp_payload();calls=[]
    stages._seal(bucket,stages._root(payload)+'prepared.json',{'payload':payload})
    monkeypatch.setattr(modal_client,'_lookup',lambda name:SimpleNamespace(spawn=lambda p:calls.append((name,p)) or SimpleNamespace(object_id='gpu')))
    assert handoff.resume_stages(bucket,payload['run_key'])['reason']=='tabpack_gpu_dispatched'
    assert handoff.resume_stages(bucket,payload['run_key'])['reason']=='awaiting_tabpack_gpu'
    assert len(calls)==1 and calls[0][0]=='fit_l4_tabpack_gpu'


def test_ambiguous_gpu_dispatch_never_repeated(monkeypatch):
    from services import modal_client
    bucket=Bucket();payload=tp_payload();calls=[]
    stages._seal(bucket,stages._root(payload)+'prepared.json',{'payload':payload})
    def lost(p):calls.append(p);raise TimeoutError()
    monkeypatch.setattr(modal_client,'_lookup',lambda name:SimpleNamespace(spawn=lost))
    with pytest.raises(TimeoutError):handoff.resume_stages(bucket,payload['run_key'])
    assert handoff.resume_stages(bucket,payload['run_key'])['status']=='pending' and len(calls)==1


def test_gpu_does_not_build_heads_and_preserves_exact_arrays(monkeypatch):
    from app import l4_tabpack_data, l4_tabpack_job
    bucket=Bucket();payload=tp_payload();root=stages._root(payload)
    import io,time
    arrays={n+s:np.ones((2,34),np.float32) if s=='_x' else np.arange(2,dtype=np.float32) for n in ('train','val','test') for s in ('_x','_y')}
    buffer=io.BytesIO();np.savez_compressed(buffer,**arrays)
    ref=stages._object(bucket,root,'prepared.npz',buffer.getvalue())
    stages._seal(bucket,root+'prepared.json',{'payload':payload,'arrays':ref})
    monkeypatch.setattr(l4_tabpack_data,'prepare',lambda *a,**k:pytest.fail('CPU work on GPU'))
    def train(dataset,output,*,timeout):
        assert 0<timeout<=3300
        np.testing.assert_array_equal(np.load(dataset/'x_num.npy'),np.concatenate([arrays[n+'_x'] for n in ('train','val','test')]))
        for name in ('result.json','weights.npz','experiment/experiments.json','experiment/online_ensemble_history.json','experiment/online_ensemble_predictions.npz'):
            path=output/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture')
    monkeypatch.setattr(l4_tabpack_job,'_train',train)
    result=stages.gpu_stage(payload,bucket,started=time.monotonic())
    assert len(result['files'])==5 and result['payload_checksum']==digest(payload)


def test_corrupt_prepared_blocks_gpu_fit(monkeypatch):
    from app import l4_tabpack_job
    import time
    bucket=Bucket();payload=tp_payload();root=stages._root(payload)
    ref=stages._object(bucket,root,'prepared.npz',b'valid')
    stages._seal(bucket,root+'prepared.json',{'payload':payload,'arrays':ref})
    bucket.blob(ref['path']).raw=b'changed'
    monkeypatch.setattr(l4_tabpack_job,'_train',lambda *a,**k:pytest.fail('must reject first'))
    with pytest.raises(ValueError,match='checksum_invalid'):stages.gpu_stage(payload,bucket,started=time.monotonic())


def test_oof_entry_uses_events_and_returns_pending_without_oof_or_nav(monkeypatch,event_store):
    import oof_materialize_job_main as job
    from services import active8_prep_lifecycle
    from routers import walk_forward
    async def ensure(**kwargs):
        ctx=events.current_context()
        assert ctx['oof_resume']['OOF_MATERIALIZE_CADENCE']=='monthly'
        assert ctx['oof_resume']['OOF_MATERIALIZE_MODEL_PROFILE_SCHEMA']=='exo'
        assert ctx['oof_resume']['OOF_MATERIALIZE_PROMOTE']=='0'
        assert ctx['oof_resume']['OOF_MATERIALIZE_DISPATCH_FULL_FIT']=='1'
        assert ctx['oof_resume']['OOF_MATERIALIZE_CONTINUATION_ONLY']=='0'
        assert ctx['oof_resume']['OOF_MATERIALIZE_CONTINUATION_ATTEMPT']=='0'
        raise events.InputDeferred('stage','prep')
    monkeypatch.setenv('OOF_MATERIALIZE_MODEL_PROFILE_SCHEMA','exo')
    monkeypatch.setattr(active8_prep_lifecycle,'ensure_active8_daily_prep',ensure)
    monkeypatch.setattr(walk_forward,'run_walk_forward_oof_lifecycle',lambda *a:pytest.fail('input not ready'))
    result=asyncio.run(job._execute_lifecycle(cadence='monthly',end_date='2026-10-04',promote=False,
        dispatch_full_fit=True,expected_cohort_id=None,continuation_attempt=0,continuation_only=False))
    assert result['status']=='pending' and result['prep_lifecycle']['cloud_compute_stopped'] is True
    assert events.current_context() is None


def test_oof_callback_cannot_consume_daily_pipeline_stage(event_store):
    with events.input_context({'producer_run_id':'daily','run_date':'2026-10-04'},'gs://fixture/state'):
        _,path,stage=events.register('prep',{})
    with pytest.raises(ValueError,match='owner_mismatch'):
        prep.dispatch_ready(path,store=event_store,jobs=Jobs())


def test_cpu_finalization_cannot_call_training(monkeypatch):
    from app import l4_tabpack_job
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    bucket=Bucket();calls=[];payload=tp_payload()
    monkeypatch.setattr(stages,'prepare_stage',lambda *a:pytest.fail('must not prepare again'))
    monkeypatch.setattr(stages,'gpu_stage',lambda *a,**k:pytest.fail('must not fit again'))
    monkeypatch.setattr(l4_tabpack_job,'build_candidate',lambda *a:calls.append(True) or {'status':'validated','promoted':False})
    result=stages.run_stage(payload,'finalize',bucket=bucket)
    assert result['status']=='validated'
    assert stages.run_stage(payload,'finalize',bucket=bucket)==result and len(calls)==1


def test_gpu_deadline_reserves_persistence_time(monkeypatch):
    from app import l4_tabpack_job
    import time,io
    bucket=Bucket();payload=tp_payload();root=stages._root(payload)
    arrays={n+s:np.ones((2,34),np.float32) if s=='_x' else np.arange(2,dtype=np.float32) for n in ('train','val','test') for s in ('_x','_y')}
    buffer=io.BytesIO();np.savez_compressed(buffer,**arrays)
    ref=stages._object(bucket,root,'prepared.npz',buffer.getvalue())
    stages._seal(bucket,root+'prepared.json',{'payload':payload,'arrays':ref})
    monkeypatch.setattr(l4_tabpack_job,'_train',lambda *a,**k:pytest.fail('no remaining fit budget'))
    with pytest.raises(TimeoutError,match='no_fit_budget'):
        stages.gpu_stage(payload,bucket,started=time.monotonic()-3500)


def test_daily_callback_rejects_oof_owner(event_store):
    with stage_context():_,path,_=events.register('adjusted',{'output_gcs_prefix':'exact'})
    with pytest.raises(ValueError,match='wrong_owner'):
        events.dispatch_ready(path,store=event_store,jobs_client=Jobs())


def test_prep_batch_rejects_wrong_modal_source_before_work(event_store,monkeypatch):
    from app.pipeline_input_prep import execute_event
    with stage_context():_,path,stage=events.register('prep',{'batches':[{}]})
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','b'*40)
    with pytest.raises(ValueError,match='producer_source_mismatch'):
        execute_event({'stage_path':path,'batch_index':0},bucket=event_store,
                      prep=lambda *a:pytest.fail('wrong source must not prepare'),token='')


def test_completed_gpu_receipt_is_verified_before_cpu_handoff(monkeypatch):
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    bucket=Bucket();payload=tp_payload();root=stages._root(payload)
    stages._seal(bucket,root+'gpu_output.json',{'payload_checksum':'wrong','files':{}})
    monkeypatch.setattr(stages,'launch',lambda *a:pytest.fail('mismatched GPU output'))
    with pytest.raises(ValueError,match='identity_invalid'):
        stages.run_stage(payload,'gpu',bucket=bucket)
