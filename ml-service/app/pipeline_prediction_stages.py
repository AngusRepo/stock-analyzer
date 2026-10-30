"""Durable CPU/GPU handoff for generation-bound pipeline requests.

GCS CAS fences retries. Checkpoints contain model outputs, never callback tokens.
Only the original full immutable request can resume; no new serving authority.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import os
import time
import uuid

SCOPE = ContextVar('pipeline_prediction_stages', default=None)
PREFIX = 'pipeline-v2/prediction-stages/v1/'
REF_SCHEMA = 'pipeline-modal-prediction-request-ref-v1'
GPU_SCHEMA = 'pipeline-gpu-stage-v1'
# Outlives the GPU function's 900s hard timeout; counted from execution start, never queueing.
GPU_LEASE_SECONDS = 1050
GPU_ATTEMPTS = 3
# Same-token re-sends after an uncertain spawn acknowledgement.
GPU_DISPATCHES = 3
# A receipt follows the spawn within seconds; wait this long before treating it as lost.
# Matches the controller's initial dispatch grace.
GPU_RESEND_GRACE_SECONDS = 600
CLAIM_VERSION = 2
QUEUE_ENV = 'PIPELINE_GPU_QUEUE_MAX_SECONDS'
# Ops timing (Wei 10/30): total time a stage may wait for a GPU worker before the run fails.
GPU_QUEUE_MAX_SECONDS = 4 * 3600


def queue_max_seconds():
    raw = os.environ.get(QUEUE_ENV, '').strip()
    if not raw:
        return GPU_QUEUE_MAX_SECONDS
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        raise ValueError('pipeline_gpu_queue_max_seconds_invalid')
    return value


def digest(value):
    # Modal already ships the controller services directory. Reuse its bounded
    # C-backed canonical writer, preserving the existing request/receipt SHA.
    from services.pipeline_json_transport import iter_json_bytes
    hasher = hashlib.sha256()
    for part in iter_json_bytes(value, sort_keys=True, allow_nan=False, default=None):
        hasher.update(part)
    return hasher.hexdigest()


def reference_identity(reference):
    if reference.get('schema_version') != REF_SCHEMA:
        raise ValueError('pipeline_stage_generation_bound_request_required')
    # Authentication is transported only in Modal arguments, never in receipts.
    return {key: value for key, value in reference.items()
            if key not in {'callback_url', 'callback_token'}}


class GpuStageUnavailable(RuntimeError):
    """No GPU result for this stage. Never sealed, so a later valid result still wins."""


class Suspended(BaseException):
    """Control flow, not a failed prediction; bypass diagnostic Exception catches."""
    def __init__(self, dispatch=None):
        self.dispatch = dispatch


class GCSStore:
    def __init__(self, bucket):
        self.bucket = bucket

    def read(self, key):
        from google.api_core.exceptions import NotFound
        blob = self.bucket.blob(PREFIX + key)
        try:
            blob.reload()
            raw = blob.download_as_bytes(if_generation_match=int(blob.generation))
        except NotFound:
            return None, 0
        packet = json.loads(raw)
        if packet.get('checksum') != digest(packet.get('value')):
            raise ValueError('pipeline_stage_receipt_checksum_mismatch')
        return packet['value'], int(blob.generation)

    def cas(self, key, value, generation):
        from google.api_core.exceptions import PreconditionFailed
        blob = self.bucket.blob(PREFIX + key)
        raw = json.dumps({'checksum': digest(value), 'value': value},
                         sort_keys=True, ensure_ascii=False, allow_nan=False).encode('utf-8')
        try:
            blob.upload_from_string(raw, content_type='application/json', if_generation_match=generation)
            return True
        except PreconditionFailed:
            return False

    def put(self, key, value):
        if self.cas(key, value, 0):
            return value
        saved, _ = self.read(key)
        if saved is None:
            raise RuntimeError('pipeline_stage_publication_missing')
        return saved


class Journal:
    def __init__(self, store, reference, *, clock=time.time, cancel=None):
        self.store, self.reference, self.clock, self.cancel = store, reference, clock, cancel
        self.unsealable = False
        self.identity = reference_identity(reference)
        self.root = digest(self.identity)
        self.started = store.put(self.root + '/started', {'at': clock()})['at']

    def elapsed(self):
        return max(0, self.clock() - self.started)

    @contextmanager
    def driver(self):
        # Lease extends beyond the existing 3600s Modal hard timeout. A killed
        # driver can be recovered with the same immutable reference after this grace.
        key = self.root + '/driver'
        old, generation = self.store.read(key)
        if old and old['until'] > self.clock():
            raise Suspended()
        token = uuid.uuid4().hex
        claim = {'token': token, 'until': self.clock() + 3660}
        if not self.store.cas(key, claim, generation):
            raise Suspended()
        scope_token = SCOPE.set(self)
        try:
            yield
        finally:
            SCOPE.reset(scope_token)
            current, version = self.store.read(key)
            if current and current['token'] == token:
                self.store.cas(key, {**current, 'until': 0}, version)

    def progress(self, value):
        key = self.root + '/progress'
        old, generation = self.store.read(key)
        if old != value and not self.store.cas(key, value, generation):
            raise RuntimeError('pipeline_stage_progress_conflict')

    def cpu(self, namespace, name, compute):
        key = self.root + '/cpu/' + namespace + '/' + name
        saved, _ = self.store.read(key)
        if saved is not None:
            return saved['value']
        self.unsealable = False
        value = compute()  # Suspended propagates; incomplete stages are never sealed.
        if self.unsealable:
            # A GPU stage without a result fails this run but is not a recorded outcome.
            self.unsealable = False
            return value
        saved = self.store.put(key, {'value': value})
        self.progress({'cpu': key})
        return saved['value']

    def gpu(self, payload):
        stage = digest(payload)
        key = self.root + '/gpu/' + stage
        claim, generation = self.store.read(key + '/claim')
        now = self.clock()
        if claim:
            result, _ = self.store.read(key + '/result/' + claim['token'])
            if result is not None:
                if result['input_checksum'] != stage:
                    raise ValueError('pipeline_stage_gpu_input_mismatch')
                if result.get('error'):
                    raise RuntimeError('pipeline_stage_gpu_failed:' + result['error'])
                return result['value']
            if claim.get('v') != CLAIM_VERSION:
                raise ValueError('pipeline_stage_gpu_claim_schema_invalid')
            if claim.get('abandoned'):
                return self._settle(key, stage, claim, 'pipeline_stage_gpu_queue_exhausted')
            if 'started' in claim:
                if claim['until'] > now:
                    self.progress({'gpu': key, 'token': claim['token']})
                    raise Suspended()
                if claim['attempt'] >= GPU_ATTEMPTS:
                    return self._settle(key, stage, claim, 'pipeline_stage_gpu_attempts_exhausted')
                late = self._valid_result(key, stage, claim)
                if late is not None:
                    return late['value']
            else:
                return self._queued(payload, key, stage, claim, generation, now)
        queued_before = (claim['queued_before'] + claim['started'] - claim['queued_at']) if claim else 0
        token = uuid.uuid4().hex
        claim = {'v': CLAIM_VERSION, 'token': token, 'tokens': (claim['tokens'] if claim else []) + [token],
                 'attempt': claim['attempt'] if claim else 0, 'dispatches': 1, 'queued_at': now,
                 'queued_before': queued_before,
                 'queue_deadline': now + queue_max_seconds() - queued_before}
        # Source persisted before claim; an interruption is safe to resume.
        self.store.put(key + '/input', {'value': payload, 'input_checksum': stage})
        if not self.store.cas(key + '/claim', claim, generation):
            raise Suspended()
        self.progress({'gpu': key, 'token': token})
        raise Suspended(self._dispatch(stage, token))

    def _queued(self, payload, key, stage, claim, generation, now):
        # Queued in Modal: keep the same request. A new token would only queue again.
        if now >= claim['queue_deadline']:
            if not self.store.cas(key + '/claim', {**claim, 'abandoned': True}, generation):
                return self.gpu(payload)  # The container started first; its lease now applies.
            receipt, _ = self.store.read(key + '/dispatch/' + claim['token'])
            if receipt and self.cancel is not None:
                try:
                    self.cancel(receipt['function_call_id'])
                except Exception as exc:
                    # A late container sees the abandoned claim and does not run.
                    print(f'[PipelineStages] gpu_cancel_failed {type(exc).__name__}', flush=True)
            return self._settle(key, stage, claim, 'pipeline_stage_gpu_queue_exhausted')
        self.progress({'gpu': key, 'token': claim['token']})
        receipt, _ = self.store.read(key + '/dispatch/' + claim['token'])
        if (receipt is not None or claim['dispatches'] >= GPU_DISPATCHES
                or now - claim['queued_at'] < GPU_RESEND_GRACE_SECONDS):
            raise Suspended()
        # The spawn acknowledgement was lost: resend the same token; execution CAS runs it once.
        if not self.store.cas(key + '/claim', {**claim, 'dispatches': claim['dispatches'] + 1}, generation):
            raise Suspended()
        raise Suspended(self._dispatch(stage, claim['token']))

    def _dispatch(self, stage, token):
        return {'schema_version': GPU_SCHEMA, 'root': self.root,
                'stage': stage, 'token': token, 'reference': self.reference}

    def dispatched(self, dispatch, function_call_id):
        """Receipt that Modal accepted this token; without it the next resume re-sends it."""
        self.store.put(self.root + '/gpu/' + dispatch['stage'] + '/dispatch/' + dispatch['token'],
                       {'function_call_id': function_call_id, 'at': self.clock()})

    def _valid_result(self, key, stage, claim):
        for token in claim['tokens']:
            result, _ = self.store.read(key + '/result/' + token)
            if result is not None and result.get('input_checksum') == stage and not result.get('error'):
                return result
        return None

    def _settle(self, key, stage, claim, reason):
        # Re-check every token before failing: any valid result for this input wins.
        result = self._valid_result(key, stage, claim)
        if result is not None:
            return result['value']
        self.unsealable = True
        raise GpuStageUnavailable(reason)


def namespace(payload):
    # Hash all economic inputs and versions, not just the symbol list/model name.
    return digest({key: value for key, value in payload.items()
                   if key not in {'callback_url', 'callback_token', 'request_transport'}})


def run_gpu_stage(store, envelope, *, predict, resume, clock=time.time):
    reference = envelope['reference']
    root, stage, token = envelope['root'], envelope['stage'], envelope['token']
    if root != digest(reference_identity(reference)):
        raise ValueError('pipeline_stage_root_mismatch')
    if any(len(value) != length or any(c not in '0123456789abcdef' for c in value)
           for value, length in ((root, 64), (stage, 64), (token, 32))):
        raise ValueError('pipeline_stage_identity_invalid')
    key = root + '/gpu/' + stage
    claim, generation = store.read(key + '/claim')
    if not claim or claim['token'] != token:
        return {'status': 'superseded'}
    terminal, _ = store.read(root + '/terminal')
    if terminal is not None:
        return {'status': 'terminal'}
    if claim.get('abandoned'):
        return {'status': 'abandoned'}
    while 'started' not in claim:
        # The lease starts here, when this container runs, not when it was queued.
        # Losing the CAS means the driver changed the claim (re-send or abandon): re-read.
        now = clock()
        if store.cas(key + '/claim', {**claim, 'started': now, 'until': now + GPU_LEASE_SECONDS,
                                      'attempt': claim['attempt'] + 1}, generation):
            break
        claim, generation = store.read(key + '/claim')
        if not claim or claim['token'] != token:
            return {'status': 'superseded'}
        if claim.get('abandoned'):
            return {'status': 'abandoned'}
    result_key = key + '/result/' + token
    result, _ = store.read(result_key)
    if result is None:
        # A duplicate .spawn acknowledgement must not run the GPU twice.
        # Its lease expires beyond the function's 900s hard timeout; a new
        # parent attempt uses a new token and does not consume a stale result.
        execution_key = key + '/execution/' + token
        if not store.cas(execution_key, {'started': clock()}, 0):
            return {'status': 'already_running'}
        try:
            packet, _ = store.read(key + '/input')
            if not packet or packet.get('input_checksum') != stage or digest(packet['value']) != stage:
                raise ValueError('pipeline_stage_input_checksum_mismatch')
            result = {'input_checksum': stage, 'value': predict(packet['value'])}
        except Exception as exc:
            # Persist the terminal type only; exception strings may contain secrets.
            result = {'input_checksum': stage, 'error': type(exc).__name__}
        result = store.put(result_key, result)
    # Duplicate completion can redeliver a lost continuation. CPU driver CAS and
    # stage checkpoints make it idempotent; final callback retains original owner.
    resume(reference)
    return {'status': 'resumed', 'stage': stage, 'failed': bool(result.get('error'))}
