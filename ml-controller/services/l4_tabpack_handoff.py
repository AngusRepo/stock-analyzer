"""Atomic CPU -> GPU -> CPU dispatch. Never repeat a possibly launched fit."""
from datetime import datetime, timezone
import json
from google.api_core.exceptions import PreconditionFailed
from services.l4_distribution import digest

PREFIX = 'l4_distribution/tabpack_runs/'
FUNCTIONS = {'gpu':'fit_l4_tabpack_gpu', 'finalize':'finalize_l4_tabpack_candidate'}


def read(bucket, key):
    blob = bucket.blob(key)
    return json.loads(blob.download_as_bytes()) if blob.exists() else None


def sealed(bucket, key):
    value = read(bucket, key)
    if value is None or value.get('checksum') != digest({k:v for k,v in value.items() if k != 'checksum'}):
        raise ValueError('tabpack_stage_receipt_invalid')
    return value


def launch(bucket, payload, stage):
    key = PREFIX + payload['run_key'] + '/' + stage + '_dispatch.json'
    blob = bucket.blob(key)
    try:
        blob.upload_from_string(json.dumps({'created_at':datetime.now(timezone.utc).isoformat(),
            'payload_checksum':digest(payload), 'stage':stage}), content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        return {'status':'pending', 'reason':'tabpack_' + stage + '_already_dispatched'}
    from services.modal_client import _lookup
    call = _lookup(FUNCTIONS[stage]).spawn(payload)
    bucket.blob(key.replace('_dispatch.json','_dispatch_ack.json')).upload_from_string(
        json.dumps({'function_call_id':call.object_id}), content_type='application/json', if_generation_match=0)
    return {'status':'pending', 'reason':'tabpack_' + stage + '_dispatched'}


def resume_stages(bucket, key):
    prefix = PREFIX + key + '/'
    prepared = read(bucket, prefix + 'prepared.json')
    gpu = read(bucket, prefix + 'gpu_output.json')
    stage = 'finalize' if gpu else 'gpu' if prepared else 'prepare'
    claim = read(bucket, prefix + stage + '_claim.json')
    launch_receipt = read(bucket, prefix + stage + '_dispatch.json')
    if claim or launch_receipt:
        observed = claim or launch_receipt
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(observed['created_at'])).total_seconds()
        if age > (2100 if stage == 'finalize' else 3900):
            return {'status':'failed', 'dependency_retry_required':False,
                    'reason':'tabpack_' + stage + '_completion_overdue', 'retry_requires_review':True}
        return {'status':'pending', 'reason':'awaiting_tabpack_' + stage}
    if prepared:
        receipt = sealed(bucket, prefix + 'prepared.json')
        if receipt['payload']['run_key'] != key:
            raise ValueError('tabpack_handoff_identity_invalid')
        if gpu:
            verified_gpu = sealed(bucket, prefix + 'gpu_output.json')
            if verified_gpu['payload_checksum'] != digest(receipt['payload']):
                raise ValueError('tabpack_gpu_handoff_identity_invalid')
        return launch(bucket, receipt['payload'], stage)
    return None
