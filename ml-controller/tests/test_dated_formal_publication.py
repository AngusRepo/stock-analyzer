from hmm_test_support import certified_contract as _hmm_contract
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path

import pytest
from test_paired_nav_atomic_recommendation import full_atomic, dispatched

from services import dated_formal_publication as recovery
from services.paired_nav_journal import digest

NOW = datetime.fromisoformat('2026-10-19T12:00:00+08:00')


@pytest.fixture
def frozen(monkeypatch):
    config = {'l4Distribution': {'operating_mode': 'single_b_tabpack_core16_median_v1',
        'strategy_role': 'B', 'scope': 'paper', 'artifact': {'model_checksum': 'a'*64, 'l3_identity': {'fixture': True},
        'model': {'residual_tabpack': {'schema_version': 'l4-three-head-tabpack-core16-median-v1'}}}}}
    context = {'trade_date': recovery.TRADE, 'cutoff': '2026-10-19T00:00:00Z', 'observations': {'fixture': True}}
    context['checksum'] = digest(context)
    packet = {'receipt': {'run_date': recovery.SIGNAL, 'run_id': recovery.PARENT, 'checksum': recovery.SEAL}, 'context': context}
    monkeypatch.setattr(recovery, 'CONFIG', digest(config))
    monkeypatch.setattr(recovery, 'CONTEXT', context['checksum'])
    state = {'run_date': packet['receipt']['run_date'],
             'producer_run_id': packet['receipt']['run_id'],
             'premarket_context': packet['context'], 'trading_config': config}
    return state, config, packet['receipt']


def grant(frozen, **kwargs):
    state, config, seal = frozen
    return recovery.publication_deferral(state, config, now=NOW,
        seal_reader=lambda day, parent: deepcopy(seal), **kwargs)


def test_exact_dated_publication_survives_the_write_boundary(frozen, monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from services import premarket_pipeline
    state, _, seal = frozen
    state['dated_formal_publication'] = grant(frozen)
    monkeypatch.setattr(recovery, 'datetime', type('Clock', (), {'now': staticmethod(lambda tz: NOW)}))
    monkeypatch.setattr(premarket_pipeline, 'read_seal', lambda *a: deepcopy(seal))
    def closed(*args): raise RuntimeError('worker_next_session_opened')
    monkeypatch.setattr(graph, 'assert_canonical_window_open', closed)
    graph._assert_pipeline_canonical_window(state)
    state['dated_formal_publication']['nav_maturity_credit'] = 1
    with pytest.raises(ValueError, match='dated_publication_write_scope_changed'):
        graph._assert_pipeline_canonical_window(state)
    state.pop('dated_formal_publication')
    with pytest.raises(RuntimeError, match='worker_next_session_opened'):
        graph._assert_pipeline_canonical_window(state)


def test_expired_dated_publication_cannot_reopen_writes(frozen, monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    state, _, _ = frozen
    state['dated_formal_publication'] = grant(frozen)
    tomorrow = datetime.fromisoformat('2026-10-20T00:00:00+08:00')
    monkeypatch.setattr(recovery, 'datetime', type('Clock', (), {'now': staticmethod(lambda tz: tomorrow)}))
    with pytest.raises(ValueError, match='dated_publication_write_scope_changed'):
        graph._assert_pipeline_canonical_window(state)


def test_actual_frozen_input_and_configuration_are_bound_without_mutation(frozen):
    before = deepcopy(frozen)
    receipt = grant(frozen)
    assert receipt['status'] == 'comparison_deferred'
    assert receipt['nav_maturity_credit'] == receipt['paired_accounts_executed'] == 0
    assert receipt['promotion_allowed'] is False and receipt['scope'] == 'paper'
    assert receipt['receipt_checksum'] == digest({k:v for k,v in receipt.items() if k != 'receipt_checksum'})
    assert frozen == before


@pytest.mark.parametrize('fault', ['run', 'signal', 'trade', 'checksum'])
def test_another_frozen_run_never_borrows_the_deferral(frozen, fault):
    state, config, _ = frozen
    if fault == 'run': state['producer_run_id'] = 'other'
    if fault == 'signal': state['run_date'] = '2026-10-15'
    if fault == 'trade': state['premarket_context']['trade_date'] = '2026-10-20'
    if fault == 'checksum': state['premarket_context']['checksum'] = '0'*64
    def forbidden(*args): pytest.fail('unrelated run read a seal')
    assert recovery.publication_deferral(state, config, now=NOW, seal_reader=forbidden) is None


@pytest.mark.parametrize('fault', ['context', 'configuration', 'seal'])
def test_changed_actual_dependencies_fail_closed(frozen, fault):
    state, config, seal = frozen
    if fault == 'context': state['premarket_context']['cutoff'] = '2026-10-19T00:00:01Z'
    if fault == 'configuration': config['l4Distribution']['strategy_role'] = 'A'
    if fault == 'seal': seal['checksum'] = '0'*64
    with pytest.raises(ValueError, match='dated_publication_'):
        grant(frozen)


def test_exception_expires_and_does_not_read_remote_state(frozen):
    state, config, _ = frozen
    def forbidden(*args): pytest.fail('expired exception read a seal')
    assert recovery.publication_deferral(state, config,
        now=datetime.fromisoformat('2026-10-20T00:00:00+08:00'), seal_reader=forbidden) is None


def test_deferral_mode_matches_existing_formal_policy_receipt(frozen, monkeypatch):
    from services import paper_strategy_mode
    _, config, _ = frozen
    # Existing model validity remains enforced by node_recommend. This checks
    # the independent receipt producer's serialization contract without I/O.
    monkeypatch.setattr(paper_strategy_mode, 'validate_bundle', lambda *a, **kw: None)
    assert grant(frozen)['paper_strategy'] == paper_strategy_mode.single_b_policy(config, signal_date=recovery.SIGNAL)


def test_actual_nav_node_requires_formal_seal_and_keeps_nav_missing(frozen, monkeypatch):
    import asyncio
    from graphs import daily_pipeline_v2 as graph
    from services import paired_nav_pipeline, premarket_pipeline
    from services.paper_strategy_mode import valid_disabled_receipt
    state, _, seal = frozen
    state['dated_formal_publication'] = grant(frozen)
    state['paired_nav_collection'] = {'status': 'allocation_context_frozen', 'snapshot_id': 'a'*64}
    monkeypatch.setattr(recovery, 'datetime', type('Clock', (), {'now': staticmethod(lambda tz: NOW)}))
    monkeypatch.setattr(premarket_pipeline, 'read_seal', lambda *a: deepcopy(seal))
    monkeypatch.setattr(graph, '_assert_pipeline_canonical_window', lambda s: None)
    def forbidden(*a, **kw): pytest.fail('dated formal publication executed NAV comparisons')
    monkeypatch.setattr(paired_nav_pipeline, 'complete_pipeline_shadow', forbidden)
    receipt = asyncio.run(graph.node_paired_nav_setup(state))['paired_nav_collection']
    assert valid_disabled_receipt(receipt)
    assert receipt['snapshot_id'] == 'a'*64
    assert receipt['reason'] == 'dated_formal_publication_comparison_deferred'
    assert receipt['nav_maturity_credit'] == 0 and receipt['paired_accounts_executed'] == 0
    state['paired_nav_collection']['status'] = 'failed'
    with pytest.raises(RuntimeError, match='allocation_context_unavailable'):
        asyncio.run(graph.node_paired_nav_setup(state))


def test_actual_recommend_node_reaches_unchanged_formal_sources_without_atomic(full_atomic, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from services import trading_config_loader, paired_nav_atomic_recommendation, recommendation_source_context
    from test_l4_alpha_ev_producer import _artifact
    graph, state = full_atomic
    original = deepcopy(state)
    configuration = {'alphaFramework': {'l4_alpha_ev': _artifact(intercept=.05)}}
    monkeypatch.setattr(graph, '_resolve_runtime_regime_contract', lambda *a, **kw:
        _hmm_contract(a[0]['run_date'], **{'alpha_regime': 'bull', 'regime_surface': {'bull': 1.}}))
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract', lambda:
        SimpleNamespace(config=configuration, contract=SimpleNamespace(degraded=False)))
    # Scope/dependency checks are covered separately; this fixture isolates
    # the real node's dispatch after admission.
    monkeypatch.setattr(recovery, 'publication_deferral', lambda *a: {'paper_strategy': None})
    def forbidden(*a, **kw): pytest.fail('formal recommendation executed Atomic preparation')
    monkeypatch.setattr(paired_nav_atomic_recommendation, 'prepare_atomic_recommendations', forbidden)
    class ReachedFormalSources(Exception): pass
    def formal_sources(**kwargs):
        assert kwargs['candidate_recs'] == {}
        assert kwargs['formal_recs'] == original['screener_recs']
        assert kwargs['run_date'] == original['run_date']
        raise ReachedFormalSources
    monkeypatch.setattr(recommendation_source_context, 'capture_recommendation_sources', formal_sources)
    with pytest.raises(ReachedFormalSources):
        asyncio.run(graph.node_recommend(state))
    assert state == original
