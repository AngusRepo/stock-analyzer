"""Synthetic contract tests; acceptance fixtures are not financial evidence."""
from copy import deepcopy
from types import SimpleNamespace
import numpy as np
import pytest

from services import l4_distribution as l4, l4_residual_tabpack as tab
from services.l4_distribution_lifecycle import prepare_paper_release, ACCEPTANCE_CHECKS
from services.paper_strategy_mode import MODE, single_b_policy, disabled_receipt, valid_disabled_receipt
from test_l4_distribution import constant_model, features
from test_l4_distribution_runtime import fixture as runtime_fixture
from test_active8_paper_admission import approved, publish, ready, prepared, environment, SESSIONS


def residual(anchor):
    weights = np.zeros((34,128), np.float32)
    weights[anchor['recipe']['names'].index('LightGBM_raw'),0] = 1
    out = np.zeros((128,1), np.float32)
    out[0,0] = .1
    result = dict(schema_version=tab.SCHEMA, inputs=34, output='scalar_ev_correction',
        activation='ReLU', anchor_model_checksum=l4.digest(anchor),
        training_label_known_max='2026-08-01', residual_scale=1.,
        recipe={'native':deepcopy(anchor['recipe']), 'head_names':tab.OUTPUTS,
            'mean':[0.]*4, 'scale':[1.]*4},
        members=[{'member_id':5, 'layers':[
            {'weight':weights.tolist(), 'bias':[0.]*128},
            {'weight':out.tolist(), 'bias':[0.]}]}],
        provenance={'checkpoint_sha256':'a'*64, 'training_manifest_sha256':'b'*64})
    result['payload_checksum'] = l4.digest(result)
    return result


def released(candidate):
    candidate = deepcopy(candidate)
    candidate.pop('release', None)
    candidate['model']['residual_tabpack'] = residual(candidate['model'])
    candidate['model_checksum'] = l4.digest(candidate['model'])
    acceptance = {'schema_version':'l4-paper-acceptance-v1',
        'model_checksum':candidate['model_checksum'],
        'l3_identity_checksum':l4.digest(candidate['l3_identity']),
        'feature_schema':l4.FEATURE_SCHEMA, 'checks':dict.fromkeys(ACCEPTANCE_CHECKS, True),
        'source_evidence_checksum':'c'*64, 'acceptance_mode':'paper_experiment',
        'efficacy_status':'unproven', 'experiment_authorization':{'scope':'paper',
            'approved':True, 'source_reference':'SYNTHETIC TEST ONLY',
            'model_checksum':candidate['model_checksum']}}
    return prepare_paper_release(candidate, acceptance, signal_date='2026-09-21')


def single_config():
    _, policy, _ = runtime_fixture()
    policy['artifact'] = released(policy['artifact'])
    policy.update(operating_mode=MODE, strategy_role='B')
    policy.pop('runtime')
    return {'l4Distribution':policy}


def test_frozen_member_correction_singleton_permutation_and_anchor():
    anchor=constant_model()
    model={**anchor,'residual_tabpack':residual(anchor)}
    rows=[{'features':features(v)} for v in (.1,.5,.9)]
    actual=l4.predict(rows,model)
    assert [r['residual_ev_correction'] for r in actual] == pytest.approx([.01,.05,.09])
    assert [r['expected_return_gross'] for r in actual] == pytest.approx([0,.04,.08],abs=1e-7)
    for row, expected in zip(rows,actual):
        assert l4.predict([row],model)[0]['expected_return_gross'] == pytest.approx(expected['expected_return_gross'])
    assert l4.predict(list(reversed(rows)),model) == list(reversed(actual))
    assert all(r['three_head_expected_return_gross'] == -.01 for r in actual)


@pytest.mark.parametrize('fault', ['anchor','checksum','future','scaler','weights','member','recipe','provenance','two_owners'])
def test_corruption_never_falls_back(fault):
    anchor=constant_model(); correction=residual(anchor)
    if fault=='anchor':correction['anchor_model_checksum']='e'*64
    elif fault=='future':correction['training_label_known_max']='2026-09-21'
    elif fault=='scaler':correction['recipe']['scale'][0]=0
    elif fault=='weights':correction['members'][0]['layers'][0]['weight']=[]
    elif fault=='member':correction['members']*=2
    elif fault=='recipe':correction['recipe']['head_names']=list(reversed(tab.OUTPUTS))
    elif fault=='provenance':correction['provenance']={}
    if fault!='checksum':
        correction['payload_checksum']=l4.digest({k:v for k,v in correction.items() if k!='payload_checksum'})
    else:correction['payload_checksum']='e'*64
    model={**anchor,'residual_tabpack':correction}
    if fault=='two_owners':model['residual_mlp']={}
    candidate={'schema_version':l4.SCHEMA,'feature_schema':l4.FEATURE_SCHEMA,
        'label_schema':l4.LABEL_SCHEMA,'horizon_sessions':5,'l3_identity':{'id':'B'},
        'model':model,'model_checksum':l4.digest(model),'training_label_known_max':'2026-08-01'}
    with pytest.raises(ValueError):
        l4.validate_bundle(candidate,l3_identity={'id':'B'},signal_date='2026-09-21',require_paper_release=False)


def test_single_b_plan_preserves_account_parent_holding_and_risk():
    from services.l4_distribution_runtime import run
    rows,policy,history=runtime_fixture()
    policy['artifact']=released(policy['artifact'])
    policy.update(operating_mode=MODE,strategy_role='B')
    policy['runtime']['account'].update(active_plan_id='d'*64,available_cash=800000,
        holdings=[{'symbol':'H','market_value':200000}])
    history['H']=history['A']
    before=deepcopy(policy['runtime']['account'])
    plan=run(rows,policy,return_history=history)[0]['_l4_portfolio_plan']
    assert plan['strategy_role']=='B' and plan['strategy_mode']==MODE
    assert plan['parent_plan_id']=='d'*64 and plan['weights']['H']==pytest.approx(.2)
    assert plan['targets']['H']['locked'] and plan['weights']['A']==0
    assert plan['proof']['preselection'] is False
    assert plan['plan_id']==l4.digest({k:v for k,v in plan.items() if k!='plan_id'})
    assert policy['runtime']['account']==before


def test_disabled_tick_does_not_open_pair_objects_or_database(monkeypatch):
    from services import trading_config_loader, paper_corporate_source, paired_native_runtime
    cfg=single_config()
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config=cfg,contract=SimpleNamespace(degraded=False,malformed=False)))
    def forbidden():raise AssertionError('comparison objects must not load')
    monkeypatch.setattr(paper_corporate_source,'production_objects',forbidden)
    result=paired_native_runtime.run_native_execution_tick(session_date='2026-09-21')
    assert valid_disabled_receipt(result)
    from services.paired_nav_pipeline import complete_pipeline_shadow,pipeline_shadow_errors
    assert pipeline_shadow_errors(result)==[]
    assert complete_pipeline_shadow(result,query=forbidden,writer=forbidden)==result
    result['paired_accounts_executed']=2
    assert pipeline_shadow_errors(result)
    with pytest.raises(ValueError):complete_pipeline_shadow(result,query=forbidden,writer=forbidden)


@pytest.mark.parametrize('fault',['role','scope','release','mode','model'])
def test_unverified_mode_cannot_disable_work(fault):
    cfg=single_config();p=cfg['l4Distribution']
    if fault=='role':p['strategy_role']='A'
    elif fault=='scope':p['scope']='private_research'
    elif fault=='release':p['artifact'].pop('release')
    elif fault=='mode':p['operating_mode']='anything'
    elif fault=='model':p['artifact']['model'].pop('residual_tabpack')
    with pytest.raises(ValueError):single_b_policy(cfg,signal_date='2026-09-21')
    assert single_b_policy({}) is None


def test_new_B_publishes_through_original_atomic_paper_authority(approved, monkeypatch):
    from services.strategy_ab import TABPACK_SCHEMA,TABPACK_RECIPE
    (_,_,_,_,current),admission=approved
    bundle=admission['strategy_bundle']
    policy=bundle['candidate_trading_config']['l4Distribution']
    policy['artifact']=released(policy['artifact'])
    policy.update(operating_mode=MODE,strategy_role='B')
    from services.l4_distribution_runtime import distribution_policy_identity
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,policy['artifact']['l3_identity'])
    bundle['strategy_ab'].update(schema_version=TABPACK_SCHEMA,role='B',recipe=TABPACK_RECIPE)
    bundle['bundle_checksum']=l4.digest({k:v for k,v in bundle.items() if k!='bundle_checksum'})
    current['trading_config']=deepcopy(bundle['candidate_trading_config'])
    admission['configuration']=deepcopy(current)
    admission['admission_checksum']=l4.digest({k:v for k,v in admission.items() if k!='admission_checksum'})
    result=publish(approved)
    assert result['promotion_scope']=='paper_experiment' and result['readback_verified']
    assert result['efficacy_status']=='unproven' and 'nav_validation' not in result
    from graphs import daily_pipeline_v2 as graph
    from services import model_serving_resolver as resolver
    client=approved[0][0]
    monkeypatch.setattr(graph,'LEARNING_D1_CLIENT',client)
    pool=resolver.load_d1_champion_pool(sidecar_models=())
    manifest,_=graph._build_pipeline_modal_serving_manifest(pool,
        registry_rows=graph._pipeline_modal_registry_identity_rows(pool),
        active8_ensemble=graph._load_active8_ensemble_snapshot(pool),
        active8_shadow_selection={'selected':[{'invalid_retired_comparison':True}]})
    assert len(manifest['models'])==8
    assert manifest['active8_shadow_candidates']==[]
    assert manifest['active8_action_authority']['paper_buy_authorized'] is True
    assert manifest['active8_action_authority']['live_buy_authorized'] is False


def test_single_B_frozen_context_never_registers_comparison(monkeypatch):
    from services import paired_nav_journal as journal,paired_nav_pipeline as pipeline
    cfg=single_config()
    parent={'manifest':{'signal_date':'2026-09-21'},
        'payload':{'content':{'trading_config':cfg}}}
    monkeypatch.setattr(journal,'read_context_projection',lambda *a,**kw:parent)
    def forbidden(*a,**kw):raise AssertionError('retired comparison must not run')
    monkeypatch.setattr(pipeline,'_complete_pipeline_shadow',forbidden)
    result=pipeline.complete_pipeline_shadow({'status':'allocation_context_frozen','snapshot_id':'a'*64},
        query=forbidden,writer=forbidden,enforce_execution_window=True)
    assert valid_disabled_receipt(result)


def test_nightly_single_B_closes_formal_plan_without_pair_review_or_training(monkeypatch):
    import asyncio
    import oof_materialize_job_main as job
    from services import trading_config_loader, d1_domain_client
    from services.l4_distribution_runtime import run
    from test_l4_lifecycle_replan import Paper
    rows, policy, history = runtime_fixture()
    policy['artifact'] = released(policy['artifact'])
    policy.update(operating_mode=MODE, strategy_role='B')
    plan = run(rows, policy, return_history=history)[0]['_l4_portfolio_plan']
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
        lambda:SimpleNamespace(config={'l4Distribution':policy}))
    monkeypatch.setattr(d1_domain_client, 'client_proxy_for_domain', lambda _:Paper(plan))
    def forbidden(**kwargs):raise AssertionError('retired comparison or training must not run')
    monkeypatch.setattr(job, '_execute_daily_nav', forbidden)
    monkeypatch.setattr(job, '_execute_oof_lifecycle', forbidden)
    result = asyncio.run(job._execute_lifecycle(cadence='daily', end_date='2026-09-11',
        promote=True, dispatch_full_fit=True, expected_cohort_id=None,
        continuation_attempt=0, continuation_only=False))
    assert result['status']=='native_l4_daily_accounted'
    assert result['native_l4_daily_closure']['plan_id']==plan['plan_id']
    assert result['completion_scope']=='verified_formal_paper_plan'
    assert valid_disabled_receipt(result['paired_nav_maturity']) and not result['promoted']
