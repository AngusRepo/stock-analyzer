import pytest
from services import pipeline_input_events as events
from services.pipeline_input_work import observe_input_work
from test_pipeline_input_events import Bucket


def stage(store, kind='snapshot', resume='pre_l2'):
    with events.input_context({'producer_run_id':'run-1','run_date':'2026-10-20'}, 'gs://fixture/checkpoint', resume_phase=resume):
        spec = {'business_date':'2026-10-20','required_history':1280} if kind == 'snapshot' else {
            'batches':[{'sha256':'a'*64},{'sha256':'b'*64}]}
        _,path,_ = events.register(kind,spec)
    return path


@pytest.fixture
def store(monkeypatch):
    value=Bucket()
    monkeypatch.setattr(events,'bucket',lambda:value)
    monkeypatch.setenv('ML_CONTROLLER_PUBLIC_URL','https://fixture.invalid')
    return value


def observe(store, phase='input_snapshot', **kwargs):
    return observe_input_work(run_id='run-1',run_date='2026-10-20',phase=phase,store=store,**kwargs)


def test_snapshot_requires_verified_started_job_and_is_strictly_read_only(store):
    path=stage(store)
    events.put_once(store,path.replace('request.json','launch.json'),{'execution_name':'exact-job'})
    before={k:v.raw for k,v in store.blobs.items()}
    seen=[]
    def reader(name,p):
        seen.append((name,p))
        return {'status':'running','execution_id':'child'}
    row=observe(store,execution_reader=reader)
    assert row['status']=='running' and row['active']==1 and row['completed']==0
    assert seen==[('exact-job',path)]
    assert all(store.blobs[k].raw==raw for k,raw in before.items())
    assert not any(v.raw for k,v in store.blobs.items() if k not in before)


def test_dispatch_without_start_is_waiting_and_failure_is_explicit(store):
    path=stage(store)
    assert observe(store)['status']=='waiting'
    events.put_once(store,path.replace('request.json','launch.json'),{'execution_name':'job'})
    assert observe(store,execution_reader=lambda *_:{'status':'waiting'})['status']=='waiting'
    assert observe(store,execution_reader=lambda *_:{'status':'failed'})['status']=='failed'


def test_export_success_is_waiting_callback_never_parent_complete(store):
    path=stage(store)
    events.put_once(store,path.replace('request.json','result.json'),{'status':'success','snapshot':{'business_date':'2026-10-20','checksum':'abc'}})
    row=observe(store)
    assert row['status']=='waiting' and row['completed']==1
    events.put_once(store,path.replace('request.json','consumed.json'),{'status':'deferred'})
    assert observe(store)['status']=='unknown'


def test_feature_prep_needs_a_matching_claim_and_a_live_call(store):
    path=stage(store,'prep')
    events.put_once(store,path.replace('request.json','batch-0-claim.json'),{'request_sha256':'a'*64,'function_call_id':'live'})
    events.put_once(store,path.replace('request.json','batch-1.json'),{'stage_path':path,'batch_index':1,'request_sha256':'b'*64})
    row=observe(store,'input_prep',call_reader=lambda call:call=='live')
    assert (row['status'],row['active'],row['completed'],row['total'])==('running',1,1,2)
    assert observe(store,'input_prep',call_reader=lambda _:False)['status']=='waiting'
    assert observe(store,'prepare_prediction_request')['status']=='unknown'


def test_wrong_lineage_or_ambiguous_owners_never_turn_blue(store):
    path=stage(store,'prep')
    events.put_once(store,path.replace('request.json','batch-0.json'),{'stage_path':'wrong','batch_index':0,'request_sha256':'a'*64})
    assert observe(store,'input_prep')['status']=='unknown'
    assert observe_input_work(run_id='old',run_date='2026-10-20',phase='input_prep',store=store)['status']=='unknown'
    with pytest.raises(ValueError):
        observe(store,'not_a_phase')


def test_snapshot_runtime_must_match_the_immutable_stage_and_really_have_a_started_task(monkeypatch):
    from types import SimpleNamespace as NS
    from services import cloud_run_jobs_client
    from services.pipeline_input_work import snapshot_execution
    observed=NS(template=NS(containers=[NS(env=[NS(name='DATASET_SNAPSHOT_INPUT_STAGE',value='exact-stage')])]),
                conditions=[],running_count=0,start_time=None)
    client=NS(_parent='projects/p/locations/r/jobs/snapshot',_get_executions_client=lambda:NS(get_execution=lambda **_:observed))
    monkeypatch.setattr(cloud_run_jobs_client,'CloudRunJobsClient',lambda **_:client)
    name=client._parent+'/executions/one'
    assert snapshot_execution(name,'exact-stage')['status']=='waiting'
    observed.running_count=1
    assert snapshot_execution(name,'exact-stage')['status']=='running'
    assert snapshot_execution(name,'different-stage')['status']=='unknown'
    assert snapshot_execution('projects/p/locations/r/jobs/unrelated/executions/one','exact-stage')['status']=='unknown'


def test_status_endpoint_requires_auth_and_only_observes(monkeypatch):
    import asyncio
    from fastapi import HTTPException, Request
    from routers.pipeline import input_work_status
    from services import pipeline_input_work
    monkeypatch.setenv('ML_CONTROLLER_TOKEN','local-fixture-token')
    calls=[]
    def observe_only(**kwargs):
        calls.append(kwargs)
        return {'status':'running',**kwargs}
    monkeypatch.setattr(pipeline_input_work,'observe_input_work',observe_only)
    def request(headers=()):
        return Request({'type':'http','headers':list(headers)})
    with pytest.raises(HTTPException) as error:
        asyncio.run(input_work_status(request(),date='2026-10-20',run_id='run-1',phase='input_snapshot'))
    assert error.value.status_code==401
    assert calls==[]
    response=asyncio.run(input_work_status(request([(b'x-controller-token',b'local-fixture-token')]),
        date='2026-10-20',run_id='run-1',phase='input_snapshot'))
    assert response['status']=='running'
    assert calls==[{'run_id':'run-1','run_date':'2026-10-20','phase':'input_snapshot'}]
