"""Run-bound, immutable slate objects. Keep only references between owners.

One object is decoded at a time. Legacy inline inputs remain readable; no
cache retains decoded objects. The local store is injected only by tests.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import date
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import shutil
import inspect
from functools import wraps, lru_cache

from services.paired_nav_journal import digest
from services.pipeline_json_transport import iter_json_bytes

PREFIX = 'pipeline-v2/slates/v1/'
SCHEMA = 'pipeline-slate-ref-v1'
_local = ContextVar('pipeline_slate_test_store', default=None)
_reads = ContextVar('pipeline_slate_read_files', default=None)
_verified = ContextVar('pipeline_slate_verified_refs', default=None)


@contextmanager
def _read_files():
    if _reads.get() is not None:
        yield
        return
    with tempfile.TemporaryDirectory(prefix='slate-read-cache-') as folder:
        token = _reads.set(Path(folder))
        checked = _verified.set(set())
        try:
            yield
        finally:
            _verified.reset(checked)
            _reads.reset(token)


def artifact_reads(function):
    """Reuse immutable compressed files within one owner; never cache decoded rows."""
    if inspect.iscoroutinefunction(function):
        @wraps(function)
        async def asynchronous(*args, **kwargs):
            with _read_files():
                return await function(*args, **kwargs)
        return asynchronous
    @wraps(function)
    def synchronous(*args, **kwargs):
        with _read_files():
            return function(*args, **kwargs)
    return synchronous


@contextmanager
def local_store(path):
    token = _local.set(Path(path))
    try:
        yield
    finally:
        _local.reset(token)


def scope_for(state):
    packet = state['payload_source_observations']
    if (packet.get('decision_date') != state['run_date']
            or packet.get('source_checksum') != digest({k: v for k, v in packet.items() if k != 'source_checksum'})):
        raise ValueError('pipeline_slate_source_checksum_invalid')
    scope = {'date': state['run_date'],
             'run': state.get('producer_run_id') or state['screener_run_id'],
             'source': packet['source_checksum'],
             'code': os.environ.get('STOCKVISION_SOURCE_SHA', 'local')}
    _validate_scope(scope)
    return scope


def _validate_scope(scope):
    if (not isinstance(scope, dict) or set(scope) != {'date', 'run', 'source', 'code'}
            or date.fromisoformat(scope['date']).isoformat() != scope['date']
            or not all(isinstance(v, str) and v for v in scope.values())
            or not re.fullmatch('[a-f0-9]{64}', scope['source'])):
        raise ValueError('pipeline_slate_scope_invalid')


def is_ref(value):
    return isinstance(value, dict) and value.get('schema_version') == SCHEMA


def _validate_ref(ref, scope=None):
    fields = {'schema_version', 'scope', 'sha256', 'path'}
    if isinstance(ref, dict) and 'logical_sha256' in ref:
        fields.add('logical_sha256')
        if not re.fullmatch('[a-f0-9]{64}', str(ref['logical_sha256'])):
            raise ValueError('pipeline_slate_logical_checksum_invalid')
    if not is_ref(ref) or set(ref) != fields:
        raise ValueError('pipeline_slate_reference_invalid')
    _validate_scope(ref['scope'])
    if (not re.fullmatch('[a-f0-9]{64}', str(ref['sha256']))
            or ref['path'] != PREFIX + digest(ref['scope']) + '/objects/' + ref['sha256'] + '.json.gz'
            or scope is not None and ref['scope'] != scope):
        raise ValueError('pipeline_slate_reference_identity_mismatch')


def _bucket():
    name = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not name:
        raise ValueError('pipeline_slate_bucket_missing')
    return _gcs_bucket(name)


@lru_cache(maxsize=1)
def _gcs_bucket(name):
    from google.cloud import storage
    return storage.Client().bucket(name)


def _download(key, filename):
    cache = _reads.get()
    cached = cache / hashlib.sha256(key.encode()).hexdigest() if cache is not None else None
    if cached is not None and cached.is_file():
        shutil.copyfile(cached, filename)
        return True
    found = _download_uncached(key, filename)
    if found and cached is not None:
        shutil.copyfile(filename, cached)
    return found


def _download_uncached(key, filename):
    local = _local.get()
    if local is not None:
        import shutil
        path = local / hashlib.sha256(key.encode()).hexdigest()
        if not path.is_file():
            return False
        shutil.copyfile(path, filename)
        return True
    from google.api_core.exceptions import NotFound
    blob = _bucket().blob(key)
    try:
        blob.reload()
        blob.download_to_filename(filename, if_generation_match=int(blob.generation), checksum='crc32c')
    except NotFound:
        return False
    return True


def _upload_once(key, filename):
    local = _local.get()
    if local is not None:
        import shutil
        path = local / hashlib.sha256(key.encode()).hexdigest()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open('xb') as out, open(filename, 'rb') as src:
                shutil.copyfileobj(src, out)
        except FileExistsError:
            return False
        return True
    from google.api_core.exceptions import PreconditionFailed
    try:
        _bucket().blob(key).upload_from_filename(filename, if_generation_match=0, checksum='crc32c')
    except PreconditionFailed:
        return False
    return True


def put(value, scope):
    _validate_scope(scope)
    with tempfile.TemporaryDirectory(prefix='pipeline-slate-') as folder:
        path = str(Path(folder) / 'value.gz')
        sha = hashlib.sha256()
        with open(path, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as out:
            for chunk in iter_json_bytes(value, sort_keys=True, allow_nan=False, default=None):
                sha.update(chunk)
                out.write(chunk)
        ref = {'schema_version': SCHEMA, 'scope': dict(scope), 'sha256': sha.hexdigest()}
        ref['path'] = PREFIX + digest(scope) + '/objects/' + ref['sha256'] + '.json.gz'
        _upload_once(ref['path'], path)
    return ref


def _load(value, scope=None, *, materialize=True):
    if not is_ref(value):
        return value
    _validate_ref(value, scope)
    with tempfile.TemporaryDirectory(prefix='pipeline-slate-') as folder:
        path = str(Path(folder) / 'value.gz')
        if not _download(value['path'], path):
            raise ValueError('pipeline_slate_artifact_missing')
        sha = hashlib.sha256()
        with gzip.open(path, 'rb') as stream:
            while chunk := stream.read(1024 * 1024):
                sha.update(chunk)
        if sha.hexdigest() != value['sha256']:
            raise ValueError('pipeline_slate_artifact_checksum_mismatch')
        with gzip.open(path, 'rt', encoding='utf8') as stream:
            decoded = json.load(stream)
        if 'logical_sha256' in value:
            if not isinstance(decoded, dict) or decoded.get('schema_version') != 'pipeline-payload-delta-v1':
                raise ValueError('pipeline_slate_delta_invalid')
            shared = _pool_rows(load(decoded['shared'], value['scope']))
            rows = []
            for item in decoded['rows']:
                # Verification never mutates nested values. Only a consumer
                # needs independent mutable histories for each payload.
                row = deepcopy(shared[item['symbol']]) if materialize else dict(shared[item['symbol']])
                for key in item['removed']:
                    del row[key]
                row.update(item['overrides'])
                rows.append(row)
            if digest(rows) != value['logical_sha256']:
                raise ValueError('pipeline_slate_logical_checksum_mismatch')
            return rows
        return decoded


def load(value, scope=None):
    return _load(value, scope)


def load_owned(value, scope=None):
    """One mutable consumer: decoded refs already own their memory."""
    return load(value, scope) if is_ref(value) else deepcopy(value)


def verify(value, scope=None):
    """Check stored and logical hashes without copying every shared history."""
    _validate_ref(value, scope)
    checked = _verified.get()
    key = digest(value)
    if checked is not None and key in checked:
        return
    _load(value, scope, materialize=False)
    if checked is not None:
        checked.add(key)


def content_digest(value):
    if is_ref(value):
        _validate_ref(value)
        return value.get('logical_sha256', value['sha256'])
    return digest(value)


def keep(value, state):
    scope = state.get('pipeline_slate_scope')
    if scope and state.get('pipeline_shared_payload_ref') and isinstance(value, list):
        return put_payloads(value, scope, state['pipeline_shared_payload_ref'])
    return put(value, scope) if scope else deepcopy(value)


def put_payloads(rows, scope, shared_ref, shared=None):
    """Store membership/overrides; price/history arrays live in one shared object."""
    _validate_ref(shared_ref, scope)
    if shared is None:
        shared = load(shared_ref, scope)
    shared = _pool_rows(shared)
    delta = []
    for row in rows:
        common = shared[row['symbol']]
        delta.append({'symbol': row['symbol'],
            'removed': [k for k in common if k not in row],
            'overrides': {k: v for k, v in row.items() if k not in common or v != common[k]}})
    ref = put({'schema_version': 'pipeline-payload-delta-v1', 'shared': shared_ref, 'rows': delta}, scope)
    return {**ref, 'logical_sha256': digest(rows)}


def shared_payload_pool(rows):
    """One raw row per symbol, and one market history per complete identity."""
    shared, histories, history_keys, known = {}, {}, {}, {}
    for row in rows:
        common = {k: v for k, v in row.items() if k not in {'stock_meta', 'runtime_options'}}
        env = common.get('market_env')
        if isinstance(env, dict) and 'history' in env:
            history = env['history']
            saved = known.get(id(history))
            key = saved[1] if saved is not None else None
            if key is None:
                key = digest(history)
                known[id(history)] = (history, key)
                histories[key] = history
            history_keys[row['symbol']] = key
            common['market_env'] = {k: v for k, v in env.items() if k != 'history'}
        shared[row['symbol']] = common
    return {'schema_version': 'pipeline-shared-payloads-v1', 'rows': shared,
            'histories': histories, 'history_keys': history_keys}


def _pool_rows(pool):
    if not isinstance(pool, dict) or pool.get('schema_version') != 'pipeline-shared-payloads-v1':
        raise ValueError('pipeline_slate_shared_pool_invalid')
    rows = {}
    for symbol, row in pool['rows'].items():
        rows[symbol] = dict(row)
        if symbol in pool['history_keys']:
            rows[symbol]['market_env'] = {**row['market_env'],
                'history': pool['histories'][pool['history_keys'][symbol]]}
    return rows


def load_inputs(reference, scope=None):
    """Hydrate exactly one L3 slate, retaining the original model input contract."""
    if is_ref(reference):
        _validate_ref(reference, scope)
        scope = reference['scope']
    # Inline compatibility needs a copy; an outer artifact is already private.
    value = load_owned(reference, scope)
    return {**value, 'payloads': load(value['payloads'], scope)}


def checkpoint(scope, identity, build, *, store=put):
    """Publish only complete objects; exact-input retries reuse their receipt."""
    _validate_scope(scope)
    key = PREFIX + digest(scope) + '/steps/' + digest(identity) + '.json'
    with tempfile.TemporaryDirectory(prefix='pipeline-step-') as folder:
        path = str(Path(folder) / 'receipt.json')
        if _download(key, path):
            ref = json.loads(Path(path).read_text(encoding='utf8'))
            _validate_ref(ref, scope)
            # Validate a completed artifact before skipping work, without retaining it.
            verify(ref, scope)
            return ref
        ref = store(build(), scope)
        Path(path).write_text(json.dumps(ref, sort_keys=True), encoding='utf8')
        if not _upload_once(key, path):
            _download(key, path)
            if json.loads(Path(path).read_text(encoding='utf8')) != ref:
                raise ValueError('pipeline_slate_checkpoint_conflict')
        return ref


async def checkpoint_async(scope, identity, build, *, cacheable=None):
    """Same exact-input receipt protocol for the async L2 owner."""
    _validate_scope(scope)
    key = PREFIX + digest(scope) + '/steps/' + digest(identity) + '.json'
    with tempfile.TemporaryDirectory(prefix='pipeline-step-') as folder:
        path = str(Path(folder) / 'receipt.json')
        if _download(key, path):
            ref = json.loads(Path(path).read_text(encoding='utf8'))
            _validate_ref(ref, scope)
            verify(ref, scope)
            return ref
        value = await build()
        if cacheable is not None and not cacheable(value):
            return value
        ref = put(value, scope)
        Path(path).write_text(json.dumps(ref, sort_keys=True), encoding='utf8')
        if not _upload_once(key, path):
            _download(key, path)
            if json.loads(Path(path).read_text(encoding='utf8')) != ref:
                raise ValueError('pipeline_slate_checkpoint_conflict')
        return ref
