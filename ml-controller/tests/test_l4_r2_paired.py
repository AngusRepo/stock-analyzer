from copy import deepcopy
from datetime import datetime,timezone
import pytest
from services import l4_r2_paired as paired
from services.l4_distribution import digest
from services.paired_nav_journal import freeze_snapshot,read_snapshot
from test_l4_r2_allocation import fixture as allocation_fixture
from test_paired_nav_journal import DB,FEES
from test_native_paper_sandbox import native_runner,ROOT


def fixture():
    rows,policy,risk,packet=allocation_fixture()
    for row in packet['forecast']['forecasts']:
        row['baseline_gross']=-.01 if row['symbol']=='B' else .02
    packet['forecast']['forecasts_checksum']=digest(packet['forecast']['forecasts'])
    packet['evaluation_policy']['cost_policy_checksum']=digest(FEES)
    packet['forecast']['policy_checksum']=digest(packet['evaluation_policy'])
    source=dict(inputs=dict(recommendations=rows,alpha_policy={'l4Distribution':policy},return_history=risk),
        trading_config={'l4Distribution':deepcopy(policy),'fees':FEES},risk_config={'system':{}},
        model_predictions=policy['runtime']['predictions'],formal_baseline_identity=policy['runtime']['l3_identity'],
        allocator_source_identity={'test':'hash'},native_execution_environment={'test':'environment'})
    source['trading_config']['l4Distribution'].pop('runtime',None)
    return source,packet,risk


def test_same_slate_same_risk_different_full_pool_forecasts_and_no_shared_rewards():
    source,packet,risk=fixture();before=deepcopy(source)
    arms,excluded=paired.input_arms(source,packet,risk)
    assert not excluded and source==before
    assert arms['baseline']['recommendations']==arms['candidate']['recommendations']
    assert arms['baseline']['return_history']==arms['candidate']['return_history']==risk
    for arm in arms:
        assert arms[arm]['opb_reward_ledger']==[]
        assert arms[arm]['r2_shadow']['comparison_arm']==arm


def test_missing_classified_name_is_excluded_from_both_slates_without_replacement():
    source,packet,risk=fixture()
    source['inputs']['recommendations'].append({'symbol':'ETF'})
    arms,excluded=paired.input_arms(source,packet,risk)
    assert excluded==['ETF']
    assert {r['symbol'] for r in arms['candidate']['recommendations']}=={'A','B','C'}


def test_real_sqlite_seals_retry_without_resolving_and_detects_changed_input(monkeypatch):
    from services import paired_nav_collection,paired_nav_execution_environment,l4_distribution_runtime
    monkeypatch.setattr(paired_nav_collection,'allocator_source_identity',lambda:{'test':'hash'})
    monkeypatch.setattr(paired_nav_execution_environment,'configuration_environment',lambda saved:{})
    source,packet,risk=fixture();db=DB();now=datetime(2026,9,11,12,tzinfo=timezone.utc)
    parent=freeze_snapshot(signal_date='2026-09-11',source_run_id='formal',snapshot_kind='allocation_context',
        content=source,query=db.query,writer=db.writer,now=now)
    args=dict(source_id=parent['snapshot_id'],packet=packet,risk=risk,query=db.query,writer=db.writer,now=now)
    result=paired.freeze_pair(**args)
    plan=read_snapshot(db.query,result['snapshot_id'])['payload']['content']
    assert plan['owner']=='l4_r2' and plan['production_effect'] is False
    from services.paired_nav_comparison import resolve_allocation_comparison
    comparison=resolve_allocation_comparison(query=db.query,allocation=read_snapshot(db.query,result['snapshot_id']))
    assert comparison['kind']=='same_l3_full_pool_l4_model_contrast'
    old=plan['baseline']['capture']['portfolio_plan'];new=plan['candidate']['capture']['portfolio_plan']
    assert old['model_checksum']==packet['forecast']['baseline_model_checksum']
    assert new['model_checksum']==packet['forecast']['model_checksum']
    assert old['targets']['B']['expected_return_gross']==-.01
    assert new['targets']['B']['expected_return_gross']==.06
    monkeypatch.setattr(l4_distribution_runtime,'run',lambda *a,**kw:pytest.fail('sealed retry must not solve again'))
    assert paired.freeze_pair(**args)==result
    packet['forecast']['forecasts'][0]['baseline_gross']=99
    with pytest.raises(ValueError,match='allocation_contract|retry_changed'):
        paired.freeze_pair(**args)


def test_cost_or_risk_drift_cannot_join_existing_pair():
    for mutation in (lambda s,r:s['trading_config']['fees'].update(tax=.5),
                     lambda s,r:r.update(signal_date='2026-09-10')):
        source,packet,risk=fixture();source=deepcopy(source);mutation(source,risk)
        with pytest.raises(ValueError,match='pair_source_changed'):
            paired.input_arms(source,packet,risk)


def test_native_registration_freezes_separate_inputs_and_never_writes_source_account(native_runner,monkeypatch):
    import json
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_execution_environment import capture_execution_environment
    from services.paired_native_registration import register_allocation_pair
    from services.native_paper_sandbox import native_runtime_manifest,PrivatePaperStore
    from services.native_paper_source_capture import ImmutableNativeObjects
    from services import strategy_nav_distribution
    from test_native_paper_source_capture import Bucket
    from test_native_paper_bootstrap import fixture as bootstrap_fixture
    source,packet,risk=fixture();db=DB();native,read=bootstrap_fixture()
    now=datetime(2026,9,11,12,tzinfo=timezone.utc)
    source_context={'schema_version':'native-paper-source-context-v1','observed_at':now.isoformat(),'variables':{},'frozen_kv':{}}
    source['native_execution_environment']=capture_execution_environment(context_reader=lambda:source_context,runner=native_runner,clock=lambda:now)
    source['allocator_source_identity']=allocator_source_identity()
    native.executescript((ROOT/'worker/domain-migrations/paper/0005_l4_distribution.sql').read_text())
    for i,row in enumerate(source['inputs']['recommendations'],10):
        symbol=row['symbol'];row.update(stock_id=i,score=50,
            score_seed_inputs={'chipFlowSeed40':20,'technicalSeed30':15,'screenerMomentumSeed20':10,'mlEdgeSeed30':15})
        native.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)',(i,symbol,symbol,'TWSE'))
        native.execute('INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES(?,?,?,?,?,?,?)',
            ('2026-09-11',i,symbol,symbol,i,50,'sealed strategy seed'))
    parent=freeze_snapshot(signal_date='2026-09-11',source_run_id='formal',snapshot_kind='allocation_context',
        content=source,query=db.query,writer=db.writer,now=now)
    plan=paired.freeze_pair(source_id=parent['snapshot_id'],packet=packet,risk=risk,query=db.query,writer=db.writer,now=now)
    monkeypatch.setattr(strategy_nav_distribution,'enabled',lambda *a,**kw:True)
    def calendar(key):
        if key.startswith('market:twse_holiday_schedule:'):
            return json.dumps({'schemaVersion':'twse-holiday-schedule-v2','source':'twse.openapi.holidaySchedule',
                'dates':[],'loadedAt':now.isoformat()})
    objects=ImmutableNativeObjects(Bucket());owners=native_runtime_manifest(native_runner)['tables']
    args=dict(snapshot_id=plan['snapshot_id'],query=db.query,writer=db.writer,domain_queries={d:read for d in set(owners.values())},
        kv_read=calendar,objects=objects,account_id=1,variables={},
        kv_read_policy=source['native_execution_environment']['kv_read_policy'],runner=native_runner,now=now,source_context=source_context)
    before=native.total_changes
    registered=register_allocation_pair(**args)
    assert native.total_changes==before
    saved=read_snapshot(db.query,registered['snapshot_id'])['payload']['content']
    assert saved['owner']=='l4_r2' and saved['session_date']=='2026-09-14'
    assert saved['schedule'][0]['observed_at']=='2026-09-14T08:45:00+08:00'
    assert saved['initial_state_checksums']['baseline']!=saved['initial_state_checksums']['candidate']
    for arm in ('baseline','candidate'):
        store=PrivatePaperStore(**objects.get(saved['initial_state_objects'][arm]),inputs={})
        try:
            value=json.loads(store.db.execute("SELECT value FROM _native_private_kv WHERE key='l4:private_allocation_inputs'").fetchone()[0])
            assert value['inputs']['r2_shadow']['comparison_arm']==arm
            assert store.db.execute('SELECT COUNT(*) FROM l4_policy_account_rewards_v1').fetchone()[0]==0
        finally:store.db.close()
    args['domain_queries']={};args['kv_read']=lambda key:pytest.fail('retry cannot bootstrap again')
    assert register_allocation_pair(**args)==registered
    native.close()
