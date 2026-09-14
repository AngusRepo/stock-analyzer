"""Synthetic contract/failure tests; no production credentials or release evidence."""
from copy import deepcopy
from datetime import date,timedelta
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from services import l4_distribution as model
from services import l4_distribution_lifecycle as lifecycle
from services.l4_distribution_dataset import build_native_oof_rows,NET_LABEL_SCHEMA
from services.l4_distribution_runtime import run
from services.l4_replan import replan
from test_l4_distribution_runtime import fixture,IDENTITY,bundle


def test_native_dataset_purges_replica_labels_and_converts_cost_once():
    parent=json.loads((Path(__file__).parent/'fixtures/active8_ensemble_20260909.json').read_text(encoding='utf-8-sig'))
    parent['cohort_id']='cohort-A';parent['payload_checksum']='a'*64
    manifest={'schema_version':'active8-oof-cohort-manifest-v5','target_semantic_version':NET_LABEL_SCHEMA,
        'cohort_id':'cohort-A','manifest_checksum':'c'*64}
    rows=[]
    for fold,day,start,known in [(1,'2026-08-03','2026-08-03','2026-08-10'),(2,'2026-09-01','2026-09-01','2026-09-08')]:
        for name in model.MODELS:
            rows.append({'cohort_id':'cohort-A','fold_id':fold,'prediction_date':day,'symbol':'A',
                'model_name':name,'market_segment':'LISTED','raw_score':.3,'rank_score':.4,'train_end':'2026-07-30',
                'test_start':start,'label_known_date':known,'target_return':.02,
                'target_semantic_version':NET_LABEL_SCHEMA,'artifact_version':'test','artifact_checksum':'e'*64})
    rows=[{**r,'symbol':symbol} for r in rows for symbol in ('A','B','C')]
    seen=[]
    def meta(prior,**kwargs):
        seen.append(deepcopy(prior))
        if not prior:raise ValueError('evidence_insufficient')
        assert all(r['label_known_date']<=kwargs['knowledge_cutoff_date'] for r in prior)
        return deepcopy(parent)
    result,receipt=build_native_oof_rows(rows,manifest=manifest,parent_l3=parent,parent_identity=IDENTITY,as_of='2026-09-11',meta_builder=meta)
    assert len(result)==3 and result[0]['date']=='2026-09-01'
    assert result[0]['gross_return']==pytest.approx(.0218)
    assert result[0]['l3_training_label_known_max']=='2026-08-10'
    assert receipt['base_models_retrained'] is False and len(receipt['excluded_warmup_folds'])==1
    assert result[0]['feature_schema']==model.FEATURE_SCHEMA
    broken=deepcopy(rows);broken[-1]['train_end']='2026-09-01'
    with pytest.raises(ValueError,match='overlaps'):build_native_oof_rows(broken,manifest=manifest,parent_l3=parent,parent_identity=IDENTITY,as_of='2026-09-11',meta_builder=meta)


def test_refresh_holdout_is_never_in_fit_or_scaler(monkeypatch):
    recs,policy,_=fixture()
    from services.l4_distribution_runtime import native_features
    feature=native_features(recs[0],policy['runtime']['predictions']['A'],IDENTITY)
    rows=[]
    for i in range(40):
        d=date(2026,6,1)+timedelta(days=i)
        rows.append({'date':str(d),'symbol':'A','label_known_date':str(d+timedelta(days=5)),
            'gross_return':.01 if i%2 else -.01,'features':feature,
            'l3_baseline':__import__('services.l4_l3_baseline',fromlist=['native_baseline']).native_baseline(policy['runtime']['predictions']['A'],IDENTITY)})
    receipt={'schema_version':'l4-native-oof-dataset-v1','rows_checksum':model.digest(rows),
        'feature_schema':model.FEATURE_SCHEMA,'parent_l3_identity':IDENTITY}
    used=[]
    def fit(train,**kwargs):used.extend(train);return bundle()
    monkeypatch.setattr(lifecycle,'fit_candidate',fit)
    result=lifecycle.refresh_candidate(rows,dataset_receipt=receipt,l3_identity=IDENTITY,as_of='2026-09-11',cadence='weekly')
    assert max(r['label_known_date'] for r in used)<min(result['evaluation']['dates'])
    assert not set(r['date'] for r in used)&set(result['evaluation']['dates'])
    assert result['evaluation']['portfolio_superiority']=='requires_same_account_execution_comparison'
    receipt['rows_checksum']='0'*64
    with pytest.raises(ValueError,match='unverified'):lifecycle.refresh_candidate(rows,dataset_receipt=receipt,l3_identity=IDENTITY,as_of='2026-09-11',cadence='weekly')


class Paper:
    def __init__(self,plan):
        self.row={'payload_json':json.dumps(plan),'allocation_snapshot_id':'e'*64};self.requests={}
    def query(self,sql,args):
        if 'l4_replan_requests' in sql:return [self.requests[args[0]]] if args[0] in self.requests else []
        return [self.row]
    def batch_execute(self,items):
        for sql,args in items:
            if sql.startswith('INSERT'):self.requests.setdefault(args[0],{'result_plan_id':None})
            else:self.requests[args[1]]['result_plan_id']=args[0]
        return {'error_count':0}


def test_veto_replan_failure_retry_and_completed_idempotency(monkeypatch):
    recs,policy,history=fixture();source=run(recs,policy,return_history=history)[0]['_l4_portfolio_plan'];db=Paper(source)
    inputs={'recommendations':recs,'alpha_policy':{'l4Distribution':policy},'return_history':history,'opb_reward_ledger':[]}
    from services import paired_nav_journal
    monkeypatch.setattr(paired_nav_journal,'read_snapshot',lambda *_:{'payload':{'content':{'inputs':inputs}}})
    account=deepcopy(policy['runtime']['account']);account.update(active_plan_id=source['plan_id'],
        risk_limits={'exposure_cap':.8,'name_cap':.3,'max_positions':2,'min_trade_value':30000},fees={'buy_cost':.001,'sell_cost':.004})
    calls=[]
    def publish(plan,_):
        calls.append(plan)
        if len(calls)==1:raise RuntimeError('publication_failed')
    args=dict(plan_id=source['plan_id'],veto_symbols=['B'],reason='debate_reject',paper=db,
        learning=SimpleNamespace(query=None),account_reader=lambda _:deepcopy(account),publisher=publish)
    with pytest.raises(RuntimeError,match='publication_failed'):replan(**args)
    assert list(db.requests.values())[0]['result_plan_id'] is None
    receipt=replan(**args)
    assert calls[-1]['weights']['B']==0 and calls[-1]['proof']['evaluated_candidate_count']==3
    assert calls[-1]['weights']['C']>0 and calls[-1]['parent_plan_id']==source['plan_id']
    assert replan(**args)==receipt and len(calls)==2
    assert policy['runtime']['account']['active_plan_id'] is None


def test_old_intervention_cannot_report_a_fake_new_l4_contrast():
    from services.paired_nav_intervention import run_isolated_allocation
    with pytest.raises(ValueError,match='legacy_intervention_incompatible'):
        run_isolated_allocation(inputs={'alpha_policy':{'l4Distribution':{}},'ranking_config':{}},inherited_state={},forecasts={'A':.02})


def test_release_packet_binds_evidence_and_preserves_account_configuration():
    from services.l4_release_packet import prepare_packet
    from services.l4_distribution_runtime import distribution_policy_identity
    candidate=bundle();_,policy,_=fixture();constraints=policy['constraints']
    from services.l4_allocation_contract import inherited_sparse_controls
    constraints.update(inherited_sparse_controls({}))
    opb={'enabled':True,'arms':[{'id':'base','constraints':{}}]}
    identity=distribution_policy_identity({'artifact':candidate,'constraints':constraints,'opb':opb},IDENTITY)
    evidence={'scope':'paired_native_paper_execution','complete':True,'opb_policy':{'enabled':True,
        'approved_policy_identity':identity,'arms':[{'id':'base','constraints':{}}]},
        'paired_comparison_checksum':model.digest(candidate['release']['validation_receipt']['paired_account_comparison'])}
    acceptance=deepcopy(candidate['release']['validation_receipt']);acceptance['source_evidence_checksum']=model.digest(evidence)
    cfg={'position':{'maxPositions':2},'fees':{'commission':.001,'tax':.003},'ranking':{'enabled':True},'unrelated':{'keep':True}}
    args=dict(current_config=cfg,candidate=candidate,acceptance=acceptance,source_evidence=evidence,
        l3_identity=IDENTITY,current_l3_identity=deepcopy(IDENTITY),constraints=constraints,signal_date='2026-09-11')
    missing={k:v for k,v in args.items() if k!='current_l3_identity'}
    with pytest.raises(ValueError,match='verified_current_l3_required'):
        prepare_packet(**missing)
    with pytest.raises(ValueError,match='verified_current_l3_required'):
        prepare_packet(**{**args,'current_l3_identity':{}})
    changed={**IDENTITY,'payload_checksum':'f'*64}
    with pytest.raises(ValueError,match='initial_cutover_cannot_change_l3'):
        prepare_packet(**{**args,'current_l3_identity':changed})
    packet=prepare_packet(**args)
    assert packet['l3_publication_qualification']=='unchanged_incumbent'
    assert packet['l3_nav_gate_waived'] is False and packet['pending_release_checks']==[]
    assert packet['rollback_config']==cfg and packet['next_config']['unrelated']==cfg['unrelated']
    assert not packet['reset_account'] and not packet['remote_mutations_executed']
    args['constraints']={**constraints,'max_positions':3}
    with pytest.raises(ValueError,match='unapproved_position_count'):prepare_packet(**args)
    args['source_evidence']={**evidence,'complete':False}
    with pytest.raises(ValueError,match='checksum_mismatch'):prepare_packet(**args)


def test_daily_new_l4_closes_its_plan_without_legacy_oof_or_retraining(monkeypatch):
    import asyncio
    import oof_materialize_job_main as job
    from services import trading_config_loader,d1_domain_client
    recs,policy,history=fixture();plan=run(recs,policy,return_history=history)[0]['_l4_portfolio_plan']
    db=Paper(plan)
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={'l4Distribution':policy}))
    monkeypatch.setattr(d1_domain_client,'client_proxy_for_domain',lambda _:db)
    calls=[]
    def nav(**kwargs):
        calls.append(kwargs);return {'status':'accounted','as_of_date':'2026-09-11'}
    monkeypatch.setattr(job,'_execute_daily_nav',nav)
    async def no_oof(**kwargs):pytest.fail('new L4 daily must not dispatch old EV OOF or full-fit training')
    monkeypatch.setattr(job,'_execute_oof_lifecycle',no_oof)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-09-11',promote=False,
        dispatch_full_fit=True,expected_cohort_id=None,continuation_attempt=0,continuation_only=False))
    assert calls==[{'end_date':'2026-09-11','retire_legacy_owners':True}]
    assert result['status']=='native_l4_daily_accounted'
    assert result['native_l4_daily_closure']['legacy_oof_maturity_requested'] is False
    assert result['native_l4_daily_closure']['training_dispatched'] is False


def test_opb_definition_change_cannot_inherit_other_policy_rewards():
    from services.l4_distribution_runtime import distribution_policy_identity
    _,policy,_=fixture();before=distribution_policy_identity(policy,IDENTITY)
    policy['opb']={'enabled':True,'arms':[{'id':'base','constraints':{}}],'exploration':.01}
    after=distribution_policy_identity(policy,IDENTITY)
    assert before!=after
    policy['opb']['approved_policy_identity']=after
    assert distribution_policy_identity(policy,IDENTITY)==after
    policy['opb']['exploration']=.02
    assert distribution_policy_identity(policy,IDENTITY)!=after


def test_joint_upgrade_packet_requires_prior_pair_and_preserves_head():
    from services.l4_release_packet import prepare_packet
    from services.l4_distribution_runtime import distribution_policy_identity
    candidate=bundle();_,policy,_=fixture();constraints=policy['constraints']
    from services.l4_allocation_contract import inherited_sparse_controls
    constraints.update(inherited_sparse_controls({}))
    opb={'enabled':True,'arms':[{'id':'base','constraints':{}}]}
    opb['approved_policy_identity']=distribution_policy_identity({'artifact':candidate,'constraints':constraints,'opb':opb},IDENTITY)
    evidence={'scope':'paired_native_paper_execution','complete':True,'opb_policy':opb,
        'paired_comparison_checksum':model.digest(candidate['release']['validation_receipt']['paired_account_comparison'])}
    acceptance=deepcopy(candidate['release']['validation_receipt']);acceptance['source_evidence_checksum']=model.digest(evidence)
    prior=deepcopy(IDENTITY);prior['artifact_id']='previous-L3'
    cfg={'l4Distribution':{'artifact':{'l3_identity':prior}},'position':{'maxPositions':2},
         'fees':{'commission':.001,'tax':.003},'ranking':{'enabled':True}}
    args=dict(current_config=cfg,candidate=candidate,acceptance=acceptance,source_evidence=evidence,
        l3_identity=IDENTITY,constraints=constraints,signal_date='2026-09-11')
    with pytest.raises(ValueError,match='verified_current'):prepare_packet(**args)
    packet=prepare_packet(**args,current_l3_identity=prior,current_plan_id='d'*64)
    assert packet['release_kind']=='paired_upgrade' and packet['expected_initial_plan_parent']=='d'*64
    assert packet['l3_publication_qualification']=='native_nav_required'
    assert packet['pending_release_checks']==['native_l3_nav_adoption']
    assert packet['l3_nav_gate_waived'] is False
    assert packet['expected_l3_identity']==prior and packet['next_l3_identity']==IDENTITY
    assert packet['reset_account'] is False and packet['cross_database_atomicity'] is False


def test_refresh_target_is_an_integrity_checked_candidate_not_serving_mutation():
    from scripts.l4_distribution_refresh_job import load_target_parent
    parent=json.loads((Path(__file__).parent/'fixtures/active8_ensemble_20260909.json').read_text(encoding='utf-8-sig'))
    record={k:parent[k] for k in ('cohort_id','payload_checksum','base_artifact_set_checksum')}
    record.update(artifact_id='candidate-L3',state='candidate',payload_json=json.dumps(parent))
    calls=[]
    def query(sql,args):calls.append((sql,args));return [record]
    _,identity=load_target_parent('candidate-L3',SimpleNamespace(query=query))
    assert identity['artifact_id']=='candidate-L3' and len(calls)==1 and calls[0][0].startswith('SELECT')
    record['payload_checksum']='f'*64
    with pytest.raises(ValueError,match='integrity'):load_target_parent('candidate-L3',SimpleNamespace(query=query))


def test_three_temporal_cv_blocks_preserve_approved_recipe_and_purge():
    rows = []
    for index in range(24):
        day = date(2026, 1, 1) + timedelta(days=index)
        rows.append({'date': str(day), 'label_known_date': str(day + timedelta(days=5))})
    blocks = lifecycle.chronological_validation_blocks(rows)
    assert blocks == [[r['date'] for r in rows[start:end]]
                      for start, end in [(12, 16), (16, 20), (20, 24)]]
    for block in blocks:
        train = [r for r in rows if r['label_known_date'] < block[0]]
        assert train and max(r['label_known_date'] for r in train) < min(block)
        assert not {r['date'] for r in train}.intersection(block)
    assert lifecycle.chronological_validation_blocks(list(reversed(rows))) == blocks
    with pytest.raises(ValueError, match='three_fold_history_insufficient'):
        lifecycle.chronological_validation_blocks(rows[:4])


@pytest.mark.parametrize('missing',[
    'native_l3_input_contract_complete','allocator_risk_mechanism_parity',
    'opb_nonstationary_reward_parity','full_pool_runtime_budget',
])
def test_release_rejects_partial_mechanism_receipts(missing):
    candidate=bundle()
    receipt=deepcopy(candidate['release']['validation_receipt'])
    receipt['checks'].pop(missing)
    with pytest.raises(ValueError,match='acceptance_evidence_incomplete'):
        lifecycle.prepare_paper_release(candidate,receipt,signal_date='2026-09-11')


def test_paper_experiment_is_explicitly_authorized_without_fabricated_superiority():
    candidate=bundle();receipt=deepcopy(candidate['release']['validation_receipt'])
    receipt.pop('paired_account_comparison')
    receipt.update(acceptance_mode='paper_experiment',efficacy_status='unproven',
        experiment_authorization={'scope':'paper','approved':True,'source_reference':'synthetic-test-authorization',
                                  'model_checksum':candidate['model_checksum']})
    released=lifecycle.prepare_paper_release(candidate,receipt,signal_date='2026-09-11')
    assert released['release']['efficacy_status']=='unproven'
    assert released['release']['acceptance_mode']=='paper_experiment'
    broken=deepcopy(receipt);broken['checks']['end_to_end_execution']=False
    with pytest.raises(ValueError,match='acceptance_evidence_incomplete'):
        lifecycle.prepare_paper_release(candidate,broken,signal_date='2026-09-11')
    broken=deepcopy(receipt);broken['experiment_authorization']['scope']='live'
    with pytest.raises(ValueError,match='experiment_authorization_missing'):
        lifecycle.prepare_paper_release(candidate,broken,signal_date='2026-09-11')
    broken=deepcopy(receipt);broken['acceptance_mode']='comparative_promotion'
    with pytest.raises(ValueError,match='paired_l3_comparison_missing'):
        lifecycle.prepare_paper_release(candidate,broken,signal_date='2026-09-11')


def test_complete_paper_trial_packet_preserves_native_controls_without_profit_claim():
    from services.l4_release_packet import prepare_packet
    from services.l4_allocation_contract import initial_paper_constraints,native_opb_policy
    from services.l4_distribution_runtime import distribution_policy_identity
    candidate=bundle()
    cfg={'position':{'maxPositions':5,'maxPctOfPortfolio':.25},'fees':{'commission':.001425,'tax':.003},
         'ranking':{'enabled':True},'alphaFramework':{'allocation':{'riskAversion':3.,'l2Penalty':.02}},
         'l4AlphaEv':{'legacy':True},'allocatorEvFusion':{'legacy':True}}
    constraints=initial_paper_constraints(cfg)
    assert constraints['min_weight']==0 and constraints['exposure_cap']==1
    opb=native_opb_policy(constraints)
    opb['approved_policy_identity']=distribution_policy_identity({'artifact':candidate,'constraints':constraints,'opb':opb},IDENTITY)
    evidence={'scope':'native_engineering_paper_execution','complete':True,'opb_policy':opb}
    receipt=deepcopy(candidate['release']['validation_receipt']);receipt.pop('paired_account_comparison')
    receipt.update(acceptance_mode='paper_experiment',efficacy_status='unproven',
        source_evidence_checksum=model.digest(evidence),experiment_authorization={'scope':'paper','approved':True,
        'source_reference':'synthetic-test-only','model_checksum':candidate['model_checksum']})
    args=dict(current_config=cfg,candidate=candidate,acceptance=receipt,source_evidence=evidence,
              l3_identity=IDENTITY,current_l3_identity=deepcopy(IDENTITY),constraints=constraints,signal_date='2026-09-11')
    packet=prepare_packet(**args)
    next_config=packet['next_config']
    assert next_config['l4Distribution']['artifact']['release']['efficacy_status']=='unproven'
    assert next_config['l4Distribution']['constraints']['risk_aversion']==3
    assert len(next_config['l4Distribution']['opb']['arms'])==6
    assert 'l4AlphaEv' not in next_config and 'allocatorEvFusion' not in next_config
    assert packet['rollback_config']==cfg and packet['remote_mutations_executed'] is False
    with pytest.raises(ValueError,match='native_sparse_controls_not_aligned'):
        prepare_packet(**{**args,'constraints':{**constraints,'risk_aversion':1}})
    with pytest.raises(ValueError,match='unapproved_position_count_change'):
        prepare_packet(**{**args,'constraints':{**constraints,'max_positions':None}})
