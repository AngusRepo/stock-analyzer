"""Daily preparation of four independent native states, preserving account carry."""
from copy import deepcopy
from services.paired_nav_journal import digest
from services.l4_distribution import digest as model_digest
from services.l4_r17_session import ARMS,identity,read_event,register
from services.l4_r17_configuration import NAMES,configurations
from services.native_paper_state import prepare_native_state


def register_signal(*,experiment,activation,forecast,observation,allocation_inputs,
                    seed_rows,stock_rows,configuration,calendar,variables,source_tables,
                    objects,runner,model_predictions,bootstrap=None,now=None,source_evidence_ref=None):
    signal=forecast['signal_date'];session=calendar[calendar.index(signal)+1]
    old_ref,old=read_event(objects,identity('registration',experiment,session))
    if old is not None:
        if (old['activation_checksum']!=activation['checksum']
                or old['forecast']!=forecast
                or old['model_predictions_checksum']!=digest(model_predictions)
                or old.get('source_evidence_ref')!=source_evidence_ref):
            raise ValueError('r17_signal_retry_changed')
        return old_ref
    if (observation.get('checksum')!=model_digest({k:v for k,v in observation.items() if k!='checksum'})
            or forecast.get('observation_checksum')!=observation['checksum']):
        raise ValueError('r17_original_observation_binding')
    policy=allocation_inputs['alpha_policy']['l4Distribution']
    expected=configurations(configuration['trading_config'],allocation_policy=policy,forecast=forecast)
    if configuration.get('arm_trading_configs')!=expected:
        raise ValueError('r17_daily_configuration_changed')
    if policy['runtime']['signal_date']!=signal:
        raise ValueError('r17_daily_allocation_date')
    recs=allocation_inputs['recommendations']
    seeds={r['symbol'] for r in seed_rows}
    if not seeds or any(r['symbol'] not in seeds for r in recs):
        raise ValueError('r17_recommendations_outside_sealed_screener')
    if session==activation['first_session_date']:
        if not bootstrap or digest(bootstrap)!=activation.get('bootstrap_checksum'):
            raise ValueError('r17_initial_account_not_sealed')
        states={a:deepcopy(bootstrap['state']) for a in ARMS}
        accounts={a:deepcopy(bootstrap['account']) for a in ARMS};previous=None
    else:
        previous=calendar[calendar.index(session)-1]
        _,closed=read_event(objects,identity('close',experiment,previous))
        if closed is None:raise ValueError('r17_prior_native_account_incomplete')
        states=closed['states'];accounts=closed['accounts']
    prepared={}
    for arm in ARMS:
        payload=deepcopy(allocation_inputs)
        payload['r16_shadow']={'arm':NAMES[arm],'forecast':forecast,'observation':observation}
        snapshot_id=model_digest({'experiment':experiment,'arm':arm,'signal_date':signal,
                                  'forecast':forecast['checksum'],'allocation':payload})
        result=prepare_native_state(base_state=states[arm],seed_rows=seed_rows,
            recommendations=recs,signal_date=signal,trading_config=expected[arm],
            risk_config=configuration['risk_config'],stock_rows=stock_rows,
            frozen_kv=configuration.get('frozen_kv'),l4_allocation_inputs=payload,
            allocation_snapshot_id=snapshot_id)
        prepared[arm]={k:result[k] for k in ('state_sql','state_checksum')}
    return register(experiment=experiment,signal_date=signal,session_date=session,
        activation=activation,forecast=forecast,states=prepared,opening_accounts=accounts,
        configuration=configuration,variables=variables,source_tables=source_tables,
        calendar=calendar,objects=objects,runner=runner,account_id=1,now=now,
        previous=previous,model_predictions=model_predictions,source_evidence_ref=source_evidence_ref)
