import numpy as np
import pytest
from services.l4_portfolio import allocate
from services.l4_allocation_contract import risk_groups
from services.l4_distribution_runtime import run
from test_l4_distribution_runtime import fixture

def test_joint_group_limits_and_costed_locked_inherited_overage():
    args=dict(symbols=['A','B','C'],expected_gross=[.12,.11,.08],covariance=np.eye(3)*.01,
        current_weights=[0,0,0],exposure_cap=.9,name_cap=.5,min_weight=.03,max_positions=None,
        buy_cost=.001,sell_cost=.004,exposure_groups={'sector:X':{'symbols':['A','B'],'cap':.4}})
    result=allocate(**args)
    assert result['weights']['A']+result['weights']['B']<=.4+1e-8
    assert result['weights']['C']>0
    args.update(current_weights=[.45,0,0],locked_symbols=['A'])
    result=allocate(**args)
    assert result['weights']['A']==pytest.approx(.45)
    assert result['weights']['B']==pytest.approx(0,abs=1e-8)
    assert result['constraints']['exposure_groups']['sector:X']['effective_cap']==.45


def test_original_utility_knobs_enter_objective_without_clipping_signed_alpha():
    args=dict(symbols=['A'],expected_gross=[.1],covariance=np.array([[.1]]),current_weights=[0.],
        exposure_cap=1.,name_cap=1.,min_weight=0.,max_positions=None,buy_cost=0.,sell_cost=0.,
        alpha_strength=2.,risk_aversion=2.,turnover_penalty=.05,turnover_pressure=[1.],l2_penalty=.1)
    result=allocate(**args)
    # Analytic optimum: (2*.1-.05)/(2*(2*.1+.1))=.25.
    assert result['weights']['A']==pytest.approx(.25,abs=2e-4)
    assert result['expected_gross']==pytest.approx(.025,abs=2e-5)
    assert result['turnover_pressure_penalty']==pytest.approx(.0125,abs=1e-5)
    args['expected_gross']=[-.01]
    assert allocate(**args)['weights']['A']==pytest.approx(0)


def test_runtime_retains_full_native_packets_by_snapshot_hash_and_group_evidence():
    rows,policy,history=fixture()
    rows[1]['sector']=rows[2]['sector']='TECH'
    policy['constraints'].update(sector_concentration_cap=.2,max_cluster_weight=.8,l2_penalty=.01)
    plan=run(rows,policy,return_history=history)[0]['_l4_portfolio_plan']
    assert sum(plan['weights'][s] for s in ('B','C'))<=.2+1e-8
    assert plan['input_attribution']['model_feature_count']==30
    assert set(plan['input_attribution']['candidate_input_checksums'])=={'A','B','C'}
    assert plan['opb']['candidate_feature_summary']['candidate_count']==3
    assert plan['utility_parameters']['risk_aversion']==2.
    assert plan['risk_evidence']['covariance_horizon_sessions']==5


def test_zero_risk_budget_and_unaffordable_minimum_choose_cash_without_bypass():
    args=dict(symbols=['A'],expected_gross=[.3],covariance=np.eye(1)*.01,current_weights=[.1],
        exposure_cap=0.,name_cap=0.,min_weight=.03,max_positions=5,buy_cost=.001,sell_cost=.004,
        exposure_groups={'halt':{'symbols':['A'],'cap':0.}})
    plan=allocate(**args)
    assert plan['weights']['A']==0 and plan['expected_trading_cost']==pytest.approx(.0004)
    args.update(current_weights=[0],exposure_cap=.8,name_cap=.02)
    plan=allocate(**args)
    assert plan['cash_weight']==1


def test_sparse_control_mapping_preserves_native_source_settings():
    from services.l4_allocation_contract import inherited_sparse_controls
    default=inherited_sparse_controls({})
    assert default['risk_aversion']==2 and default['max_cluster_weight']==.55
    assert default['covariance_horizon_sessions']==1
    cfg={'alphaFramework':{'allocation':{'riskAversion':3.,'alphaStrength':.4,'l2Penalty':.02,
        'turnoverPenalty':.1,'maxClusterWeight':.25,'sectorConcentrationCap':.3}}}
    actual=inherited_sparse_controls(cfg)
    assert actual['risk_aversion']==3 and actual['alpha_strength']==.4
    assert actual['l2_penalty']==.02 and actual['turnover_penalty']==.1
    assert actual['max_cluster_weight']==.25 and actual['sector_concentration_cap']==.3


def test_all_five_native_opb_arms_are_preserved_without_priors_or_stock_caps():
    from services.l4_allocation_contract import native_opb_policy
    from services.online_portfolio_bandit import DEFAULT_ARMS
    from services.l4_distribution_runtime import choose_opb,distribution_policy_identity
    _,policy,_=fixture();policy['opb']=native_opb_policy(policy['constraints'])
    identity=distribution_policy_identity(policy,policy['artifact']['l3_identity'])
    policy['opb']['approved_policy_identity']=identity
    chosen,evidence=choose_opb(policy,[],identity,'2026-09-11')
    assert chosen==policy['constraints'] and evidence['status']=='cold_start_base'
    assert set(evidence['arm_statistics'])=={'base'}|{arm.arm_id for arm in DEFAULT_ARMS}
    assert evidence['fabricated_prior_samples']==0
    for old,new in zip(DEFAULT_ARMS,policy['opb']['arms'][1:]):
        assert new['id']==old.arm_id
        assert new['constraints']['name_cap']==min(policy['constraints']['name_cap'],old.max_weight)
        assert new['constraints']['exposure_cap']==min(policy['constraints']['exposure_cap'],1-old.cash_buffer)
        assert new['constraints']['min_weight']==max(policy['constraints']['min_weight'],old.min_trade_weight)
        assert not any('candidate' in key for key in new['constraints'])
