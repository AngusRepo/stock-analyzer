"""Read the original immutable serving authority; never grant an approval."""
import json
from services.paired_nav_journal import digest


def _model_components(model):
    """R33 roster objects carry an equal-weight variant and a serving calibration table instead
    of the learned ensemble's fit coefficients and feature names."""
    from services.r33_ensemble import is_r33
    models={'artifact_id':model['artifact_id'],'cohort_id':model['cohort_id'],
        'payload_checksum':model['payload_checksum'],'base_artifacts':model['base_artifacts'],
        'model_order':model['model_order']}
    if is_r33(model):
        calibration=model['serving_calibration']
        return ({**models,'variant':model['variant'],'weight_semantic':'r33_roster_equal_weight',
                 'calibration_checksum':digest(calibration)},
                {'ensemble_schema_version':model['schema_version'],
                 'calibration_schema_version':calibration['schema_version'],
                 'calibration_target':calibration['target'],'calibration_weighting':calibration['weighting']})
    return ({**models,'fit_coefficients':model['fit']['coefficients'],
             'weight_semantic':'learned_rank_ridge_coefficients',
             'calibration_checksum':digest(model.get('calibration'))},
            {'feature_names':model['feature_names'],
             'ensemble_semantic_version':model['ensemble_semantic_version'],
             'calibration_schema_version':model['calibration_schema_version']})


def configuration_components(configuration, *, strategy, model):
    native=configuration['native_execution_policy']
    models,semantics=_model_components(model)
    return {'strategy':strategy,
            'models':models,
            'parameters':{'trading':configuration['trading_config'],'risk':configuration['risk_config']},
            'data_semantics':{**semantics,
                'native_kv_policy':native['frozen_kv'],'kv_read_policy':native['kv_read_policy']},
            'cost':configuration['trading_config'].get('fees'),
            'execution':{'native_owner':native['execution_owner_version'],
                'allocator_source':configuration['allocator_source_identity'],
                'l3_inference_source':configuration['l3_inference_source_identity'],
                'variables_checksum':digest(native['variables'])}}


def canonical_bundle_view(*, query):
    from services import active8_nav_adoption as authority, active8_paper_admission as paper
    publication=authority.load_committed_publication(query=query,allow_paper=True)
    if publication is None:
        return {'status':'INSUFFICIENT','reason':'committed_serving_bundle_missing','promotion_authority':False}
    receipt=json.loads(publication.receipt_json);payload=json.loads(publication.payload_json)
    if 'paper_admission' in receipt:
        admission=receipt['paper_admission']
        approval=paper.verify_active_approval(admission)
        expected=paper.runtime_configuration_identity(approval['configuration'])
        strategy=admission['strategy_bundle'];basis='paper_experiment_unproven'
    else:
        from services.paired_nav_strategy_bundle import publication_configuration
        expected=publication_configuration(receipt['nav_configuration'],
            signal_date=receipt['nav_validation']['as_of_date'])
        strategy=expected.get('strategy_bundle');basis='committed_paired_nav'
    current=paper.runtime_configuration_identity(authority.current_execution_configuration())
    from services.ensemble_v2 import ensemble_artifact_id
    from services.r33_ensemble import is_r33
    model=payload if is_r33(payload) else {**payload,'artifact_id':ensemble_artifact_id(payload)}
    before=configuration_components(expected,strategy=strategy,model=model)
    after=configuration_components(current,strategy=strategy,model=model)
    missing=[key for key in before if not before[key] or not after[key]]
    differences=[]
    def walk(a,b,path):
        if isinstance(a,dict) and isinstance(b,dict):
            for key in sorted(set(a)|set(b)):walk(a.get(key),b.get(key),path+'.'+key)
        elif a!=b:
            # Report hashes and field names; never expose source binding values.
            differences.append({'field':path,'validated_checksum':digest(a),'current_checksum':digest(b)})
    for key in before:walk(before[key],after[key],key)
    return {'schema_version':'canonical-serving-bundle-view-v1',
            'status':'FAIL' if differences else ('INSUFFICIENT' if missing else 'PASS'),
            'missing_components':missing,'adoption_basis':basis,
            'efficacy_status':'unproven' if basis=='paper_experiment_unproven' else 'see_original_nav_verdict',
            'models':before['models'],'source_receipt_checksum':digest(receipt),
            'strategy_bundle_checksum':digest(strategy),
            'components':{key:{'validated_checksum':digest(before[key]),'current_checksum':digest(after[key])}
                          for key in before},'drift_fields':differences,
            'source_authority':'active8_nav_adoption.load_committed_publication',
            'promotion_authority':False,'real_order_writes':0}
