"""Real recommendation/sparse code, synthetic signals; never performance data."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from services import paired_nav_recommendation_path as path
from services import recommendation_service as service
from services.active_model_policy import ACTIVE_ALPHA_MODELS
from services.active8_score_semantics import (
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
)
from services.paired_nav_collection import run_and_capture_allocation
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot
from test_paired_nav_intervention import inputs as allocation_inputs
from test_paired_nav_journal import DB, FEES
from test_paired_nav_candidate_collection import environment
from test_native_paper_sandbox import native_runner
from test_recommendation_provenance import _screener_rec, _payload, _prediction_with_ensemble_v2


def recommendation_inputs():
    predictions = {}
    rows, payloads = [], []
    for index, symbol in enumerate(('2330', '2317'), start=1):
        pred = _prediction_with_ensemble_v2()
        pred['rank_scores'] = {name: .8 for name in ACTIVE_ALPHA_MODELS}
        pred['model_score_lineage'] = {
            'schema_version': MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
            'semantic_version': MODEL_SCORE_SEMANTIC_VERSION,
            'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION,
            'complete': True, 'blockers': []}
        pred['ensemble_v2'].update(avg_rank=.79, weights={name: 1 / len(ACTIVE_ALPHA_MODELS) for name in ACTIVE_ALPHA_MODELS},
                                   contributing_models=list(ACTIVE_ALPHA_MODELS))
        if symbol == '2317':
            pred['ensemble_v2']['signal'] = 'SELL'
        predictions[symbol] = pred
        row = _screener_rec(symbol)
        row.update(stock_id=index, date='2026-09-07')
        rows.append(row)
        payload = _payload(symbol)
        payload['prices'][0]['volume'] = 1_000_000
        for field in ('prices', 'indicators', 'chips'):
            for item in payload[field]:
                item['date'] = '2026-09-07'
        payloads.append(payload)
    return dict(screener_recs=rows, predictions=predictions, payloads=payloads,
        filter_options=dict(persona_opinions={}, persona_weight=0, regime_label='bull',
            regime_surface={}, alpha_policy={}, fundamental_quality_by_symbol={},
            pit_sector_alpha_by_symbol={}, run_date='2026-09-07'), l2_summary=None)


def fixed_l4_policy():
    # Synthetic, predeclared coefficients; no fitting or promotion is performed.
    # Preserve the full canonical feature set required by the actual producer.
    from test_l4_alpha_ev_producer import _artifact
    artifact = _artifact(intercept=-.001)
    artifact['coefficients'] = {name: 0. for name in artifact['feature_names']}
    artifact['coefficients'].update(ml_edge_norm=.001, ensemble_directional_margin=.1)
    return {'l4AlphaEv': artifact}


@pytest.fixture(autouse=True)
def forbid_live_io(monkeypatch):
    def forbidden(*a, **kw):
        pytest.fail('recommendation replay must not load mutable live data')
    for name in ('load_inherited_paper_weights', 'build_portfolio_ml_shadow_inputs',
                 'build_rfs_implementable_frontier_shadow',
                 'load_online_portfolio_bandit_reward_ledger'):
        monkeypatch.setattr(service, name, forbidden)
    from types import SimpleNamespace
    monkeypatch.setattr(service, 'MARKET_D1_CLIENT', SimpleNamespace(query=forbidden))


def test_shared_path_matches_original_calls_and_captures_before_mutation():
    inputs = recommendation_inputs()
    original = deepcopy(inputs)
    rows, sells, diagnostics = service.filter_and_score_recommendations(
        original['screener_recs'], original['predictions'], original['payloads'],
        **original['filter_options'], include_filtered_diagnostics=True)
    rows = service.apply_l2_timesfm_evidence(rows, original['predictions'], l2_summary=None)
    rows = service.apply_core_family_evidence(rows, original['predictions'], target_size=len(rows),
        require_lifecycle_weights=True, require_complete_active_models=True)
    expected_before = deepcopy(inputs)
    result, context = path.run_and_capture_recommendation_path(inputs=inputs)
    assert context['status'] == 'recommendation_context_captured'
    assert result['recommendations'] == rows
    assert result['sell_count'] == sells == 0
    assert {row['symbol'] for row in rows} == {'2330', '2317'}
    assert result['filter_stage_diagnostics'] == diagnostics
    assert inputs['predictions'] == original['predictions']
    assert context['inputs'] == expected_before
    assert 'core_family_evidence' not in context['inputs']['predictions']['2330']
    assert 'core_family_evidence' in context['post_predictions']['2330']
    assert path.replay_recommendation_context(context) == result
    inputs['predictions']['2330']['ensemble_v2']['signal'] = 'SELL'
    result['recommendations'][0]['score'] = -999
    assert context['expected']['recommendations'][0]['score'] != -999
    assert context['inputs']['predictions']['2330']['ensemble_v2']['signal'] == 'BUY'


def test_failed_l3_challenger_does_not_discard_other_lanes_incumbent_context():
    def unavailable():
        raise ValueError('paired_nav_l3_dispatch_inference_missing_or_failed')
    result, context = path.run_and_capture_recommendation_path(inputs=recommendation_inputs(), candidate_reader=unavailable)
    assert context['status'] == 'recommendation_context_captured'
    assert context['l3_candidate_selection']['status'] == 'failed'
    assert context['l3_candidate_selection']['reason'] == 'paired_nav_l3_dispatch_inference_missing_or_failed'
    assert path.replay_recommendation_context(context) == result


def test_replay_recomputes_admission_not_just_scores_of_incumbent_picks():
    inputs = recommendation_inputs()
    inputs['filter_options']['alpha_policy'] = fixed_l4_policy()
    inputs['predictions']['2330']['ensemble_v2']['avg_rank'] = .95
    inputs['predictions']['2317']['ensemble_v2']['avg_rank'] = .05
    baseline, context = path.run_and_capture_recommendation_path(inputs=inputs)
    altered = deepcopy(context['inputs'])
    altered['predictions']['2330']['ensemble_v2']['signal'] = 'SELL'
    altered['predictions']['2317']['ensemble_v2']['signal'] = 'BUY'
    altered['predictions']['2330']['ensemble_v2']['avg_rank'] = .05
    altered['predictions']['2317']['ensemble_v2']['avg_rank'] = .95
    candidate = path.run_recommendation_path(inputs=altered)
    # Both directions reach L4. Actual EV, not the BUY/SELL label, changes picks.
    assert {r['symbol'] for r in baseline['recommendations']} == {'2330', '2317'}
    assert {r['symbol'] for r in candidate['recommendations']} == {'2330', '2317'}
    # Run the actual isolated allocator on both resulting slates, no EV override.
    plans = []
    for result in (baseline, candidate):
        alloc = allocation_inputs()
        alloc['alpha_policy'] = deepcopy(inputs['filter_options']['alpha_policy'])
        alloc['recommendations'] = result['recommendations']
        plans.append(run_isolated_allocation(inputs=alloc, inherited_state={}))
    assert plans[0]['capture']['effective_weights'].get('2330', 0) > 0
    assert plans[1]['capture']['effective_weights'].get('2317', 0) > 0
    assert '2317' not in plans[0]['capture']['effective_weights']
    assert '2330' not in plans[1]['capture']['effective_weights']
    assert all(p['nav_maturity_credit'] == 0 and p['can_write_order'] is False for p in plans)


@pytest.mark.parametrize('fault', ['inputs', 'outputs', 'formal'])
def test_capture_failure_does_not_duplicate_or_hide_formal_execution(fault):
    calls = []
    inputs = recommendation_inputs()
    if fault == 'inputs':
        inputs['unserializable'] = object()
    def run_filter(*a, **kw):
        calls.append('filter')
        if fault == 'formal':
            raise RuntimeError('actual recommendation failure')
        return [{'symbol': '2330', 'data': object() if fault == 'outputs' else 1}], 0, {}
    def l2(rows, *a, **kw):
        calls.append('l2')
        return rows
    def core(rows, *a, **kw):
        calls.append('core')
        return rows
    if fault == 'formal':
        with pytest.raises(RuntimeError, match='actual recommendation failure'):
            path.run_and_capture_recommendation_path(inputs=inputs, filter_rows=run_filter, enrich_l2=l2, enrich_core=core)
        assert calls == ['filter']
    else:
        result, context = path.run_and_capture_recommendation_path(
            inputs=inputs, filter_rows=run_filter, enrich_l2=l2, enrich_core=core)
        assert calls == ['filter', 'l2', 'core']
        assert len(result['recommendations']) == 1 and context['status'] == 'failed'


@pytest.mark.parametrize('fault', ['checksum', 'source', 'output', 'post_predictions'])
def test_replay_rejects_corrupt_or_different_execution(fault):
    _, context = path.run_and_capture_recommendation_path(inputs=recommendation_inputs())
    if fault == 'source':
        context['source_identity']['recommendation_service.py'] = '0' * 64
    elif fault == 'post_predictions':
        context['post_predictions']['2330']['ensemble_v2']['signal'] = 'SELL'
    else:
        context['expected']['sell_count'] = 999
    if fault != 'checksum':
        context['content_checksum'] = digest({k: v for k, v in context.items() if k != 'content_checksum'})
    with pytest.raises(ValueError, match='paired_nav_'):
        path.replay_recommendation_context(context)


def test_sealed_recommendation_to_allocation_replay_and_no_legacy_reconstruction(monkeypatch):
    from services import paired_nav_collection as capture
    db = DB(legacy_assessments=False)
    inputs = recommendation_inputs()
    inputs['filter_options']['alpha_policy'] = fixed_l4_policy()
    result, context = path.run_and_capture_recommendation_path(inputs=inputs)
    alloc = allocation_inputs()
    alloc['alpha_policy'] = deepcopy(inputs['filter_options']['alpha_policy'])
    alloc['recommendations'] = result['recommendations']
    # Local runner uses original sparse/OPB with only external inherited state isolated.
    def isolated(**kw):
        sink = kw.pop('allocation_evidence_sink')
        result = run_isolated_allocation(inputs=kw, inherited_state={})
        sink(result['capture'])
        return result['recommendations']
    stamp = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)
    monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp))
    _, receipt = run_and_capture_allocation(**alloc, signal_date='2026-09-07', source_run_id='path-test',
        trading_config={'fees': FEES}, risk_config={'maxSingleNamePct': .25},
        query=db.query, writer=db.writer, recommendation_context=context, run_allocation=isolated)
    replay = path.replay_frozen_recommendation_allocation(snapshot_id=receipt['snapshot_id'], query=db.query)
    assert replay['recommendation_allocation_replay'] == 'PASS'
    assert replay['allocation']['capture']['effective_weights'].get('2330', 0) > 0
    assert replay['nav_maturity_credit'] == 0
    # A legacy final-pick-only snapshot stays missing for this broader replay.
    saved = read_snapshot(db.query, receipt['snapshot_id'])['payload']['content']
    saved.pop('recommendation_context')
    legacy = freeze_snapshot(signal_date='2026-09-07', source_run_id='legacy-path',
        snapshot_kind='allocation_context', content=saved, query=db.query, writer=db.writer, now=stamp)
    with pytest.raises(ValueError, match='pre_filter_context_missing'):
        path.replay_frozen_recommendation_allocation(snapshot_id=legacy['snapshot_id'], query=db.query)


def test_actual_recommend_node_persists_pre_filter_context_and_replays(monkeypatch, environment, native_runner):
    import asyncio
    import sqlite3
    from types import SimpleNamespace
    import graphs.daily_pipeline_v2 as graph
    from services import paired_nav_collection as capture, trading_config_loader
    source = recommendation_inputs()
    source['filter_options']['alpha_policy'] = fixed_l4_policy()
    source['predictions']['2330']['ensemble_v2']['avg_rank'] = .95
    source['predictions']['2317']['ensemble_v2']['avg_rank'] = .05
    # Complete synthetic volume/history: do not override real liquidity checks.
    for payload in source['payloads']:
        payload['prices'] = [
            {'date': (datetime(2026, 9, 7) - timedelta(days=offset)).date().isoformat(),
             'close': 100 + offset % 3, 'open': 100, 'high': 104, 'low': 98,
             'volume': 1_000_000}
            for offset in reversed(range(70))
            if (datetime(2026, 9, 7) - timedelta(days=offset)).weekday() < 5]
    identity = {'artifact_id': 'fixture-ensemble', 'cohort_id': 'fixture-cohort',
                'payload_checksum': 'a' * 64, 'base_artifact_set_checksum': 'b' * 64}
    manifest = {'schema_version': graph.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
        'active8_ensemble': identity,
        'active8_action_authority': {'schema_version': graph.ACTIVE8_ACTION_AUTHORITY_SCHEMA,
            'mode': graph.ACTIVE8_ACTION_MODE_PRODUCTION, 'buy_authorized': True,
            'production_effect': True, **identity}}
    state = {**source, 'run_date': '2026-09-07', 'producer_run_id': 'real-recommend-path',
        'decision_universe_frozen_at': '2026-09-07T10:00:00Z',
        'pipeline_modal_serving_context': {'schema_version': 'pipeline-modal-serving-context-v1',
            'serving_manifest': manifest,
            'serving_manifest_digest': graph._pipeline_modal_canonical_digest(manifest)}}
    db, bucket, _, _ = environment
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    db.conn.backup(threaded)
    db.conn.close()
    db.conn = threaded
    db.conn.row_factory = sqlite3.Row
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=db.query, batch_execute=db.writer))
    monkeypatch.setattr(graph, '_resolve_runtime_regime_contract', lambda *a, **k:
        {'alpha_regime': 'bull', 'regime_surface': {'bull': 1.0}})
    config = {'ranking': {'enabled': True}, 'fees': FEES,
              'alphaFramework': deepcopy(source['filter_options']['alpha_policy'])}
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract', lambda:
        SimpleNamespace(config=config, contract=SimpleNamespace(degraded=False)))
    monkeypatch.setattr(graph, 'kv_client', SimpleNamespace(get_json=lambda key, **kw:
        {'maxSingleNamePct': .25} if key == 'trading:risk_config' else 1))
    monkeypatch.setattr(graph, 'load_pit_sector_alpha_experts', lambda *a, **k: {})
    monkeypatch.setattr(graph, 'load_fundamental_quality_by_symbol', lambda *a, **k: {})
    monkeypatch.setattr(graph, 'MARKET_D1_CLIENT', SimpleNamespace(query=lambda *a, **kw: []))
    monkeypatch.setattr(graph, 'load_online_portfolio_bandit_reward_ledger', lambda: [])
    monkeypatch.setattr(service, 'load_inherited_paper_weights', lambda *a, **k:
        {'status': 'fixture', 'weights': {}, 'portfolio_value_twd': 100000})
    monkeypatch.setattr(service, 'build_portfolio_ml_shadow_inputs', lambda *a, **k: {})
    monkeypatch.setattr(service, 'build_rfs_implementable_frontier_shadow', lambda *a, **k:
        {'status': 'fixture_observer', 'weights': {}, 'metrics': {}})
    stamp = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)
    monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp))
    from test_paired_nav_execution_environment import patch_graph_environment
    captured_environment = patch_graph_environment(monkeypatch, native_runner)
    result = asyncio.run(graph.node_recommend(state))
    receipt = result['paired_nav_collection']
    assert receipt['status'] == 'allocation_context_frozen'
    parent = read_snapshot(db.query, receipt['snapshot_id'])['payload']['content']
    assert parent['native_execution_environment'] == captured_environment
    context = parent['recommendation_context']
    assert [r['symbol'] for r in context['inputs']['screener_recs']] == ['2330', '2317']
    assert {r['symbol'] for r in parent['inputs']['recommendations']} == {'2330', '2317'}
    assert result['sell_filtered_symbols'] == []
    assert 'alpha_allocation' not in context['inputs']['predictions']['2330']
    verified = path.replay_frozen_recommendation_allocation(snapshot_id=receipt['snapshot_id'], query=db.query)
    assert verified['recommendation_allocation_replay'] == 'PASS'
    assert verified['allocation']['capture']['effective_weights'].get('2330', 0) > 0
    from services.paired_nav_candidate_collection import collect_candidate_allocations
    candidates = collect_candidate_allocations(snapshot_id=receipt['snapshot_id'],
        query=db.query, writer=db.writer, bucket=bucket)
    assert candidates['status'] == 'allocation_pairs_frozen'
    assert len(candidates['plans']) == 2
    for plan in candidates['plans']:
        content = read_snapshot(db.query, plan['snapshot_id'])['payload']['content']
        assert content['allocation_context_snapshot_id'] == receipt['snapshot_id']
        assert content['nav_maturity_credit'] == 0
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
