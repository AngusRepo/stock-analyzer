from copy import deepcopy
from datetime import datetime,timezone
import numpy as np
import pytest
from services import l4_distribution as m
from services.l4_distribution_runtime import native_features,run,choose_opb
from services.l4_distribution_lifecycle import prepare_paper_release,ACCEPTANCE_CHECKS
from test_l4_distribution import constant_model

IDENTITY={'schema_version':'paired-nav-formal-ml-baseline-v1','artifact_id':'native-A',
          'cohort_id':'cohort-A','payload_checksum':'a'*64,'base_artifact_set_checksum':'b'*64}


def prediction(rank=.5):
    return {'rank_scores':{name:rank for name in m.MODELS},
        'model_score_lineage':{'raw_scores':{name:rank for name in m.MODELS}},
        'ensemble_v2':{'artifact_id':'native-A','cohort_id':'cohort-A','artifact_checksum':'a'*64,
          'base_artifact_set_checksum':'b'*64,'avg_rank':.5,'probability_positive_net_return':.5,
          'avg_rank_semantic':'compatibility_alias_probability_positive_net_return','lineage_status':'complete',
          'validation':{'decision':'PASS'},'signal':'HOLD',
          'target_semantic_version':'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4',
          'forecast_horizon_bars':5,'forecast_return_5bar_source':'active8_ensemble_expected_net_return',
          'forecast_return_5bar_owner':'active8_ensemble_artifact',
          'forecast_return_5bar':.01,'ml_expected_net_return':.01}}


def bundle():
    model=constant_model()
    model['heads']['gain']['intercept']=.08
    model['heads']['loss']['intercept']=.02
    candidate={'schema_version':m.SCHEMA,'feature_schema':m.FEATURE_SCHEMA,'label_schema':m.LABEL_SCHEMA,
        'horizon_sessions':5,'l3_identity':IDENTITY,'model':model,'model_checksum':m.digest(model),
        'training_label_known_max':'2026-08-01'}
    # Test-only acceptance fixture. Never emitted as a deployable artifact.
    receipt={'schema_version':'l4-paper-acceptance-v1','model_checksum':candidate['model_checksum'],
        'l3_identity_checksum':m.digest(IDENTITY),'feature_schema':m.FEATURE_SCHEMA,
        'checks':dict.fromkeys(ACCEPTANCE_CHECKS,True),'source_evidence_checksum':'c'*64,
        'paired_account_comparison':__import__('l4_comparison_fixture').comparison(candidate)}
    return prepare_paper_release(candidate,receipt,signal_date='2026-09-11')


def fixture():
    recs=[{'symbol':s,'signal':'SELL','confidence':.1,'eligible_for_pending_buy':1,
           'score_components':{'components':{'mlEdge':12.5}}} for s in ('A','B','C')]
    policy={'scope':'paper','artifact':bundle(),'constraints':{'exposure_cap':.8,'name_cap':.3,'min_weight':.03,
         'max_positions':2,'buy_cost':.001,'sell_cost':.004},
        'runtime':{'signal_date':'2026-09-11','l3_identity':IDENTITY,
            'predictions':{r['symbol']:prediction() for r in recs},
            'account':{'schema_version':'l4-account-context-v1','account_id':1,'signal_date':'2026-09-11',
                'active_plan_id':None,'observed_at':datetime.now(timezone.utc).isoformat(),'nav':1000000,
                'available_cash':1000000,'complete':True,'holdings':[], 'forbidden_buys':['A']}}}
    history={s:(np.sin(np.arange(30)+i)*.01).tolist() for i,s in enumerate(('A','B','C'))}
    return recs,policy,history


def test_native_semantic_and_lineage_are_not_rank_aliases():
    recs,policy,_=fixture();p=prediction()
    assert native_features(recs[0],p,IDENTITY)['ml_edge_norm']==.5
    p['ensemble_v2']['avg_rank_semantic']='cross_sectional_rank'
    with pytest.raises(ValueError,match='semantic_mismatch'): native_features(recs[0],p,IDENTITY)
    p=prediction();p['ensemble_v2']['artifact_checksum']='f'*64
    with pytest.raises(ValueError,match='lineage_mismatch'): native_features(recs[0],p,IDENTITY)
    p=prediction();recs[0]['score_components']['components']['mlEdge']=20
    with pytest.raises(ValueError,match='ml_edge_semantic'): native_features(recs[0],p,IDENTITY)


def test_full_pool_owns_selection_preserves_l3_and_has_replay_identity():
    rows,policy,history=fixture();sink=[]
    before=deepcopy(rows)
    result=run(rows,policy,return_history=history,evidence_sink=sink.append)
    plan=result[0]['_l4_portfolio_plan']
    assert rows==before
    assert plan['weights']['A']==0
    assert plan['proof']['evaluated_candidate_count']==3
    assert sum(w>0 for w in plan['weights'].values())==2
    assert all(r['ml_advisory']['signal']=='SELL' for r in result)
    assert {r['alpha_allocation']['expected_return_owner'] for r in result}=={'l4_distribution'}
    assert m.digest({k:v for k,v in plan.items() if k!='plan_id'})==plan['plan_id']
    assert len(sink)==1
    assert run(rows,policy,return_history=history)==result


def test_held_outside_pool_stays_in_portfolio_and_reserves_capital():
    rows,policy,history=fixture()
    policy['runtime']['account'].update(available_cash=800000,holdings=[{'symbol':'H','market_value':200000}])
    history['H']=history['A']
    plan=run(rows,policy,return_history=history)[0]['_l4_portfolio_plan']
    assert plan['targets']['H']['locked'] and plan['weights']['H']==pytest.approx(.2)
    assert plan['proof']['evaluated_candidate_count']==4
    assert sum(w>1e-7 for w in plan['weights'].values())<=2


@pytest.mark.parametrize('mutation,error',[
    (lambda p:p['runtime']['account'].update(complete=False),'stale_or_incomplete'),
    (lambda p:p['artifact']['release']['validation_receipt']['checks'].update(partial_fills=False),'evidence_incomplete'),
    (lambda p:p['artifact'].update(feature_schema='full-l3-30-v1'),'contract_mismatch'),
])
def test_invalid_runtime_never_falls_back(mutation,error):
    rows,policy,history=fixture();mutation(policy)
    with pytest.raises(ValueError,match=error):run(rows,policy,return_history=history)


def test_opb_uses_complete_own_account_rewards_and_does_not_truncate():
    _,policy,_=fixture();identity='d'*64
    policy['opb']={'enabled':True,'approved_policy_identity':identity,'exploration':.01,
        'arms':[{'id':'base','constraints':{}},{'id':'lower_risk','constraints':{'risk_aversion':2.}}]}
    constraints,evidence=choose_opb(policy,[],identity,'2026-09-11')
    assert evidence['status']=='cold_start_base' and constraints==policy['constraints']
    reward={'policy_identity':identity,'arm_id':'base','complete':True,'known_date':'2026-09-10',
            'reward_kind':'complete_policy_account_net_return','reward':-.03}
    _,evidence=choose_opb(policy,[reward],identity,'2026-09-11')
    assert evidence['arm_id']=='lower_risk'
    reward['reward_kind']='selected_stock_return'
    with pytest.raises(ValueError,match='reward_contract'):choose_opb(policy,[reward],identity,'2026-09-11')
    policy['opb']['arms'][1]['constraints']['max_positions']=1
    # Force the prohibited override to win.
    with pytest.raises(ValueError,match='forbidden_override'):
        choose_opb(policy,[dict(reward,reward_kind='complete_policy_account_net_return')],identity,'2026-09-11')


def test_attested_l3_excluded_core_is_masked_but_unexplained_missing_core_fails():
    recs,_,_=fixture();p=prediction()
    for field in (p['rank_scores'],p['model_score_lineage']['raw_scores']):del field['LightGBM']
    with pytest.raises(ValueError,match='native_model_missing:LightGBM'):native_features(recs[0],p,IDENTITY)
    p['model_score_lineage'].update(coverage_policy='validated-bundle-selected-core-sequence-missingness-v1',
        selected_models=[n for n in m.MODELS if n!='LightGBM'],ensemble_payload_checksum='a'*64,complete=True)
    result=native_features(recs[0],p,IDENTITY)
    assert result['LightGBM_available']==0 and result['LightGBM_raw'] is None
    p['model_score_lineage']['ensemble_payload_checksum']='f'*64
    with pytest.raises(ValueError,match='native_model_missing:LightGBM'):native_features(recs[0],p,IDENTITY)


def test_unreleased_candidate_only_runs_with_private_host_capability():
    rows,policy,history=fixture()
    policy['artifact'].pop('release')
    policy['scope']='private_research'
    with pytest.raises(ValueError,match='scope_invalid'):
        run(rows,policy,return_history=history)
    result=run(rows,policy,return_history=history,private_research=True)
    assert result[0]['_l4_portfolio_plan']['execution_scope']=='private_research'
    assert 'release' not in policy['artifact']
    policy['scope']='paper'
    with pytest.raises(ValueError,match='paper_release_missing'):
        run(rows,policy,return_history=history,private_research=True)


def test_opb_recent_regime_and_native_estimator_parity_without_fake_priors():
    from datetime import date,timedelta
    from services.online_portfolio_bandit import _decayed_reward_stats
    _,policy,_=fixture();identity='d'*64
    policy['opb']={'enabled':True,'approved_policy_identity':identity,'exploration':0.,
        'arms':[{'id':'base','constraints':{}},{'id':'cautious','constraints':{'risk_aversion':2.}}]}
    ledger=[]
    for index in range(90):
        known=str(date(2026,1,1)+timedelta(days=index))
        for arm in ('base','cautious'):
            ledger.append({'policy_identity':identity,'arm_id':arm,'complete':True,'known_date':known,
                'reward_kind':'complete_policy_account_net_return',
                'reward':(.1 if index<60 else -.1) if arm=='base' else .001})
    # All-history average favors base; the existing nonstationary estimator
    # responds to the recent reversal and favors cautious.
    assert np.mean([r['reward'] for r in ledger if r['arm_id']=='base'])>.001
    _,evidence=choose_opb(policy,ledger,identity,'2026-09-11')
    assert evidence['arm_id']=='cautious'
    expected=_decayed_reward_stats([r for r in ledger if r['arm_id']=='base'])
    for key,value in expected.items():
        assert evidence['arm_statistics']['base'][key]==pytest.approx(value)
    assert evidence['samples']==120 and evidence['fabricated_prior_samples']==0
    assert choose_opb(policy,list(reversed(ledger)),identity,'2026-09-11')[1]==evidence
    with pytest.raises(ValueError,match='duplicate_reward'):
        choose_opb(policy,ledger+[ledger[-1]],identity,'2026-09-11')


def test_opb_rejects_invalid_dormant_arm_before_cold_start_release():
    _,policy,_=fixture();identity='d'*64
    policy['opb']={'enabled':True,'approved_policy_identity':identity,'exploration':.01,
        'arms':[{'id':'base','constraints':{}},{'id':'invalid','constraints':{'max_positions':1}}]}
    with pytest.raises(ValueError,match='forbidden_override'):
        choose_opb(policy,[],identity,'2026-09-11')
    policy['opb']['arms'][1]['constraints']={'name_cap':1.}
    with pytest.raises(ValueError,match='exceeds_hard_risk'):
        choose_opb(policy,[],identity,'2026-09-11')


@pytest.mark.parametrize('held', [False, True])
def test_attested_missing_l3_keeps_full_pool_without_fake_forecast_or_liquidation(held):
    rows, policy, history = fixture()
    p = policy['runtime']['predictions']['B']
    p['ensemble_v2'] = {'lineage_status': 'incomplete'}
    p['model_score_lineage'].update(complete=False, blockers=['selected_model_evidence_missing'],
        coverage_policy='validated-bundle-selected-core-sequence-missingness-v1',
        ensemble_payload_checksum=IDENTITY['payload_checksum'], run_date='2026-09-11')
    if held:
        policy['runtime']['account'].update(available_cash=900000,
            holdings=[{'symbol':'B','market_value':100000}])
    result = run(rows, policy, return_history=history)
    plan = result[0]['_l4_portfolio_plan']
    assert len(result) == plan['proof']['evaluated_candidate_count'] == 3
    assert plan['prediction_coverage']['available'] == 2
    assert plan['targets']['B']['expected_return_gross'] is None
    assert plan['targets']['B']['distribution'] is None
    assert 'B' in plan['forbidden_buys']
    assert plan['weights']['B'] == pytest.approx(.1 if held else 0)
    assert plan['weights']['C'] > 0
    blocked = next(row for row in result if row['symbol'] == 'B')
    assert blocked['signal'] == 'HOLD' and blocked['has_buy_signal'] == 0
    assert blocked['alpha_allocation']['expected_return'] is None
    assert blocked['alpha_allocation']['selection_reason'] == 'l3_evidence_unavailable'
    assert set(plan['input_attribution']['candidate_input_checksums']) == {'A','B','C'}
    # A wrong parent identity must never be downgraded to an ordinary coverage gap.
    p['model_score_lineage']['ensemble_payload_checksum'] = 'f' * 64
    with pytest.raises(ValueError, match='prediction_lineage_mismatch'):
        run(rows, policy, return_history=history)


def test_all_candidates_without_l3_evidence_hold_cash_without_truncation():
    rows, policy, history = fixture()
    for p in policy['runtime']['predictions'].values():
        p['ensemble_v2'] = {'lineage_status': 'incomplete'}
        p['model_score_lineage'].update(complete=False, blockers=['selected_model_evidence_missing'],
            coverage_policy='validated-bundle-selected-core-sequence-missingness-v1',
            ensemble_payload_checksum=IDENTITY['payload_checksum'], run_date='2026-09-11')
    plan = run(rows, policy, return_history=history)[0]['_l4_portfolio_plan']
    assert plan['cash_weight'] == pytest.approx(1)
    assert plan['proof']['evaluated_candidate_count'] == 3
    assert plan['prediction_coverage']['available'] == 0
