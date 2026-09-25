"""Synthetic models, real release validators; no performance or serving claims."""
from copy import deepcopy
from pathlib import Path
import pytest
from services.paired_nav_journal import digest
from services.paired_nav_strategy_bundle import (
    SCHEMA,validate_strategy_bundle,arm_configuration,verify_strategy_inputs)
from services.l4_allocation_contract import initial_paper_constraints,native_opb_policy
from services.l4_distribution_runtime import distribution_policy_identity
from test_l4_distribution_runtime import fixture,IDENTITY

DAY='2026-09-11'


def fixture_bundle():
    _,policy,history=fixture()
    baseline={'fees':{'commission':.001,'tax':.003},
        'position':{'maxPositions':2,'maxPctOfPortfolio':.3},
        'ranking':{'enabled':True},'l4AlphaEv':{'historical_owner':True}}
    policy={k:v for k,v in policy.items() if k!='runtime'}
    policy['constraints']=initial_paper_constraints(baseline)
    policy['opb']=native_opb_policy(policy['constraints'])
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,IDENTITY)
    old={**IDENTITY,'artifact_id':'old-l3','payload_checksum':'d'*64}
    bundle={'schema_version':SCHEMA,'comparison_unit':'complete_l3_l4_strategy',
        'declared_signal_date':DAY,'baseline_l3_identity':old,'candidate_l3_identity':IDENTITY,
        'baseline_trading_config':baseline,
        'candidate_trading_config':{k:v for k,v in baseline.items() if k!='l4AlphaEv'},
        'source_evidence_checksum':'c'*64,'production_effect':False}
    bundle['candidate_trading_config']['l4Distribution']=policy
    bundle['bundle_checksum']=digest(bundle)
    config={'trading_config':deepcopy(baseline),'formal_baseline_identity':old,'strategy_bundle':bundle}
    return bundle,config,history


def reseal(bundle):
    bundle['bundle_checksum']=digest({k:v for k,v in bundle.items() if k!='bundle_checksum'})


def test_complete_chain_has_distinct_policies_same_risk_and_no_promotion():
    bundle,config,_=fixture_bundle()
    assert validate_strategy_bundle(bundle,candidate_identity=IDENTITY,signal_date=DAY)==bundle
    baseline=arm_configuration(config,'baseline',signal_date=DAY)
    candidate=arm_configuration(config,'candidate',signal_date=DAY)
    assert 'l4Distribution' not in baseline and 'l4AlphaEv' in baseline
    assert 'l4Distribution' in candidate and 'l4AlphaEv' not in candidate
    for key in ('fees','position','ranking'):assert baseline[key]==candidate[key]
    candidate['fees']['commission']=.9
    assert bundle['candidate_trading_config']['fees']['commission']==.001
    assert bundle['production_effect'] is False


@pytest.mark.parametrize('fault',['fees','position','model','unsealed','scope','runtime','old_owner','future'])
def test_changed_or_unpaired_policy_cannot_reuse_nav_contrast(fault):
    bundle,_,_=fixture_bundle()
    target=bundle['candidate_trading_config']
    if fault=='fees':target['fees']=dict(target['fees'],commission=.002)
    elif fault=='position':target['position']=dict(target['position'],maxPositions=9)
    elif fault=='model':bundle['candidate_l3_identity']={**IDENTITY,'payload_checksum':'e'*64}
    elif fault=='scope':target['l4Distribution']['scope']='private_research'
    elif fault=='runtime':target['l4Distribution']['runtime']={}
    elif fault=='old_owner':target['l4AlphaEv']={}
    elif fault=='future':bundle['declared_signal_date']='2026-09-12'
    else:bundle['source_evidence_checksum']='a'*64
    if fault!='unsealed':reseal(bundle)
    with pytest.raises(ValueError):validate_strategy_bundle(bundle,signal_date=DAY)


@pytest.mark.parametrize('copy_inputs', [True, False])
def test_runtime_inputs_cannot_borrow_old_predictions_or_policy(copy_inputs):
    bundle,config,history=fixture_bundle()
    rows,policy,_=fixture()
    policy={**deepcopy(bundle['candidate_trading_config']['l4Distribution']),
        'runtime':policy['runtime']}
    old={'recommendations':rows,'alpha_policy':{'l4AlphaEv':{}},'return_history':history,
        'ranking_config':{},'ensemble_v2_cfg':{},'regime_label':'x','regime_surface':{}}
    new={**deepcopy(old),'alpha_policy':{'l4Distribution':policy}}
    parent={'inputs':old,'strategy_allocation_input_arms':{'baseline':old,'candidate':new},
        'model_prediction_arms':{'candidate':{'predictions':deepcopy(policy['runtime']['predictions'])}}}
    if not copy_inputs:
        class NoUnusedCopy(dict):
            def __deepcopy__(self, memo):
                raise AssertionError('validation must not duplicate full input history')
        parent['strategy_allocation_input_arms'] = NoUnusedCopy(parent['strategy_allocation_input_arms'])
    result = verify_strategy_inputs(config,parent,signal_date=DAY,copy_inputs=copy_inputs)
    assert (result['candidate']==new) if copy_inputs else result is None
    new['alpha_policy']['l4Distribution']['runtime']['predictions']['A']['ensemble_v2']['artifact_checksum']='d'*64
    with pytest.raises(ValueError,match='candidate_predictions_changed'):
        verify_strategy_inputs(config,parent,signal_date=DAY,copy_inputs=copy_inputs)


def test_legacy_immutable_comparison_remains_compatible():
    config={'trading_config':{'fees':{'commission':.001}}}
    assert arm_configuration(config,'candidate',signal_date=DAY)==config['trading_config']
    assert verify_strategy_inputs(config,{},signal_date=DAY) is None


def test_whole_chain_nav_cannot_authorize_l3_only_under_old_policy():
    from services.paired_nav_strategy_bundle import publication_configuration
    bundle,configuration,_=fixture_bundle()
    before=deepcopy(configuration)
    required=publication_configuration(configuration,signal_date=DAY)
    assert required['trading_config']==bundle['candidate_trading_config']
    assert required['trading_config']!=bundle['baseline_trading_config']
    assert configuration==before
    assert required['strategy_bundle']['baseline_trading_config']==before['trading_config']


from test_paired_nav_l3_candidate import prepared,environment,native_runner


def test_full_l3_to_three_heads_to_original_allocation_pair(prepared,monkeypatch,native_runner):
    from services import paired_nav_l3_candidate as l3
    from services.paired_nav_collection import run_and_capture_allocation,baseline_model_identity
    from services.paired_nav_recommendation_path import run_and_capture_recommendation_path
    from services.paired_nav_intervention import run_isolated_allocation
    from services.paired_nav_journal import read_snapshot
    from services.paired_nav_comparison import resolve_allocation_comparison
    from services.l4_distribution_lifecycle import prepare_paper_release,ACCEPTANCE_CHECKS
    from services import l4_distribution_context as bridge
    from test_paired_nav_l3_candidate import DAY as day
    from test_paired_nav_intervention import inputs as allocation_inputs
    from test_paired_nav_journal import FEES
    db,_,manifest,rec_inputs,selection=prepared
    artifact=selection['candidates'][0]['artifact']
    identity={'schema_version':'paired-nav-formal-ml-baseline-v1',
        'artifact_id':selection['candidates'][0]['registry']['artifact_id'],
        **{k:artifact[k] for k in ('cohort_id','payload_checksum','base_artifact_set_checksum')}}
    cfg={'fees':FEES,'position':{'maxPositions':5,'maxPctOfPortfolio':.25},
        'ranking':{'enabled':True}}
    rows,policy,history=fixture()
    model=deepcopy(policy['artifact']);model.pop('release');model['l3_identity']=identity
    acceptance={'schema_version':'l4-paper-acceptance-v1','model_checksum':model['model_checksum'],
        'l3_identity_checksum':digest(identity),'feature_schema':model['feature_schema'],
        'checks':dict.fromkeys(ACCEPTANCE_CHECKS,True),'source_evidence_checksum':'c'*64,
        'acceptance_mode':'paper_experiment','efficacy_status':'unproven',
        'experiment_authorization':{'scope':'paper','approved':True,'source_reference':'synthetic-test-only',
            'model_checksum':model['model_checksum']}}
    policy={'scope':'paper','artifact':prepare_paper_release(model,acceptance,signal_date=day),
        'constraints':initial_paper_constraints(cfg)}
    policy['opb']=native_opb_policy(policy['constraints'])
    policy['opb']['approved_policy_identity']=distribution_policy_identity(policy,identity)
    bundle={'schema_version':SCHEMA,'comparison_unit':'complete_l3_l4_strategy','declared_signal_date':day,
        'baseline_l3_identity':baseline_model_identity(manifest),'candidate_l3_identity':identity,
        'baseline_trading_config':deepcopy(cfg),'candidate_trading_config':{**deepcopy(cfg),'l4Distribution':policy},
        'source_evidence_checksum':'c'*64,'production_effect':False}
    reseal(bundle)
    selection['candidates'][0]['strategy_bundle']=bundle
    selection['comparison_unit']='complete_l3_l4_strategy'
    account={'schema_version':'l4-account-context-v1','account_id':1,'signal_date':day,
        'complete':True,'holdings':[],'nav':1000000.,'available_cash':1000000.,
        'active_plan_id':None,'risk_limits':{'exposure_cap':1.,'name_cap':.25,'max_positions':5,'min_trade_value':0},
        'fees':{'buy_cost':FEES['commission'],'sell_cost':FEES['commission']+FEES['tax']}}
    from services import paired_nav_strategy_bundle as strategy
    monkeypatch.setattr(strategy,'capture_strategy_context',lambda **kwargs:{'strategy_bundle_account':deepcopy(account)})
    result,context=run_and_capture_recommendation_path(inputs=deepcopy(rec_inputs),candidate_reader=lambda:selection)
    alloc=allocation_inputs();alloc['alpha_policy']=deepcopy(rec_inputs['filter_options']['alpha_policy'])
    alloc['return_history']['2454']=[.01,-.01,0,.02,-.02]*10
    alloc['recommendations']=result['recommendations']
    def isolated(**kw):
        sink=kw.pop('allocation_evidence_sink');plan=run_isolated_allocation(inputs=kw,inherited_state={})
        sink(plan['capture']);return plan['recommendations']
    _,sealed=run_and_capture_allocation(**alloc,signal_date=day,source_run_id='whole-chain-test',
        trading_config=cfg,risk_config={'maxSingleNamePct':.25},formal_model_manifest=manifest,
        model_predictions=rec_inputs['predictions'],recommendation_context=context,
        query=db.query,writer=db.writer,run_allocation=isolated)
    assert sealed['status']=='allocation_context_frozen',sealed
    root=read_snapshot(db.query,sealed['snapshot_id'])['payload']['content']
    assert 'ev_candidate_selection' not in root and 'opb_candidate_selection' not in root
    result=l3.collect_ensemble_allocations(snapshot_id=sealed['snapshot_id'],query=db.query,writer=db.writer)
    assert len(result['plans'])==1
    saved=read_snapshot(db.query,result['plans'][0]['snapshot_id'])
    plan=saved['payload']['content']
    comparison=resolve_allocation_comparison(query=db.query,allocation=saved)
    assert comparison['kind']=='strategy_bundle_replacement'
    assert plan['configuration']['strategy_bundle']['bundle_checksum']==bundle['bundle_checksum']
    assert {r['alpha_allocation']['expected_return_owner'] for r in plan['candidate']['recommendations']}=={'l4_distribution'}
    assert {r['symbol'] for r in plan['candidate']['recommendations']}==set(rec_inputs['predictions'])
    assert plan['production_effect'] is False and plan['nav_maturity_credit']==0
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1',[])

    # Original registration and SQLite serializer must really persist DIFFERENT
    # policies and candidate inputs, while seeding both from the same account.
    import json
    from services.paired_native_registration import register_allocation_pair
    from services.native_paper_source_capture import ImmutableNativeObjects
    from services.native_paper_sandbox import native_runtime_manifest,PrivatePaperStore
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar,NOW
    source,read=source_fixture()
    source.executescript((Path(__file__).resolve().parents[2]/'worker/domain-migrations/paper/0005_l4_distribution.sql').read_text(encoding='utf-8'))
    try:
        source.execute('UPDATE paper_accounts SET cash=1000000,initial_cash=1000000 WHERE id=1')
        for sid,symbol in ((2,'2317'),(3,'2454')):
            source.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)',[sid,symbol,symbol,'TWSE'])
            source.execute('INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES(?,?,?,?,?,?,?)',
                [day,sid,symbol,symbol,sid,50,'synthetic seed'])
        objects=ImmutableNativeObjects(Bucket());owners=native_runtime_manifest(native_runner)['tables']
        before=source.total_changes
        registered=register_allocation_pair(snapshot_id=saved['manifest']['snapshot_id'],query=db.query,writer=db.writer,
            domain_queries={domain:read for domain in set(owners.values())},kv_read=calendar,objects=objects,
            account_id=1,variables={},kv_read_policy={},runner=native_runner,now=NOW)
        packet=read_snapshot(db.query,registered['snapshot_id'])['payload']['content']
        for arm in ('baseline','candidate'):
            state=objects.get(packet['initial_state_objects'][arm])
            store=PrivatePaperStore(**state,inputs={})
            try:
                config=json.loads(store.db.execute("SELECT value FROM _native_private_kv WHERE key='trading:config'").fetchone()[0])
                assert ('l4Distribution' in config)==(arm=='candidate')
                assert store.db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0]==1000000
                if arm=='candidate':
                    frozen=json.loads(store.db.execute("SELECT value FROM _native_private_kv WHERE key='l4:private_allocation_inputs'").fetchone()[0])
                    assert frozen['inputs']['alpha_policy']['l4Distribution']['runtime']['l3_identity']==identity
                    assert set(frozen['inputs']['alpha_policy']['l4Distribution']['runtime']['predictions'])==set(rec_inputs['predictions'])
            finally:store.db.close()
        assert source.total_changes==before
    finally:source.close()


def test_capture_freezes_canonical_risk_for_candidate_own_holdings(monkeypatch):
    from datetime import datetime,timezone,timedelta
    from services import paired_nav_native_holdings as holdings_source,l4_risk_history as prices
    from services import paired_nav_strategy_bundle as strategy,l4_distribution_context as bridge
    from services.paired_nav_collection import replay_allocator_return_history
    day=datetime.now(timezone.utc).date().isoformat()
    account={'schema_version':'l4-account-context-v1','account_id':1,'signal_date':day,'complete':True,
        'holdings':[],'fees':{'buy_cost':.001,'sell_cost':.004},'risk_limits':{'name_cap':.25},
        'observed_at':datetime.now(timezone.utc).isoformat()}
    monkeypatch.setattr(bridge,'worker_request',lambda *args,**kwargs:deepcopy(account))
    def capture(**kw):
        assert kw['owner']=='ensemble' and kw['definition_checksums']==['a'*64]
        return {'definitions':{'a'*64:{'status':'ready','arms':{'baseline':[],'candidate':['HELD']}}}}
    monkeypatch.setattr(holdings_source,'capture_native_holdings',capture)
    now=datetime.now(timezone.utc).date()
    dated=[{'date':(now-timedelta(days=i)).isoformat(),'adj_close':100.+30-i} for i in reversed(range(31))]
    payloads=[{'symbol':'POOL','stock_id':1,'prices':dated}]
    def held(**kw):
        assert kw['holdings']==[{'symbol':'HELD'}]
        return [{'symbol':'HELD','stock_id':2,'prices':deepcopy(dated),
            'source':'market.stock_prices.adj_close','as_of_date':day,'role':'held_only_risk_not_l3_candidate'}]
    monkeypatch.setattr(prices,'load_held_risk_payloads',held)
    def canonical(**kw):
        return [{**deepcopy(p),'source':'market.canonical_market_daily.adj_close',
            'role':'canonical_risk_only','as_of_date':day} for p in kw['payloads']+kw['held_payloads']]
    monkeypatch.setattr(prices,'load_canonical_risk_payloads',canonical)
    extra=strategy.capture_strategy_context(selection={'candidates':[{'artifact':{'payload_checksum':'a'*64},'strategy_bundle':{'bound':True}}]},
        recommendation_context={'inputs':{'payloads':payloads}},signal_date=day,query=None,writer=None)
    context=extra['strategy_bundle_risk_context']
    assert {p['symbol'] for p in context['canonical_risk_payloads']}=={'POOL','HELD'}
    assert [p['symbol'] for p in payloads]==['POOL']
    assert replay_allocator_return_history(context,payloads=payloads,signal_date=day)==context['return_history']
