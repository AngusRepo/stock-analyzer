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
GPU_CLAIM_VERSION = 2
# Mirrors the Modal journal: same-token re-sends after an unacknowledged spawn, and executions.
GPU_DISPATCHES = 3
GPU_ATTEMPTS = 3
# Same as the Modal journal's receipt grace and this module's initial dispatch grace.
GPU_DISPATCH_GRACE_SECONDS = 600
GPU_QUEUE_LOG_CRON = 'pipeline-gpu-queue'


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
    recovery, generation = store.read(key + '/dispatch')
    result_generation = current_generation = older_generation = 0
    queue_note = {}
    gpu_claim = None
    if progress and progress.get('gpu'):
        gpu = progress['gpu']
        if not gpu.startswith(root[len(PREFIX):] + '/gpu/'):
            raise ValueError('pipeline_recovery_gpu_identity_mismatch')
        claim, claim_generation = store.read(PREFIX + gpu + '/claim')
        if claim:
            gpu_claim = (claim, claim_generation, PREFIX + gpu)
            current_generation = store.generation(PREFIX + gpu + '/result/' + claim['token'])
            # An older token's result can land after a newer token: it gets one driver per
            # generation (a valid one finishes the stage); otherwise the current token decides.
            older = claim['tokens'][:-1] if claim.get('v') == GPU_CLAIM_VERSION else []
            older_generation = max([store.generation(PREFIX + gpu + '/result/' + t) for t in older] or [0])
            older_unseen = older_generation and (recovery or {}).get('older_result_generation') != older_generation
            result_generation = current_generation or (older_generation if older_unseen else 0)
            if not result_generation:
                waiting = _gpu_wait(store, PREFIX + gpu, claim, clock())
                if waiting.get('reason'):
                    drifted = source_sha != reference.get('expected_source_sha') or not source_sha
                    if drifted and waiting['reason'] == 'gpu_queued':
                        waiting = {**waiting, 'recovery_blocked': True}  # Its log text must say so.
                    return _with_log(store, key, waiting, blocked=False, clock=clock)
                queue_note = waiting
    # Release drift prevents redispatch on this runtime; it does not prove
    # that an already-dispatched immutable request failed. Preserve its callback.
    if source_sha != reference.get('expected_source_sha') or not source_sha:
        if queue_note.get('gpu_queue_exhausted'):
            # No driver can run on this release: keep a late GPU request from running either.
            if _abandon_queued(store, gpu_claim) == 'started':
                return {'reason': 'gpu_lease_active'}
        return _with_log(store, key, {'reason': 'source_changed', 'recovery_blocked': True, **queue_note},
                         blocked=True, clock=clock)
    if clock() - registered['created_at'] < 600:
        return {'reason': 'initial_dispatch_grace'}
    if recovery and recovery['until'] > clock():
        return {'reason': 'recovery_dispatch_grace'}
    # Retry accounting resets only on durable computational progress, never on
    # a duplicate dispatch or a new CPU driver lease.
    marker = digest({'progress': progress, 'gpu_result_generation': result_generation})
    attempt = recovery['attempt'] + 1 if recovery and recovery['marker'] == marker else 1
    if attempt > 3:
        # The run fails now: a queued GPU request that still arrives must not run. If it
        # started meanwhile, its lease decides instead.
        if not current_generation and _abandon_queued(store, gpu_claim) == 'started':
            return {'reason': 'gpu_lease_active'}
        return {'reason': 'attempts_exhausted', 'error': 'pipeline_modal_recovery_attempts_exhausted'}
    if not callback_url or not callback_token:
        raise ValueError('pipeline_recovery_callback_credentials_missing')
    claim = {'until': clock() + 600, 'marker': marker, 'attempt': attempt,
             'older_result_generation': older_generation}
    if not store.cas(key + '/dispatch', claim, generation):
        return {'reason': 'recovery_cas_not_acquired'}
    payload = {**reference, 'callback_url': callback_url, 'callback_token': callback_token}
    try:
        result = spawn(payload)
    except Exception:
        # Accepted-but-unacknowledged dispatch is not a terminal model failure. An older
        # result's one driver did not certainly start: let the next reconcile try again.
        if older_generation:
            sent, sent_generation = store.read(key + '/dispatch')
            if sent == claim:
                store.cas(key + '/dispatch', {**claim, 'older_result_generation': 0}, sent_generation)
        return _with_log(store, key, {'reason': 'recovery_dispatch_uncertain', 'attempt': attempt, **queue_note},
                         blocked=False, clock=clock)
    return _with_log(store, key, {'reason': 'same_request_resumed', 'attempt': attempt,
                                  'function_call_id': result.get('function_call_id'), **queue_note},
                     blocked=False, clock=clock)


def _abandon_queued(store, gpu_claim):
    """Mark a still-queued v2 GPU claim abandoned. Returns 'started' when a container won."""
    if not gpu_claim:
        return None
    claim, generation, gpu_key = gpu_claim
    if claim.get('v') != GPU_CLAIM_VERSION or 'started' in claim or claim.get('abandoned'):
        return None
    if store.cas(gpu_key + '/claim', {**claim, 'abandoned': True}, generation):
        return 'abandoned'
    current, _ = store.read(gpu_key + '/claim')
    if current and current.get('token') == claim['token'] and 'started' in current:
        return 'started'
    return 'abandoned' if current and current.get('abandoned') else None


def _gpu_wait(store, gpu_key, claim, now):
    """Why the GPU stage needs no driver now, or a note for the driver dispatch that follows."""
    if claim.get('v') != GPU_CLAIM_VERSION:
        # Claims written before the queue/lease split: the lease covered the queue.
        return {'reason': 'gpu_lease_active'} if claim['until'] > now else {}
    if claim.get('abandoned'):
        return {}
    role = claim.get('role', 'formal')
    if 'started' in claim:
        if claim['until'] > now:
            return {'reason': 'gpu_lease_active'}
        if claim['started'] >= claim['queue_deadline'] and claim['attempt'] < GPU_ATTEMPTS:
            # Started only after its deadline and then failed: the driver ends the queue now.
            return {'gpu_queue_exhausted': True, 'gpu_role': role,
                    'gpu_queued_s': round(claim['queued_before'] + claim['started'] - claim['queued_at'], 3)}
        return {}
    queued_s = round(claim['queued_before'] + now - claim['queued_at'], 3)
    if now >= claim['queue_deadline']:
        # The driver abandons the request: a formal stage fails the run, a shadow one is skipped.
        return {'gpu_queue_exhausted': True, 'gpu_role': role, 'gpu_queued_s': queued_s}
    if (store.generation(gpu_key + '/dispatch/' + claim['token'])
            or claim.get('dispatches', 1) >= GPU_DISPATCHES):
        # With no receipt after every re-send, the driver would only wait too: let the
        # queue limit, not recovery attempts, end it.
        # Queued in Modal: a redispatch would only queue again. Not a recovery attempt.
        return {'reason': 'gpu_queued', 'gpu_role': role, 'gpu_queued_s': queued_s,
                'gpu_queue_remaining_s': round(claim['queue_deadline'] - now, 3)}
    if now - claim.get('dispatched_at', claim['queued_at']) < GPU_DISPATCH_GRACE_SECONDS:
        return {'reason': 'gpu_dispatch_grace'}
    return {}


# reason -> (level, written once per run?)
GPU_LOGS = {
    'gpu_queued': ('warn', False),
    'gpu_queue_exhausted': ('error', False),
    'gpu_shadow_queued': ('warn', True),
    'gpu_shadow_queue_skipped': ('warn', True),
    'gpu_queue_limit_blocked': ('error', True),
}


def _with_log(store, key, out, *, blocked, clock):
    """Name the ops line this reconcile writes, if any. Once-per-run lines claim a marker."""
    role = out.get('gpu_role')
    if out.get('reason') == 'gpu_queued':
        reason = 'gpu_shadow_queued' if role == 'shadow' else 'gpu_queued'
    elif out.get('gpu_queue_exhausted'):
        reason = ('gpu_queue_limit_blocked' if blocked
                  else 'gpu_shadow_queue_skipped' if role == 'shadow' else 'gpu_queue_exhausted')
    else:
        return out
    if GPU_LOGS[reason][1] and not _claim_once(store, key + '/ops-log/' + reason, clock):
        return out
    return {**out, 'gpu_log': reason}


def _claim_once(store, marker_key, clock):
    """At most once per run: the marker is taken before the D1 write, so a failed write is
    not retried (the Cloud Logging line still appears). Never fails the reconcile."""
    import uuid
    mine = {'at': clock(), 'nonce': uuid.uuid4().hex}
    try:
        if store.cas(marker_key, mine, 0):
            return True
        current, _ = store.read(marker_key)  # A write that landed despite a reported conflict.
        return current == mine
    except Exception:
        return False


def write_gpu_queue_log(recovery, *, run_date, run_id, ops_execute, logger):
    """Write the ops line recover_request named. A write failure never fails the reconcile."""
    reason = recovery.get('gpu_log')
    if reason not in GPU_LOGS:
        return None
    level = GPU_LOGS[reason][0]
    queued = recovery.get('gpu_queued_s', 0)
    left = recovery.get('gpu_queue_remaining_s', 0)
    message = {
        'gpu_queued': (f"pipeline {run_date} GPU stage queued {queued:.0f}s, {left:.0f}s left before the run fails"
                       if not recovery.get('recovery_blocked') else
                       f"pipeline {run_date} GPU stage queued {queued:.0f}s ({left:.0f}s to its limit) while "
                       "recovery is blocked by a release change; at the limit the run stays open for manual "
                       "handling"),
        'gpu_queue_exhausted': (f"pipeline {run_date} GPU stage queued {queued:.0f}s and reached the queue limit; "
                                "unless the GPU started meanwhile, the driver abandons it and the run fails "
                                "with pipeline_stage_gpu_queue_exhausted"),
        'gpu_shadow_queued': (f"pipeline {run_date} shadow GPU stage (no production effect) is queued; "
                              f"it is skipped for the day unless the GPU starts within {left:.0f}s"),
        'gpu_shadow_queue_skipped': (f"pipeline {run_date} shadow GPU stage queued {queued:.0f}s and reached its "
                                     "limit; unless the GPU started meanwhile, today's shadow is skipped and "
                                     "formal results are unaffected"),
        'gpu_queue_limit_blocked': (f"pipeline {run_date} {recovery.get('gpu_role', 'formal')} GPU stage reached "
                                    "its queue limit, but recovery is blocked because the release changed; no "
                                    "driver runs on this release, so the run stays open until handled manually"),
    }[reason]
    meta = {'run_date': run_date, 'run_id': run_id, 'gpu_log': reason,
            **{k: recovery[k] for k in ('gpu_role', 'gpu_queued_s', 'gpu_queue_remaining_s', 'reason', 'attempt')
               if k in recovery}}
    (logger.error if level == 'error' else logger.warning)('[GPU queue] %s', message)
    try:
        ops_execute("INSERT INTO system_logs (level, cron_name, message, meta, created_at) "
                    "VALUES (?, ?, ?, ?, datetime('now'))",
                    [level, GPU_QUEUE_LOG_CRON, message, json.dumps(meta, sort_keys=True)])
    except Exception as exc:
        logger.warning('[GPU queue] system_log write failed: %s: %s', type(exc).__name__, exc)
    return level


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


def log_gpu_queue(recovery, *, run_date, run_id):
    """Reconcile hook: the ops line for a waiting or exhausted GPU queue, if any."""
    import logging

    def ops_execute(sql, params):
        from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
        return client_proxy_for_domain(D1DataDomain.OPS).execute(sql, params)
    return write_gpu_queue_log(recovery, run_date=run_date, run_id=run_id, ops_execute=ops_execute,
                               logger=logging.getLogger(__name__))
