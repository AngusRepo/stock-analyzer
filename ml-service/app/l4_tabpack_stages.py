"""Official TabPack stage owners. CPU preparation/finalization never allocate a GPU."""
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
import numpy as np
from google.api_core.exceptions import PreconditionFailed
from services.l4_distribution import digest
from services.l4_tabpack_handoff import PREFIX, read, sealed, launch
from app.l4_tabpack_protocol import RECIPE


def _put(bucket, path, raw, content_type='application/json'):
    blob = bucket.blob(path)
    try:
        blob.upload_from_string(raw, content_type=content_type, if_generation_match=0)
    except PreconditionFailed:
        if blob.download_as_bytes() != raw:
            raise ValueError('tabpack_stage_immutable_conflict')
    if blob.download_as_bytes() != raw:
        raise ValueError('tabpack_stage_readback_failed')


def _seal(bucket, path, value):
    value = {**value, 'checksum':digest(value)}
    _put(bucket, path, json.dumps(value, sort_keys=True).encode())
    return value


def _root(payload):
    return PREFIX + payload['run_key'] + '/'


def read_prepared(payload, bucket):
    value = sealed(bucket, _root(payload) + 'prepared.json')
    if value['payload'] != payload:
        raise ValueError('tabpack_prepared_payload_mismatch')
    return value


def _bytes(bucket, ref, prefix):
    if not ref['path'].startswith(prefix) or '..' in ref['path'].split('/'):
        raise ValueError('tabpack_stage_object_scope_invalid')
    raw = bucket.blob(ref['path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != ref['sha256'] or len(raw) != ref['bytes']:
        raise ValueError('tabpack_stage_object_checksum_invalid')
    return raw


def _object(bucket, root, name, raw):
    ref = {'path':root + name, 'sha256':hashlib.sha256(raw).hexdigest(), 'bytes':len(raw)}
    _put(bucket, ref['path'], raw, 'application/octet-stream')
    return ref


def prepare_stage(payload, bucket):
    from app.l4_tabpack_data import prepare
    if (payload['dataset_path'] != 'l4_distribution/native_datasets/' + payload['rows_checksum'] + '.json'
            or not payload['anchor_path'].startswith('l4_distribution/candidates/')
            or '..' in payload['anchor_path'].split('/')):
        raise ValueError('l4_tabpack_source_reference_invalid')
    rows = json.loads(bucket.blob(payload['dataset_path']).download_as_bytes())
    anchor = json.loads(bucket.blob(payload['anchor_path']).download_as_bytes())
    if digest(rows) != payload['rows_checksum'] or digest(anchor) != payload['anchor_checksum']:
        raise ValueError('l4_tabpack_source_checksum_mismatch')
    arrays, recipe, evidence, _ = prepare(rows, anchor, as_of=payload['as_of'])
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **{name + '_' + suffix:value for name,pair in arrays.items()
                                  for suffix,value in zip(('x','y'),pair, strict=True)})
    ref = _object(bucket, _root(payload), 'prepared.npz', buffer.getvalue())
    return _seal(bucket, _root(payload) + 'prepared.json',
                 {'payload':payload, 'arrays':ref, 'recipe':recipe, 'evidence':evidence})


def gpu_stage(payload, bucket, *, started):
    from app.l4_tabpack_data import write_dataset
    from app.l4_tabpack_job import _train
    prepared = read_prepared(payload, bucket)
    raw = _bytes(bucket, prepared['arrays'], _root(payload))
    with np.load(io.BytesIO(raw), allow_pickle=False) as source:
        arrays = {name:(source[name + '_x'], source[name + '_y']) for name in ('train','val','test')}
    with tempfile.TemporaryDirectory(prefix='tabpack-gpu-') as temp:
        root = Path(temp)
        write_dataset(root / 'data', arrays)
        # Leave an explicit 120s for export-object persistence and handoff.
        remaining = min(3300, int(3600 - (time.monotonic() - started) - 120))
        if remaining <= 0:
            raise TimeoutError('tabpack_gpu_no_fit_budget')
        _train(root / 'data', root / 'output', timeout=remaining)
        names = ('result.json', 'weights.npz', 'experiment/experiments.json',
                 'experiment/online_ensemble_history.json', 'experiment/online_ensemble_predictions.npz')
        refs = {name:_object(bucket, _root(payload) + 'gpu/', name, (root/'output'/name).read_bytes()) for name in names}
    return _seal(bucket, _root(payload) + 'gpu_output.json',
                 {'payload_checksum':digest(payload), 'files':refs})


def read_gpu_output(payload, bucket, destination):
    receipt = sealed(bucket, _root(payload) + 'gpu_output.json')
    expected = {'result.json','weights.npz','experiment/experiments.json',
                'experiment/online_ensemble_history.json','experiment/online_ensemble_predictions.npz'}
    if receipt['payload_checksum'] != digest(payload) or set(receipt['files']) != expected:
        raise ValueError('tabpack_gpu_receipt_identity_invalid')
    for name, ref in receipt['files'].items():
        path = Path(destination) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_bytes(bucket, ref, _root(payload) + 'gpu/'))


def _stage_owner():
    from modal import current_function_call_id, current_input_id
    call, item = current_function_call_id(), current_input_id()
    return {'function_call_id':call, 'input_id':item} if call and item else None


def run_stage(payload, stage, *, bucket=None):
    started = time.monotonic()
    if (stage not in ('prepare','gpu','finalize') or payload.get('expected_source_sha') != os.environ.get('STOCKVISION_SOURCE_SHA')
            or not re.fullmatch('[a-f0-9]{40}', str(payload.get('expected_source_sha','')))
            or not re.fullmatch('[a-f0-9]{64}', str(payload.get('run_key','')))
            or payload.get('training_recipe') != RECIPE):
        raise ValueError('l4_tabpack_runtime_or_recipe_mismatch')
    if bucket is None:
        from google.cloud import storage
        bucket = storage.Client().bucket(os.environ['GCS_BUCKET_NAME'])
    root = _root(payload)
    for name in ('completed.json','failed.json'):
        previous = read(bucket, root + name)
        if previous is not None:
            return previous
    output = {'prepare':'prepared.json', 'gpu':'gpu_output.json', 'finalize':'completed.json'}[stage]
    result = read(bucket, root + output)
    if result is None:
        owner = _stage_owner()
        try:
            bucket.blob(root + stage + '_claim.json').upload_from_string(json.dumps({
                'created_at':datetime.now(timezone.utc).isoformat(), 'payload_checksum':digest(payload),
                'owner':owner}),
                content_type='application/json', if_generation_match=0)
        except PreconditionFailed:
            claim = read(bucket, root + stage + '_claim.json') or {}
            if claim.get('payload_checksum') != digest(payload):
                raise ValueError('tabpack_stage_claim_payload_mismatch')
            if owner is None or claim.get('owner') != owner:
                return {'status':'pending', 'reason':'tabpack_' + stage + '_already_claimed'}
            # Modal preemption restarts the same input after its old container
            # terminates. Only that exact provider owner may resume its claim.
            # Partial GPU exports need explicit reconciliation, never refitting
            # into an immutable object namespace with different weights.
            if stage == 'gpu' and any(bucket.list_blobs(prefix=root + 'gpu/', max_results=1)):
                raise ValueError('tabpack_partial_gpu_exports_require_review')
        try:
            if stage == 'prepare':
                result = prepare_stage(payload, bucket)
            elif stage == 'gpu':
                result = gpu_stage(payload, bucket, started=started)
            else:
                from app.l4_tabpack_job import build_candidate
                result = build_candidate(payload, bucket)
                _put(bucket, root + 'completed.json', json.dumps(result, sort_keys=True).encode())
            _seal(bucket, root + stage + '_metrics.json', {'stage':stage,
                  'elapsed_seconds':time.monotonic()-started, 'run_key':payload['run_key']})
        except Exception as exc:
            _put(bucket, root + 'failed.json', json.dumps({'status':'failed', 'run_key':payload['run_key'],
                'stage':stage, 'error_type':type(exc).__name__, 'promoted':False, 'retry_requires_review':True}, sort_keys=True).encode())
            raise
    if stage != 'finalize':
        if stage == 'prepare':
            read_prepared(payload, bucket)
        elif sealed(bucket, root + output)['payload_checksum'] != digest(payload):
            raise ValueError('tabpack_gpu_handoff_identity_invalid')
        # Result is durable before dispatch. The Controller can safely launch a
        # missing next stage if this CPU/GPU container dies at the handoff.
        return launch(bucket, payload, 'gpu' if stage == 'prepare' else 'finalize')
    return result
