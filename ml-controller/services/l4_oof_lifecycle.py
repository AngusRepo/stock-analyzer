"""Retain native L3 OOF/full-fit cadence without old EV/Fusion materializers."""
import json
from services.l4_distribution import digest


def uses_native_l4(manifest):
    from services.active8_release_model_profiles import TIMEXER_PRICE_PROFILE_SCHEMA, TIMEXER_EXO_PROFILE_SCHEMA
    return manifest.get('model_profile_schema_version') in (TIMEXER_PRICE_PROFILE_SCHEMA, TIMEXER_EXO_PROFILE_SCHEMA)


def persist_base_index(*,manifest,predictions,client,dry_run):
    from services.active8_oof_cohort_materializer import build_oof_fold_artifact_rows
    from services.ev_lineage_contract import build_model_set_signature
    from services.l4_distribution_dataset import NET_LABEL_SCHEMA
    from services.l4_distribution import MODELS as LEGACY_MODELS
    from services.alpha_model_roster import validate_order
    MODELS = validate_order(manifest.get("model_set") or LEGACY_MODELS)
    cohort=manifest['cohort_id']
    folds=build_oof_fold_artifact_rows(manifest,predictions)
    if len(folds)!=len(manifest['windows'])*len(MODELS):
        raise ValueError('l4_native_base_fold_coverage_incomplete')
    dates=sorted({row['prediction_date'] for row in predictions})
    receipt={'scope':'native_l3_base_only','cohort_id':cohort,'source_manifest_checksum':manifest['manifest_checksum'],
        'prediction_rows':len(predictions),'prediction_dates':len(dates),'fold_artifact_rows':len(folds),
        'legacy_ev_rows_written':0,'min_date':dates[0],'max_date':dates[-1]}
    if dry_run:return {'status':'dry_run',**receipt}
    existing=client.query('SELECT status,artifact_manifest_checksum FROM active8_oof_cohorts WHERE cohort_id=?',[cohort])
    if existing and existing[0]['artifact_manifest_checksum']!=manifest['manifest_checksum']:
        raise ValueError('l4_native_base_cohort_collision')
    if not existing:
        signature=build_model_set_signature({name:f'cohort:{cohort}' for name in MODELS},list(MODELS))
        client.execute("""INSERT INTO active8_oof_cohorts(cohort_id,generation_mode,status,target_semantic_version,
            score_semantic_version,model_set_signature,expected_models,expected_folds,artifact_manifest_path,
            artifact_manifest_checksum,prediction_storage_mode) VALUES(?,'purged_oof','building',?,?,?,8,?,?,?,'gcs_indexed_v1')""",
            [cohort,NET_LABEL_SCHEMA,'same-market-same-date-average-tie-percentile-rank-v2',signature,
             len(manifest['windows']),f'walk_forward/oof_cohorts/{cohort}/manifest.json',manifest['manifest_checksum']])
    columns=('cohort_id','fold_id','source_cohort_id','source_manifest_checksum','model_name','artifact_path',
        'artifact_checksum','artifact_rows','prediction_dates','train_start','train_end','test_start','test_end',
        'target_semantic_version','score_semantic_version')
    result=client.batch_execute([('INSERT INTO active8_oof_fold_artifacts('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+') ON CONFLICT(cohort_id,fold_id,model_name) DO NOTHING',
        [r[k] for k in columns]) for r in folds])
    if result.get('error_count'):raise ValueError('l4_native_base_index_write_failed')
    saved=client.query('SELECT * FROM active8_oof_fold_artifacts WHERE cohort_id=?',[cohort])
    expected={(r['fold_id'],r['model_name']):r['artifact_checksum'] for r in folds}
    actual={(r['fold_id'],r['model_name']):r['artifact_checksum'] for r in saved}
    if expected!=actual:raise ValueError('l4_native_base_index_readback_failed')
    client.execute("UPDATE active8_oof_cohorts SET status='ready',completed_folds=expected_folds,prediction_rows=?,prediction_dates=?,ready_at=COALESCE(ready_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE cohort_id=?",
        [len(predictions),len(dates),cohort])
    return {'status':'ready',**receipt}


async def materialize_native_base(*,manifest_path,cohort_id,as_of,cadence,dry_run,dispatch_full_fit,poll_only,bucket,client,calendar=None):
    from services.active8_oof_cohort_materializer import load_verified_oof_manifest,load_oof_prediction_rows
    from routers.walk_forward import dispatch_oof_full_fit_training,_materialize_nav_with_reviews
    manifest,_=load_verified_oof_manifest(manifest_path,bucket=bucket,require_formal_lineage=True)
    if manifest['cohort_id']!=cohort_id:raise ValueError('l4_native_base_manifest_mismatch')
    predictions=load_oof_prediction_rows(manifest,bucket=bucket)
    index=persist_base_index(manifest=manifest,predictions=predictions,client=client,dry_run=dry_run)
    del predictions  # The index is complete; L3/L4 own their subsequent data loads.
    full_fit={'status':'not_requested','retry_required':False}
    if dispatch_full_fit and not dry_run:
        full_fit=await dispatch_oof_full_fit_training(manifest=manifest,knowledge_cutoff_date=as_of,
            bucket=bucket,lifecycle_cadence=cadence,allow_new_dispatch=not poll_only)
    # Existing upstream NAV evidence remains owned by its original evaluator.
    nav=None if dry_run else _materialize_nav_with_reviews(business_date=as_of,learning_client=client)
    refresh=None
    if cadence in ('weekly','monthly') and not dry_run and not full_fit.get('retry_required'):
        from scripts.l4_distribution_refresh_job import execute
        registry=full_fit.get('release_registry') or {}
        target=(registry.get('ensemble_candidate') or {}).get('artifact_id')
        if dispatch_full_fit and not target:
            refresh={'status':'awaiting_l3_candidate','promoted':False,'reason':'full_fit_has_no_usable_ensemble_candidate'}
        else:
            from services.active8_release_model_profiles import TIMEXER_EXO_PROFILE_SCHEMA
            options = {'strategy_role': 'B'} if manifest.get('model_profile_schema_version') == TIMEXER_EXO_PROFILE_SCHEMA else {}
            refresh=execute(as_of=as_of,cadence=cadence,target_l3_artifact_id=target,**options)
    result={'status':'dry_run' if dry_run else 'pending' if full_fit.get('retry_required') else 'materialized',
        'dependency_retry_required':bool(full_fit.get('retry_required')),'calendar':calendar or {},
        'cadence':cadence,'knowledge_cutoff_date':as_of,'materialization_owner':'native_l3_new_l4',
        'cohort_id':cohort_id,'persistence':index,'full_fit_dispatch':full_fit,
        'full_fit_retry_required':bool(full_fit.get('retry_required')),'paired_nav_maturity':nav,
        'l4_distribution_refresh':refresh,'promoted':False,'promotion_allowed':False,
        'promotion_reason':'paired_l3_l4_paper_release_required',
        'physical_prediction_coverage':{'date_count':index['prediction_dates'],'min_date':index['min_date'],
            'max_date':index['max_date'],'base_max_date':index['max_date'],
            'manifest_declared_end_date':manifest.get('end_date'),'declared_end_matches_physical':index['max_date']==manifest.get('end_date')}}
    if not dry_run:
        key='l4_distribution/native_base_receipts/'+digest(result)+'.json'
        blob=bucket.blob(key)
        if not blob.exists():blob.upload_from_string(json.dumps(result,sort_keys=True),content_type='application/json',if_generation_match=0)
        result['receipt_path']=key
    return result


class L4DailyPlanPending(ValueError):
    """The original signal-date Paper plan has not been activated yet."""


def daily_plan_closure(config,as_of,paper):
    from services.l4_distribution import validate_bundle
    rows=paper.query('SELECT p.payload_json FROM l4_portfolio_head_v1 h JOIN l4_portfolio_plans_v1 p ON h.plan_id=p.plan_id WHERE h.account_id=1 AND p.activated=1',[])
    if len(rows)!=1:raise L4DailyPlanPending('l4_daily_plan_missing')
    plan=json.loads(rows[0]['payload_json'])
    if plan['signal_date']!=as_of:
        raise L4DailyPlanPending('l4_daily_plan_pending_for_signal_date')
    bundle=config['l4Distribution']['artifact']
    validate_bundle(bundle,l3_identity=plan['l3_identity'],signal_date=as_of)
    if plan['model_checksum']!=bundle['model_checksum']:
        raise ValueError('l4_daily_plan_model_changed')
    return {'schema_version':'l4-daily-plan-closure-v1','signal_date':as_of,'plan_id':plan['plan_id'],
        'model_checksum':plan['model_checksum'],'legacy_oof_maturity_requested':False,
        'training_dispatched':False,'promoted':False}


def verified_paper_closure_with_incomplete_comparison(nav, closure, clients):
    """Keep failed historical research visible; certify only the current Paper plan.

    No accounting gap, current source failure, promotion, or live order is waived.
    """
    failures = (nav.get('family_reviews') or {}).get('failures') or []
    if (nav.get('status') != 'failed' or nav.get('journal_chain_verified') is not True
            or nav.get('accounting_status') not in {'awaiting_execution_pairs', 'up_to_date', 'materialized'}
            or nav.get('error_type') or not failures):
        return False
    for failure in failures:
        counts = failure.get('counts') or {}
        if (failure.get('reason') != 'nav_daily_population_unresolved' or not counts
                or set(counts) - {'unmaterialized_selections', 'unresolved_selection_sources'}
                or any(type(n) is not int or n <= 0 for n in counts.values())):
            return False
    if any(not isinstance(nav.get(key), dict) or nav[key].get('failures') != [] for key in ('candidate_decisions',
            'opb_candidate_decisions', 'l3_candidate_decisions', 'atomic_candidate_decisions')):
        return False
    route = nav.get('route_candidate_decisions')
    if not isinstance(route, dict) or not isinstance(route.get('failures'), list):
        return False
    evidence = nav.get('paired_nav_evidence') or {}
    population = evidence.get('candidate_population') or {}
    for failure in route['failures']:
        checksum = failure.get('candidate_checksum')
        # Missing allocation is the same unobserved comparison, not a route
        # evaluation error. Match the original, fully verified population.
        if (failure.get('owner') != 'l15_route' or failure.get('stage') != 'original_source'
                or failure.get('reason') != 'nav_policy_original_allocation_missing'
                or failure.get('error_type') != 'ValueError' or not checksum
                or evidence.get('schema') != 'paired-nav-verified-evidence-v1'
                or evidence.get('as_of_date') != nav.get('as_of_date')
                or not population.get('population_checksum')
                or population['population_checksum'] != nav['family_reviews'].get('source_population_checksum')
                or not any(item.get('owner') == 'l15_route' and item.get('candidate_checksum') == checksum
                    for item in population.get('unmaterialized_selections', []))
                or any(item.get('owner') == 'l15_route' and item.get('candidate_checksum') == checksum
                    for item in population.get('pairs', []))):
            return False
    paper = clients('paper')
    rows = paper.query('SELECT allocation_snapshot_id,payload_json FROM l4_portfolio_plans_v1 WHERE plan_id=? AND activated=1', [closure['plan_id']])
    if len(rows) != 1:
        return False
    plan = json.loads(rows[0]['payload_json'])
    if (plan.get('plan_id') != closure['plan_id'] or plan.get('execution_scope') != 'paper' or plan.get('signal_date') != closure['signal_date']
            or plan.get('model_checksum') != closure['model_checksum']):
        return False
    manifests = clients('learning').query('SELECT signal_date,source_run_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=? AND snapshot_kind=?',
        [rows[0]['allocation_snapshot_id'], 'allocation_context'])
    if len(manifests) != 1 or manifests[0]['signal_date'] != closure['signal_date']:
        return False
    stages = clients('ops').query('SELECT canonical_run_id,status FROM pipeline_stage_runs WHERE business_date=? AND stage=?',
        [closure['signal_date'], 'pipeline_execution'])
    return (len(stages) == 1 and stages[0]['status'] == 'success'
        and stages[0]['canonical_run_id'] == manifests[0]['source_run_id'])
