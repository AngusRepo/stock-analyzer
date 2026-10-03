import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed
from services import pipeline_input_events as events


class Blob:
    def __init__(self, name):
        self.name, self.raw, self.generation = name, None, 0
    def upload_from_string(self, value, **kwargs):
        if kwargs.get('if_generation_match', self.generation) != self.generation:
            raise PreconditionFailed('generation')
        self.raw = value.encode() if isinstance(value, str) else value
        self.generation += 1
    def download_as_bytes(self):
        if self.raw is None:
            raise NotFound(self.name)
        return self.raw
    def download_as_text(self):
        return self.download_as_bytes().decode()
    def reload(self):
        return None
    def exists(self):
        return self.raw is not None


class Bucket:
    name = 'fixture'
    def __init__(self):
        self.blobs = {}
    def blob(self, path):
        return self.blobs.setdefault(path, Blob(path))
    def list_blobs(self, prefix):
        return [v for k,v in self.blobs.items() if k.startswith(prefix) and v.raw is not None]


class Jobs:
    def __init__(self):
        self.calls = []
    def run_job(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(execution_name='projects/p/jobs/pipeline/executions/one', execution_id='one')


@pytest.fixture
def store(monkeypatch):
    store = Bucket()
    monkeypatch.setattr(events, 'bucket', lambda: store)
    monkeypatch.setenv('ML_CONTROLLER_PUBLIC_URL', 'https://controller.invalid')
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'a'*40)
    from services import pipeline_canonical_window
    monkeypatch.setattr(pipeline_canonical_window, 'assert_canonical_window_open', lambda day: None)
    return store


def snapshot_stage(store):
    state = {'producer_run_id': 'run-1', 'run_date': '2026-10-02'}
    with events.input_context(state, 'gs://fixture/sealed-l2'):
        _, path, stage = events.register('snapshot', {'business_date':'2026-10-02', 'required_history':1280})
    return path, stage


def test_snapshot_dispatch_is_nonblocking_and_join_does_not_poll(monkeypatch, store):
    from services import cloud_run_jobs_client as cloud
    calls = []
    class Job(Jobs):
        def run_job(self, **kwargs):
            calls.append(kwargs)
            raise cloud.JobAlreadyRunningError(cloud.JobExecution('projects/p/jobs/snapshot/executions/existing','existing'))
        def execution_state(self, *_):
            pytest.fail('synchronous polling')
    monkeypatch.setattr(cloud, 'CloudRunJobsClient', lambda **_: Job())
    monkeypatch.setenv('DATASET_SNAPSHOT_JOB_NAME', 'snapshot')
    with events.input_context({'producer_run_id':'run-1','run_date':'2026-10-02'}, 'gs://fixture/sealed-l2'):
        for _ in range(2):
            with pytest.raises(events.InputDeferred):
                asyncio.run(events.defer_snapshot(business_date='2026-10-02', required_history=1280))
    assert len(calls) == 1
    assert calls[0]['env_overrides']['DATASET_SNAPSHOT_INPUT_ONLY'] == '1'


def test_callback_reads_receipt_and_dispatches_same_run_once(store):
    path, stage = snapshot_stage(store)
    jobs = Jobs()
    assert events.dispatch_ready(path, jobs_client=jobs, store=store)['status'] == 'waiting'
    assert not jobs.calls
    events.record_snapshot_result(path, status='success', snapshot={'business_date':'2026-10-02','checksum':'abc'})
    assert events.dispatch_ready(path, jobs_client=jobs, store=store)['status'] == 'dispatched'
    assert events.dispatch_ready(path, jobs_client=jobs, store=store)['idempotent'] is True
    assert len(jobs.calls) == 1
    env = jobs.calls[0]['env_overrides']
    assert env['PIPELINE_PARENT_RUN_ID'] == stage['run_id']
    assert env['PIPELINE_INPUT_CONTINUATION_MODE'] == '1'


@pytest.mark.parametrize('result,pattern', [
    ({'status':'error','error':'export failure'}, 'snapshot_failed'),
    ({'status':'success','snapshot':{'business_date':'2026-10-01','checksum':'x'}}, 'lineage_mismatch'),
])
def test_failed_or_wrong_date_result_does_not_start_pipeline(store, result, pattern):
    path,_ = snapshot_stage(store)
    events.put_once(store,path.replace('request.json','result.json'),result)
    jobs=Jobs()
    with pytest.raises(ValueError,match=pattern):events.dispatch_ready(path,jobs_client=jobs,store=store)
    assert not jobs.calls


def test_divergent_completion_and_stage_mutation_rejected(store):
    path,_ = snapshot_stage(store)
    events.record_snapshot_result(path,status='success',snapshot={'business_date':'2026-10-02','checksum':'a'})
    with pytest.raises(ValueError,match='immutable_conflict'):
        events.record_snapshot_result(path,status='success',snapshot={'business_date':'2026-10-02','checksum':'b'})
    stage=events.read(store,path);stage['run_id']='other'
    store.blob(path).raw=events.encoded(stage)
    with pytest.raises(ValueError,match='checksum_mismatch'):events.load_stage(store,path)


def test_lost_snapshot_callback_is_reconciled(store):
    path,_=snapshot_stage(store)
    events.record_snapshot_result(path,status='success',snapshot={'business_date':'2026-10-02','checksum':'x'})
    jobs=Jobs()
    result=events.reconcile_inputs(run_id='run-1',run_date='2026-10-02',jobs_client=jobs)
    assert result['status']=='dispatched' and len(jobs.calls)==1
    assert events.reconcile_inputs(run_id='other',run_date='2026-10-02',jobs_client=jobs) is None


def test_dispatch_ack_loss_adopts_exact_stage_execution(store):
    path,_=snapshot_stage(store)
    events.record_snapshot_result(path,status='success',snapshot={'business_date':'2026-10-02','checksum':'x'})
    events.put_once(store,path.replace('request.json','continuation.json'),{'status':'dispatching',
        'created_at':(datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat()})
    jobs=Jobs();observed=[]
    def status(**kw):
        observed.append(kw)
        return {'state':'running','execution_name':'projects/p/jobs/pipeline/executions/existing'}
    jobs.pipeline_execution_status=status
    result=events.dispatch_ready(path,jobs_client=jobs,store=store)
    assert result['execution_id']=='existing' and not jobs.calls
    assert observed[0]['required_env']=={'PIPELINE_INPUT_STAGE':path}


def test_consumption_once_and_terminal_result_reuse(store):
    path,_=snapshot_stage(store)
    assert events.claim_consumption(path) is None
    with pytest.raises(events.InputDeferred):events.claim_consumption(path)
    result={'status':'deferred','deferred_reason':'modal_prediction_callback'}
    events.finish_consumption(path,result)
    assert events.claim_consumption(path)==result


def prep_stage(store, monkeypatch):
    from routers import retrain_trigger as trigger
    from services import retrain_lock
    monkeypatch.setattr(retrain_lock,'release',lambda *a,**kw:None)
    monkeypatch.setattr(trigger,'_upsert_retrain_status',lambda *a,**kw:None)
    template={'schema_version':trigger.ACTIVE8_PREP_RECEIPT_SCHEMA_VERSION,
        'business_date':'2026-10-02','run_id':'prep-1','output_gcs_prefix':'universal/oof_forward_prep_v2/test',
        'producer_source_sha':trigger._runtime_source_sha(),
        'feature_semantic_version':trigger.ACTIVE8_FEATURE_SEMANTIC_VERSION,
        'feature_imputation_semantic':trigger.ACTIVE8_FEATURE_IMPUTATION_SEMANTIC_VERSION}
    calls=[]
    monkeypatch.setattr(events,'_launch_missing_prep',lambda bucket,path,stage:calls.append((path,stage)))
    payloads=[{'batch_index':idx,'retain_unlabeled_features':True,'gcs_prefix':template['output_gcs_prefix']} for idx in range(2)]
    with events.input_context({'producer_run_id':'run-1','run_date':'2026-10-02'},'gs://fixture/sealed-l2'):
        with pytest.raises(events.InputDeferred):
            events.defer_prep(payloads=payloads,receipt_template=template,lock_key='lock',lock_run_id='prep-1')
    return calls[0]


def batch_result(store,path,stage,index,**overrides):
    result={'stage_path':path,'batch_index':index,'request_sha256':stage['spec']['batches'][index]['sha256'],'rows':6000,**overrides}
    events.put_once(store,path.replace('request.json',f'batch-{index}.json'),result)
    prefix=stage['spec']['receipt_template']['output_gcs_prefix']
    store.blob(f'{prefix}/prep/batch_{index}.npz').upload_from_string(b'features')
    store.blob(f'{prefix}/prep/feature_names.json').upload_from_string(b'["price"]')


def test_prep_waits_for_every_batch_then_seals_without_training(store,monkeypatch):
    path,stage=prep_stage(store,monkeypatch);jobs=Jobs()
    batch_result(store,path,stage,0)
    assert events.dispatch_ready(path,jobs_client=jobs,store=store)['status']=='waiting'
    batch_result(store,path,stage,1)
    assert events.dispatch_ready(path,jobs_client=jobs,store=store)['status']=='dispatched'
    prefix=stage['spec']['receipt_template']['output_gcs_prefix']
    receipt=events.read(store,prefix+'/prep/immutable_receipt.json')
    assert receipt['training_dispatched'] is False and receipt['output_rows']==12000
    assert len(receipt['output_checksums'])==3
    assert len(jobs.calls)==1


@pytest.mark.parametrize('override,pattern', [({'error':'OOM'},'prep_failed'),({'request_sha256':'bad'},'lineage_mismatch'),({'rows':1},'rows_insufficient')])
def test_prep_invalid_result_never_dispatches(store,monkeypatch,override,pattern):
    path,stage=prep_stage(store,monkeypatch);jobs=Jobs()
    batch_result(store,path,stage,0,**override);batch_result(store,path,stage,1)
    with pytest.raises(ValueError,match=pattern):events.dispatch_ready(path,jobs_client=jobs,store=store)
    assert not jobs.calls


def test_modal_duplicate_batch_reuses_result_and_does_not_prepare_twice(store,monkeypatch):
    path,stage=prep_stage(store,monkeypatch)
    import importlib.util
    source=Path(__file__).resolve().parents[2]/'ml-service/app/pipeline_input_prep.py'
    spec=importlib.util.spec_from_file_location('event_prep',source);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    calls=[]
    payload={'stage_path':path,'batch_index':0,'request':stage['spec']['batches'][0], 'callback_url':stage['callback_url']}
    for _ in range(2):
        result=module.execute_event(payload,bucket=store,prep=lambda request:calls.append(request) or {'rows':6000},token='')
        assert result['rows']==6000
    assert len(calls)==1


@pytest.mark.parametrize('state', ['failed', 'succeeded'])
def test_terminated_continuation_without_receipt_is_not_perpetual_wait(store, state):
    path, _ = snapshot_stage(store)
    events.record_snapshot_result(path, status='success', snapshot={'business_date':'2026-10-02','checksum':'x'})
    jobs = Jobs()
    events.dispatch_ready(path, jobs_client=jobs, store=store)
    events.claim_consumption(path)
    observed = []
    jobs.execution_state = lambda execution: observed.append(execution.execution_name) or state
    with pytest.raises(ValueError, match='continuation_unfinished:' + state):
        events.reconcile_inputs(run_id='run-1', run_date='2026-10-02', jobs_client=jobs)
    assert observed == ['projects/p/jobs/pipeline/executions/one']
    assert len(jobs.calls) == 1


def test_running_continuation_waits_and_consumed_receipt_stops_observation(store):
    path, _ = snapshot_stage(store)
    events.record_snapshot_result(path, status='success', snapshot={'business_date':'2026-10-02','checksum':'x'})
    jobs = Jobs()
    events.dispatch_ready(path, jobs_client=jobs, store=store)
    jobs.execution_state = lambda execution: 'running'
    assert events.reconcile_inputs(run_id='run-1', run_date='2026-10-02', jobs_client=jobs)['reason'] == 'input_continuation_running'
    events.finish_consumption(path, {'status':'deferred','deferred_reason':'modal_prediction_callback'})
    jobs.execution_state = lambda execution: pytest.fail('consumed execution need not be polled')
    assert events.reconcile_inputs(run_id='run-1', run_date='2026-10-02', jobs_client=jobs) is None
