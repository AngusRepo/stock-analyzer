"""CPU-only canonical adjustment, with a durable result before notification."""
from datetime import datetime, timezone
import json
import os
import urllib.request
from google.api_core.exceptions import PreconditionFailed


def run(payload, *, token, bucket=None, rebuild=None):
    from services import pipeline_input_events as events
    if bucket is None:
        from google.cloud import storage
        bucket = storage.Client().bucket(payload['bucket'])
    path = payload['stage_path']
    stage = events.load_stage(bucket, path)
    if stage['kind'] != 'adjusted' or not stage.get('oof_resume') or stage.get('producer_source_sha') != os.environ.get('STOCKVISION_SOURCE_SHA'):
        raise ValueError('oof_adjusted_stage_identity_invalid')
    result_path = path.replace('request.json', 'result.json')
    result = events.read(bucket, result_path)
    if result is None:
        try:
            bucket.blob(path.replace('request.json','work_claim.json')).upload_from_string(
                json.dumps({'created_at':datetime.now(timezone.utc).isoformat()}),
                content_type='application/json', if_generation_match=0)
        except PreconditionFailed:
            return {'status':'pending', 'reason':'adjustment_already_claimed'}
        try:
            if rebuild is None:
                from app.canonical_adjusted_prep import rebuild_canonical_adjusted_prep as rebuild
            output = rebuild(stage['spec'])
            if output.get('error') or output.get('status') not in ('ready', 'idempotent_ready'):
                raise ValueError('oof_adjusted_result_not_ready')
            result = {'status':'ready', 'result':output, 'request_checksum':events.digest(events.encoded(stage))}
        except Exception as exc:
            result = {'status':'failed', 'error_type':type(exc).__name__,
                      'request_checksum':events.digest(events.encoded(stage))}
        events.put_once(bucket, result_path, result)
    if token:
        request = urllib.request.Request(stage['callback_url'], data=json.dumps({'stage_path':path}).encode(),
            headers={'Content-Type':'application/json','X-Service-Token':token}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response.read()
        except Exception:
            return {**result, 'callback':'watchdog_reconciliation_required'}
    return result
