"""One claim per complete three-seed E0 candidate, never auto-promotes."""
from datetime import datetime, timezone
import json
from services.l4_distribution import digest, validate_bundle
from services.l4_mlp_median import SCHEMA

RECIPE = 'three-head-oof-full-mlp-median-e0-v1'
PREFIX = 'l4_distribution/mlp_median_runs/'


def completed(bucket, run_key):
    result = json.loads(bucket.blob(PREFIX+run_key+'/completed.json').download_as_bytes())
    candidate = json.loads(bucket.blob(result['artifact_path']).download_as_bytes())
    if (result.get('run_key') != run_key or result.get('model_schema') != SCHEMA
            or result.get('training_recipe') != RECIPE or result.get('status') != 'validated'
            or result.get('promoted') is not False or digest(candidate) != result['artifact_checksum']
            or candidate['model'].get('residual_tabpack') is not None
            or candidate['model'].get('residual_mlp',{}).get('schema_version') != SCHEMA
            or candidate['model']['residual_mlp'].get('residual_multiplier') != 1.0
            or candidate.get('challenger_training_source',{}).get('run_key') != run_key):
        raise ValueError('l4_mlp_completed_receipt_invalid')
    validate_bundle(candidate,l3_identity=candidate['l3_identity'],
        signal_date=candidate['challenger_training_source']['as_of'],require_paper_release=False)
    return result


def dispatch(bucket, run_key, make_payload):
    root = PREFIX+run_key+'/'
    if bucket.blob(root+'completed.json').exists():
        return completed(bucket,run_key)
    if bucket.blob(root+'failed.json').exists():
        return {**json.loads(bucket.blob(root+'failed.json').download_as_bytes()),'dependency_retry_required':False}
    pending = {'status':'pending','run_key':run_key,'promoted':False,
        'dependency_retry_required':True,'training_recipe':RECIPE,'model_schema':SCHEMA}
    claim = bucket.blob(root+'dispatch_claim.json')
    if claim.exists():
        age = (datetime.now(timezone.utc)-datetime.fromisoformat(json.loads(claim.download_as_bytes())['created_at'])).total_seconds()
        return {**pending, **({'status':'failed','dependency_retry_required':False,'retry_requires_review':True,
            'reason':'mlp_completion_overdue'} if age>7500 else {'reason':'awaiting_full_mlp_median'})}
    from google.api_core.exceptions import PreconditionFailed
    try:
        claim.upload_from_string(json.dumps({'created_at':datetime.now(timezone.utc).isoformat(),'run_key':run_key}),
            content_type='application/json',if_generation_match=0)
    except PreconditionFailed:
        return {**pending,'reason':'dispatch_already_claimed'}
    try:
        payload = {**make_payload(),'run_key':run_key,'training_recipe':RECIPE}
    except Exception as exc:
        bucket.blob(root+'failed.json').upload_from_string(json.dumps({'status':'failed','run_key':run_key,
            'promoted':False,'stage':'prepare_anchor','error_type':type(exc).__name__,'retry_requires_review':True}),
            content_type='application/json',if_generation_match=0)
        raise
    from services.modal_client import _lookup
    # Retain claim on an uncertain response; retry must never launch another fit.
    call = _lookup('train_l4_mlp_median_candidate').spawn(payload)
    bucket.blob(root+'dispatch.json').upload_from_string(json.dumps({'function_call_id':call.object_id,
        'payload_checksum':digest(payload),'run_key':run_key}),content_type='application/json',if_generation_match=0)
    return {**pending,'function_call_id':call.object_id,'reason':'full_mlp_median_dispatched'}
