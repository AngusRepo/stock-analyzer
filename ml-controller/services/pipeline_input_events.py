"""Nonblocking prerequisites for the existing pipeline; all handoffs retain L2.

GCS create/CAS gates publication and continuation. Callbacks carry only a stage
address; results and lineage are read back from trusted immutable objects.
"""
from __future__ import annotations
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import gzip
import hashlib
import json
import logging
import os
import re
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import storage

PREFIX = 'pipeline-v2/input-events/v1/'
_CONTEXT = ContextVar('pipeline_input_context', default=None)


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode('utf8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def bucket():
    name = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not name:
        raise ValueError('pipeline_input_bucket_missing')
    return storage.Client().bucket(name)


def read(store, path):
    try:
        return json.loads(store.blob(path).download_as_bytes())
    except NotFound:
        return None


def put_once(store, path, value):
    raw = encoded(value)
    blob = store.blob(path)
    try:
        blob.upload_from_string(raw, content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        if blob.download_as_bytes() != raw:
            raise ValueError('pipeline_input_immutable_conflict:' + path)
    return path


def run_prefix(run_id, run_date):
    if not run_id or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', run_date):
        raise ValueError('pipeline_input_identity_missing')
    return f'{PREFIX}{run_date}/{digest(run_id.encode())}/'


def load_stage(store, path):
    if not re.fullmatch(re.escape(PREFIX) + r'\d{4}-\d{2}-\d{2}/[a-f0-9]{64}/(?:snapshot|prep|adjusted)-[a-f0-9]{64}/request.json', path):
        raise ValueError('pipeline_input_stage_path_invalid')
    stage = read(store, path)
    if not stage or stage.get('schema_version') != 'pipeline-input-stage-v1':
        raise ValueError('pipeline_input_stage_missing')
    expected = run_prefix(stage['run_id'], stage['run_date']) + stage['kind'] + '-' + digest(encoded(stage)) + '/request.json'
    if path != expected:
        raise ValueError('pipeline_input_stage_checksum_mismatch')
    return stage


def seal_checkpoint(state, raw):
    store = bucket()
    path = run_prefix(state['producer_run_id'], state['run_date']) + 'checkpoints/' + digest(raw) + '.json.gz'
    blob = store.blob(path)
    try:
        blob.upload_from_string(raw, content_type='application/gzip', if_generation_match=0)
    except PreconditionFailed:
        if blob.download_as_bytes() != raw:
            raise ValueError('pipeline_input_checkpoint_conflict')
    return f'gs://{store.name}/{path}'


@contextmanager
def input_context(state, state_uri):
    token = _CONTEXT.set({'run_id': state['producer_run_id'], 'run_date': state['run_date'], 'state_gcs_uri': state_uri})
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def current_context():
    return _CONTEXT.get()


class InputDeferred(Exception):
    def __init__(self, path, kind):
        self.path, self.kind = path, kind
        super().__init__('awaiting_' + kind)

    def result(self, run_date):
        return {'status': 'deferred', 'run_date': run_date, 'deferred_reason': 'input_' + self.kind,
                'metrics': {'async_input_dependency': {'stage': self.kind, 'stage_path': self.path,
                                                     'cloud_compute_stopped': True}}}


def callback_url():
    base = (os.environ.get('ML_CONTROLLER_PUBLIC_URL') or os.environ.get('ML_CONTROLLER_URL') or '').rstrip('/')
    if not base:
        raise ValueError('pipeline_input_callback_url_missing')
    return base + ('/pipeline/v2/oof-input/callback' if (current_context() or {}).get('oof_resume') else '/pipeline/v2/input/callback')


def register(kind, spec):
    ctx = current_context()
    if not ctx:
        raise ValueError('pipeline_input_context_missing')
    stage = {'schema_version': 'pipeline-input-stage-v1', **ctx, 'kind': kind, 'spec': spec,
             'callback_url': callback_url()}
    store = bucket()
    root = run_prefix(ctx['run_id'], ctx['run_date'])
    path = root + kind + '-' + digest(encoded(stage)) + '/request.json'
    put_once(store, path, stage)
    # Each immutable stage is independently discoverable by reconciliation;
    # no mutable latest pointer can lose a completion to a concurrent writer.
    return store, path, stage


def _claim_launch(store, path):
    blob = store.blob(path.replace('request.json', 'launch.json'))
    try:
        blob.upload_from_string(encoded({'status': 'launching', 'created_at': datetime.now(timezone.utc).isoformat()}),
                                content_type='application/json', if_generation_match=0)
        return blob
    except PreconditionFailed:
        return None


def _save_launch(blob, value):
    blob.reload()
    blob.upload_from_string(encoded(value), content_type='application/json', if_generation_match=blob.generation)


async def defer_snapshot(*, business_date, required_history):
    from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError
    store, path, stage = register('snapshot', {'business_date': business_date, 'required_history': required_history})
    claim = _claim_launch(store, path)
    if claim is not None:
        job_name = os.environ.get('DATASET_SNAPSHOT_JOB_NAME', '').strip()
        if not job_name:
            raise ValueError('inference_snapshot_job_not_configured')
        client = CloudRunJobsClient(job_name=job_name)
        try:
            execution = await asyncio.to_thread(client.run_job, env_overrides={
                'DATASET_SNAPSHOT_RUN_DATE': business_date,
                'DATASET_SNAPSHOT_PRODUCER_RUN_ID': 'inference-input:' + digest(path.encode()),
                'DATASET_SNAPSHOT_INPUT_ONLY': '1',
                'DATASET_SNAPSHOT_INPUT_STAGE': path,
                'STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS': str(required_history),
            }, reject_if_running=True)
            joined = False
        except JobAlreadyRunningError as exc:
            execution, joined = exc.execution, True
        except Exception:
            logging.getLogger(__name__).exception('Snapshot dispatch uncertain; retained for reconciliation')
            raise InputDeferred(path, 'snapshot')
        # On ambiguous dispatch failure leave launching intact, never duplicate
        # costly exports; reconcile checks Cloud Run before any new dispatch.
        _save_launch(claim, {'status': 'running', 'execution_name': execution.execution_name,
                            'execution_id': execution.execution_id, 'joined': joined})
    raise InputDeferred(path, 'snapshot')


def defer_prep(*, payloads, receipt_template, lock_key, lock_run_id):
    """Persist CPU work before spawning; never invoke a model training method."""
    store = bucket()
    refs = []
    for payload in payloads:
        raw = gzip.compress(encoded(payload), mtime=0)
        path = PREFIX + 'batches/' + digest(raw) + '.json.gz'
        blob = store.blob(path)
        try:
            blob.upload_from_string(raw, content_type='application/gzip', if_generation_match=0)
        except PreconditionFailed:
            if digest(blob.download_as_bytes()) != digest(raw):
                raise ValueError('pipeline_input_batch_conflict')
        refs.append({'path': path, 'sha256': digest(raw)})
    store, path, stage = register('prep', {'batches': refs, 'receipt_template': receipt_template,
                                         'lock_key': lock_key, 'lock_run_id': lock_run_id})
    try:
        _launch_missing_prep(store, path, stage)
    except Exception:
        logging.getLogger(__name__).exception('Prep dispatch uncertain; retained for reconciliation')
    raise InputDeferred(path, 'prep')


def _launch_missing_prep(store, path, stage):
    import modal
    fn = modal.Function.from_name('stockvision-ml', 'prep_universal_batch_event')
    for index, ref in enumerate(stage['spec']['batches']):
        if read(store, path.replace('request.json', f'batch-{index}.json')) is not None:
            continue
        dispatch_path = path.replace('request.json', f'batch-{index}-dispatch.json')
        if read(store, dispatch_path) is not None:
            continue
        # Lost spawn acknowledgement can resubmit this wrapper safely: the
        # wrapper's create-only batch claim excludes duplicate prep writes.
        call = fn.spawn({'bucket': store.name, 'stage_path': path, 'batch_index': index,
                         'request': ref, 'callback_url': stage['callback_url']})
        try:
            put_once(store, dispatch_path, {'function_call_id': call.object_id,
                     'created_at': datetime.now(timezone.utc).isoformat()})
        except ValueError:
            if not read(store, dispatch_path):
                raise


def record_snapshot_result(path, *, status, snapshot=None, error=None):
    store = bucket()
    stage = load_stage(store, path)
    if stage['kind'] != 'snapshot':
        raise ValueError('pipeline_input_not_snapshot')
    value = {'status': status, 'snapshot': snapshot, 'error': error}
    put_once(store, path.replace('request.json', 'result.json'), value)
    return stage


def _complete_prep(store, stage, path):
    spec = stage['spec']
    results = [read(store, path.replace('request.json', f'batch-{idx}.json')) for idx in range(len(spec['batches']))]
    for idx, result in enumerate(results):
        if result and (result.get('stage_path') != path or result.get('batch_index') != idx
                       or result.get('request_sha256') != spec['batches'][idx]['sha256']):
            raise ValueError('pipeline_input_batch_result_lineage_mismatch')
        if result and result.get('error'):
            raise ValueError('pipeline_input_prep_failed:' + str(result['error']))
        if result is None:
            claim = read(store, path.replace('request.json', f'batch-{idx}-claim.json'))
            if claim and claim.get('created_at'):
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(claim['created_at'])).total_seconds()
                if age > 2100:
                    raise ValueError('pipeline_input_prep_completion_timeout:' + str(idx))
    if any(result is None for result in results):
        return False
    # Only one callback reads the large outputs. Other batch callbacks wait for
    # this short sealing step instead of each downloading all NPZs again.
    seal_path = path.replace('request.json', 'seal.json')
    seal_blob = store.blob(seal_path)
    seal_claim = {'status':'sealing', 'created_at':datetime.now(timezone.utc).isoformat()}
    try:
        seal_blob.upload_from_string(encoded(seal_claim), content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        seal_blob.reload()
        generation = seal_blob.generation
        previous = read(store, seal_path)
        if previous.get('status') == 'ready':
            return True
        if (datetime.now(timezone.utc)-datetime.fromisoformat(previous['created_at'])).total_seconds() < 300:
            return False
        seal_blob.upload_from_string(encoded(seal_claim), content_type='application/json', if_generation_match=generation)
    template = spec['receipt_template']
    prefix = template['output_gcs_prefix']
    rows = [int(result.get('rows') or 0) for result in results]
    if any(row <= 0 for row in rows) or sum(rows) < 10000:
        raise ValueError('pipeline_input_prep_rows_insufficient')
    paths = [f'{prefix}/prep/batch_{idx}.npz' for idx in range(len(results))]
    paths.append(f'{prefix}/prep/feature_names.json')
    checksums = {key: digest(store.blob(key).download_as_bytes()) for key in paths}
    receipt_path = f'{prefix}/prep/immutable_receipt.json'
    receipt = read(store, receipt_path)
    if receipt is None:
        receipt = {**template, 'status': 'ready', 'created_at': datetime.now(timezone.utc).isoformat(),
                   'batch_count': len(rows), 'batch_rows': rows, 'output_rows': sum(rows),
                   'output_checksums': checksums, 'feature_names_path': paths[-1], 'training_dispatched': False}
        receipt['receipt_checksum'] = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
        try:
            store.blob(receipt_path).upload_from_string(encoded(receipt), content_type='application/json', if_generation_match=0)
        except PreconditionFailed:
            pass  # Another completion may have sealed the same verified outputs.
    from routers.retrain_trigger import _verified_prep_only_receipt, _upsert_retrain_status
    from services import retrain_lock
    sealed = _verified_prep_only_receipt(store, prefix, template['business_date'])
    if not sealed or sealed['output_checksums'] != checksums:
        raise ValueError('pipeline_input_prep_seal_mismatch')
    retrain_lock.release(spec['lock_key'], expected_metadata={'run_id': spec['lock_run_id']})
    _upsert_retrain_status(spec['lock_run_id'], status='completed', summary=sealed,
                          downstream_notes='prep_only_event_complete_no_training_dispatched')
    _save_launch(seal_blob, {'status':'ready', 'receipt_checksum':sealed['receipt_checksum']})
    return True


def dispatch_ready(path, *, jobs_client, store=None):
    store = store or bucket()
    stage = load_stage(store, path)
    if stage.get('oof_resume'):
        raise ValueError('pipeline_input_wrong_owner')
    from services.pipeline_canonical_window import assert_canonical_window_open
    assert_canonical_window_open(stage['run_date'])
    existing = read(store, path.replace('request.json', 'continuation.json'))
    if existing and existing.get('status') == 'dispatched':
        return {**existing, 'idempotent': True}
    if stage['kind'] == 'prep':
        ready = _complete_prep(store, stage, path)
    else:
        result = read(store, path.replace('request.json', 'result.json'))
        ready = result is not None and result.get('status') == 'success'
        if result and not ready:
            raise ValueError('pipeline_input_snapshot_failed:' + str(result.get('error')))
        if ready:
            snapshot = result.get('snapshot') or {}
            if snapshot.get('business_date') != stage['spec']['business_date'] or not snapshot.get('checksum'):
                raise ValueError('pipeline_input_snapshot_lineage_mismatch')
    if not ready:
        return {'status': 'waiting', 'reason': 'awaiting_' + stage['kind'], 'stage_path': path}
    receipt_path = path.replace('request.json', 'continuation.json')
    blob = store.blob(receipt_path)
    claim = {'status': 'dispatching', 'created_at': datetime.now(timezone.utc).isoformat()}
    try:
        blob.upload_from_string(encoded(claim), content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        existing = read(store, receipt_path)
        if existing.get('status') == 'dispatched':
            return {**existing, 'idempotent': True}
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(existing['created_at'])).total_seconds()
        if age < 120:
            return {**existing, 'idempotent': True, 'reason': 'input_continuation_dispatching'}
        observed = jobs_client.pipeline_execution_status(run_date=stage['run_date'], run_id=stage['run_id'],
            required_env={'PIPELINE_INPUT_STAGE': path})
        if observed.get('execution_name'):
            value = {'status': 'dispatched', 'execution_name': observed['execution_name'],
                     'execution_id': observed['execution_name'].rsplit('/', 1)[-1], 'reason': 'input_dispatch_recovered'}
            _save_launch(blob, value)
            return value
        if observed.get('reason') != 'exact_run_execution_not_found':
            return {'status': 'waiting', 'reason': 'input_dispatch_observation_incomplete'}
        blob.reload()
        generation = blob.generation
        if read(store, receipt_path) != existing:
            return {'status': 'waiting', 'reason': 'input_dispatch_competing_recovery'}
        blob.upload_from_string(encoded(claim), content_type='application/json', if_generation_match=generation)
    execution = jobs_client.run_job(env_overrides={
        'PIPELINE_INPUT_CONTINUATION_MODE': '1', 'PIPELINE_INPUT_STAGE': path,
        'PIPELINE_PARENT_RUN_ID': stage['run_id'], 'PIPELINE_RUN_DATE': stage['run_date'],
    }, reject_if_running=False)
    value = {'status': 'dispatched', 'execution_name': execution.execution_name, 'execution_id': execution.execution_id,
             'reason': 'input_' + stage['kind'] + '_ready'}
    _save_launch(blob, value)
    return value


def resume_state(path, *, run_id, run_date):
    store = bucket()
    stage = load_stage(store, path)
    if stage['run_id'] != run_id or stage['run_date'] != run_date:
        raise ValueError('pipeline_input_resume_identity_mismatch')
    continuation = read(store, path.replace('request.json', 'continuation.json'))
    if not continuation or continuation.get('status') not in {'dispatching', 'dispatched'}:
        raise ValueError('pipeline_input_resume_not_dispatched')
    uri = stage['state_gcs_uri']
    expected = f'gs://{store.name}/' + run_prefix(run_id, run_date) + 'checkpoints/'
    if not uri.startswith(expected):
        raise ValueError('pipeline_input_checkpoint_scope_mismatch')
    raw = store.blob(uri.removeprefix(f'gs://{store.name}/')).download_as_bytes()
    if uri != expected + digest(raw) + '.json.gz':
        raise ValueError('pipeline_input_checkpoint_checksum_mismatch')
    from graphs.daily_pipeline_v2 import decode_pipeline_state_envelope, validate_pipeline_payload_identity
    state = decode_pipeline_state_envelope(raw)['state']
    if state.get('producer_run_id') != run_id or state.get('run_date') != run_date:
        raise ValueError('pipeline_input_checkpoint_identity_mismatch')
    validate_pipeline_payload_identity(state)
    return state


def reconcile_inputs(*, run_id, run_date, jobs_client):
    """Recover lost callbacks from durable results; never infer L3 completion."""
    store = bucket()
    paths = sorted(blob.name for blob in store.list_blobs(prefix=run_prefix(run_id, run_date))
                   if blob.name.endswith('/request.json'))
    if not paths:
        return None
    pending = []
    for path in paths:
        continued = read(store, path.replace('request.json', 'continuation.json'))
        if continued and continued.get('status') == 'dispatched':
            if read(store, path.replace('request.json', 'consumed.json')) is None:
                # A dispatcher exit is not a durable consumption receipt. Observe
                # the exact continuation, including crashes after its claim.
                from services.cloud_run_jobs_client import JobExecution
                execution_state = jobs_client.execution_state(JobExecution(
                    continued['execution_name'], continued['execution_id']))
                if execution_state in {'failed', 'succeeded'}:
                    raise ValueError('pipeline_input_continuation_unfinished:' + execution_state)
                pending.append({'status': 'waiting', 'reason': 'input_continuation_running', 'stage_path': path})
            continue
        stage = load_stage(store, path)
        if stage['kind'] == 'snapshot' and read(store, path.replace('request.json', 'result.json')) is None:
            launch = read(store, path.replace('request.json', 'launch.json')) or {}
            if not launch.get('execution_name'):
                launch = _recover_snapshot_launch(store, path, launch)
            if launch.get('execution_name'):
                from services.cloud_run_jobs_client import CloudRunJobsClient
                client = CloudRunJobsClient(job_name=os.environ.get('DATASET_SNAPSHOT_JOB_NAME', ''))
                from services.cloud_run_jobs_client import JobExecution
                observed = {'state': client.execution_state(JobExecution(launch['execution_name'], launch['execution_id']))}
                if observed.get('state') == 'failed':
                    raise ValueError('pipeline_input_snapshot_execution_failed')
                if observed.get('state') == 'succeeded':
                    from services.dataset_snapshots import latest_dataset_snapshot
                    snapshot = latest_dataset_snapshot(kind='backtest_dataset', access_tier='compute', business_date=stage['spec']['business_date'])
                    put_once(store, path.replace('request.json', 'result.json'), {'status': 'success', 'snapshot': snapshot, 'error': None})
        if stage['kind'] == 'prep':
            _launch_missing_prep(store, path, stage)
        pending.append(dispatch_ready(path, jobs_client=jobs_client, store=store))
    return pending[-1] if pending else None


def claim_consumption(path):
    store = bucket()
    result = read(store, path.replace('request.json', 'consumed.json'))
    if result is not None:
        return result
    blob = store.blob(path.replace('request.json', 'consuming.json'))
    try:
        blob.upload_from_string(encoded({'execution_id': os.environ.get('CLOUD_RUN_EXECUTION'),
            'created_at': datetime.now(timezone.utc).isoformat()}), content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        raise InputDeferred(path, 'continuation_in_progress')
    return None


def finish_consumption(path, result):
    put_once(bucket(), path.replace('request.json', 'consumed.json'), result)


def _recover_snapshot_launch(store, path, launch):
    from services.cloud_run_jobs_client import CloudRunJobsClient
    from google.cloud import run_v2
    from itertools import islice
    client = CloudRunJobsClient(job_name=os.environ.get('DATASET_SNAPSHOT_JOB_NAME', ''))
    page = client._get_executions_client().list_executions(
        request=run_v2.ListExecutionsRequest(parent=client._parent, page_size=100), timeout=15)
    for execution in islice(page, 100):
        values = {item.name:item.value for container in execution.template.containers for item in container.env
                  if item.name == 'DATASET_SNAPSHOT_INPUT_STAGE'}
        if values.get('DATASET_SNAPSHOT_INPUT_STAGE') == path:
            value = {'status':'running', 'execution_name':execution.name,
                     'execution_id':execution.name.rsplit('/',1)[-1], 'joined':False}
            _save_launch(store.blob(path.replace('request.json','launch.json')), value)
            return value
    if launch.get('created_at') and (datetime.now(timezone.utc)-datetime.fromisoformat(launch['created_at'])).total_seconds() > 180:
        raise ValueError('pipeline_input_snapshot_dispatch_unconfirmed')
    return launch
