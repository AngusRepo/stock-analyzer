"""One durable claim per recipe/parent/data/date; retries observe, never refit."""
from datetime import datetime, timezone
import json

from services.l4_distribution import digest
from services.l4_tabpack_weights import SCHEMA

RECIPE = 'three-head-oof-official-tabpack-v2'


def dispatch(bucket, run_key, make_payload, *, recipe=RECIPE, seed=42):
    from services.l4_tabpack_budget_protocol import validate_run, RECIPE as BUDGET_RECIPE
    validate_run(recipe, seed)
    prefix = 'l4_distribution/tabpack_runs/' + run_key
    completed = bucket.blob(prefix + '/completed.json')
    if completed.exists():
        result = json.loads(completed.download_as_bytes())
        candidate = json.loads(bucket.blob(result['artifact_path']).download_as_bytes())
        if (result.get('run_key') != run_key or result.get('model_schema') != SCHEMA
                or result.get('training_recipe') != recipe or result.get('status') != 'validated'
                or result.get('promoted') is not False or digest(candidate) != result['artifact_checksum']
                or candidate['model'].get('residual_mlp') is not None
                or candidate['model'].get('residual_tabpack', {}).get('schema_version') != SCHEMA
                or candidate.get('challenger_training_source', {}).get('run_key') != run_key):
            raise ValueError('l4_tabpack_completed_receipt_invalid')
        if recipe == BUDGET_RECIPE:
            p = candidate['model']['residual_tabpack'].get('provenance') or {}
            if p.get('seed') != seed or p.get('training_recipe') != recipe or p.get('n_models') != 16:
                raise ValueError('l4_tabpack_completed_recipe_mismatch')
            from services.l4_distribution import validate_bundle
            validate_bundle(candidate, l3_identity=candidate['l3_identity'],
                signal_date=candidate['challenger_training_source']['as_of'], require_paper_release=False)
        return result
    failed = bucket.blob(prefix + '/failed.json')
    if failed.exists():
        return {**json.loads(failed.download_as_bytes()), 'dependency_retry_required': False}
    claim = bucket.blob(prefix + '/dispatch_claim.json')
    pending = {'status': 'pending', 'run_key': run_key, 'promoted': False,
               'dependency_retry_required': True, 'training_recipe': recipe}
    if claim.exists():
        from services.l4_tabpack_handoff import resume_stages
        stage = resume_stages(bucket, run_key)
        if stage is not None:
            return {**pending, **stage}
        # Before prepare has claimed work, only observe the existing launch.
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(json.loads(claim.download_as_bytes())['created_at'])).total_seconds()
        if age > 3900:
            return {**pending, 'status':'failed', 'dependency_retry_required':False,
                    'reason':'tabpack_prepare_dispatch_overdue', 'retry_requires_review':True}
        return {**pending, 'reason':'awaiting_tabpack_prepare'}
    from google.api_core.exceptions import PreconditionFailed
    try:
        claim.upload_from_string(json.dumps({'created_at': datetime.now(timezone.utc).isoformat(), 'run_key': run_key}),
                                 content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        return {**pending, 'reason': 'dispatch_already_claimed'}
    try:
        payload = {**make_payload(), 'run_key': run_key, 'training_recipe': recipe}
        if recipe == BUDGET_RECIPE:
            payload['seed'] = seed
    except Exception as exc:
        # Preparation has not touched Modal: report this failure immediately.
        failure = {'status': 'failed', 'run_key': run_key, 'promoted': False,
                   'stage': 'prepare_anchor', 'error_type': type(exc).__name__, 'retry_requires_review': True}
        failed.upload_from_string(json.dumps(failure), content_type='application/json', if_generation_match=0)
        raise
    try:
        from services.modal_client import _lookup
        call = _lookup('train_l4_tabpack_candidate').spawn(payload)
        bucket.blob(prefix + '/dispatch.json').upload_from_string(json.dumps({'function_call_id': call.object_id,
            'payload_checksum': digest(payload), 'run_key': run_key}), content_type='application/json', if_generation_match=0)
        return {**pending, 'function_call_id': call.object_id, 'reason': 'official_tabpack_dispatched'}
    except Exception:
        # Could have reached Modal. Retain the claim for explicit recovery.
        raise
