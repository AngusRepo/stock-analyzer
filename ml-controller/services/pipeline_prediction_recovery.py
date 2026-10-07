"""Resume the exact Modal request through the existing pipeline watchdog.

Only small receipts are read. No prediction/source artifact is reconstructed here.
Callback credentials come from the current runtime, never the durable registry.
"""
from datetime import date
import hashlib
import json
import os
import time

from google.api_core.exceptions import NotFound, PreconditionFailed

PREFIX = 'pipeline-v2/prediction-stages/v1/'
REGISTRY = 'pipeline-v2/prediction-recovery/v1/'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class ReceiptStore:
    def __init__(self, bucket):
        self.bucket = bucket

    def read(self, key):
        blob = self.bucket.blob(key)
        try:
            blob.reload()
            if int(blob.size) > 65536:
                raise ValueError('pipeline_recovery_receipt_too_large')
            raw = blob.download_as_bytes(if_generation_match=int(blob.generation))
        except NotFound:
            return None, 0
        packet = json.loads(raw)
        if packet.get('checksum') != digest(packet.get('value')):
            raise ValueError('pipeline_recovery_receipt_checksum_mismatch')
        return packet['value'], int(blob.generation)

    def generation(self, key):
        blob = self.bucket.blob(key)
        try:
            blob.reload()
            return int(blob.generation)
        except NotFound:
            return 0

    def cas(self, key, value, generation):
        blob = self.bucket.blob(key)
        raw = json.dumps({'checksum': digest(value), 'value': value},
                        sort_keys=True, ensure_ascii=False, allow_nan=False)
        try:
            blob.upload_from_string(raw, content_type='application/json', if_generation_match=generation)
            return True
        except PreconditionFailed:
            return False


def runtime_store():
    from google.cloud import storage
    bucket = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not bucket:
        raise ValueError('pipeline_recovery_bucket_missing')
    return ReceiptStore(storage.Client().bucket(bucket))


def registry_key(run_date, run_id):
    if date.fromisoformat(run_date).isoformat() != run_date or not run_id:
        raise ValueError('pipeline_recovery_identity_invalid')
    return REGISTRY + digest({'run_date': run_date, 'run_id': run_id})


def register_request(reference, *, store=None, clock=time.time):
    store = store or runtime_store()
    identity = {k: v for k, v in reference.items() if k not in {'callback_url', 'callback_token'}}
    if identity.get('schema_version') != 'pipeline-modal-prediction-request-ref-v1':
        raise ValueError('pipeline_recovery_reference_schema_invalid')
    key = registry_key(identity['run_date'], identity['run_id'])
    value = {'reference': identity, 'created_at': clock()}
    if not store.cas(key, value, 0):
        old, _ = store.read(key)
        if not old or old.get('reference') != identity:
            raise ValueError('pipeline_recovery_reference_conflict')
    return key


def recover_request(*, run_date, run_id, callback_url, callback_token, source_sha,
                    spawn, store=None, clock=time.time):
    store = store or runtime_store()
    key = registry_key(run_date, run_id)
    registered, _ = store.read(key)
    if registered is None:
        return {'reason': 'no_registered_modal_request'}
    reference = registered['reference']
    if (reference.get('run_date') != run_date or reference.get('run_id') != run_id
            or reference.get('schema_version') != 'pipeline-modal-prediction-request-ref-v1'):
        raise ValueError('pipeline_recovery_reference_identity_mismatch')
    root = PREFIX + digest(reference)
    terminal, _ = store.read(root + '/terminal')
    if terminal:
        return {'reason': terminal['status']}
    driver, _ = store.read(root + '/driver')
    if driver and driver['until'] > clock():
        return {'reason': 'cpu_lease_active'}
    progress, _ = store.read(root + '/progress')
    result_generation = 0
    if progress and progress.get('gpu'):
        gpu = progress['gpu']
        if not gpu.startswith(root[len(PREFIX):] + '/gpu/'):
            raise ValueError('pipeline_recovery_gpu_identity_mismatch')
        claim, _ = store.read(PREFIX + gpu + '/claim')
        if claim:
            result_generation = store.generation(PREFIX + gpu + '/result/' + claim['token'])
            if not result_generation and claim['until'] > clock():
                return {'reason': 'gpu_lease_active'}
    # Release drift prevents redispatch on this runtime; it does not prove
    # that an already-dispatched immutable request failed. Preserve its callback.
    if source_sha != reference.get('expected_source_sha') or not source_sha:
        return {'reason': 'source_changed', 'recovery_blocked': True}
    if clock() - registered['created_at'] < 600:
        return {'reason': 'initial_dispatch_grace'}
    recovery, generation = store.read(key + '/dispatch')
    if recovery and recovery['until'] > clock():
        return {'reason': 'recovery_dispatch_grace'}
    # Retry accounting resets only on durable computational progress, never on
    # a duplicate dispatch or a new CPU driver lease.
    marker = digest({'progress': progress, 'gpu_result_generation': result_generation})
    attempt = recovery['attempt'] + 1 if recovery and recovery['marker'] == marker else 1
    if attempt > 3:
        return {'reason': 'attempts_exhausted', 'error': 'pipeline_modal_recovery_attempts_exhausted'}
    if not callback_url or not callback_token:
        raise ValueError('pipeline_recovery_callback_credentials_missing')
    claim = {'until': clock() + 600, 'marker': marker, 'attempt': attempt}
    if not store.cas(key + '/dispatch', claim, generation):
        return {'reason': 'recovery_cas_not_acquired'}
    payload = {**reference, 'callback_url': callback_url, 'callback_token': callback_token}
    try:
        result = spawn(payload)
    except Exception:
        # Accepted-but-unacknowledged dispatch is not a terminal model failure.
        return {'reason': 'recovery_dispatch_uncertain', 'attempt': attempt}
    return {'reason': 'same_request_resumed', 'attempt': attempt,
            'function_call_id': result.get('function_call_id')}


def reconcile_modal_request(*, run_date, run_id):
    from services.modal_client import spawn_pipeline_prediction_bundle
    base = (os.environ.get('ML_CONTROLLER_PUBLIC_URL') or os.environ.get('ML_CONTROLLER_URL') or '').rstrip('/')
    token = next((os.environ.get(k, '').strip() for k in (
        'ML_CONTROLLER_SECRET', 'ML_CONTROLLER_TOKEN', 'INTERNAL_TOKEN', 'STOCKVISION_AUTH_TOKEN')
        if os.environ.get(k, '').strip()), '')
    return recover_request(run_date=run_date, run_id=run_id,
        callback_url=base + '/pipeline/v2/modal-prediction/callback' if base else '',
        callback_token=token, source_sha=os.environ.get('STOCKVISION_SOURCE_SHA', ''),
        spawn=spawn_pipeline_prediction_bundle)
