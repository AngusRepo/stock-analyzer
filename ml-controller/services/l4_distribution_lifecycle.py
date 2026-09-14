"""Candidate refresh and evidence-bound Paper release; no automatic promotion."""
from copy import deepcopy
from services.l4_distribution import FEATURE_SCHEMA, digest, fit_candidate, predict, validate_bundle

ACCEPTANCE_CHECKS = ('native_feature_parity','purged_labels','same_pool','same_calendar','same_costs',
    'same_risk_constraints','legal_share_accounting','partial_fills','unfilled_exposure_reserved',
    'hard_risk_exits','veto_replan_retry','no_score_v2_reselection','no_top_k','end_to_end_execution',
    'native_l3_input_contract_complete','allocator_risk_mechanism_parity',
    'opb_nonstationary_reward_parity','opb_action_space_parity','full_pool_runtime_budget',
    'native_l3_baseline_preserved','incremental_comparison_contract')


def validate_acceptance(receipt,bundle):
    if (receipt.get('schema_version')!='l4-paper-acceptance-v1'
            or receipt.get('model_checksum')!=bundle['model_checksum']
            or receipt.get('l3_identity_checksum')!=digest(bundle['l3_identity'])
            or receipt.get('feature_schema')!=FEATURE_SCHEMA
            or not all(receipt.get('checks',{}).get(key) is True for key in ACCEPTANCE_CHECKS)
            or len(receipt.get('source_evidence_checksum',''))!=64):
        raise ValueError('l4_distribution_acceptance_evidence_incomplete')
    mode=receipt.get('acceptance_mode','comparative_promotion')
    if mode == 'paper_experiment':
        grant=receipt.get('experiment_authorization') or {}
        if (grant.get('scope')!='paper' or grant.get('approved') is not True
                or not isinstance(grant.get('source_reference'),str) or not grant['source_reference'].strip()
                or grant.get('model_checksum')!=bundle['model_checksum']
                or receipt.get('efficacy_status')!='unproven'):
            raise ValueError('l4_distribution_paper_experiment_authorization_missing')
        # Explicitly authorized Paper learning needs full engineering evidence,
        # not fictitious positive historical P&L or another shadow maturity wait.
        return
    if mode != 'comparative_promotion':
        raise ValueError('l4_distribution_acceptance_mode_invalid')
    from services.l4_incremental_acceptance import validate_comparison
    validate_comparison(receipt.get('paired_account_comparison'), bundle)


def prepare_paper_release(candidate,receipt,*,signal_date):
    frozen=deepcopy(candidate)
    validate_bundle(frozen,l3_identity=frozen['l3_identity'],signal_date=signal_date,require_paper_release=False)
    validate_acceptance(receipt,frozen)
    frozen['release']={'scope':'paper','decision':'PASS',
        'acceptance_mode':receipt.get('acceptance_mode','comparative_promotion'),
        'efficacy_status':'unproven' if receipt.get('acceptance_mode')=='paper_experiment' else 'paired_comparison_passed',
        'model_checksum':frozen['model_checksum'],
        'l3_identity_checksum':digest(frozen['l3_identity']),'validation_receipt':deepcopy(receipt),
        'validation_receipt_checksum':digest(receipt)}
    validate_bundle(frozen,l3_identity=frozen['l3_identity'],signal_date=signal_date)
    return frozen


def chronological_validation_blocks(rows):
    """Three expanding-window folds, matching the approved 24-date recipe.

    With longer histories the final half is split into three adjacent blocks.
    fit_candidate purges labels independently before each block and fits its
    scaler on that training subset. Never reduce silently to one validation.
    """
    dates = sorted({row['date'] for row in rows})
    tail = dates[len(dates) // 2:]
    if len(tail) < 3:
        raise ValueError('l4_distribution_three_fold_history_insufficient')
    width, extra = divmod(len(tail), 3)
    blocks, offset = [], 0
    for index in range(3):
        end = offset + width + int(index < extra)
        block = tail[offset:end]
        if not any(row['label_known_date'] < block[0] for row in rows):
            raise ValueError('l4_distribution_purged_fold_empty')
        blocks.append(block)
        offset = end
    return blocks


def refresh_candidate(rows,*,dataset_receipt,l3_identity,as_of,cadence):
    if cadence not in ('weekly','monthly','manual'):
        raise ValueError('l4_distribution_refresh_cadence_invalid')
    if (dataset_receipt.get('schema_version')!='l4-native-oof-dataset-v1'
            or dataset_receipt.get('rows_checksum')!=digest(rows)
            or dataset_receipt.get('feature_schema')!=FEATURE_SCHEMA
            or dataset_receipt.get('parent_l3_identity')!=l3_identity):
        raise ValueError('l4_distribution_training_dataset_unverified')
    from services.l4_l3_baseline import validate_baseline
    for row in rows:
        baseline=validate_baseline(row.get('l3_baseline'))
        replica=(row.get('source') or {}).get('meta_replica_checksum')
        if replica is not None and baseline['artifact_checksum'] != replica:
            raise ValueError('l4_distribution_baseline_replica_mismatch')
    dates=sorted({r['date'] for r in rows})
    if len(dates)<15:
        raise ValueError('l4_distribution_training_history_insufficient')
    holdout_dates=dates[max(10,int(len(dates)*.8)):]
    train=[r for r in rows if r['label_known_date']<holdout_dates[0]]
    validation_dates=chronological_validation_blocks(train)
    candidate=fit_candidate(train,l3_identity=l3_identity,as_of=as_of,validation_dates=validation_dates)
    held=[r for r in rows if r['date'] in holdout_dates]
    output=predict(held,candidate['model'])
    candidate['evaluation']={'method':'untouched_later_dates_no_refit','dates':holdout_dates,
        'rows':len(held),'rows_checksum':digest(held),
        'ev_mse':sum((p['expected_return_gross']-r['gross_return'])**2 for r,p in zip(held,output))/len(held),
        'zero_mse':sum(r['gross_return']**2 for r in held)/len(held),
        'portfolio_superiority':'requires_same_account_execution_comparison'}
    from services.l4_prediction_evaluation import evaluate_predictions
    candidate['evaluation']['native_l3_comparison']=evaluate_predictions(held,output)
    candidate['training_source']=dataset_receipt
    candidate['cadence']=cadence
    candidate['candidate_id']='l4_distribution:'+digest(candidate)
    return candidate


def persist_candidate(candidate,*,bucket):
    import json
    key='l4_distribution/candidates/'+candidate['candidate_id'].split(':',1)[1]+'.json'
    payload=json.dumps(candidate,sort_keys=True,separators=(',',':'),allow_nan=False)
    blob=bucket.blob(key)
    if blob.exists():
        if blob.download_as_text()!=payload:
            raise ValueError('l4_distribution_candidate_immutable_conflict')
    else:
        blob.upload_from_string(payload,content_type='application/json',if_generation_match=0)
    return {'candidate_id':candidate['candidate_id'],'artifact_path':key,'artifact_checksum':digest(candidate),
            'status':'validated','promoted':False,'scope':'research_candidate',
            'summary':'new_l4_candidate_saved_requires_paired_account_acceptance'}
