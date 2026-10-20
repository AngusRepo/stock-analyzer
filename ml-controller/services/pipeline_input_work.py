"""Read-only child-work observations; never dispatch, reconcile, or consume inputs."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import os
import re

from services import pipeline_input_events as events

PHASES = {'input_snapshot', 'input_prep', 'prepare_prediction_request'}


def snapshot_execution(name, path):
    from google.cloud import run_v2
    from services.cloud_run_jobs_client import CloudRunJobsClient
    client = CloudRunJobsClient(job_name=os.environ.get('DATASET_SNAPSHOT_JOB_NAME', ''))
    if not name.startswith(client._parent + '/executions/'):
        return {'status': 'unknown'}
    observed = client._get_executions_client().get_execution(
        request=run_v2.GetExecutionRequest(name=name), timeout=3)
    values = {item.name: item.value for container in observed.template.containers for item in container.env}
    if values.get('DATASET_SNAPSHOT_INPUT_STAGE') != path:
        return {'status': 'unknown'}
    for condition in observed.conditions:
        if condition.type_ == 'Completed':
            if condition.state == run_v2.Condition.State.CONDITION_FAILED:
                return {'status': 'failed'}
            if condition.state == run_v2.Condition.State.CONDITION_SUCCEEDED:
                return {'status': 'waiting'}  # Publication/callback still owns continuation.
    return {'status': 'running' if observed.running_count else 'waiting',
            'execution_id': name.rsplit('/', 1)[-1],
            'started_at': observed.start_time.isoformat() if observed.start_time else None}


def call_running(call_id):
    if not call_id:
        return False
    import modal
    try:
        modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return True
    except Exception:
        return False
    return False


def observe_input_work(*, run_id, run_date, phase, store=None,
                       execution_reader=snapshot_execution, call_reader=call_running):
    if phase not in PHASES or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', run_date) or not run_id or len(run_id) > 180:
        raise ValueError('pipeline_input_work_identity_invalid')
    store = store or events.bucket()
    prefix = events.run_prefix(run_id, run_date)
    paths = [blob.name for blob in store.list_blobs(prefix=prefix) if blob.name.endswith('/request.json')]
    observations = []
    for path in paths:
        stage = events.load_stage(store, path)
        if stage.get('oof_resume') or stage['run_id'] != run_id or stage['run_date'] != run_date:
            continue
        stage_phase = 'input_snapshot' if stage['kind'] == 'snapshot' else (
            'input_prep' if stage.get('resume_phase') == 'pre_l2' else 'prepare_prediction_request')
        if stage_phase != phase or events.read(store, path.replace('request.json', 'consumed.json')) is not None:
            continue
        row = {'stage_id': hashlib.sha256(path.encode()).hexdigest(), 'status': 'waiting',
               'active': 0, 'completed': 0, 'total': 1}
        if stage['kind'] == 'snapshot':
            result = events.read(store, path.replace('request.json', 'result.json'))
            launch = events.read(store, path.replace('request.json', 'launch.json')) or {}
            if result is not None:
                snapshot = result.get('snapshot') or {}
                valid = result.get('status') == 'success' and snapshot.get('business_date') == run_date and bool(snapshot.get('checksum'))
                row.update(status='waiting' if valid else 'unknown' if result.get('status') == 'success' else 'failed',
                           completed=int(valid))
            elif launch.get('execution_name'):
                try:
                    row.update(execution_reader(launch['execution_name'], path))
                except Exception:
                    # Unobservable runtime is unknown, never running; return a cacheable answer.
                    row['status'] = 'unknown'
                row['active'] = int(row['status'] == 'running')
        elif stage['kind'] == 'prep':
            refs = stage['spec']['batches']
            row['total'] = len(refs)
            if not 0 < len(refs) <= 128:
                row['status'] = 'unknown'
                observations.append(row)
                continue

            def batch(index):
                result = events.read(store, path.replace('request.json', f'batch-{index}.json'))
                if result is not None:
                    if result.get('stage_path') != path or result.get('batch_index') != index or result.get('request_sha256') != refs[index]['sha256']:
                        return 'unknown'
                    return 'failed' if result.get('error') else 'completed'
                claim = events.read(store, path.replace('request.json', f'batch-{index}-claim.json')) or {}
                if claim.get('request_sha256') == refs[index]['sha256'] and call_reader(claim.get('function_call_id')):
                    return 'running'
                return 'waiting'

            with ThreadPoolExecutor(max_workers=8) as pool:
                states = list(pool.map(batch, range(len(refs))))
            row.update(active=states.count('running'), completed=states.count('completed'))
            row['status'] = 'failed' if 'failed' in states else 'unknown' if 'unknown' in states else 'running' if row['active'] else 'waiting'
        observations.append(row)
    # Multiple unresolved stage instances are ambiguous; never pick an arbitrary owner.
    work = observations[0] if len(observations) == 1 else {
        'stage_id': '', 'status': 'unknown', 'active': 0, 'completed': 0, 'total': 0}
    return {'run_id': run_id, 'run_date': run_date, 'phase': phase,
            'observed_at': datetime.now(timezone.utc).isoformat(), **work}
