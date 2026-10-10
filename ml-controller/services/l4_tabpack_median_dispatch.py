"""Sequential three-seed candidate orchestration; completed members are reused."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from google.api_core.exceptions import PreconditionFailed
from services.l4_distribution import digest, validate_bundle, predict
from services.l4_tabpack_budget_protocol import RECIPE as SINGLE_RECIPE, MEDIAN_RECIPE as RECIPE, SEEDS
from services.l4_tabpack_median import SCHEMA, ensemble
from services.l4_tabpack_handoff import read, sealed

PREFIX = 'l4_distribution/tabpack_median16_runs/'


def put(bucket, path, value):
    raw = json.dumps(value, sort_keys=True, allow_nan=False).encode()
    try:
        bucket.blob(path).upload_from_string(raw, content_type='application/json', if_generation_match=0)
    except PreconditionFailed:
        if bucket.blob(path).download_as_bytes() != raw:
            raise ValueError('tabpack_median_immutable_conflict')


def completed(bucket, run_key):
    result = read(bucket, PREFIX + run_key + '/completed.json')
    candidate = read(bucket, result['artifact_path'])
    if (result.get('run_key') != run_key or result.get('training_recipe') != RECIPE
            or result.get('model_schema') != SCHEMA or result.get('promoted') is not False
            or result.get('status') != 'validated' or digest(candidate) != result.get('artifact_checksum')
            or candidate.get('challenger_training_source', {}).get('run_key') != run_key
            or candidate.get('model', {}).get('residual_tabpack', {}).get('schema_version') != SCHEMA):
        raise ValueError('tabpack_median_completed_receipt_invalid')
    validate_bundle(candidate, l3_identity=candidate['l3_identity'],
        signal_date=candidate['challenger_training_source']['as_of'], require_paper_release=False)
    return result


def dispatch(bucket, run_key, make_payload):
    root = PREFIX + run_key + '/'
    if read(bucket, root + 'completed.json') is not None:
        return completed(bucket, run_key)
    failure = read(bucket, root + 'failed.json')
    if failure is not None:
        return {**failure, 'dependency_retry_required':False}
    pending = {'status':'pending', 'run_key':run_key, 'training_recipe':RECIPE,
        'model_schema':SCHEMA, 'promoted':False, 'dependency_retry_required':True}
    if read(bucket, root + 'source.json') is None:
        try:
            bucket.blob(root + 'prepare_claim.json').upload_from_string(json.dumps({
                'created_at':datetime.now(timezone.utc).isoformat()}),
                content_type='application/json', if_generation_match=0)
        except PreconditionFailed:
            return {**pending, 'status':'failed', 'reason':'tabpack_median_preparation_claimed_requires_review',
                'dependency_retry_required':False, 'retry_requires_review':True}
        try:
            source = {'payload':{**make_payload(), 'run_key':run_key, 'training_recipe':RECIPE}}
            source['checksum'] = digest(source)
            put(bucket, root + 'source.json', source)
        except Exception as exc:
            put(bucket, root + 'failed.json', {**pending, 'status':'failed',
                'dependency_retry_required':False, 'retry_requires_review':True,
                'stage':'prepare_anchor', 'error_type':type(exc).__name__})
            raise
    source = sealed(bucket, root + 'source.json')['payload']
    if source['run_key'] != run_key or source['training_recipe'] != RECIPE:
        raise ValueError('tabpack_median_source_identity_invalid')
    from services.l4_tabpack_dispatch import dispatch as dispatch_seed
    candidates = []
    for seed in SEEDS:
        child_key = digest({'parent_run_key':run_key, 'seed':seed, 'recipe':SINGLE_RECIPE})
        child_source = dict(source)
        if seed != SEEDS[0]:
            child_source['shared_prepared_run_key'] = digest({'parent_run_key':run_key, 'seed':SEEDS[0], 'recipe':SINGLE_RECIPE})
        result = dispatch_seed(bucket, child_key, lambda: child_source, recipe=SINGLE_RECIPE, seed=seed)
        if result['status'] != 'validated':
            if result['status'] == 'failed':
                put(bucket, root + 'failed.json', {**pending, 'status':'failed', 'failed_seed':seed,
                    'child_run_key':child_key, 'dependency_retry_required':False, 'retry_requires_review':True})
            return {**result, 'run_key':run_key, 'child_run_key':child_key, 'current_seed':seed,
                'training_recipe':RECIPE, 'model_schema':SCHEMA}
        candidate = read(bucket, result['artifact_path'])
        expected = {**child_source, 'run_key':child_key, 'training_recipe':SINGLE_RECIPE, 'seed':seed}
        if candidate.get('challenger_training_source') != expected:
            raise ValueError('tabpack_median_child_source_mismatch')
        candidates.append(candidate)
    return finalize(bucket, source, candidates)


def finalize(bucket, source, candidates):
    from services.l4_distribution_lifecycle import persist_candidate
    from services.l4_prediction_evaluation import evaluate_predictions
    anchor = read(bucket, source['anchor_path'])
    rows = read(bucket, source['dataset_path'])
    if digest(anchor) != source['anchor_checksum'] or digest(rows) != source['rows_checksum']:
        raise ValueError('tabpack_median_source_checksum_mismatch')
    if any({k:c['model'][k] for k in ('recipe','heads')} != anchor['model']
           or c['l3_identity'] != anchor['l3_identity'] for c in candidates):
        raise ValueError('tabpack_median_anchor_mismatch')
    candidate = deepcopy(anchor)
    candidate.pop('candidate_id', None)
    candidate['model']['residual_tabpack'] = ensemble(anchor['model'], [
        {'seed':seed, 'model':c['model']['residual_tabpack']} for seed,c in zip(SEEDS,candidates,strict=True)])
    candidate['model_checksum'] = digest(candidate['model'])
    candidate['release'] = {'scope':'research', 'decision':'CANDIDATE'}
    candidate['challenger_training_source'] = source
    candidate['export_verification'] = {'method':'three_independent_official_checkpoint_exports',
        'seeds':{str(s):c['export_verification'] for s,c in zip(SEEDS,candidates,strict=True)}}
    validate_bundle(candidate, l3_identity=candidate['l3_identity'], signal_date=source['as_of'], require_paper_release=False)
    dates = set(anchor['evaluation']['dates'])
    held = [r for r in rows if r['date'] in dates]
    if not held:
        raise ValueError('tabpack_median_heldout_missing')
    outputs = predict(held, candidate['model'])
    candidate['evaluation'] = {'method':'untouched_later_dates_three_seed_median_no_refit',
        'dates':anchor['evaluation']['dates'], 'rows':len(held), 'rows_checksum':digest(held),
        'ev_mse':sum((p['expected_return_gross']-r['gross_return'])**2 for r,p in zip(held,outputs,strict=True))/len(held),
        'zero_mse':sum(r['gross_return']**2 for r in held)/len(held),
        'native_l3_comparison':evaluate_predictions(held,outputs,model=candidate['model']),
        'portfolio_superiority':'requires_same_account_execution_comparison'}
    candidate['candidate_id'] = 'l4_distribution:' + digest(candidate)
    result = {**persist_candidate(candidate,bucket=bucket), 'run_key':source['run_key'],
        'training_recipe':RECIPE, 'model_schema':SCHEMA}
    put(bucket, PREFIX+source['run_key']+'/completed.json', result)
    return completed(bucket, source['run_key'])
