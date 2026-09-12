"""Real seed merge, frozen recommendation and allocator; synthetic signals."""
from copy import deepcopy

import pytest

from services.paired_nav_route_effect import audit_route_allocation_effect
from services.paired_nav_journal import read_snapshot
from services.screener_seed_domain_merge import merge_screener_seed_domains
from test_paired_nav_l3_candidate import prepared, environment, seal, DAY, CUTOFF, NOW
from test_native_paper_sandbox import native_runner


@pytest.fixture(autouse=True)
def route_freeze_clock(monkeypatch):
    from services import paired_nav_route_candidate as route
    from services.paired_nav_journal import freeze_snapshot
    monkeypatch.setattr(route, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=NOW))


def with_routes(prepared, *, serving='incumbent', mutate=None, contrasts=None):
    db, bucket, manifest, inputs, selection = prepared
    inputs = deepcopy(inputs)
    seeds, stocks = [], []
    for index, row in enumerate(inputs['screener_recs']):
        score = 100 - index * 40
        contrast = {'schema_version': 'l15-route-contrast-v1',
            'slate_builder_version': 'l15-continuous-full-universe-priority-v4',
            'incumbent': {'version': 'fixture-incumbent', 'score': score},
            'challenger': {'version': 'fixture-challenger', 'score': 100 - score},
            'serving_arm': serving, 'effect_scope': 'dispatch_priority_only',
            'allocation_weight_applied': False}
        if contrasts is not None:
            contrast = deepcopy(contrasts[index])
        seeds.append({'symbol': row['symbol'], 'screener_run_id': 'fixture-frozen-run',
            'decision_universe_frozen_at': CUTOFF, 'seed_rank': index + 1,
            'seed_evidence': {'l15_route_contrast': contrast},
            'l1_evidence': {'l15_route_contrast': deepcopy(contrast)}})
        stocks.append({'symbol': row['symbol'], 'stock_id': row['stock_id'], 'market': 'TWSE'})
    inputs['screener_recs'] = merge_screener_seed_domains(ops_seed_rows=seeds,
        daily_rows=inputs['screener_recs'], stock_rows=stocks, run_date=DAY)
    if serving == 'challenger':
        inputs['screener_recs'].reverse()
        for index, row in enumerate(inputs['screener_recs'], 1):
            row['rank'] = index
    if mutate:
        mutate(inputs['screener_recs'])
    receipt = seal((db, bucket, manifest, inputs, selection))
    return db, receipt


@pytest.mark.parametrize('serving', ['incumbent', 'challenger'])
def test_pit_route_order_replays_actual_consumer_without_inventing_allocation_weights(prepared, serving):
    db, receipt = with_routes(prepared, serving=serving)
    before = db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', [])
    result = audit_route_allocation_effect(snapshot_id=receipt['snapshot_id'], query=db.query)
    assert result['status'] == 'verified_no_allocation_change'
    assert result['incumbent_dispatch'] == ['2330', '2317', '2454']
    assert result['challenger_dispatch'] == ['2454', '2317', '2330']
    assert result['serving_arm'] == serving
    assert result['candidate_count'] == 3 and result['allocation_equal'] is True
    assert result['incumbent_effective_weights'] == result['challenger_effective_weights']
    assert result['incumbent_effective_weights'].get('2330', 0) > 0
    assert result['nav_inference_status'] == 'not_evaluated' and result['nav_maturity_credit'] == 0
    assert audit_route_allocation_effect(snapshot_id=receipt['snapshot_id'], query=db.query) == result
    assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', []) == before
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


@pytest.mark.parametrize('fault', ['future', 'run', 'missing_row', 'conflict', 'score', 'weight', 'mixed_version', 'row_date'])
def test_route_gap_cannot_be_replaced_by_current_score_or_partially_evaluated(prepared, fault):
    def mutate(rows):
        row = rows[0]
        source = row['l15_route_source']
        if fault == 'future':
            source['decision_universe_frozen_at'] = row['decision_universe_frozen_at'] = '2026-09-08T10:00:00Z'
        elif fault == 'run':
            source['screener_run_id'] = 'other-run'
        elif fault == 'missing_row':
            row['l15_route_source'] = None
        elif fault == 'conflict':
            source['seed_contrast']['challenger']['score'] = 12
        elif fault == 'row_date':
            row['date'] = '2026-09-06'
        else:
            for key in ('l1_contrast', 'seed_contrast'):
                if fault == 'score':
                    source[key]['challenger']['score'] = '90'
                elif fault == 'weight':
                    source[key]['allocation_weight_applied'] = True
                else:
                    source[key]['challenger']['version'] = 'different-version'
    db, receipt = with_routes(prepared, mutate=mutate)
    with pytest.raises(ValueError, match='paired_nav_route_'):
        audit_route_allocation_effect(snapshot_id=receipt['snapshot_id'], query=db.query)


def test_old_seed_without_pit_route_is_unknown_not_no_effect(prepared):
    db, *_ = prepared
    receipt = seal(prepared)
    result = audit_route_allocation_effect(snapshot_id=receipt['snapshot_id'], query=db.query)
    assert result['status'] == 'unavailable_legacy_route_inputs'
    assert 'allocation_equal' not in result


def test_merge_never_uses_mutable_core_route_as_missing_pit_evidence():
    daily = {'symbol': '2330', 'stock_id': 1, 'score_components': {'l15_route_contrast': {'wrong': 'current'}}}
    result = merge_screener_seed_domains(ops_seed_rows=[{'symbol': '2330'}], daily_rows=[daily],
        stock_rows=[{'stock_id': 1, 'symbol': '2330', 'market': 'TWSE'}], run_date=DAY)
    assert result[0]['l15_route_source'] is None


def test_real_worker_router_json_reaches_python_merge_freeze_and_real_allocator(prepared, native_runner):
    import json
    import os
    from pathlib import Path
    import shutil
    import subprocess
    worker = Path(__file__).resolve().parents[2] / 'worker'
    env = {**os.environ, 'TSX_DISABLE_CACHE': '1'}
    process = subprocess.run([shutil.which('node'), 'node_modules/tsx/dist/cli.mjs',
        'src/lib/strategyRouteAdmissionParity.test.ts', '--emit-pit-route'],
        cwd=worker, env=env, capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
    payloads = [line.removeprefix('NAV_ROUTE_FIXTURE=') for line in process.stdout.splitlines()
        if line.startswith('NAV_ROUTE_FIXTURE=')]
    assert len(payloads) == 1
    contrasts = json.loads(payloads[0])
    assert len(contrasts) == 3 and all(row['schema_version'] == 'l15-route-contrast-v1' for row in contrasts)
    db, receipt = with_routes(prepared, contrasts=contrasts)
    frozen = read_snapshot(db.query, receipt['snapshot_id'])['payload']['content']
    actual = frozen['recommendation_context']['inputs']['screener_recs']
    assert [row['l15_route_source']['seed_contrast'] for row in actual] == contrasts
    result = audit_route_allocation_effect(snapshot_id=receipt['snapshot_id'], query=db.query)
    assert result['status'] == 'verified_no_allocation_change'
    assert result['incumbent_version'] == contrasts[0]['incumbent']['version']
    assert result['challenger_version'] == contrasts[0]['challenger']['version']


@pytest.mark.parametrize('failure,other_candidates_waiting',
    [(failure, waiting) for failure in (None, 'audit', 'route_before', 'route_after', 'route_coverage', 'route_lifecycle')
        for waiting in (False, True)] + [(failure, False) for failure in
        ('ev_collection', 'ensemble_collection', 'l4_registration', 'l4_lifecycle')])
def test_real_pipeline_registers_all_other_lanes_before_route_audit_and_retries_without_reset(
        prepared, native_runner, monkeypatch, failure, other_candidates_waiting):
    from services import paired_native_runtime as native, paired_nav_candidate_collection as candidates
    from services import paired_nav_route_effect as route
    from services.paired_nav_pipeline import complete_pipeline_shadow, pipeline_shadow_errors
    from services.native_paper_source_capture import ImmutableNativeObjects
    from services.native_paper_sandbox import native_runtime_manifest
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar, NOW
    db, receipt = with_routes(prepared)
    source, source_query = source_fixture()
    try:
        for index, symbol in ((2, '2317'), (3, '2454')):
            source.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)', [index, symbol, symbol, 'TWSE'])
            source.execute('INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES(?,?,?,?,?,?,?)',
                [DAY, index, symbol, symbol, index, 50, 'seed'])
        before_source = source.total_changes
        objects = ImmutableNativeObjects(Bucket())
        owners = native_runtime_manifest(native_runner)['tables']
        original_register, original_audit = native.register_candidate_execution_plans, route.audit_route_allocation_effect
        original_pair = native.register_allocation_pair
        from services import paired_nav_lifecycle as lifecycle
        original_close = lifecycle.close_changed_comparisons
        injected = []
        def register_pair(**kw):
            is_route = read_snapshot(db.query, kw['snapshot_id'])['payload']['content']['owner'] == 'l15_route'
            if is_route and failure == 'route_before' and not injected:
                injected.append(failure)
                raise RuntimeError('fixture_route_registration_interrupted_before_write')
            result = original_pair(**kw)
            if is_route and failure == 'route_after' and not injected:
                injected.append(failure)
                raise RuntimeError('fixture_route_registration_interrupted_after_write')
            return result
        monkeypatch.setattr(native, 'register_allocation_pair', register_pair)
        monkeypatch.setattr(candidates, '_bucket', lambda: prepared[1])
        if failure in {'ev_collection', 'ensemble_collection'}:
            from services import paired_nav_l3_candidate as l3
            module, name = (candidates, '_collect_ev_allocations') if failure == 'ev_collection' else (l3, 'collect_ensemble_allocations')
            original_collect = getattr(module, name)
            def collect(**kw):
                if not injected:
                    injected.append(failure)
                    raise RuntimeError('paired_nav_fixture_owner_source_interrupted')
                return original_collect(**kw)
            monkeypatch.setattr(module, name, collect)
        if other_candidates_waiting:
            monkeypatch.setattr(candidates, 'collect_candidate_allocations',
                lambda **kw: {'status': 'awaiting_frozen_l4_candidate', 'plans': []})
        def register(**kw):
            if failure == 'l4_registration' and not injected and kw['collection']['plans'][0]['owner'] == 'l4_alpha_ev':
                injected.append(failure)
                raise RuntimeError('native_fixture_owner_registration_interrupted')
            result = original_register(**kw, objects=objects,
                domain_queries={d: source_query for d in set(owners.values())},
                kv_read=calendar, context_reader=lambda: {'schema_version': 'native-paper-source-context-v1',
                    'observed_at': NOW.isoformat(), 'variables': {},
                    'frozen_kv': {'ml:config': '{}', 'ml:config.debate_max_rounds': '3', 'ml:adaptive_params': None}},
                runner=native_runner, clock=lambda: NOW)
            if failure == 'route_coverage' and not injected and kw['collection']['plans'][0]['owner'] == 'l15_route':
                injected.append(failure)
                return {**result, 'registrations': []}
            return result
        monkeypatch.setattr(native, 'register_candidate_execution_plans', register)
        def close(**kw):
            if failure == 'l4_lifecycle' and not injected and kw['plans'][0]['owner'] == 'l4_alpha_ev':
                injected.append(failure)
                raise RuntimeError('paired_nav_fixture_owner_lifecycle_interrupted')
            if failure == 'route_lifecycle' and not injected and kw['plans'][0]['owner'] == 'l15_route':
                injected.append(failure)
                raise RuntimeError('fixture_route_lifecycle_commit_interrupted')
            return original_close(**kw)
        monkeypatch.setattr(lifecycle, 'close_changed_comparisons', close)
        calls = []
        def audit(**kw):
            frozen = db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair' ORDER BY snapshot_id", [])
            frozen = [row for row in frozen if read_snapshot(db.query, row['snapshot_id'])['payload']['content']['owner'] != 'l15_route']
            expected = 0 if other_candidates_waiting else 3
            if not calls:
                expected -= {'ev_collection': 2, 'ensemble_collection': 1, 'l4_registration': 1}.get(failure, 0)
            assert len(frozen) == expected
            calls.append(frozen)
            if failure == 'audit' and len(calls) == 1:
                raise RuntimeError('fixture_transient_route_read_failure')
            return original_audit(**kw)
        monkeypatch.setattr(route, 'audit_route_allocation_effect', audit)
        result = complete_pipeline_shadow(receipt, query=db.query, writer=db.writer)
        if failure:
            stage = ('l15_route_effect' if failure == 'audit' else 'candidate_allocations'
                if failure in {'ev_collection', 'ensemble_collection'} else 'lifecycle_commit'
                if failure in {'route_lifecycle', 'l4_lifecycle'} else 'native_registration')
            assert result['status'] == 'failed' and result['stage'] == stage, result
            assert pipeline_shadow_errors(result)
            if failure in {'ev_collection', 'ensemble_collection', 'l4_registration', 'l4_lifecycle'}:
                assert result['l15_route_collection']['plans']
                assert result['native_execution']['status'] == 'partial_native_execution_registration'
                assert any(read_snapshot(db.query, row['snapshot_id'])['payload']['content']['owner'] == 'l15_route'
                    for row in result['native_execution']['registrations'])
                # A stale top-level green label cannot hide a failed owner.
                assert pipeline_shadow_errors({**result, 'status': 'native_execution_pairs_registered'})
            result = complete_pipeline_shadow(result, query=db.query, writer=db.writer)
            assert all(row in calls[1] for row in calls[0])
        assert result['status'] == 'native_execution_pairs_registered', result
        assert result['l15_route_effect']['status'] == 'verified_no_allocation_change'
        assert len(result['native_execution']['registrations']) == (1 if other_candidates_waiting else 4)
        assert len(result['candidate_allocations']['plans']) == (1 if other_candidates_waiting else 4)
        assert result['candidate_allocations']['upstream_collection_status'] == (
            'awaiting_frozen_l4_candidate' if other_candidates_waiting else 'allocation_pairs_frozen')
        route_plan = result['l15_route_collection']['plans'][0]
        from services.paired_nav_comparison import resolve_comparison
        route_execution = [read_snapshot(db.query, item['snapshot_id'])
            for item in result['native_execution']['registrations']
            if read_snapshot(db.query, item['snapshot_id'])['payload']['content']['owner'] == 'l15_route']
        assert len(route_execution) == 1
        assert route_execution[0]['payload']['content']['pair_id'] == route_plan['pair_id']
        assert resolve_comparison(query=db.query, execution=route_execution[0])['kind'] == 'route_policy_contrast'
        assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])  # Registration is not mature evidence.
        assert pipeline_shadow_errors(result) == []
        assert complete_pipeline_shadow(result, query=db.query, writer=db.writer) == result
        assert source.total_changes == before_source
        assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])
    finally:
        source.close()
