from copy import deepcopy
import pytest
from services.l4_distribution import digest
from services.l4_distribution_runtime import run,native_features
from services.l4_r16_allocation import allocation_policy
from test_l4_distribution_runtime import fixture as base_fixture


def fixture(arm='raw'):
    recs,policy,history=base_fixture(); policy['scope']='private_research'
    policy['constraints']['covariance_horizon_sessions']=5
    identity=policy['runtime']['l3_identity']; day=policy['runtime']['signal_date']
    rows=[dict(symbol=r['symbol'],features=native_features(r,policy['runtime']['predictions'][r['symbol']],identity)) for r in recs]
    symbols=[r['symbol'] for r in recs]
    observation=dict(signal_date=day,l3_identity=identity,rows=rows,pool_symbols=symbols)
    observation['checksum']=digest(observation)
    forecast=dict(schema='r16-four-arm-forecast-v1',signal_date=day,model_checksum='a'*64,
        calibration_checksum='b'*64,upstream_checksum='c'*64,symbols=symbols,pool_checksum=digest(sorted(symbols)),
        observation_checksum=observation['checksum'],production_enabled=False,order_submission_allowed=False,
        outer_acceptance_credit=0,p_loss=[.5,.5,.5],arms={a:[-.03,.06,-.03] for a in ('raw','linear','empirical_bayes')},
        incumbent={'model_checksum':policy['artifact']['model_checksum'],'gross':[-.03,.06,-.03]})
    forecast['checksum']=digest(forecast)
    policy['r16_binding']={k:forecast[k] for k in ('model_checksum','upstream_checksum','calibration_checksum')}
    policy['r16_binding']['allocation_policy_checksum']=digest(allocation_policy(policy))
    return recs,policy,history,dict(forecast=forecast,observation=observation,arm=arm)


def test_native_r16_all_arms_preserve_solver_risk_and_distinct_policy_accounts():
    plans=[]
    for arm in ('raw','linear','empirical_bayes','incumbent'):
        recs,policy,history,packet=fixture(arm); before=deepcopy(policy)
        out=run(recs,policy,return_history=history,private_research=True,r16_shadow=packet)
        plan=out[0]['_l4_portfolio_plan']; plans.append(plan)
        assert plan['execution_scope']=='private_research' and plan['weights']['A']==0
        assert plan['r16_evidence']['outer_acceptance_credit']==0
        assert plan['r16_evidence']['comparison_arm']==arm
        assert plan['input_attribution']['model_feature_count']==(30 if arm=='incumbent' else 31)
        assert plan['model_checksum']==(policy['artifact']['model_checksum'] if arm=='incumbent' else 'a'*64)
        assert plan['plan_id']==digest({k:v for k,v in plan.items() if k!='plan_id'})
        assert policy==before
    assert len({p['policy_identity'] for p in plans})==4
    assert all(p['weights']==plans[0]['weights'] for p in plans)


def test_r16_private_scope_binding_and_feature_change_rejected():
    recs,policy,history,packet=fixture()
    for override in ({'private_research':False},{'private_research':True,'r2_shadow':{}}):
        with pytest.raises(ValueError,match='private_exclusive'):
            run(recs,policy,return_history=history,r16_shadow=packet,**override)
    for mutation in ('model','constraints','features','equal_weight'):
        r,p,h,k=fixture()
        if mutation=='model': p['r16_binding']['model_checksum']='f'*64
        if mutation=='constraints': p['constraints']['name_cap']=.5
        if mutation=='features': r[1]['score_components']['components']['mlEdge']=15
        if mutation=='equal_weight': k['arm']='pool_equal_weight'
        with pytest.raises(ValueError): run(r,p,return_history=h,private_research=True,r16_shadow=k)


def test_r16_native_locked_holding_and_risk_overlay_are_preserved():
    recs,policy,history,packet=fixture()
    policy['runtime']['account'].update(available_cash=800000,holdings=[{'symbol':'H','market_value':200000}])
    history['H']=history['A']; recs[1]['alpha_context']={'risk_overlay':{'skip':True}}
    out=run(recs,policy,return_history=history,private_research=True,r16_shadow=packet)
    plan=out[0]['_l4_portfolio_plan']
    assert plan['weights']['H']==pytest.approx(.2) and plan['targets']['H']['locked']
    assert plan['weights']['B']==0 and 'B' in plan['forbidden_buys']
