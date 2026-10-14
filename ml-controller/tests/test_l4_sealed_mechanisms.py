import numpy as np
import pytest
from services.l4_portfolio import allocate
from services.l4_position_constraints import position_constraints
from services.l4_sealed_execution import execution_inputs,seal_execution_evidence,aligned_covariance,SCHEMA
from services.l4_distribution import digest

def allocation(**overrides):
    args=dict(symbols=['3374','2327'],expected_gross=[.01595809,.03042264],
        covariance=np.eye(2)*.0004,current_weights=[.1,0.],exposure_cap=.45,name_cap=.125,
        min_weight=.03,max_positions=5,buy_cost=.001425,sell_cost=.004425,risk_aversion=2.)
    args.update(overrides);return args,allocate(**args)

def test_sector_cardinality_and_pair_veto_enter_same_certified_optimizer():
    args,result=allocation(membership_groups={'sector:X':{'symbols':['3374','2327'],'max_count':1}})
    assert sum(w>1e-7 for w in result['weights'].values())==1
    assert result['proof']['within_tolerance'] and not result['proof']['preselection']
    assert len(digest(result))==64  # The complete plan must survive canonical JSON sealing.
    _,pair=allocation(excluded_pairs=[['3374','2327']])
    assert not all(w>1e-7 for w in pair['weights'].values())

def test_inherited_correlated_holdings_can_stay_but_never_grow():
    _,result=allocation(current_weights=[.1,.1],expected_gross=[.1,.1],excluded_pairs=[['3374','2327']])
    assert all(w<=.1+1e-8 for w in result['weights'].values())

def test_trade_ambiguity_can_retain_a_positive_incumbent_but_never_override_hard_risk():
    args,result=allocation(expected_gross=[.02,.025],name_cap=.1,exposure_cap=.1,trade_uncertainty=[.02,.02])
    assert result['weights']['3374']==pytest.approx(.1)
    assert result['weights']['2327']==pytest.approx(0)
    _,hard=allocation(exposure_cap=0.,name_cap=0.,trade_uncertainty=[.02,.02])
    assert sum(hard['weights'].values())==0

def test_position_correlation_uses_pairwise_observed_returns_and_positive_edges_only():
    x=np.sin(np.arange(60))*.01
    rows={s:{'sector':'X'} for s in ['A','B','C']}
    groups,pairs=position_constraints(['A','B','C'],rows,{}, {'A':x.tolist(),'B':x.tolist(),'C':(-x).tolist()},
        {'max_per_sector':2,'correlation_threshold':.7,'correlation_window':60})
    assert groups['sector:X']['max_count']==2
    assert pairs==[['A','B']]
    _,missing=position_constraints(['A','B'],rows,{}, {'A':[None]*60,'B':x.tolist()}, {'correlation_threshold':.7,'correlation_window':60})
    assert missing==[]

def test_oos_uncertainty_requires_sealed_model_date_horizon_and_measured_coverage():
    config={'schema_version':SCHEMA,'rotation_mode':'selected_ready_or_filled','expiry':'retain_until_next_seal',
            'uncertainty_calibration_checksum':'a'*64,'minimum_calibration_dates':20}
    policy={'sealedExecution':config}
    with pytest.raises(ValueError,match='evidence_missing'):execution_inputs(policy,{},['2327'],'b'*64,'2026-10-13',1)
    evidence={'schema_version':'l4-oos-trade-uncertainty-v1','calibration_checksum':'a'*64,'model_checksum':'b'*64,
      'signal_date':'2026-10-13','horizon_sessions':5,'known_date_max':'2026-10-12','independent_dates':20,
      'status':'validated_oos','source_reference':'synthetic-test-only','absolute_return_error_by_symbol':{'2327':.01}}
    evidence['checksum']=digest(evidence)
    _,values,_,_=execution_inputs(policy,{'sealed_execution_evidence':evidence},['2327'],'b'*64,'2026-10-13',1)
    assert values.tolist()==[.01]
    with pytest.raises(ValueError,match='risk_horizon'):
        execution_inputs({'sealedExecution':{**config,'require_matched_risk_horizon':True}}, {'sealed_execution_evidence':evidence},['2327'],'b'*64,'2026-10-13',1)

def test_preseal_comparisons_and_3374_conditional_exit_use_only_chosen_legs():
    args,result=allocation(excluded_pairs=[['3374','2327']])
    config={'schema_version':SCHEMA,'rotation_mode':'selected_ready_or_filled','expiry':'retain_until_next_seal'}
    saved=seal_execution_evidence(config,args['symbols'],args['current_weights'],args['expected_gross'],args['covariance'],
        {**result,'_buy_cost':args['buy_cost'],'_sell_cost':args['sell_cost']},1e6,np.zeros(2))
    rule=saved['exit_rules']['3374']
    assert rule['mode']=='selected_ready_or_filled'
    assert [c['symbol'] for c in rule['credits']]==['2327']
    assert saved['decision_comparisons']['no_new_fills']['exposure']==pytest.approx(.1)
    assert saved['decision_comparisons']['all_new_fills']['exposure']==pytest.approx(.125)
    assert saved['scenario_probability_policy']=='stress_only_no_invented_probabilities'
    assert result['proof']['within_tolerance']

def test_conditional_policy_does_not_delay_cash_preferred_or_risk_required_exit():
    args,result=allocation(exposure_cap=.05,name_cap=.05)
    saved=seal_execution_evidence({'rotation_mode':'selected_ready_or_filled','expiry':'retain_until_next_seal'},
      args['symbols'],args['current_weights'],args['expected_gross'],args['covariance'],
      {**result,'_buy_cost':args['buy_cost'],'_sell_cost':args['sell_cost']},1e6,np.zeros(2))
    assert saved['exit_rules']['3374']['mode']=='unconditional'

def test_measured_execution_cost_changes_utility_and_capital_without_changing_broker_fee_rates():
    _,result=allocation(expected_gross=[.02,.025],name_cap=.1,exposure_cap=.1,buy_cost_adjustments=[0.,.03])
    assert result['weights']['3374']==pytest.approx(.1)
    assert result['weights']['2327']==pytest.approx(0)
    config={'schema_version':SCHEMA,'rotation_mode':'selected_ready_or_filled','expiry':'retain_until_next_seal',
      'execution_cost_calibration_checksum':'a'*64,'minimum_cost_observations':10}
    with pytest.raises(ValueError,match='cost_evidence_missing'):
        execution_inputs({'sealedExecution':config},{},['2327'],'b'*64,'2026-10-13',1)
    packet={'schema_version':'l4-observed-execution-cost-v1','calibration_checksum':'a'*64,'signal_date':'2026-10-13',
      'known_date_max':'2026-10-12','status':'verified_execution_receipts','observations':10,
      'source_reference':'synthetic-test-only','additional_buy_cost_by_symbol':{'2327':.001},'additional_sell_cost_by_symbol':{'2327':.002}}
    packet['checksum']=digest(packet)
    _,_,buy,sell=execution_inputs({'sealedExecution':config},{'sealed_execution_cost_evidence':packet},['2327'],'b'*64,'2026-10-13',1)
    assert buy.tolist()==[.001] and sell.tolist()==[.002]

def test_matched_horizon_uses_measured_matrix_and_rejects_missing_future_or_invalid_evidence():
    config={'require_matched_risk_horizon':True,'minimum_covariance_windows':20}
    prior=np.eye(2)*.001
    packet={'schema_version':'l4-measured-horizon-covariance-v1','horizon_sessions':5,
        'symbols':['3374','2327'],'signal_date':'2026-10-13','known_date_max':'2026-10-12',
        'observed_windows':20,'method':'observed_nonoverlapping_five_session_returns',
        'source_reference':'synthetic-test-only','covariance':[[.006,.001],[.001,.004]]}
    packet['checksum']=digest(packet)
    measured,evidence=aligned_covariance(config,{'five_session_risk_evidence':packet},packet['symbols'],'2026-10-13',5,prior)
    assert np.array_equal(measured,np.asarray(packet['covariance']))
    assert not np.array_equal(measured,5*prior)
    assert evidence['checksum']==packet['checksum']
    assert aligned_covariance(None,{},packet['symbols'],'2026-10-13',1,prior)[0] is prior
    for change in [None,{'known_date_max':'2026-10-14'},{'observed_windows':19},{'symbols':['2327','3374']},
                   {'covariance':[[1.,2.],[2.,1.]]}]:
        bad={**packet,**(change or {})};bad.pop('checksum',None);bad['checksum']=digest(bad)
        with pytest.raises(ValueError):
            aligned_covariance(config,{} if change is None else {'five_session_risk_evidence':bad},packet['symbols'],'2026-10-13',5,prior)

def test_runtime_seals_conditional_evidence_in_plan_hash_without_mutating_inputs():
    from copy import deepcopy
    from test_l4_distribution_runtime import fixture
    from services.l4_distribution_runtime import run
    rows,policy,history=fixture()
    policy['sealedExecution']={'schema_version':SCHEMA,'rotation_mode':'selected_ready_or_filled','expiry':'retain_until_next_seal'}
    before=deepcopy(policy)
    plan=run(rows,policy,return_history=history)[0]['_l4_portfolio_plan']
    assert plan['sealed_execution']['schema_version']==SCHEMA
    assert plan['sealed_execution']['scenario_probability_policy']=='stress_only_no_invented_probabilities'
    assert plan['plan_id']==digest({k:v for k,v in plan.items() if k!='plan_id'})
    assert plan['proof']['within_tolerance'] and plan['proof']['evaluated_candidate_count']==3
    assert policy==before
