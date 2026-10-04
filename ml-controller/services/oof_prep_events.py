"""OOF prep reuses pipeline batch events, with a separate training continuation owner."""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import os
from google.api_core.exceptions import PreconditionFailed
from services import pipeline_input_events as events


@contextmanager
def prep_context(*, cadence, end_date, profile, controls=None):
    day = date.fromisoformat(end_date).isoformat()
    if cadence not in ('weekly', 'monthly'):
        raise ValueError('oof_prep_cadence_invalid')
    keys = ('CADENCE', 'END_DATE', 'PROMOTE', 'DISPATCH_FULL_FIT', 'RUN_ID', 'CALLBACK_TASK',
            'CONTINUATION_ATTEMPT', 'CONTINUATION_ONLY', 'EXPECTED_COHORT_ID',
            'SCHEDULER_TICKET_ID', 'SCHEDULER_RUN_ID', 'MODEL_PROFILE_SCHEMA')
    defaults = {'PROMOTE':'1', 'DISPATCH_FULL_FIT':'0', 'CONTINUATION_ONLY':'0',
                'CONTINUATION_ATTEMPT':'0', 'CALLBACK_TASK':f'active8-oof-{cadence}',
                'RUN_ID':os.environ.get('CLOUD_RUN_EXECUTION') or f'active8-oof-{cadence}:{day}:resolve-after-prep'}
    resume = {'OOF_MATERIALIZE_' + k: os.environ.get('OOF_MATERIALIZE_' + k, defaults.get(k, '')) for k in keys}
    for key,value in (controls or {}).items():
        if key.upper() not in keys:
            raise ValueError('oof_prep_control_unknown')
        resume['OOF_MATERIALIZE_' + key.upper()] = ('1' if value else '0') if isinstance(value,bool) else str(value or '0')
    resume.update(OOF_MATERIALIZE_CADENCE=cadence, OOF_MATERIALIZE_END_DATE=day,
                  OOF_MATERIALIZE_MODEL_PROFILE_SCHEMA=profile)
    sha = os.environ.get('STOCKVISION_SOURCE_SHA', '')
    if len(sha) != 40:
        raise ValueError('oof_prep_source_identity_missing')
    ctx = {'run_id': f'oof-prep:{cadence}:{day}:{profile}:{sha}', 'run_date': day,
           'state_gcs_uri': '', 'oof_resume': resume, 'producer_source_sha': sha}
    token = events._CONTEXT.set(ctx)
    try:
        yield
    finally:
        events._CONTEXT.reset(token)


def _validate(stage):
    env = stage.get('oof_resume') or {}
    if (env.get('OOF_MATERIALIZE_CADENCE') not in ('weekly', 'monthly')
            or env.get('OOF_MATERIALIZE_END_DATE') != stage['run_date']
            or stage.get('producer_source_sha') != os.environ.get('STOCKVISION_SOURCE_SHA')
            or stage['kind'] not in ('prep', 'adjusted')
            or any(not key.startswith('OOF_MATERIALIZE_') for key in env)):
        raise ValueError('oof_input_owner_mismatch')
    return env


def _ready(store, path, stage):
    if stage['kind'] == 'prep':
        return events._complete_prep(store, stage, path)
    result = events.read(store, path.replace('request.json', 'result.json'))
    if result:
        if result.get('status') != 'ready' or result.get('request_checksum') != events.digest(events.encoded(stage)):
            raise ValueError('oof_adjusted_prep_failed_or_mismatched')
        output = result['result']
        if output.get('output_gcs_prefix') != stage['spec']['output_gcs_prefix']:
            raise ValueError('oof_adjusted_output_mismatch')
        return True
    claim = (events.read(store, path.replace('request.json', 'work_claim.json'))
             or events.read(store, path.replace('request.json', 'launch.json')))
    if claim and _age(claim) > 2100:
        raise ValueError('oof_adjusted_prep_completion_timeout')
    return False


def _age(value):
    return (datetime.now(timezone.utc) - datetime.fromisoformat(value['created_at'])).total_seconds()


def reconcile_current():
    ctx, store = events.current_context(), events.bucket()
    for blob in store.list_blobs(prefix=events.run_prefix(ctx['run_id'], ctx['run_date'])):
        if not blob.name.endswith('/request.json'):
            continue
        stage = events.load_stage(store, blob.name)
        _validate(stage)
        if stage['kind'] == 'prep':
            events._launch_missing_prep(store, blob.name, stage)
        if not _ready(store, blob.name, stage):
            raise events.InputDeferred(blob.name, stage['kind'])


def adjusted_result(spec):
    # Reuse the exact previous request even if the watchdog has a new ticket.
    ctx, store = events.current_context(), events.bucket()
    for blob in store.list_blobs(prefix=events.run_prefix(ctx['run_id'], ctx['run_date'])):
        if blob.name.endswith('/request.json'):
            old = events.load_stage(store, blob.name)
            if old['kind'] == 'adjusted' and old['spec'] == spec:
                if _ready(store, blob.name, old):
                    return events.read(store, blob.name.replace('request.json', 'result.json'))['result']
                raise events.InputDeferred(blob.name, 'adjusted')
    store, path, stage = events.register('adjusted', spec)
    claim = events._claim_launch(store, path)
    if claim is not None:
        from services.modal_client import _lookup
        try:
            call = _lookup('rebuild_canonical_adjusted_prep_event').spawn({'bucket':store.name, 'stage_path':path})
            events._save_launch(claim, {'status':'running', 'function_call_id':call.object_id,
                                       'created_at':datetime.now(timezone.utc).isoformat()})
        except Exception:
            # Ambiguous launch must never automatically duplicate paid work.
            raise events.InputDeferred(path, 'adjusted')
    raise events.InputDeferred(path, 'adjusted')


def dispatch_ready(path, *, store=None, jobs=None):
    from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError
    store = store or events.bucket()
    stage = events.load_stage(store, path)
    env = _validate(stage)
    if not _ready(store, path, stage):
        return {'status':'waiting', 'stage_path':path}
    jobs = jobs or CloudRunJobsClient(job_name=os.environ.get('OOF_MATERIALIZE_JOB_NAME', 'active8-oof-materialize'))
    receipt_path = path.replace('request.json', 'oof_continuation.json')
    previous = events.read(store, receipt_path)
    if previous:
        if previous['status'] == 'dispatched':
            return {**previous, 'idempotent':True}
        # Watchdog executes the original owner with the completed input. An
        # ambiguous callback dispatch is never retried blindly.
        return {'status':'waiting', 'reason':'oof_input_dispatch_unconfirmed_watchdog_owner'}
    if jobs.get_active_execution() is not None:
        return {'status':'waiting', 'reason':'oof_job_active_watchdog_will_consume'}
    claim = store.blob(receipt_path)
    try:
        claim.upload_from_string(events.encoded({'status':'dispatching', 'created_at':datetime.now(timezone.utc).isoformat()}),
                                 content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        return {'status':'waiting', 'reason':'oof_input_dispatch_claimed'}
    try:
        execution = jobs.run_job(env_overrides={**env, 'OOF_MATERIALIZE_MODE':'oof_lifecycle',
            'OOF_MATERIALIZE_INPUT_STAGE':path}, reject_if_running=True)
    except JobAlreadyRunningError:
        return {'status':'waiting', 'reason':'oof_job_active_watchdog_will_consume'}
    result = {'status':'dispatched', 'execution_name':execution.execution_name, 'execution_id':execution.execution_id}
    events._save_launch(claim, result)
    return result
