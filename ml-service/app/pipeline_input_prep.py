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


def execute_event(payload, *, bucket, prep, token, sleep=time.sleep):
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
    try:
        claim.upload_from_string(json.dumps({'request_sha256': expected['sha256'], 'created_at': datetime.now(timezone.utc).isoformat()}), content_type='application/json', if_generation_match=0)
        owned = True
    except PreconditionFailed:
        owned = False
    result_blob = bucket.blob(result_path)
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
        result = {**result, 'stage_path': stage_path, 'batch_index': index,
                  'request_sha256': expected['sha256']}
        result_blob.upload_from_string(json.dumps(result, sort_keys=True), content_type='application/json', if_generation_match=0)
    elif not result_blob.exists():
        return {'status': 'running', 'reason': 'batch_claim_exists'}
    else:
        result = json.loads(result_blob.download_as_bytes())
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
