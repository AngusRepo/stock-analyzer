"""Synthetic fixed models, real normalization/inference/recommendation/allocator.

No training, production access or financial performance assertions.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json

import pytest

from services import ensemble_v2 as ensemble, paired_nav_l3_candidate as l3
from services.active8_ensemble_repository import _exact_artifact_row
from services.active8_score_semantics import normalize_active8_challenger_scores, MODEL_TARGET_SEMANTIC_VERSION
from services.paired_nav_collection import run_and_capture_allocation, baseline_model_identity
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_journal import digest, encode, freeze_snapshot, read_snapshot
from services.paired_nav_recommendation_path import run_and_capture_recommendation_path
from test_paired_nav_recommendation_path import recommendation_inputs, fixed_l4_policy
from test_paired_nav_candidate_collection import environment
from test_paired_nav_intervention import inputs as allocation_inputs
from test_paired_nav_journal import FEES
from test_native_paper_sandbox import native_runner

DAY = '2026-09-07'
NOW = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)
CUTOFF = '2026-09-07T10:00:00Z'


def fixed_artifact(version):
    base = {name: {'artifact_id': f'{name}:{version}', 'version': version,
        'checksum': 'sha256:' + digest([name, version]), 'candidate_type': 'oof_full_fit_release'}
        for name in ensemble.ACTIVE_ALPHA_MODELS}
    payload = {'schema_version': ensemble.ARTIFACT_SCHEMA_VERSION,
        'ensemble_semantic_version': ensemble.ENSEMBLE_V2_SEMANTIC_VERSION,
        'calibration_schema_version': ensemble.CALIBRATION_SCHEMA_VERSION,
        'model_order': list(ensemble.ACTIVE_ALPHA_MODELS), 'feature_names': list(ensemble.FEATURE_NAMES),
        'cohort_id': 'fixture-cohort-' + version, 'knowledge_cutoff_date': '2026-09-04',
        'base_artifacts': base, 'base_artifact_set_checksum': digest(base),
        'observation_artifacts': base, 'observation_artifact_set_checksum': digest(base),
        'selected_models': list(base), 'excluded_models': [],
        'fit': {'method': 'nonnegative_rank_ridge_full_fit_after_heldout_chronological_oof_validation',
            'rank_coefficient_constraint': 'nonnegative', 'outer_folds': 5,
            'intercept': -.08, 'coefficients': [.02] * 8 + [0.] * 8},
        'validation': {'decision': 'PASS', 'rank_ic_equal_date_market_lcb90': .1,
            'top_bottom_net_return_spread_lcb90': .01, 'failed_gates': []},
        'calibration': {'absolute_residual_quantiles': {'0.9': .005, '0.95': .01},
            'probability_x_thresholds': [-.1, .1], 'probability_y_thresholds': [.05, .95]},
        'signal_policy': {'schema_version': ensemble.SIGNAL_POLICY_VERSION, 'top_k': None,
            'buy_rule': 'conformal_lower_bound_gt_zero', 'sell_rule': 'conformal_upper_bound_lt_zero',
            'buy_coverage': .9, 'strong_coverage': .95,
            'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION}}
    payload['payload_checksum'] = digest(payload)
    return payload


@pytest.fixture
def prepared(environment, monkeypatch, request):
    from functools import partial
    from services import paired_nav_opb_candidate
    monkeypatch.setattr(paired_nav_opb_candidate, 'select_opb_candidates',
        partial(paired_nav_opb_candidate.select_opb_candidates, now=NOW))
    import graphs.daily_pipeline_v2 as graph
    from services import paired_nav_collection as capture
    db, bucket, _, _ = environment
    db.conn.executescript('CREATE TABLE IF NOT EXISTS data_domain_control_revisions(table_name TEXT PRIMARY KEY,revision INTEGER,updated_at TEXT);')
    migration = Path(__file__).resolve().parents[2] / 'worker/domain-migrations/learning/0027_active8_ensemble_serving_owner.sql'
    db.conn.executescript(migration.read_text(encoding='utf-8'))
    artifact, formal = fixed_artifact('candidate-v1'), fixed_artifact('formal-v1')
    selected_models = getattr(request, 'param', {}).get('selected_models')
    if selected_models is not None:
        # Define the synthetic candidate before registry/ledger freezing, never
        # rewrite an already-reviewed artifact to obtain different coverage.
        artifact['selected_models'] = list(selected_models)
        artifact['excluded_models'] = [name for name in ensemble.ACTIVE_ALPHA_MODELS if name not in selected_models]
        artifact['base_artifacts'] = {name: artifact['observation_artifacts'][name] for name in selected_models}
        artifact['base_artifact_set_checksum'] = digest(artifact['base_artifacts'])
        for index, name in enumerate(ensemble.ACTIVE_ALPHA_MODELS):
            if name not in selected_models:
                artifact['fit']['coefficients'][index] = 0.
                artifact['fit']['coefficients'][index + 8] = 0.
        artifact.pop('payload_checksum')
        artifact['payload_checksum'] = digest(artifact)
    shared_bases = bool(getattr(request, 'param', {}).get('shared_bases'))
    if shared_bases:
        # A new ensemble calibrator may reuse the exact incumbent base models.
        # Declare this before any candidate admission or outcome is frozen.
        artifact['fit']['intercept'] += .01
        formal['base_artifacts'] = deepcopy(artifact['base_artifacts'])
        formal['observation_artifacts'] = deepcopy(artifact['observation_artifacts'])
        for payload in (artifact, formal):
            payload['base_artifact_set_checksum'] = digest(payload['base_artifacts'])
            payload['observation_artifact_set_checksum'] = digest(payload['observation_artifacts'])
            payload.pop('payload_checksum')
            payload['payload_checksum'] = digest(payload)
    registry = _exact_artifact_row(artifact, training_run_id=artifact['cohort_id'], archive_uri='gs://fixture/candidate.json')
    registry.update(created_at='2026-09-06 03:00:00', updated_at='2026-09-06 03:00:00')
    fields = list(registry)
    db.conn.execute('INSERT INTO active8_ensemble_artifacts_v1(' + ','.join(fields) + ') VALUES(' + ','.join('?' for _ in fields) + ')', [registry[key] for key in fields])
    candidates = {name: {**row, 'model': name, 'status': 'challenger', 'effective_status': 'challenger',
        'production_effect': False, 'vote_weight': 0., 'schema': {'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION}}
        for name, row in artifact['observation_artifacts'].items()}
    manifest = {'active8_ensemble': formal, 'active8_action_authority': graph._active8_action_authority(formal),
                'active8_shadow_candidates': list(candidates.values())}
    inputs = recommendation_inputs()
    # L3 advice is not final selection. Declare a fixed, valid L4 head BEFORE
    # freezing either arm; use the actual producer/allocator, not raw ML BUY.
    inputs['filter_options']['alpha_policy'] = fixed_l4_policy()
    third = deepcopy(inputs['screener_recs'][0])
    third.update(stock_id=3, id=3, symbol='2454', name='2454')
    inputs['screener_recs'].append(third)
    inputs['payloads'].append({**deepcopy(inputs['payloads'][0]), 'symbol': '2454'})
    inputs['predictions']['2454'] = deepcopy(inputs['predictions']['2330'])
    pool = {name: {'serving_artifact_id': row['artifact_id'], 'version': row['version'],
                   'checksum': row['checksum'], 'serving_eligible': True}
            for name, row in formal['base_artifacts'].items()}
    for symbol, rank in [('2330', 1.), ('2317', 0.), ('2454', .5)]:
        pred = inputs['predictions'][symbol]
        pred['stock_meta'] = {'market_segment': 'LISTED'}
        pred['rank_scores'] = {name: rank for name in ensemble.ACTIVE_ALPHA_MODELS}
        ensemble.attach_ensemble_v2(pred, formal, pool)
        challenger_rank = rank if shared_bases else 1 - rank
        pred['challenger_rank_scores'] = {name: challenger_rank for name in candidates}
        pred['challenger_model_signals'] = {name: {'forecast_pct': challenger_rank}
            for name in ('DLinear', 'PatchTST', 'iTransformer')}
    normalize_active8_challenger_scores(inputs['predictions'], candidate_rows=candidates, run_date=DAY)
    selection = l3.load_candidate_ensembles(manifest=manifest, signal_date=DAY, decision_cutoff=CUTOFF, query=db.query)
    db.conn.commit()
    for module in (capture, l3):
        monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=NOW))
    return db, bucket, manifest, inputs, selection


def seal(prepared):
    db, bucket, manifest, inputs, selection = prepared
    inputs = deepcopy(inputs)
    result, context = run_and_capture_recommendation_path(inputs=inputs, candidate_reader=lambda: selection)
    for row in result['recommendations']:
        assert row.get('l4_alpha_ev', {}).get('status') == 'loaded', row.get('l4_alpha_ev', row)
    alloc = allocation_inputs()
    alloc['alpha_policy'] = deepcopy(inputs['filter_options']['alpha_policy'])
    alloc['return_history']['2454'] = [.01, -.01, 0, .02, -.02] * 10
    alloc['recommendations'] = result['recommendations']
    def isolated(**kw):
        sink = kw.pop('allocation_evidence_sink')
        plan = run_isolated_allocation(inputs=kw, inherited_state={})
        sink(plan['capture'])
        return plan['recommendations']
    _, receipt = run_and_capture_allocation(**alloc, signal_date=DAY, source_run_id='l3-test',
        trading_config={'fees': FEES, 'alphaFramework': deepcopy(alloc['alpha_policy'])}, risk_config={'maxSingleNamePct': .25},
        formal_model_manifest=manifest, model_predictions=inputs['predictions'],
        recommendation_context=context, query=db.query, writer=db.writer, run_allocation=isolated)
    assert receipt['status'] == 'allocation_context_frozen', receipt
    return receipt


def test_canonical_payload_id_is_derived_without_mutating_checksum(prepared):
    _, _, manifest, _, _ = prepared
    original = deepcopy(manifest)
    identity = baseline_model_identity(manifest)
    assert identity['artifact_id'] == ensemble.ensemble_artifact_id(manifest['active8_ensemble'])
    assert 'artifact_id' not in manifest['active8_ensemble']
    assert manifest == original


def test_real_daily_normalization_candidate_inference_and_isolated_allocation(prepared):
    db, _, manifest, inputs, selection = prepared
    before = deepcopy(inputs)
    candidate = selection['candidates'][0]
    predictions = l3.infer_candidate_predictions(predictions=inputs['predictions'], candidate=candidate, signal_date=DAY)
    assert predictions['2330']['ensemble_v2']['forecast_pct'] == pytest.approx(-.08)
    assert predictions['2317']['ensemble_v2']['forecast_pct'] == pytest.approx(.08)
    assert inputs == before
    assert predictions['2317']['active8_action_authority']['buy_authorized'] is False
    receipt = seal(prepared)
    result = l3.collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    assert len(result['plans']) == 1
    content = read_snapshot(db.query, result['plans'][0]['snapshot_id'])['payload']['content']
    assert content['baseline']['capture']['effective_weights'].get('2330', 0) > 0, content['baseline']
    assert content['candidate']['capture']['effective_weights'].get('2317', 0) > 0
    assert '2330' not in content['candidate']['capture']['effective_weights']
    assert content['nav_maturity_credit'] == 0 and content['can_write_order'] is False
    parent = read_snapshot(db.query, content['allocation_context_snapshot_id'])['payload']['content']
    assert parent['upstream_allocation_context_snapshot_id'] == receipt['snapshot_id']
    for arm, advice in [('baseline', 'STRONG_BUY'), ('candidate', 'STRONG_SELL')]:
        prediction = parent['model_prediction_arms'][arm]['predictions']['2330']
        assert prediction['ensemble_v2']['unqualified_signal'] == advice
        assert prediction['signal_raw'] == 'HOLD'  # No invented directional qualification.
    assert l3.collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer) == result
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


@pytest.mark.parametrize('fault', ['formal_rank_fallback', 'identity', 'day', 'missing_core', 'range', 'partial_section', 'reversed_rank'])
def test_candidate_cannot_borrow_or_relabel_incumbent_predictions(prepared, fault):
    _, _, _, inputs, selection = prepared
    predictions = deepcopy(inputs['predictions'])
    row = predictions['2330']
    lineage = row['challenger_model_score_lineage']
    if fault == 'formal_rank_fallback':
        row.pop('challenger_rank_scores')
    elif fault == 'identity':
        lineage['candidate_artifact_checksums']['LightGBM'] = 'sha256:' + 'f' * 64
    elif fault == 'day':
        lineage['run_date'] = '2026-09-06'
    elif fault == 'missing_core':
        row['challenger_rank_scores'].pop('LightGBM')
    elif fault == 'range':
        row['challenger_rank_scores']['LightGBM'] = 2.
    elif fault == 'partial_section':
        lineage['cross_section_sizes']['LightGBM'] = 1
    else:
        row['challenger_rank_scores']['LightGBM'] = 1.
    with pytest.raises(ValueError, match='paired_nav_l3_'):
        l3.infer_candidate_predictions(predictions=predictions, candidate=selection['candidates'][0], signal_date=DAY)


def test_future_or_mismatched_artifact_waits_without_using_current_model(prepared):
    db, _, manifest, _, selection = prepared
    db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET created_at='2026-09-07 11:00:00'")
    assert l3.load_candidate_ensembles(manifest=manifest, signal_date=DAY, decision_cutoff=CUTOFF, query=db.query)['candidates'] == []
    db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET created_at='2026-09-06 03:00:00'")
    other = deepcopy(manifest)
    other['active8_shadow_candidates'][0]['artifact_id'] = 'unrelated-new-base'
    assert l3.load_candidate_ensembles(manifest=other, signal_date=DAY, decision_cutoff=CUTOFF, query=db.query)['candidates'] == []
    # Selection/reading never grants serving eligibility to candidate slots.
    pool = {name: {'serving_artifact_id': row['artifact_id'], 'version': row['version'],
        'checksum': row['checksum'], 'serving_eligible': False}
        for name, row in selection['candidates'][0]['artifact']['base_artifacts'].items()}
    with pytest.raises(RuntimeError, match='base_not_serving:LightGBM:eligibility_missing'):
        ensemble.validate_active8_ensemble_artifact(selection['candidates'][0]['artifact'], pool)


def test_l3_collection_runs_even_without_l4_candidate(prepared):
    from services.paired_nav_candidate_collection import collect_candidate_allocations
    db, bucket, _, _, _ = prepared
    db.conn.execute('DELETE FROM model_artifact_registry')  # private fixture database only
    receipt = seal(prepared)
    result = collect_candidate_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert [p['owner'] for p in result['plans']] == ['ensemble']
    assert result['status'] == 'allocation_pairs_frozen'
    assert result['owner_status']['expected_return'] == 'awaiting_frozen_l4_candidate'


def test_real_native_registration_keeps_each_models_actual_buy_slate(prepared, native_runner):
    import sqlite3
    from services.paired_native_runtime import register_candidate_execution_plans
    from services.native_paper_sandbox import native_runtime_manifest
    from services.native_paper_source_capture import ImmutableNativeObjects
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar
    db, _, _, _, _ = prepared
    receipt = seal(prepared)
    plans = l3.collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    source, query_source = source_fixture()
    try:
        source.execute("UPDATE daily_recommendations SET signal='BUY',has_buy_signal=1,eligible_for_pending_buy=1 WHERE symbol='2330'")
        for index, symbol in [(2, '2317'), (3, '2454')]:
            source.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)', [index, symbol, symbol, 'TWSE'])
            source.execute('INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason,has_buy_signal) VALUES(?,?,?,?,?,?,?,?)',
                           [DAY, index, symbol, symbol, index, 0, 'formal_filtered_seed', 0])
        before = source.total_changes
        owners = native_runtime_manifest(native_runner)['tables']
        objects = ImmutableNativeObjects(Bucket())
        result = register_candidate_execution_plans(collection=plans, query=db.query, writer=db.writer,
            objects=objects, domain_queries={owner: query_source for owner in set(owners.values())},
            kv_read=calendar, runner=native_runner, clock=lambda: NOW,
            context_reader=lambda: {'schema_version': 'native-paper-source-context-v1',
                'observed_at': NOW.isoformat(), 'variables': {},
                'frozen_kv': {'ml:config': '{}', 'ml:config.debate_max_rounds': '3', 'ml:adaptive_params': None}})
        assert result['status'] == 'native_execution_pairs_registered'
        registration = read_snapshot(db.query, result['registrations'][0]['snapshot_id'])['payload']['content']
        for arm, expected in [('baseline', ['2330']), ('candidate', ['2317'])]:
            state = objects.get(registration['initial_state_objects'][arm])
            with sqlite3.connect(':memory:') as private:
                private.executescript(state['state_sql'])
                buys = [row[0] for row in private.execute('SELECT symbol FROM daily_recommendations WHERE has_buy_signal=1 AND eligible_for_pending_buy=1 ORDER BY symbol')]
                assert buys == expected
        assert source.total_changes == before
        assert registration['model_prediction_arms']['candidate']['model_identity']['artifact_checksum'] != registration['model_prediction_arms']['baseline']['model_identity']['artifact_checksum']
    finally:
        source.close()


@pytest.mark.parametrize('multiple_bundles', [False, True])
def test_actual_daily_node_freezes_matching_model_and_collects_l3_plan(prepared, monkeypatch, multiple_bundles, native_runner):
    import asyncio
    import sqlite3
    from types import SimpleNamespace
    import graphs.daily_pipeline_v2 as graph
    from services import recommendation_service as service, trading_config_loader
    from services.paired_nav_candidate_collection import collect_candidate_allocations
    db, bucket, manifest, inputs, _ = prepared
    state = deepcopy(inputs)
    for payload in state['payloads']:
        payload['prices'] = [
            {'date': (NOW - timedelta(days=offset)).date().isoformat(), 'close': 100 + offset % 3,
             'open': 100, 'high': 104, 'low': 98, 'volume': 1_000_000}
            for offset in reversed(range(70)) if (NOW - timedelta(days=offset)).weekday() < 5]
    manifest = {**manifest, 'schema_version': graph.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA}
    state.update(run_date=DAY, producer_run_id='l3-real-node', decision_universe_frozen_at=CUTOFF,
        pipeline_modal_serving_context={'schema_version': 'pipeline-modal-serving-context-v1',
            'serving_manifest': manifest, 'serving_manifest_digest': graph._pipeline_modal_canonical_digest(manifest)})
    if multiple_bundles:
        from test_paired_nav_l3_dispatch import setup_dispatch, attach_outputs
        dispatch_state = setup_dispatch(prepared)
        state['paired_nav_l3_dispatch'] = dispatch_state['paired_nav_l3_dispatch']
        state['pipeline_modal_serving_context']['expected_source_sha'] = 'a' * 40
        attach_outputs(state, inputs)
        db.conn.commit()
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    db.conn.backup(threaded)
    db.conn.close()
    db.conn = threaded
    db.conn.row_factory = sqlite3.Row
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=db.query, batch_execute=db.writer))
    monkeypatch.setattr(graph, '_resolve_runtime_regime_contract', lambda *a, **k:
        {'alpha_regime': 'bull', 'regime_surface': {'bull': 1.0}})
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract', lambda:
        SimpleNamespace(config={'ranking': {'enabled': True}, 'fees': FEES}, contract=SimpleNamespace(degraded=False)))
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
    from test_paired_nav_execution_environment import patch_graph_environment
    captured_environment = patch_graph_environment(monkeypatch, native_runner)
    result = asyncio.run(graph.node_recommend(state))
    receipt = result['paired_nav_collection']
    assert receipt['status'] == 'allocation_context_frozen'
    content = read_snapshot(db.query, receipt['snapshot_id'])['payload']['content']
    assert content['native_execution_environment'] == captured_environment
    assert len(content['recommendation_context']['l3_candidate_selection']['candidates']) == (2 if multiple_bundles else 1)
    plans = collect_candidate_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert {p['owner'] for p in plans['plans']} == {'ensemble', 'l4_alpha_ev', 'allocator_ev_fusion'}
    assert sum(p['owner'] == 'ensemble' for p in plans['plans']) == (2 if multiple_bundles else 1)
    from services.paired_nav_evidence import read_verified_nav_evidence
    population = read_verified_nav_evidence(business_date=DAY, query=db.query).summary()['candidate_population']
    assert {f['owner'] for f in population['families']} == {'ensemble', 'l4_alpha_ev', 'allocator_ev_fusion'}
    assert population['pair_count'] == (4 if multiple_bundles else 3)
    assert population['selection_materialization_complete'] is True
    assert all(p['execution_status'] == 'not_registered' and p['accounted_sessions'] == 0 for p in population['pairs'])
    from services.paired_nav_execution_environment import execution_policy
    for item in plans['plans']:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        assert plan['configuration']['native_execution_policy'] == execution_policy(captured_environment)
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


def test_frozen_l3_selection_is_visible_before_any_allocation_is_published(prepared):
    from services.paired_nav_evidence import read_verified_nav_evidence
    db, *_ = prepared
    seal(prepared)
    population = read_verified_nav_evidence(business_date=DAY, query=db.query).summary()['candidate_population']
    assert population['pair_count'] == population['hypothesis_count'] == 0
    assert population['selection_materialization_complete'] is False
    assert len(population['unmaterialized_selections']) == 3
    assert {p['owner'] for p in population['unmaterialized_selections']} == {'ensemble', 'l4_alpha_ev', 'allocator_ev_fusion'}
