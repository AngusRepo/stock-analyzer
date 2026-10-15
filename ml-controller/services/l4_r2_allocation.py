"""Use sealed full-pool alpha in the same allocator, in isolated research only."""
from services.l4_distribution import digest,finite
from services.l4_r2_forward_evaluation import validate_policy

def allocation_policy(policy):
    result={k:policy[k] for k in ('constraints','opb','sealedExecution','sealedExecutionCalibration') if k in policy}
    if 'opb' in result:result['opb']={k:v for k,v in result['opb'].items() if k!='approved_policy_identity'}
    return result

def inputs(packet,*,identity,day,baseline,policy,symbols):
    forecast=packet['forecast'];snapshot=packet['snapshot'];evaluation=packet['evaluation_policy']
    validate_policy(evaluation)
    if (forecast.get('schema_version')!='l4-r2-daily-shadow-v1'
            or forecast.get('execution_scope')!='shadow_only' or forecast.get('promoted') is not False
            or forecast.get('neural_network_updated') is not False
            or forecast['signal_date']!=day or snapshot['signal_date']!=day
            or forecast['l3_identity']!=identity or snapshot['l3_identity']!=identity
            or forecast['model_checksum']!=evaluation['model_checksum']
            or forecast['baseline_model_checksum']!=baseline['model_checksum']
            or forecast['policy_checksum']!=digest(evaluation)
            or forecast.get('implementation_checksum')!=evaluation['implementation_checksum']
            or evaluation['allocation_policy_checksum']!=digest(allocation_policy(policy))
            or forecast['native_snapshot_id']!=snapshot['snapshot_id']
            or forecast['native_original_sha256']!=snapshot['original_sha256']
            or digest(forecast['forecasts'])!=forecast['forecasts_checksum']
            or digest(snapshot['feature_rows'])!=snapshot['features_checksum']
            or policy['constraints'].get('covariance_horizon_sessions')!=5
            or not (policy.get('sealedExecution') or {}).get('require_matched_risk_horizon')):
        raise ValueError('l4_r2_allocation_contract')
    by={r['symbol']:r for r in forecast['forecasts']};features={r['symbol']:r for r in snapshot['feature_rows']}
    if (len(by)!=len(forecast['forecasts']) or len(features)!=len(snapshot['feature_rows'])
            or set(by)!=set(features) or set(by)!=set(snapshot['eligible_symbols']) or set(symbols)-set(by)):
        raise ValueError('l4_r2_allocation_full_pool_missing')
    mu={s:finite(r['relative_mu'],'r2_mu') for s,r in by.items()}
    if not mu or abs(sum(mu.values())/len(mu))>1e-8:raise ValueError('l4_r2_allocation_centering')
    if any(r['native_features_checksum']!=digest(features[s]['features']) for s,r in by.items()):
        raise ValueError('l4_r2_allocation_features_changed')
    arm=packet.get('comparison_arm','candidate')
    if arm not in ('baseline','candidate'):raise ValueError('l4_r2_allocation_arm')
    semantic='five_session_relative_pool_decimal' if arm=='candidate' else 'five_session_gross_decimal'
    values=mu if arm=='candidate' else {s:finite(r['baseline_gross'],'baseline_mu') for s,r in by.items()}
    model=forecast['model_checksum'] if arm=='candidate' else forecast['baseline_model_checksum']
    # Both models use the same original full pool, then the same sealed slate.
    outputs={s:dict(expected_return_gross=values[s],expected_return_semantic=semantic,
        model_checksum=model,source_pool_checksum=digest(sorted(by)),
        mean_policy='sealed_r2_full_native_pool_centered' if arm=='candidate' else 'sealed_incumbent_full_native_pool_gross',incremental_efficacy='unproven',
        execution_scope='private_research',source_forecast_checksum=digest(forecast)) for s in symbols}
    return [features[s] for s in symbols],outputs
