from copy import deepcopy
from datetime import date,timedelta
import numpy as np
import pytest
from services.l4_distribution import digest
from services.l4_distribution_runtime import run,native_features
from services.l4_r2_allocation import allocation_policy
from services.l4_dated_risk import build_dated_risk
from test_l4_distribution_runtime import fixture as account_fixture
from test_l4_r2_forward_evaluation import fixture as evaluation_fixture

def fixture():
    rows,policy,_=account_fixture();policy['scope']='private_research'
    policy['constraints']['covariance_horizon_sessions']=5
    policy['sealedExecution']=dict(schema_version='l4-sealed-execution-v1',rotation_mode='selected_ready_or_filled',
        expiry='retain_until_next_seal',require_matched_risk_horizon=True,minimum_covariance_windows=20)
    _,options=evaluation_fixture();evaluation=options['policy']
    evaluation.update(first_signal_date='2026-09-11',last_inspected_signal_date='2026-09-10',
        allocation_policy_checksum=digest(allocation_policy(policy)),baseline_model_checksum=policy['artifact']['model_checksum'])
    identity=policy['runtime']['l3_identity'];day=policy['runtime']['signal_date']
    # D belongs to the complete native pool but is not a routed buy candidate.
    features=[dict(symbol=s,features={'test_native':i},l3_baseline={}) for i,s in enumerate(('A','B','C','D'))]
    snapshot=dict(signal_date=day,snapshot_id='native',original_sha256='f'*64,l3_identity=identity,
        feature_rows=features,features_checksum=digest(features),eligible_symbols=['A','B','C','D'])
    forecasts=[dict(symbol=r['symbol'],relative_mu=mu,native_features_checksum=digest(r['features']))
        for r,mu in zip(features,[-.04,.06,.03,-.05])]
    forecast=dict(schema_version='l4-r2-daily-shadow-v1',execution_scope='shadow_only',neural_network_updated=False,
        implementation_checksum=evaluation['implementation_checksum'],
        promoted=False,signal_date=day,l3_identity=identity,model_checksum='a'*64,
        baseline_model_checksum=policy['artifact']['model_checksum'],policy_checksum=digest(evaluation),
        native_snapshot_id='native',native_original_sha256='f'*64,forecasts=forecasts,forecasts_checksum=digest(forecasts))
    packet=dict(forecast=forecast,snapshot=snapshot,evaluation_policy=evaluation)
    end=date.fromisoformat(day);dates=[(end-timedelta(days=120-i)).isoformat() for i in range(121)]
    payloads=[dict(symbol=s,prices=[dict(date=d,adj_close=100*np.exp(.01*np.sin(i+j))) for i,d in enumerate(dates)])
        for j,s in enumerate(('A','B','C','H'))]
    history=build_dated_risk(payloads,signal_date=day,lookback=120)
    return rows,policy,history,packet

def test_same_allocator_uses_full_pool_mean_and_five_day_risk_without_new_candidates():
    rows,policy,history,packet=fixture();before=deepcopy(policy)
    plan=run(rows,policy,return_history=history,private_research=True,r2_shadow=packet)[0]['_l4_portfolio_plan']
    assert set(plan['weights'])=={'A','B','C'} and plan['weights']['A']==0
    assert plan['targets']['B']['expected_return_gross']==.06  # no subset re-centering
    assert plan['risk_evidence']['measured_covariance_horizon']['horizon_sessions']==5
    assert plan['model_checksum']=='a'*64 and plan['execution_scope']=='private_research'
    assert plan['r2_evidence']['promotion_allowed'] is False and policy==before

def test_new_alpha_does_not_unlock_unmodeled_holdings_or_trade_in_formal_scope():
    rows,policy,history,packet=fixture()
    policy['runtime']['account'].update(available_cash=900000,holdings=[{'symbol':'H','market_value':100000}])
    plan=run(rows,policy,return_history=history,private_research=True,r2_shadow=packet)[0]['_l4_portfolio_plan']
    assert plan['targets']['H']['locked'] and plan['weights']['H']==pytest.approx(.1)
    policy['scope']='paper'
    with pytest.raises(ValueError,match='formal_promotion_not_admitted'):
        run(rows,policy,return_history=history,private_research=True,r2_shadow=packet)

def test_changed_scores_features_policy_and_daily_risk_cannot_reuse_frozen_contract():
    mutations=[lambda p,s:p['constraints'].update(covariance_horizon_sessions=1),
        lambda p,s:s['forecast']['forecasts'][0].update(relative_mu=10),
        lambda p,s:s['snapshot']['feature_rows'][0]['features'].update(test_native=999),
        lambda p,s:p['constraints'].update(name_cap=.9)]
    for change in mutations:
        rows,policy,history,packet=fixture();change(policy,packet)
        with pytest.raises(ValueError,match='l4_r2_allocation'):
            run(rows,policy,return_history=history,private_research=True,r2_shadow=packet)
