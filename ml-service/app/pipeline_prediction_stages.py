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
SHADOW_QUEUE_ENV = 'PIPELINE_GPU_SHADOW_QUEUE_MAX_SECONDS'
# Ops timing (Wei 10/30): total time a stage may wait for a GPU worker. A formal stage
# then fails the run; a shadow stage (no production effect) is skipped for the day.
GPU_QUEUE_MAX_SECONDS = 4 * 3600
GPU_SHADOW_QUEUE_MAX_SECONDS = 3600


def queue_max_seconds(shadow=False):
    name, default = (SHADOW_QUEUE_ENV, GPU_SHADOW_QUEUE_MAX_SECONDS) if shadow else (QUEUE_ENV, GPU_QUEUE_MAX_SECONDS)
    raw = os.environ.get(name, '').strip()
    if not raw:
        return default
    # Plain decimal seconds only: no sign, underscore or other Python int spellings.
    value = int(raw) if raw.isascii() and raw.isdigit() else 0
    if value <= 0:
        raise ValueError(('pipeline_gpu_shadow_queue_max_seconds_invalid' if shadow
                          else 'pipeline_gpu_queue_max_seconds_invalid'))
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
        outer, self.unsealable = self.unsealable, False
        try:
            value = compute()  # Suspended propagates; incomplete stages are never sealed.
        finally:
            # Kept on the raise path too, so an enclosing stage that catches it stays unsealed.
            inner = self.unsealable
            self.unsealable = outer or inner
        if inner:
            # A GPU stage without a result is not a recorded outcome; neither is a stage built on it.
            return value
        saved = self.store.put(key, {'value': value})
        self.progress({'cpu': key})
        return saved['value']

    def gpu(self, payload, *, shadow=False):
        """`shadow`: a no-production-effect stage with the shorter queue limit; a new claim only."""
        stage = digest(payload)
        key = self.root + '/gpu/' + stage
        claim, generation = self.store.read(key + '/claim')
        now = self.clock()
        if claim:
            if claim.get('v') != CLAIM_VERSION:
                raise self._unsealed(ValueError('pipeline_stage_gpu_claim_schema_invalid'))
            result, _ = self.store.read(key + '/result/' + claim['token'])
            if result is not None:
                if result['input_checksum'] != stage:
                    raise ValueError('pipeline_stage_gpu_input_mismatch')
                if result.get('error'):
                    late = self._valid_result(key, stage, claim)
                    if late is not None:
                        return late['value']
                    raise RuntimeError('pipeline_stage_gpu_failed:' + result['error'])
                return result['value']
            late = self._valid_result(key, stage, claim)
            if late is not None:
                return late['value']
            if claim.get('abandoned'):
                if claim.get('role') == 'shadow':
                    # Later shadow stages of this run skip at once instead of each queueing an hour.
                    self.store.put(self.root + '/shadow-skipped', {'at': now})
                    return self._skip_shadow(key, stage, claim)
                return self._settle(key, stage, claim, 'pipeline_stage_gpu_queue_exhausted')
            if 'started' not in claim:
                return self._queued(payload, key, stage, claim, generation, now, shadow)
            if claim['until'] > now:
                self.progress({'gpu': key, 'token': claim['token']})
                raise Suspended()
            if claim['attempt'] >= GPU_ATTEMPTS:
                return self._settle(key, stage, claim, 'pipeline_stage_gpu_attempts_exhausted')
        role = claim.get('role', 'formal') if claim else ('shadow' if shadow else 'formal')
        if role == 'shadow' and self.store.read(self.root + '/shadow-skipped')[0] is not None:
            return self._skip_shadow(key, stage, claim or {'tokens': []})
        try:
            limit = queue_max_seconds(role == 'shadow')
        except ValueError as exc:
            raise self._unsealed(exc)
        queued_before = (claim['queued_before'] + claim['started'] - claim['queued_at']) if claim else 0
        if claim and queued_before >= limit:
            # Started after its deadline and then failed: no queue time is left for another request.
            self.store.cas(key + '/claim', {**claim, 'abandoned': True}, generation)
            return self.gpu(payload, shadow=shadow)
        token = uuid.uuid4().hex
        claim = {'v': CLAIM_VERSION, 'token': token, 'tokens': (claim['tokens'] if claim else []) + [token],
                 'role': role,
                 'attempt': claim['attempt'] if claim else 0, 'dispatches': 1, 'queued_at': now,
                 'dispatched_at': now,
                 'queued_before': queued_before, 'queue_deadline': now + limit - queued_before}
        # Source persisted before claim; an interruption is safe to resume.
        self.store.put(key + '/input', {'value': payload, 'input_checksum': stage})
        if not self.store.cas(key + '/claim', claim, generation):
            raise Suspended()
        self.progress({'gpu': key, 'token': token})
        raise Suspended(self._dispatch(stage, token))

    def _queued(self, payload, key, stage, claim, generation, now, shadow):
        # Queued in Modal: keep the same request. A new token would only queue again.
        if now >= claim['queue_deadline']:
            # Re-read either way: a CAS can report a conflict for a write that landed, and a
            # container that started first keeps its lease.
            self.store.cas(key + '/claim', {**claim, 'abandoned': True}, generation)
            current, _ = self.store.read(key + '/claim')
            if current and current['token'] == claim['token'] and current.get('abandoned'):
                self._cancel_queued(key, claim['token'])
            return self.gpu(payload, shadow=shadow)
        self.progress({'gpu': key, 'token': claim['token']})
        receipt, _ = self.store.read(key + '/dispatch/' + claim['token'])
        if (receipt is not None or claim['dispatches'] >= GPU_DISPATCHES
                or now - claim['dispatched_at'] < GPU_RESEND_GRACE_SECONDS):
            raise Suspended()
        # The spawn acknowledgement was lost: resend the same token; execution CAS runs it once.
        if not self.store.cas(key + '/claim', {**claim, 'dispatches': claim['dispatches'] + 1,
                                               'dispatched_at': now}, generation):
            raise Suspended()
        raise Suspended(self._dispatch(stage, claim['token']))

    def _cancel_queued(self, key, token):
        receipt, _ = self.store.read(key + '/dispatch/' + token)
        for function_call_id in (receipt or {}).get('function_call_ids', []):
            if self.cancel is None:
                return
            try:
                self.cancel(function_call_id)
            except Exception as exc:
                # A late container sees the abandoned claim and does not run.
                print(f'[PipelineStages] gpu_cancel_failed {type(exc).__name__}', flush=True)

    def _dispatch(self, stage, token):
        return {'schema_version': GPU_SCHEMA, 'root': self.root,
                'stage': stage, 'token': token, 'reference': self.reference}

    def dispatched(self, dispatch, function_call_id):
        """Receipt that Modal accepted this token; without it the next resume re-sends it.
        Every accepted call is kept so an abandon can cancel all of them."""
        key = self.root + '/gpu/' + dispatch['stage'] + '/dispatch/' + dispatch['token']
        for _ in range(GPU_DISPATCHES + 1):
            receipt, generation = self.store.read(key)
            ids = (receipt or {}).get('function_call_ids', [])
            if function_call_id in ids:
                return  # A write that landed although its CAS reported a conflict.
            if self.store.cas(key, {'function_call_ids': ids + [function_call_id], 'at': self.clock()},
                              generation):
                return
        raise RuntimeError('pipeline_stage_gpu_receipt_conflict')

    def _valid_result(self, key, stage, claim):
        for token in claim['tokens']:
            result, _ = self.store.read(key + '/result/' + token)
            if result is not None and result.get('input_checksum') == stage and not result.get('error'):
                return result
        return None

    def _skip_shadow(self, key, stage, claim):
        print('[PipelineStages] WARNING shadow GPU stage skipped for the day: queue limit reached', flush=True)
        return self._settle(key, stage, claim, 'pipeline_stage_gpu_shadow_queue_exhausted')

    def _unsealed(self, exc):
        self.unsealable = True
        return exc

    def _settle(self, key, stage, claim, reason):
        # Re-check every token before failing: any valid result for this input wins.
        result = self._valid_result(key, stage, claim)
        if result is not None:
            return result['value']
        raise self._unsealed(GpuStageUnavailable(reason))


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
    leased = False
    while 'started' not in claim:
        # The lease starts here, when this container runs, not when it was queued.
        # Losing the CAS means the driver changed the claim (re-send or abandon): re-read.
        now = clock()
        if store.cas(key + '/claim', {**claim, 'started': now, 'until': now + GPU_LEASE_SECONDS,
                                      'attempt': claim['attempt'] + 1}, generation):
            leased = True
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
        if not leased:
            # Another container of this token started and died before executing: this run
            # needs its own lease. If the claim moved on meanwhile, do not run at all.
            now = clock()
            if not store.cas(key + '/claim', {**claim, 'until': now + GPU_LEASE_SECONDS}, generation):
                current, _ = store.read(key + '/claim')
                if not current or current['token'] != token:
                    return {'status': 'superseded'}
                if current.get('abandoned'):
                    return {'status': 'abandoned'}
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
