"""Durable CPU/GPU handoff for generation-bound pipeline requests.

GCS CAS fences retries. Checkpoints contain model outputs, never callback tokens.
Only the original full immutable request can resume; no new serving authority.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import time
import uuid

SCOPE = ContextVar('pipeline_prediction_stages', default=None)
PREFIX = 'pipeline-v2/prediction-stages/v1/'
REF_SCHEMA = 'pipeline-modal-prediction-request-ref-v1'
GPU_SCHEMA = 'pipeline-gpu-stage-v1'


def digest(value):
    hasher = hashlib.sha256()
    for part in json.JSONEncoder(sort_keys=True, ensure_ascii=False,
            separators=(',', ':'), allow_nan=False).iterencode(value):
        hasher.update(part.encode('utf-8'))
    return hasher.hexdigest()


def reference_identity(reference):
    if reference.get('schema_version') != REF_SCHEMA:
        raise ValueError('pipeline_stage_generation_bound_request_required')
    # Authentication is transported only in Modal arguments, never in receipts.
    return {key: value for key, value in reference.items()
            if key not in {'callback_url', 'callback_token'}}


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
    def __init__(self, store, reference, *, clock=time.time):
        self.store, self.reference, self.clock = store, reference, clock
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
        value = compute()  # Suspended propagates; incomplete stages are never sealed.
        saved = self.store.put(key, {'value': value})
        self.progress({'cpu': key})
        return saved['value']

    def gpu(self, payload):
        stage = digest(payload)
        key = self.root + '/gpu/' + stage
        claim, generation = self.store.read(key + '/claim')
        if claim:
            result, _ = self.store.read(key + '/result/' + claim['token'])
            if result is not None:
                if result['input_checksum'] != stage:
                    raise ValueError('pipeline_stage_gpu_input_mismatch')
                if result.get('error'):
                    raise RuntimeError('pipeline_stage_gpu_failed:' + result['error'])
                return result['value']
            if claim['until'] > self.clock():
                self.progress({'gpu': key, 'token': claim['token']})
                raise Suspended()
            if claim['attempt'] >= 3:
                raise RuntimeError('pipeline_stage_gpu_attempts_exhausted')
        claim = {'token': uuid.uuid4().hex, 'until': self.clock() + 1050,
                 'attempt': (claim['attempt'] if claim else 0) + 1}
        # Source persisted before claim; an interruption is safe to resume.
        self.store.put(key + '/input', {'value': payload, 'input_checksum': stage})
        if not self.store.cas(key + '/claim', claim, generation):
            raise Suspended()
        self.progress({'gpu': key, 'token': claim['token']})
        raise Suspended({'schema_version': GPU_SCHEMA, 'root': self.root,
            'stage': stage, 'token': claim['token'], 'reference': self.reference})


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
    claim, _ = store.read(key + '/claim')
    if not claim or claim['token'] != token:
        return {'status': 'superseded'}
    if claim['until'] <= clock():
        resume(reference)  # Expired while queued: CPU may acquire a fresh bounded attempt.
        return {'status': 'expired_resumed'}
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
