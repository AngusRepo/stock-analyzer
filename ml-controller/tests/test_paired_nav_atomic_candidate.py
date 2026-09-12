"""Actual daily allocation -> immutable Atomic/native plans. No real ROI data."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import subprocess
from types import SimpleNamespace

import pytest

from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot
from services.paired_nav_atomic_policy import validate_atomic_policy
from services.paired_nav_atomic_candidate import collect_atomic_allocations, verify_atomic_comparison
from test_paired_nav_atomic_recommendation import full_atomic
from test_paired_nav_atomic_dispatch import dispatched
from test_paired_nav_candidate_collection import environment
from test_native_paper_sandbox import native_runner
from test_native_paper_source_capture import Bucket
from services.native_paper_source_capture import ImmutableNativeObjects

ROOT = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 9, 6, 14, tzinfo=timezone.utc)


def attach_policy(population, *, daily_weight_owner=False):
    """Use the ORIGINAL Worker policy normalizer/hash before any source freeze."""
    p = deepcopy(population)
    baseline = dict(id='baseline', version='strategy-spec-v1', name='baseline', status='active', owner='strategy',
        ownerType='strategy', promotionStatus='production', familyId='TREND_RECLAIM_CONTINUATION', variantId='baseline',
        alphaBucket='trend_following', supportedRegimes=['bull'], thesis='synthetic fixture',
        thresholds={'minFactorSignals': {'baseline': .5}},
        candidatePolicy={'poolQuota': 10, 'costBudget': 10, 'evidenceRequirements': [], 'maxMlShare': .2},
        riskNotes=[], createdBy='p5_strategy_governance')
    specs = [baseline]
    for index, row in enumerate(p['replacements']):
        candidate = {**deepcopy(baseline), 'id': 'candidate_' + str(index), 'status': 'candidate',
            'promotionStatus': 'candidate', 'variantId': 'candidate_' + str(index)}
        specs.append(candidate)
        row['replacement'] = dict(candidateId=candidate['id'], candidateVersion=candidate['version'],
            incumbentId=baseline['id'], incumbentVersion=baseline['version'])
    source = {'inputs': {'specs': specs, 'options': {'targetSize': 4, 'coarseMlQueueSize': 4,
        'performanceWeightOwner': 'ple_portfolio_metrics' if daily_weight_owner else 'formal_evidence_owner',
        'strategyWeights': {s['id']: 1 for s in specs},
        'productionStrategyWeights': {s['id']: int(s['status']=='active') for s in specs}}},
        'source_checksum': p['source_checksum']}
    script = """const {buildAtomicPolicyContext}=require('./src/lib/atomicStrategyShadow.ts');
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>raw+=part);
process.stdin.on('end',async()=>{try{process.stdout.write(JSON.stringify(await buildAtomicPolicyContext(JSON.parse(raw))));}
catch(error){console.error(error);process.exitCode=1;}});"""
    out = subprocess.run(['node', '--import', 'tsx', '-e', script], cwd=ROOT/'worker',
        input=json.dumps(source), text=True, encoding='utf-8', capture_output=True, check=True)
    p['policy_context'] = json.loads(out.stdout)
    by_id = {s['id']: s for s in p['policy_context']['policy']['specs']}
    for row in p['replacements']:
        replacement = row['replacement']
        definition = {'replacement': replacement,
            'candidate': by_id[replacement['candidateId']], 'incumbent': by_id[replacement['incumbentId']]}
        if daily_weight_owner:
            row['weight_policy_version'] = 'strategy-original-daily-weight-owner-v1'
            definition['weight_policy_version'] = row['weight_policy_version']
        row['definition_checksum'] = digest(definition)
    validate_atomic_policy(p)
    return p


@pytest.fixture
def allocated(full_atomic, environment, monkeypatch, native_runner, request):
    graph, state = full_atomic
    db, model_bucket, *_ = environment
    if request.node.callspec.params.get('full_atomic') == 'native_policy_weight_owner_complete':
        # Positive all-owner census: the real L3 selector reads an observed empty
        # candidate registry, not a missing-table failure relabelled as empty.
        db.conn.executescript('CREATE TABLE IF NOT EXISTS data_domain_control_revisions(table_name TEXT PRIMARY KEY,revision INTEGER,updated_at TEXT);')
        db.conn.executescript((ROOT / 'worker/domain-migrations/learning/0027_active8_ensemble_serving_owner.sql').read_text(encoding='utf-8'))
    from services import paired_nav_candidate_collection as candidates
    monkeypatch.setattr(candidates, '_bucket', lambda: model_bucket)
    import requests
    def no_network(*args, **kwargs):
        pytest.fail('local NAV integration attempted external HTTP')
    monkeypatch.setattr(requests.sessions.Session, 'request', no_network)
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    db.conn.backup(threaded); db.conn.close(); db.conn = threaded; db.conn.row_factory = sqlite3.Row
    from services import recommendation_service as service, trading_config_loader, paired_nav_collection
    from test_l4_alpha_ev_producer import _artifact
    from test_allocator_direction_authority import _validated_l4_prior
    from test_paired_nav_journal import FEES
    from test_paired_nav_execution_environment import patch_graph_environment
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=db.query, batch_execute=db.writer))
    monkeypatch.setattr(graph, 'MARKET_D1_CLIENT', SimpleNamespace(query=lambda *a, **kw: []))
    monkeypatch.setattr(graph, '_resolve_runtime_regime_contract', lambda *a, **kw: {'alpha_regime':'bull','regime_surface':{'bull':1.}})
    config = {'ranking': {'enabled': True}, 'fees': FEES, 'alphaFramework': {
        'l4_alpha_ev': _artifact(intercept=.05), 'allocation': {'controller': 'OnlinePortfolioBandit',
            'method': 'sparse_tangent_inverse_risk', 'opb_arm_prior': _validated_l4_prior()}}}
    risk = {'system': {'killSwitch': False}}
    if request.node.callspec.params.get('full_atomic') in {'native_policy_execution','native_policy_holdings'}:
        from test_paired_native_session import native_config
        original = native_config()
        config = {**original['trading'], **config}
        risk = original['risk']
        risk['system']['killSwitch'] = False
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract', lambda:
        SimpleNamespace(config=deepcopy(config),contract=SimpleNamespace(degraded=False)))
    monkeypatch.setattr(graph, 'kv_client', SimpleNamespace(get_json=lambda key, **kw: deepcopy(risk) if key=='trading:risk_config' else 1))
    monkeypatch.setattr(graph, 'load_online_portfolio_bandit_reward_ledger', lambda: [])
    monkeypatch.setattr(service, 'load_inherited_paper_weights', lambda *a, **kw: {'status':'fixture','weights':{},'portfolio_value_twd':100000})
    monkeypatch.setattr(service, 'build_portfolio_ml_shadow_inputs', lambda *a, **kw: {})
    monkeypatch.setattr(service, 'build_rfs_implementable_frontier_shadow', lambda *a, **kw: {'status':'fixture_observer','weights':{},'metrics':{}})
    monkeypatch.setattr(paired_nav_collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=NOW))
    from services import paired_nav_atomic_candidate as collector
    monkeypatch.setattr(collector, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=NOW))
    patch_graph_environment(monkeypatch, native_runner, day=state['run_date'])
    state.update(asyncio.run(graph.node_recommend(state)))
    assert state['paired_nav_collection']['status']=='allocation_context_frozen', state['paired_nav_collection']
    return db, graph, state


@pytest.mark.parametrize('full_atomic', ['native_policy', 'native_policy_complete', 'native_policy_initial_unavailable', 'native_policy_weight_owner'], indirect=True)
def test_actual_daily_atomic_pairs_keep_complete_population_and_own_native_seeds(allocated, native_runner, monkeypatch, request):
    from services.paired_nav_comparison import resolve_allocation_comparison
    from services.paired_native_registration import register_allocation_pair
    from services.native_paper_sandbox import native_runtime_manifest
    from test_native_paper_bootstrap import fixture as bootstrap_fixture
    db, graph, state = allocated
    if request.node.callspec.params.get('full_atomic') == 'native_policy_weight_owner':
        saved = read_snapshot(db.query, state['paired_nav_collection']['snapshot_id'])
        policy = validate_atomic_policy(saved['payload']['content']['atomic_recommendation_inputs']['policy_population'])
        assert all(d['weight_policy_version'] == 'strategy-original-daily-weight-owner-v1'
                   for d in policy['definitions'].values())
    complete = all(r['candidate']['status']=='materialized' for r in state['paired_nav_atomic_inputs']['population']['replacements'])
    ready = 4 if complete else 3
    args = dict(snapshot_id=state['paired_nav_collection']['snapshot_id'], query=db.query, writer=db.writer)
    group = collect_atomic_allocations(**args)
    assert group['status']=='allocation_pairs_frozen' and len(group['plans'])==ready, group['unavailable']
    assert group['definition_count']==4 and len(group['unavailable'])==4-ready
    assert group['selection_materialization_complete'] is complete
    assert collect_atomic_allocations(**args)==group
    from services.paired_nav_population import read_candidate_population
    population = read_candidate_population(business_date=state['run_date'], query=db.query, series=[])
    atomic_pairs = [p for p in population['pairs'] if p['owner']=='atomic_strategy']
    assert len(atomic_pairs)==ready
    assert population['selection_materialization_complete'] is False
    assert len([s for s in population['unmaterialized_selections'] if s['owner']=='atomic_strategy'])==4-ready
    assert len(population['unresolved_selection_sources'])==1
    assert population['unresolved_selection_sources'][0]['owner']=='ensemble'
    parent = read_snapshot(db.query,args['snapshot_id'])['payload']['content']
    key = parent['atomic_recommendation_inputs']['policy_population']['replacements'][0]['definition_checksum']
    item = next(p for p in group['plans'] if read_snapshot(db.query,p['snapshot_id'])['payload']['content']['candidate_checksum']==key)
    saved = read_snapshot(db.query,item['snapshot_id'])
    plan = saved['payload']['content']
    assert resolve_allocation_comparison(query=db.query,allocation=saved)['kind']=='atomic_strategy_replacement'
    own = read_snapshot(db.query,plan['allocation_context_snapshot_id'])
    seeds = verify_atomic_comparison(plan,own,query=db.query)
    for field in ('risk_config', 'trading_config', 'allocator_policies', 'recommendation_source_identity'):
        changed = deepcopy(plan)
        changed['configuration'][field] = {'changed': True}
        changed['configuration_checksum'] = digest(changed['configuration'])
        changed['root_pair_id'] = digest(['atomic_strategy', key, changed['baseline_checksum'], changed['configuration_checksum']])
        with pytest.raises(ValueError, match='atomic_comparison_identity_mismatch'):
            verify_atomic_comparison(changed, own, query=db.query)
    assert {r['symbol'] for r in seeds['baseline']}=={'1000','1001','1003'}
    assert {r['symbol'] for r in seeds['candidate']}=={'1000','1002','1003'}
    source, query = bootstrap_fixture()
    source.commit()  # SQLite backup waits on its own uncommitted fixture writes.
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    source.backup(threaded); source.close(); source = threaded; source.row_factory = sqlite3.Row
    query = lambda sql, args: [dict(row) for row in source.execute(sql, args)]
    try:
        source.execute("UPDATE stocks SET symbol='1000',name='1000',added_at='2026-09-01',updated_at='2026-09-01' WHERE id=1")
        for sid in (2,3,4):
            source.execute("INSERT INTO stocks(id,symbol,name,market,added_at,updated_at) VALUES(?,?,?,'TWSE','2026-09-01','2026-09-01')",[sid,str(999+sid),str(999+sid)])
        source.commit()
        objects = ImmutableNativeObjects(Bucket())
        env = own['payload']['content']['native_execution_environment']
        def calendar(key):
            return json.dumps({'schemaVersion':'twse-holiday-schedule-v2','source':'twse.openapi.holidaySchedule',
                'loadedAt':NOW.isoformat(),'dates':[]}) if key.startswith('market:twse_holiday_schedule:') else None
        kwargs = dict(snapshot_id=item['snapshot_id'],query=db.query,writer=db.writer,objects=objects,
            domain_queries={d:query for d in set(native_runtime_manifest(native_runner)['tables'].values())},
            kv_read=calendar, account_id=1, variables=env['source_context']['variables'],
            kv_read_policy=env['kv_read_policy'],source_context=env['source_context'],runner=native_runner,now=NOW)
        before = source.total_changes
        if request.node.callspec.params['full_atomic']=='native_policy_initial_unavailable':
            assert own['payload']['content']['atomic_recommendation_inputs']['native_holdings']['initial_observation']['status']=='failed'
            with pytest.raises(ValueError,match='paired_native_initial_holdings_source_unavailable'):
                register_allocation_pair(**kwargs)
            assert source.total_changes==before
            assert db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'",[])==[]
            assert db.query('SELECT * FROM paired_nav_daily_journal_v1',[])==[]
            return
        result = register_allocation_pair(**kwargs)
        assert register_allocation_pair(**{**kwargs,'domain_queries':{}})==result
        assert source.total_changes==before
        execution=read_snapshot(db.query,result['snapshot_id'])['payload']['content']
        assert execution['session_date']=='2026-09-07'
        for arm, symbols in [('baseline',{'1000','1001','1003'}),('candidate',{'1000','1002','1003'})]:
            with sqlite3.connect(':memory:') as private:
                private.executescript(objects.get(execution['initial_state_objects'][arm])['state_sql'])
                actual={r[0] for r in private.execute("SELECT symbol FROM daily_recommendations WHERE date='2026-09-06'")}
                assert actual==symbols
        assert db.query('SELECT * FROM paired_nav_daily_journal_v1',[])==[]
        # Real DAG post-serving node -> original batch registration. An interrupted
        # batch retains its acknowledged manifests, then resumes without new I/O.
        from services import paired_native_runtime as runtime
        from services.paired_nav_pipeline import pipeline_shadow_errors
        batch = runtime.register_candidate_execution_plans
        monkeypatch.setattr(runtime, 'KV_READ_POLICY', env['kv_read_policy'])
        def local_batch(**kw):
            return batch(**kw, objects=objects, domain_queries=kwargs['domain_queries'],
                kv_read=calendar, runner=native_runner, clock=lambda: NOW)
        monkeypatch.setattr(runtime, 'register_candidate_execution_plans', local_batch)
        calls = []
        def interrupted(**kw):
            calls.append(kw['snapshot_id'])
            if len(calls)==1:
                raise RuntimeError('paired_nav_test_registration_interrupted')
            return register_allocation_pair(**kw)
        monkeypatch.setattr(runtime, 'register_allocation_pair', interrupted)
        failed = asyncio.run(graph.node_paired_nav_setup(state))['paired_nav_collection']
        assert failed['atomic_collection']['status']=='failed'
        assert len(db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'",[]))==ready-1
        assert len(failed['atomic_collection']['native_execution']['registrations'])==ready-1
        member_failures = failed['atomic_collection']['owner_failures']['atomic_strategy']['candidate_failures']
        assert [f['allocation_snapshot_id'] for f in member_failures]==[calls[0]]
        assert all(f['stage']=='native_registration' for f in member_failures)
        assert pipeline_shadow_errors(failed)
        monkeypatch.setattr(runtime, 'register_allocation_pair', register_allocation_pair)
        resumed = asyncio.run(graph.node_paired_nav_setup({**state,'paired_nav_collection':failed}))['paired_nav_collection']
        atomic = resumed['atomic_collection']
        assert atomic['status']==('native_execution_pairs_registered' if complete else 'atomic_partial_native_registration'), atomic
        assert len(atomic['native_execution']['registrations'])==ready
        assert resumed['atomic_daily']['status']==('native_execution_pairs_registered' if complete else 'incomplete')
        if complete:
            assert resumed['atomic_daily']['execution_status']=='awaiting_native_session'
        assert resumed['atomic_daily']['nav_maturity_credit']==0
        assert resumed['status']=='failed', 'unrelated L3 selection failure cannot be hidden'
        assert pipeline_shadow_errors(resumed)
        sealed = db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', [])
        assert asyncio.run(graph.node_paired_nav_setup({**state,'paired_nav_collection':resumed}))['paired_nav_collection']==resumed
        assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', [])==sealed
        after = read_candidate_population(business_date=state['run_date'],query=db.query,series=[])
        members = [p for p in after['pairs'] if p['owner']=='atomic_strategy']
        assert all(p['execution_status']=='awaiting_session' and p['exact_nav_sessions']==0 for p in members)
        assert len(members)==ready and after['selection_materialization_complete'] is False
        # Original registration owner, not today's admission list, supplies
        # continuation requests. Reads retain every open actual definition.
        from services.paired_nav_atomic_continuation import registered_atomic_continuations
        from services import paired_nav_atomic_inputs as daily, worker_config_client
        assert registered_atomic_continuations(signal_date='2026-09-06', query=db.query)==[]
        pins = registered_atomic_continuations(signal_date='2026-09-07', query=db.query)
        assert len(pins)==ready
        assert {p['definitionChecksum'] for p in pins}=={p['candidate_checksum'] for p in members}
        actual_executions={p['snapshot_id'] for p in atomic['native_execution']['registrations']}
        assert {sid for p in pins for sid in p['executionSnapshotIds']}==actual_executions
        requests=[]
        response={'continuations':pins,'replacements':[
            {'definition_checksum':p['definitionChecksum'],'replacement':p['replacement']} for p in pins]}
        async def worker(path, **kw):
            requests.append((path,kw))
            return deepcopy(response)
        monkeypatch.setattr(worker_config_client,'worker_fetch',worker)
        read_kwargs=dict(signal_date='2026-09-07',producer_run_id='next-canonical-run',query=db.query)
        assert asyncio.run(daily.read_daily_population(**read_kwargs))==response
        assert requests[0][0]==daily.PATH
        assert requests[0][1]['json_body']['continuations']==pins
        assert requests[0][1]['json_body']['producerRunId']=='next-canonical-run'
        response['replacements'].pop()
        with pytest.raises(ValueError,match='registered_definition_missing'):
            asyncio.run(daily.read_daily_population(**read_kwargs))
        assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', [])==sealed
        assert source.total_changes==before
        assert db.query('SELECT * FROM paired_nav_daily_journal_v1',[])==[]
    finally:
        source.close()
