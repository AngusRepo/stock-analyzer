"""Monthly training completeness is distinct from daily OOF freshness."""
import hashlib
import json
import re
from services.l4_distribution import digest, validate_bundle

SCHEMA = 'l4-monthly-training-closure-v1'
PREFIX = 'l4_distribution/monthly_closures/'


def completed_candidate(bucket, run_key, *, identity, manifest_checksum, as_of):
    """Explicit completed-run reuse cannot launch work or change training provenance."""
    from services.l4_tabpack_dispatch import dispatch
    if not re.fullmatch(r'[a-f0-9]{64}', run_key):
        raise ValueError('monthly_completed_run_key_invalid')
    if not bucket.blob('l4_distribution/tabpack_runs/' + run_key + '/completed.json').exists():
        raise ValueError('monthly_completed_candidate_missing')
    def forbidden():
        raise ValueError('monthly_completed_candidate_cannot_train')
    result = dispatch(bucket, run_key, forbidden)
    candidate = json.loads(bucket.blob(result['artifact_path']).download_as_bytes())
    if (candidate.get('cadence') != 'monthly'
            or candidate.get('challenger_training_source', {}).get('as_of') != as_of
            or candidate.get('training_source', {}).get('source_manifest_checksum') != manifest_checksum):
        raise ValueError('monthly_candidate_source_mismatch')
    validate_bundle(candidate, l3_identity=identity, signal_date=as_of, require_paper_release=False)
    return result


def build(result, manifest, bucket, client):
    from services.l4_oof_index_receipt import reuse_index
    from scripts.l4_distribution_refresh_job import load_target_parent
    calendar = result.get('calendar') or {}
    fit = result.get('full_fit_dispatch') or {}
    models = manifest['model_set']
    windows = manifest['windows']
    as_of = result.get('knowledge_cutoff_date')
    if (result.get('cadence') != 'monthly' or result.get('status') != 'materialized'
            or result.get('promoted') is not False or result.get('dependency_retry_required')
            or calendar.get('cutoff') != as_of or len(set(models)) != 8 or not windows
            or len({w['window_id'] for w in windows}) != len(windows)):
        raise ValueError('monthly_training_scope_incomplete')
    for window in windows:
        metrics = window.get('model_metrics') or {}
        if (window.get('oof_fold_ready') is not True or window.get('missing_oof_models') != []
                or window.get('fold_blockers') != [] or set(metrics) != set(models)
                or any(v.get('status') != 'ready' or not v.get('oof_artifact')
                       or not v.get('artifact_checksum') for v in metrics.values())):
            raise ValueError('monthly_oof_window_incomplete')
    index = reuse_index(manifest, bucket, client)
    width = manifest['test_window_days']
    tail = calendar.get('deferred_oof_dates')
    mature_max = calendar.get('mature_max_date')
    if (not index or index.get('max_date') != manifest['end_date']
            or index.get('fold_artifact_rows') != len(windows) * len(models)
            or index.get('prediction_dates') != len(windows) * width
            or not isinstance(tail, list) or tail != sorted(set(tail))
            or len(tail) >= width or not mature_max
            or any(not manifest['end_date'] < d <= mature_max for d in tail)
            or (tail[-1] if tail else manifest['end_date']) != mature_max
            or not calendar.get('prep_manifest_checksum')):
        raise ValueError('monthly_oof_coverage_incomplete')
    if (fit.get('status') != 'completed' or fit.get('retry_required') is not False
            or fit.get('cohort_id') != manifest['cohort_id'] or fit.get('knowledge_cutoff_date') != as_of
            or set(fit.get('release_models') or []) != set(models)
            or any(fit.get(k) != [] for k in ('missing_models','offline_failed_models','training_failed_models'))):
        raise ValueError('monthly_full_fit_incomplete')
    raw = bucket.blob(fit['terminal_payload_path']).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != fit['terminal_payload_checksum']:
        raise ValueError('monthly_full_fit_terminal_checksum_mismatch')
    terminal = json.loads(raw)
    completion = terminal.get('stages', {}).get('release_model_completion', {})
    if (completion.get('status') != 'complete' or completion.get('models_completed') != 8
            or completion.get('models_required') != 8 or set(completion.get('receipts') or {}) != set(models)
            or terminal.get('gcs_prefix') != calendar.get('prep_gcs_prefix')):
        raise ValueError('monthly_full_fit_terminal_incomplete')
    for model in completion['receipts'].values():
        if not model.get('checksum') or not bucket.blob(model['artifact_path']).exists():
            raise ValueError('monthly_full_fit_artifact_missing')
    parent_id = fit['release_registry']['ensemble_candidate']['artifact_id']
    _, identity = load_target_parent(parent_id, client)
    if identity['cohort_id'] != manifest['cohort_id']:
        raise ValueError('monthly_parent_cohort_mismatch')
    refresh = result.get('l4_distribution_refresh') or {}
    candidate = completed_candidate(bucket, refresh.get('run_key', ''), identity=identity,
        manifest_checksum=manifest['manifest_checksum'], as_of=as_of)
    if candidate['artifact_checksum'] != refresh.get('artifact_checksum'):
        raise ValueError('monthly_candidate_checksum_mismatch')
    return {'schema_version':SCHEMA, 'status':'complete', 'completion_scope':'monthly_training_candidate',
        'as_of':as_of, 'cohort_id':manifest['cohort_id'], 'manifest_checksum':manifest['manifest_checksum'],
        'planned_windows':len(windows), 'completed_windows':len(windows), 'oof_model_artifacts':len(windows)*len(models),
        'oof_max_date':manifest['end_date'], 'mature_max_date':mature_max,
        'deferred_oof_dates':tail, 'deferred_oof_reason':'fewer_than_complete_test_window',
        'test_window_sessions':width, 'full_fit_models':len(models),
        'full_fit_terminal_checksum':fit['terminal_payload_checksum'], 'l3_identity':identity,
        'candidate_checksum':candidate['artifact_checksum'], 'candidate_run_key':candidate['run_key'],
        'daily_freshness_credit':False, 'promoted':False, 'promotion_allowed':False}


def seal(result, manifest, bucket, client):
    evidence = build(result, manifest, bucket, client)
    payload = {'evidence':evidence, 'lifecycle':result}
    checksum = digest(payload)
    path = PREFIX + checksum + '.json'
    blob = bucket.blob(path)
    if not blob.exists():
        blob.upload_from_string(json.dumps(payload, sort_keys=True), content_type='application/json', if_generation_match=0)
    if digest(json.loads(blob.download_as_bytes())) != checksum:
        raise ValueError('monthly_closure_readback_mismatch')
    return {**evidence, 'receipt_checksum':checksum}


def verify(checksum, bucket, client):
    from services.active8_oof_cohort_materializer import load_verified_oof_manifest
    if not re.fullmatch(r'[a-f0-9]{64}', checksum):
        raise ValueError('monthly_closure_checksum_invalid')
    payload = json.loads(bucket.blob(PREFIX + checksum + '.json').download_as_bytes())
    if digest(payload) != checksum:
        raise ValueError('monthly_closure_checksum_mismatch')
    manifest, _ = load_verified_oof_manifest('walk_forward/oof_cohorts/' + payload['evidence']['cohort_id'] + '/manifest.json',
        bucket=bucket, require_formal_lineage=True)
    if build(payload['lifecycle'], manifest, bucket, client) != payload['evidence']:
        raise ValueError('monthly_closure_evidence_changed')
    return {**payload['evidence'], 'receipt_checksum':checksum}
