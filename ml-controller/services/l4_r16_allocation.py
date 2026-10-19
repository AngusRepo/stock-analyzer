"""R16 frozen full-pool scores into the native allocator, private scope only.

No policy promotion, account registration, order submission or target-to-fill
conversion occurs here. Equal weight is an analytical benchmark, not an account.
"""
from services.l4_distribution import digest,finite

ARMS=('raw','linear','empirical_bayes','incumbent')


def allocation_policy(policy):
    value={k:policy[k] for k in ('constraints','opb','sealedExecution','sealedExecutionCalibration') if k in policy}
    if 'opb' in value: value['opb']={k:v for k,v in value['opb'].items() if k!='approved_policy_identity'}
    return value


def inputs(packet,*,identity,day,baseline,policy,symbols):
    forecast=packet['forecast']; observation=packet['observation']; arm=packet['arm']
    binding=policy.get('r16_binding') or {}
    if (arm not in ARMS or policy.get('scope')!='private_research'
        or forecast.get('schema')!='r16-four-arm-forecast-v1'
        or forecast.get('production_enabled') is not False or forecast.get('order_submission_allowed') is not False
        or forecast.get('outer_acceptance_credit')!=0
        or forecast.get('checksum')!=digest({k:v for k,v in forecast.items() if k!='checksum'})
        or observation.get('checksum')!=digest({k:v for k,v in observation.items() if k!='checksum'})
        or forecast.get('observation_checksum')!=observation.get('checksum')
        or forecast['signal_date']!=day or observation['signal_date']!=day
        or observation.get('l3_identity')!=identity
        or forecast['model_checksum']!=binding.get('model_checksum')
        or forecast['upstream_checksum']!=binding.get('upstream_checksum')
        or forecast['calibration_checksum']!=binding.get('calibration_checksum')
        or forecast['incumbent']['model_checksum']!=baseline['model_checksum']
        or digest(allocation_policy(policy))!=binding.get('allocation_policy_checksum')
        or policy['constraints'].get('covariance_horizon_sessions')!=5):
        raise ValueError('r16_native_allocation_binding')
    rows={r['symbol']:r for r in observation['rows']}; full=forecast['symbols']
    if (len(rows)!=len(observation['rows']) or len(set(full))!=len(full)
        or set(full)!=set(rows) or set(full)!=set(observation['pool_symbols']) or set(symbols)-set(full)
        or forecast['pool_checksum']!=digest(sorted(full))):
        raise ValueError('r16_native_full_pool_missing')
    values=forecast['incumbent']['gross'] if arm=='incumbent' else forecast['arms'][arm]
    if len(values)!=len(full): raise ValueError('r16_score_length')
    scores={s:finite(v,'r16_score') for s,v in zip(full,values,strict=True)}
    if arm!='incumbent' and abs(sum(scores.values())/len(scores))>1e-8:
        raise ValueError('r16_full_pool_centering')
    model_checksum=baseline['model_checksum'] if arm=='incumbent' else forecast['model_checksum']
    outputs={s:dict(expected_return_gross=scores[s],
        expected_return_semantic='five_session_gross_decimal' if arm=='incumbent' else 'five_session_relative_pool_decimal',
        model_checksum=model_checksum,calibration_checksum=forecast['calibration_checksum'],
        comparison_arm=arm,source_forecast_checksum=forecast['checksum'],
        source_pool_checksum=forecast['pool_checksum'],execution_scope='private_research') for s in symbols}
    if len(forecast.get('p_loss',[]))!=len(full): raise ValueError('r16_p_loss_attribution_missing')
    p={s:finite(v,'r16_p_loss') for s,v in zip(full,forecast['p_loss'],strict=True)}
    if any(not 0<=v<=1 for v in p.values()): raise ValueError('r16_p_loss_invalid')
    features=[{**rows[s],'features':{**rows[s]['features'],**({'p_loss':p[s]} if arm!='incumbent' else {})}} for s in symbols]
    return features,outputs,model_checksum
