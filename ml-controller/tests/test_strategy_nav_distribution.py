"""Synthetic full-policy wiring checks; never production NAV or efficacy evidence."""
from hmm_test_support import certified_contract as _hmm_contract
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from test_paired_nav_atomic_recommendation import full_atomic
from test_paired_nav_atomic_dispatch import dispatched
from test_paired_nav_candidate_collection import environment
from test_native_paper_sandbox import native_runner
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot
from test_paired_atomic_daily_execution import isolated_execution_environment


@pytest.fixture
def distribution_day(full_atomic, environment, native_runner, monkeypatch, request):
    from test_paired_native_session import native_config
    from test_l4_distribution_runtime import bundle
    from test_full_mlp_median import full_release
    from test_paired_nav_atomic_candidate import NOW
    from test_paired_nav_execution_environment import patch_graph_environment
    from services import trading_config_loader, paired_nav_collection, l4_distribution_context, l4_risk_history
    graph, state = full_atomic
    db, _, *_ = environment
    if request.node.callspec.params.get('parent_storage') == 'cold':
        from pathlib import Path
        from services import paired_nav_cold as cold
        from test_paired_nav_cold import Objects
        migration=Path(__file__).parents[2]/'worker/domain-migrations/learning/0048_paired_nav_cold_storage.sql'
        db.conn.executescript(migration.read_text(encoding='utf-8'))
        objects=Objects()
        monkeypatch.setattr(cold,'production_store',lambda:objects)
        original_parse=cold.parse_file
        db.full_parent_decodes=[]
        def parse(path,**kwargs):
            if kwargs.get('prefixes') is None:db.full_parent_decodes.append(path)
            return original_parse(path,**kwargs)
        monkeypatch.setattr(cold,'parse_file',parse)
    frozen_clock = datetime.fromisoformat(state['run_date']+'T14:00:00+00:00')
    config = native_config()['trading']
    risk = native_config()['risk']
    identity = paired_nav_collection.baseline_model_identity(graph._pipeline_frozen_serving_manifest(state))
    candidate = bundle()
    candidate['l3_identity'] = identity
    released_artifact = full_release(candidate)
    operating_mode = 'single_b_full_mlp_median_v1'
    if request.node.callspec.params.get('model_family') == 'tabpack_median16':
        from test_tabpack_core16 import fixture as tabpack_fixture
        from test_paper_single_b_tabpack import released
        from services.l4_distribution_lifecycle import prepare_paper_release
        anchor, median = tabpack_fixture(monkeypatch)
        released_artifact = released(candidate)
        released_artifact['model'] = {**anchor, 'residual_tabpack': median}
        from services.l4_distribution import digest as model_digest
        released_artifact['model_checksum'] = model_digest(released_artifact['model'])
        receipt = deepcopy(released_artifact['release']['validation_receipt'])
        receipt['model_checksum'] = receipt['experiment_authorization']['model_checksum'] = released_artifact['model_checksum']
        released_artifact = prepare_paper_release(released_artifact, receipt, signal_date=state['run_date'])
        operating_mode = 'single_b_tabpack_core16_median_v1'
    policy = {'scope': 'paper', 'operating_mode': 'single_b_full_mlp_median_v1', 'strategy_role': 'B',
        'artifact': released_artifact, 'constraints': {'exposure_cap': .8, 'name_cap': .3,
            'min_weight': .03, 'max_positions': config['position']['maxPositions'],
            'buy_cost': config['fees']['commission'],
            'sell_cost': config['fees']['commission'] + config['fees']['tax']}}
    policy['operating_mode'] = operating_mode
    from services.l4_allocation_contract import native_opb_policy
    from services.l4_distribution_runtime import distribution_policy_identity
    policy['opb'] = native_opb_policy(policy['constraints'])
    policy['opb']['approved_policy_identity'] = distribution_policy_identity(policy, identity)
    config['l4Distribution'] = policy
    config['ranking'] = {'enabled': True}
    state['trading_config'] = deepcopy(config)
    account = {'schema_version': 'l4-account-context-v1', 'account_id': 1, 'signal_date': state['run_date'],
        'active_plan_id': None, 'observed_at': NOW.isoformat(), 'nav': 1000000,
        'available_cash': 1000000, 'complete': True, 'holdings': [],
        'risk_limits': {'exposure_cap': .8, 'name_cap': .3, 'max_positions': 4,
            'min_trade_value': 1000, 'buys_halted': False},
        'fees': {'buy_cost': config['fees']['commission'],
            'sell_cost': config['fees']['commission'] + config['fees']['tax']}}
    prepare = l4_distribution_context.prepare_runtime_policy
    monkeypatch.setattr(l4_distribution_context, 'prepare_runtime_policy', lambda **kw:
        prepare(**kw, account_reader=lambda _: {**deepcopy(account), 'observed_at': datetime.now(timezone.utc).isoformat()},
            reward_reader=lambda: []))
    def canonical(**kw):
        return [{**deepcopy(p), 'source': 'market.canonical_market_daily.adj_close',
            'as_of_date': kw['signal_date'], 'role': 'canonical_risk_only', 'legacy_price_fallback': False}
            for p in [*kw['payloads'], *kw['held_payloads']]]
    monkeypatch.setattr(l4_risk_history, 'load_canonical_risk_payloads', canonical)
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract', lambda:
        SimpleNamespace(config=deepcopy(config), contract=SimpleNamespace(degraded=False, malformed=False)))
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=db.query, batch_execute=db.writer))
    monkeypatch.setattr(graph, 'MARKET_D1_CLIENT', SimpleNamespace(query=lambda *a, **kw: []))
    monkeypatch.setattr(graph, '_resolve_runtime_regime_contract', lambda *a, **kw:
        _hmm_contract(a[0]['run_date'], **{'alpha_regime': 'bull', 'regime_surface': {'bull': 1.}}))
    monkeypatch.setattr(graph, 'kv_client', SimpleNamespace(get_json=lambda key, **kw:
        deepcopy(risk) if key == 'trading:risk_config' else 1))
    monkeypatch.setattr(paired_nav_collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=frozen_clock))
    from services import paired_nav_atomic_candidate
    monkeypatch.setattr(paired_nav_atomic_candidate, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=frozen_clock))
    patch_graph_environment(monkeypatch, native_runner, day=state['run_date'])
    state.update(asyncio.run(graph.node_recommend(state)))
    assert state['paired_nav_collection']['status'] == 'allocation_context_frozen', state['paired_nav_collection']
    return db, graph, state


@pytest.mark.parametrize('full_atomic', ['native_policy_weight_owner_complete'], indirect=True)
@pytest.mark.parametrize('parent_storage', ['cold'])
def test_cold_formal_node_defers_atomic_comparison_without_parent_decode(distribution_day,parent_storage):
    from services.paired_nav_atomic_allocation import run_atomic_allocations
    db,_,state=distribution_day
    # The L4 phase seals and publishes only; atomic allocations run post-write.
    assert db.full_parent_decodes==[]
    assert 'paired_nav_atomic_allocation' not in state
    saved=read_snapshot(db.query,state['paired_nav_collection']['snapshot_id'])
    assert len(db.full_parent_decodes)==1
    assert state['l4_pending_plan']==saved['payload']['content']['capture']['portfolio_plan']
    history=saved['payload']['content']['atomic_distribution_history']
    assert 'payloads' not in history and history['payload_layout']=='formal-plus-extra-v1'
    formal={p['symbol'] for p in saved['payload']['content']['recommendation_context']['inputs']['payloads']}
    assert not formal & {p['symbol'] for p in history['extra_payloads']}
    allocation=run_atomic_allocations(snapshot_id=state['paired_nav_collection']['snapshot_id'],query=db.query)
    assert allocation['status']=='allocations_materialized'
    assert allocation['baseline_economic_replay']=='PASS'
    assert saved['payload']['content']['formal_output']==allocation['baseline']['output']


@pytest.mark.parametrize('full_atomic', ['native_policy_weight_owner_complete'], indirect=True)
def test_real_candidate_slates_use_same_median_and_seal_distinct_native_inputs(distribution_day):
    from services.paired_nav_atomic_candidate import collect_atomic_allocations, verify_atomic_comparison
    from services.strategy_nav_distribution import verify_input_arms
    db, _, state = distribution_day
    root = read_snapshot(db.query, state['paired_nav_collection']['snapshot_id'])
    formal = root['payload']['content']
    args = {'snapshot_id': root['manifest']['snapshot_id'], 'query': db.query, 'writer': db.writer}
    result = collect_atomic_allocations(**args)
    assert result['selection_materialization_complete'], [(k,v.get('reason')) for k,v in result['unavailable'].items()]
    assert len(result['plans']) == 4
    assert collect_atomic_allocations(**args) == result
    pairs = [read_snapshot(db.query, p['snapshot_id']) for p in result['plans']]
    different = 0
    for saved in pairs:
        plan = saved['payload']['content']
        parent = read_snapshot(db.query, plan['allocation_context_snapshot_id'])
        # The child seals only its own fields and references the root.
        assert parent['payload']['content']['context_layout'] == 'atomic-child-delta-v1'
        assert parent['payload']['content']['upstream_payload_checksum'] == root['manifest']['payload_checksum']
        assert parent['manifest']['part_count'] < root['manifest']['part_count']
        assert all(parent['payload']['content'][k] == formal[k] for k in
                   ('recommendation_context', 'inputs', 'capture', 'atomic_distribution_history'))
        verify_atomic_comparison(plan, parent, query=db.query)
        arms = verify_input_arms(plan, parent, query=db.query)
        assert arms['baseline'] == formal['inputs']
        assert arms['candidate']['alpha_policy']['l4Distribution']['artifact'] == arms['baseline']['alpha_policy']['l4Distribution']['artifact']
        assert plan['baseline']['output'] == formal['formal_output']
        symbols = {r['symbol'] for r in arms['candidate']['recommendations']}
        assert symbols <= set(arms['candidate']['alpha_policy']['l4Distribution']['runtime']['predictions'])
        assert plan['candidate']['capture']['portfolio_plan']['model_checksum'] == plan['baseline']['capture']['portfolio_plan']['model_checksum']
        different += plan['candidate']['output'] != plan['baseline']['output']
        changed = deepcopy(parent)
        changed['payload']['content']['atomic_distribution_input_arms']['candidate']['alpha_policy']['l4Distribution']['runtime']['l3_identity']['payload_checksum'] = 'f'*64
        with pytest.raises(ValueError, match='arms_changed'):
            verify_input_arms(plan, changed, query=db.query)
        assert plan['production_effect'] is False and plan['nav_maturity_credit'] == 0
    assert different > 0
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []


@pytest.mark.parametrize('held', [False, True])
def test_empty_candidate_slate_is_cash_or_retains_own_locked_holdings(held):
    from test_l4_distribution_runtime import fixture
    from services.l4_distribution_runtime import run
    _, policy, history = fixture()
    if held:
        policy['runtime']['account'].update(holdings=[{'symbol':'H', 'market_value':200000}], available_cash=800000)
        history['H'] = history['A']
    captures = []
    account = deepcopy(policy['runtime']['account'])
    assert run([], policy, return_history=history, evidence_sink=captures.append) == []
    plan = captures[0]['portfolio_plan']
    assert plan['weights'] == ({'H': pytest.approx(.2)} if held else {})
    assert plan['cash_weight'] == pytest.approx(.8 if held else 1.)
    assert plan['expected_trading_cost'] == 0
    assert policy['runtime']['account'] == account


def test_empty_portfolio_rejects_nonempty_constraints_and_nonfinite_inputs():
    import numpy as np
    from services.l4_portfolio import allocate
    args = dict(symbols=[], expected_gross=[], covariance=np.zeros((0,0)), current_weights=[],
        exposure_cap=1., name_cap=.3, min_weight=.01, max_positions=4, buy_cost=.001, sell_cost=.004)
    assert allocate(**args)['proof']['within_tolerance'] is True
    for extra in ({'locked_symbols':['A']}, {'capital_available':float('nan')}, {'expected_gross':[.1]},
                  {'exposure_groups':{'sector':{'symbols':['A'],'cap':.2}}}):
        with pytest.raises(ValueError):
            allocate(**{**args, **extra})


def test_shared_price_capture_mismatch_cannot_seal_risk(monkeypatch):
    from services.strategy_nav_distribution import capture_history
    from services import l4_risk_history
    monkeypatch.setattr(l4_risk_history, 'load_canonical_risk_payloads', lambda **kw:
        pytest.fail('must reject conflicting observations before reading source'))
    p = {'symbol': 'A', 'prices': [{'date': '2026-09-06', 'adj_close': 10}]}
    prepared = {'definitions': {'c': {'status': 'ready', 'payloads': [{**p, 'prices': []}]}}, 'input_hash': 'x'}
    with pytest.raises(ValueError, match='shared_price_capture_changed'):
        capture_history(prepared, formal_payloads=[p], signal_date='2026-09-06', capture_source=None)


@pytest.mark.parametrize('full_atomic', ['native_policy_distribution_weekday', 'native_policy_distribution_weekday_holdings'], indirect=True)
@pytest.mark.parametrize('environment', ['2026-09-06'], indirect=True)
@pytest.mark.parametrize('model_family', ['tabpack_median16'])
def test_same_median_original_281_frames_costed_journal_retry_and_private_carry(distribution_day, native_runner, record_property, model_family, request):
    # Reuse the existing real source/engine/journal verifier, including failed
    # journal-write recovery, all frames, fees, own carry and no formal writes.
    from test_paired_atomic_daily_execution import test_daily_atomic_original_complete_session_and_ledger as full_session
    kind = 'native_policy_holdings' if request.node.callspec.params['full_atomic'].endswith('_holdings') else 'native_policy_execution'
    source_request = SimpleNamespace(node=SimpleNamespace(callspec=SimpleNamespace(params={'full_atomic':kind})))
    if kind == 'native_policy_holdings':
        # This fixture explicitly sets killSwitch / zero exposure. The held
        # name is outside the candidate pool and therefore locked until the
        # ORIGINAL risk exit owner acts. Never loosen a limit to earn NAV credit.
        with pytest.raises(RuntimeError, match='locked_exposure_requires_risk_exit'):
            full_session(distribution_day, native_runner, record_property, source_request)
        assert distribution_day[0].query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    else:
        full_session(distribution_day, native_runner, record_property, source_request)


def test_released_single_b_enters_real_pre_l2_capture_not_distribution_wait(monkeypatch):
    import test_paired_nav_atomic_daily_inputs as daily
    from test_paper_single_b_tabpack import single_config
    graph, state, _ = daily._setup(monkeypatch)
    state['trading_config'] = single_config()
    result = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert result['paired_nav_atomic_inputs']['status'] == 'pre_l2_inputs_captured'
    assert len(result['paired_nav_atomic_inputs']['candidate_stocks']) == 1
    assert {r['symbol'] for r in result['payload_source_observations']['stocks']} == {'1000','1001','1002'}
