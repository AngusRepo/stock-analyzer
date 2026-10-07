"""One feature-prep batch with durable completion; no model fitting."""
from __future__ import annotations
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
import time
import urllib.request
from google.api_core.exceptions import PreconditionFailed
from services.pipeline_prep_ownership import MAX_PREP_ATTEMPTS, modal_prep_call_finished


def _validate_result(result, stage_path, index, expected):
    if (not isinstance(result, dict) or result.get('stage_path') != stage_path
            or result.get('batch_index') != index or result.get('request_sha256') != expected['sha256']):
        raise ValueError('input_prep_result_lineage_mismatch')
    return result


def execute_event(payload, *, bucket, prep, token, sleep=time.sleep,
                  input_id=None, function_call_id=None, owner_finished=modal_prep_call_finished):
    stage_path = str(payload.get('stage_path') or '')
    index = payload.get('batch_index')
    if not stage_path.startswith('pipeline-v2/input-events/v1/') or not stage_path.endswith('/request.json') or not isinstance(index, int) or index < 0:
        raise ValueError('input_prep_event_identity_invalid')
    stage = json.loads(bucket.blob(stage_path).download_as_bytes())
    if stage.get('oof_resume') and stage.get('producer_source_sha') != os.environ.get('STOCKVISION_SOURCE_SHA'):
        raise ValueError('oof_prep_producer_source_mismatch')
    expected = stage['spec']['batches'][index]
    if stage['kind'] != 'prep' or expected != payload.get('request') or stage['callback_url'] != payload.get('callback_url'):
        raise ValueError('input_prep_event_request_mismatch')
    raw = bucket.blob(expected['path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != expected['sha256']:
        raise ValueError('input_prep_batch_checksum_mismatch')
    request = json.loads(gzip.decompress(raw))
    if request.get('batch_index') != index or request.get('retain_unlabeled_features') is not True or request.get('gcs_prefix') != stage['spec']['receipt_template']['output_gcs_prefix']:
        raise ValueError('input_prep_batch_scope_mismatch')
    result_path = stage_path.replace('request.json', f'batch-{index}.json')
    claim = bucket.blob(stage_path.replace('request.json', f'batch-{index}-claim.json'))
    result_blob = bucket.blob(result_path)
    if result_blob.exists():
        result = _validate_result(json.loads(result_blob.download_as_bytes()), stage_path, index, expected)
        owned = False
    else:
        value = {'request_sha256': expected['sha256'], 'created_at': datetime.now(timezone.utc).isoformat(),
                 'input_id': input_id, 'function_call_id': function_call_id, 'attempt_count': 1}
        try:
            claim.upload_from_string(json.dumps(value), content_type='application/json', if_generation_match=0)
            owned = True
        except PreconditionFailed:
            claim.reload()
            generation = claim.generation
            previous = json.loads(claim.download_as_bytes())
            if result_blob.exists():
                completed = _validate_result(json.loads(result_blob.download_as_bytes()), stage_path, index, expected)
                return {**completed, 'callback': 'pending_reconciliation'}
            if previous.get('request_sha256') != expected['sha256']:
                raise ValueError('input_prep_claim_lineage_mismatch')
            # Modal restarts a terminated input with the same input/call IDs.
            # Another input may take over only after the recorded owner is terminal.
            same_input = bool(input_id and function_call_id and previous.get('input_id') == input_id
                              and previous.get('function_call_id') == function_call_id)
            if not same_input and not owner_finished(previous.get('function_call_id')):
                return {'status': 'waiting', 'reason': 'batch_claim_owner_unverified_or_active'}
            attempt = int(previous.get('attempt_count') or 1) + 1
            if attempt > MAX_PREP_ATTEMPTS:
                raise ValueError('input_prep_attempts_exhausted')
            value.update(attempt_count=attempt, previous_owner=previous.get('function_call_id'),
                         previous_claim_generation=str(generation))
            try:
                claim.upload_from_string(json.dumps(value), content_type='application/json', if_generation_match=generation)
                owned = True
            except PreconditionFailed:
                return {'status': 'waiting', 'reason': 'batch_claim_changed'}
        owned_generation = claim.generation
    if owned:
        result = {}
        for attempt in range(3):
            try:
                result = prep(request)
                if not isinstance(result, dict):
                    raise ValueError('input_prep_invalid_result')
                if not result.get('error'):
                    break
            except Exception as exc:
                result = {'error': f'{type(exc).__name__}: {exc}'}
            if attempt < 2:
                sleep(2 ** attempt)
        # Fence the durable completion if ownership changed during computation.
        claim.reload()
        if claim.generation != owned_generation:
            raise ValueError('input_prep_claim_lost_before_completion')
        result = {**result, 'stage_path': stage_path, 'batch_index': index,
                  'request_sha256': expected['sha256'], 'function_call_id': function_call_id,
                  'input_id': input_id, 'claim_generation': str(owned_generation)}
        result_blob.upload_from_string(json.dumps(result, sort_keys=True), content_type='application/json', if_generation_match=0)
    if not token:
        return {**result, 'callback': 'missing_token_reconcile_required'}
    request = urllib.request.Request(stage['callback_url'], data=json.dumps({'stage_path': stage_path}).encode(),
        headers={'Content-Type': 'application/json', 'X-Service-Token': token}, method='POST')
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response.read()
            return {**result, 'callback': 'delivered'}
        except Exception:
            if attempt < 2:
                sleep(2 ** attempt)
    return {**result, 'callback': 'pending_reconciliation'}
