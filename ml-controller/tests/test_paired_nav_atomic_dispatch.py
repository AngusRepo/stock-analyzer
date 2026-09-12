"""Real daily source/L2/request -> real service consumer -> real ML merge.

Only model forecasts, remote readers and downstream writes are local stubs.
Fixture rank/peer values are not investment performance.
"""
import asyncio
from copy import deepcopy
from pathlib import Path
from datetime import date, timedelta

import pytest

import test_paired_nav_atomic_daily_inputs as daily
from test_active8_cutover_contract import _artifact
from test_pipeline_modal_manifest_parity import _pool_and_rows
from services import payload_builder, modal_client, cost_tracker
from services.paired_nav_atomic_inputs import daily_setup_status
from services.paired_nav_journal import digest


def _model_bundle(request):
    bundle = {k: deepcopy(request[k]) for k in ('run_date', 'run_id', 'state_gcs_uri',
        'serving_manifest_digest', 'slot_artifact_identities', 'active_artifact_identities',
        'active8_shadow_artifact_identities', 'serving_coverage', 'sequence_input_contract', 'sequence_dataset_meta')}
    bundle.update(schema_version='pipeline-modal-prediction-bundle-v1', n_input=len(request['payloads']),
        modal_source_sha=request['expected_source_sha'],
        active_artifact_versions={n: v['version'] for n, v in request['active_artifact_identities'].items()},
        active8_sequence_shadow_raw={'schema_version': 'active8-sequence-shadow-bundle-v1',
                                    'production_effect': False, 'vote_weight': 0., 'candidates': {}},
        predict_batch_v2_results=[{'symbol': p['symbol'], 'rank_scores': {n: (i+1)/3
            for n in ('LightGBM', 'XGBoost', 'ExtraTrees', 'TabM')}} for i, p in enumerate(request['payloads'])],
        gnn_graphsage_raw={'results': [{'symbol': p['symbol'], 'rank_score': (i+1)/3}
                                     for i, p in enumerate(request['payloads'])]})
    for name, field in [('DLinear', 'dlinear_raw'), ('PatchTST', 'patchtst_raw'), ('iTransformer', 'itransformer_raw')]:
        bundle[field] = {'results': [{'symbol': r['symbol'], 'forecast_pct': .01}
            for r in request['sequence_model_series_by_model'][name]]}
    return bundle


@pytest.fixture
def dispatched(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'ml-service'))
    population = daily._population()
    common = deepcopy(population['baseline']['rows'][0])
    common['seed']['row'].update(symbol='1003', name='1003')
    population['baseline']['rows'].append(deepcopy(common))
    population['replacements'][0]['candidate']['rows'].append(deepcopy(common))
    duplicate = deepcopy(population['replacements'][0])
    duplicate['definition_checksum'] = 'e'*64
    empty = deepcopy(duplicate)
    empty['definition_checksum'] = 'f'*64
    empty['candidate']['rows'] = []
    population['replacements'].extend([duplicate, empty])
    monkeypatch.setattr(daily, '_population', lambda: deepcopy(population))
    graph, state, _ = daily._setup(monkeypatch)
    state['active_stocks'].extend(payload_builder.build_ml_universe([], [{
        'stock_id': 4, 'symbol': '1003', 'name': '1003', 'sector': 'Semiconductor',
        'market_segment': 'LISTED', 'recommendation_lane': 'tradable',
        'eligible_for_pending_buy': True, 'watch_points': []}]))
    monkeypatch.setattr(payload_builder.CORE_D1_CLIENT, 'query', lambda sql, ids:
        [{'id': int(s)-999, 'symbol': s} for s in ids])
    load_prices = payload_builder._bulk_load_prices
    def prices(ids, **kw):
        result = load_prices([i for i in ids if i != 4], **kw)
        if 4 in ids:
            result[4] = [{'date': f'2026-09-{d:02}', 'close': 100, 'volume': 2_000_000} for d in range(1, 7)]
        return result
    monkeypatch.setattr(payload_builder, '_bulk_load_prices', prices)
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', lambda *a, **kw:
        [{'symbol': str(s), 'tag': 'Semiconductor'} for s in range(1000, 1004)])
    state['producer_run_id'] = 'daily-atomic-ml-fixture'
    state['decision_universe_frozen_at'] = '2026-09-06T12:00:00Z'
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    state.update(asyncio.run(graph.node_build_payloads(state)))
    canonical = []
    for sid, prices in state['payload_source_observations']['sources']['prices_by_id'].items():
        observed = {p['date']: p['close'] for p in prices}
        for age in reversed(range(512)):
            day = (date(2026, 9, 6) - timedelta(days=age)).isoformat()
            canonical.append({'symbol': str(999 + int(sid)), 'date': day, 'as_of_date': day,
                'adj_close': observed.get(day, 100), 'source': 'finlab.price'})
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', lambda *a, **kw: deepcopy(canonical))
    monkeypatch.setattr(graph, 'daily_sequence_target_points', lambda: 512)
    monkeypatch.setattr(graph, '_timesfm_l175_release_policy', lambda: {})
    monkeypatch.setattr(graph, '_load_model_pool_versions', lambda: ({'TimesFM': 'active'}, {'TimesFM': 'fixture-v'}, {}, True))
    monkeypatch.setattr(graph, '_load_active8_serving_pool', lambda: ({}, {}))
    monkeypatch.setattr(graph, '_timesfm_sequence_contract_points', lambda pool: 2)
    async def l2(rows, **kw):
        return {'results': [{'symbol': r['symbol'], 'forecast_pct': .02} for r in rows]}
    monkeypatch.setattr(modal_client, 'timesfm_batch_predict', l2)
    state.update(asyncio.run(graph.node_l2_timesfm_enrich(state)))
    assert state['paired_nav_atomic_l2']['status'] == 'l2_payloads_built'
    artifact = _artifact()  # existing synthetic contract fixture, not production training
    pool, rows = _pool_and_rows(artifact)
    manifest, checksum = graph._build_pipeline_modal_serving_manifest(pool, registry_rows=rows, active8_ensemble=artifact)
    state['pipeline_modal_serving_context'] = {'schema_version': 'pipeline-modal-serving-context-v1',
        'serving_pool': graph._pipeline_modal_runtime_pool_from_manifest(pool, manifest),
        'serving_manifest': manifest, 'serving_manifest_digest': checksum,
        'model_status': {r['model']: r['effective_status'] for r in manifest['models']},
        'active_versions': {r['model']: r['version'] for r in manifest['models']},
        'pool_versions_loaded': True, 'expected_source_sha': 'a'*40}
    monkeypatch.setattr(graph.LEARNING_D1_CLIENT, 'query', lambda *a, **kw: [])
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_url', lambda: 'https://fixture.invalid')
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_token', lambda: 'fixture')
    request = asyncio.run(graph._build_pipeline_modal_prediction_payload(state, state_gcs_uri='gs://fixture/daily'))
    assert 'paired_nav_atomic_slates' in request, state['paired_nav_atomic_dispatch']
    async def no_cost(*a, **kw): return None
    monkeypatch.setattr(cost_tracker, 'record_compute_profile_event', no_cost)
    def forbidden(*a, **kw): pytest.fail('post-dispatch mutable input read')
    for name in ('_load_model_pool_versions', '_load_active8_serving_pool', 'enrich_state_space_series_with_long_history'):
        monkeypatch.setattr(graph, name, forbidden)
    return graph, state, request


def _compute(request):
    from app.paired_nav_atomic_inference import run_atomic_slates
    formal = _model_bundle(request)
    calls = []
    def compute(child):
        calls.append(deepcopy(child))
        assert 'callback_url' not in child and 'paired_nav_atomic_slates' not in child
        return _model_bundle(child)
    formal['paired_nav_atomic_inference'] = run_atomic_slates(request, compute=compute, formal_bundle=formal)
    return formal, calls


def test_actual_daily_dispatch_service_and_original_merge_preserve_slate_features(dispatched):
    graph, state, request = dispatched
    before = deepcopy(request)
    bundle, calls = _compute(request)
    assert request == before
    assert len(calls) == 1 and [p['symbol'] for p in calls[0]['payloads']] == ['1000', '1002', '1003']
    assert calls[0]['payloads'][0]['stock_meta']['sector_peer_return_1d'] == .133333
    assert request['payloads'][0]['stock_meta']['sector_peer_return_1d'] == 0
    assert bundle['paired_nav_atomic_inference']['status'] == 'complete'
    state['modal_prediction_bundle'] = bundle
    raw = deepcopy(bundle)
    merged = asyncio.run(graph.node_l3_formal_predict(state))
    atomic = merged['paired_nav_atomic_ml']
    assert atomic['status'] == 'incomplete'  # semantic-unavailable definition remains
    assert atomic['definitions']['c'*64]['status'] == 'ready'
    assert atomic['definitions']['d'*64]['status'] == 'unavailable'
    assert atomic['definitions']['f'*64]['status'] == 'ready'
    key = atomic['definitions']['c'*64]['candidate_key']
    candidate = atomic['slates'][key]['predictions']
    assert candidate['1000']['stock_meta']['sector_peer_return_1d'] == .133333
    assert merged['predictions']['1000']['stock_meta']['sector_peer_return_1d'] == 0
    assert set(candidate) == {'1000', '1002', '1003'} and set(merged['predictions']) == {'1000', '1001', '1003'}
    assert bundle == raw
    again = asyncio.run(graph.node_l3_formal_predict(state))
    assert again['paired_nav_atomic_ml']['slates'] == atomic['slates']
    state.update(merged)
    status = daily_setup_status(state)
    assert status['reason'] == 'requires_allocation_and_native_execution'
    assert status['ml_ready_definition_count'] == 3 and status['ml_unavailable_definition_count'] == 1


@pytest.mark.parametrize('fault', ['missing_response', 'wrong_request', 'missing_slate', 'feature_missing',
    'wrong_run', 'wrong_membership', 'empty_faked', 'baseline_changed'])
def test_bad_candidate_result_cannot_replace_formal_or_become_ready(dispatched, fault):
    graph, state, request = dispatched
    bundle, _ = _compute(request)
    response = bundle['paired_nav_atomic_inference']
    contrast = response['contrasts'][0]
    key = contrast['candidate_key']
    if fault == 'missing_response': del bundle['paired_nav_atomic_inference']
    if fault == 'wrong_request': response['request_checksum'] = '0'*64
    if fault == 'missing_slate': del response['slates'][key]
    if fault == 'feature_missing': response['slates'][key]['result']['predict_batch_v2_results'][0]['rank_scores'].pop('TabM')
    if fault == 'wrong_run': response['slates'][key]['result']['run_id'] = 'other'
    if fault == 'wrong_membership': response['slates'][key]['result']['sequence_input_contract']['sequence_point_counts']['1000'] = 511
    if fault == 'empty_faked':
        response['slates'][key] = {'status': 'empty_universe', 'symbols': []}
    if fault == 'baseline_changed':
        response['slates'][contrast['baseline_key']]['result']['predict_batch_v2_results'][0]['rank_scores']['TabM'] = 999
    state['modal_prediction_bundle'] = bundle
    merged = asyncio.run(graph.node_l3_formal_predict(state))
    assert set(merged['predictions']) == {'1000', '1001', '1003'}
    atomic = merged['paired_nav_atomic_ml']
    if fault in {'missing_response', 'wrong_request'}:
        assert atomic['status'] == 'failed'
    else:
        assert atomic['definitions']['c'*64]['status'] == 'incomplete'
        if fault != 'baseline_changed':
            assert atomic['definitions']['f'*64]['status'] == 'ready', 'valid empty contrast must survive unrelated candidate failure'
    assert atomic['production_effect'] is False and atomic['nav_maturity_credit'] == 0


def test_real_parent_engine_publishes_once_and_real_callback_preserves_atomic_results(monkeypatch, dispatched):
    graph, state, request = dispatched
    import modal_app
    from app import batch_prediction, dlinear_universal, patchtst_universal, itransformer_universal, serving_resolver
    from services.pipeline_async_state_transport import encode_pipeline_state_envelope, decode_pipeline_state_envelope
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'a'*40)
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    monkeypatch.setattr(serving_resolver, 'load_d1_champion_pool', lambda **kw: pytest.fail('mutable serving read'))
    universes, published, callbacks = [], [], []
    def features(payloads, **kw):
        universes.append([p['symbol'] for p in payloads])
        return {'results': [{'symbol': p['symbol'], 'rank_scores': {n: (i+1)/4
            for n in ('LightGBM', 'XGBoost', 'ExtraTrees', 'TabM')}} for i, p in enumerate(payloads)]}
    def gnn(payloads, **kw):
        return {'results': [{'symbol': p['symbol'], 'rank_score': (i+1)/4} for i, p in enumerate(payloads)]}
    def sequence(*, series_list, **kw):
        return [{'symbol': p['symbol'], 'forecast_pct': (i+1)*.01} for i, p in enumerate(series_list)]
    monkeypatch.setattr(batch_prediction, 'predict_stock_v2_chunked_with_metrics', features)
    monkeypatch.setattr(batch_prediction, 'predict_gnn_graphsage_batch', gnn)
    for module, name in ((dlinear_universal, 'dlinear_batch_predict'), (patchtst_universal, 'patchtst_batch_predict'),
                         (itransformer_universal, 'itransformer_batch_predict')):
        monkeypatch.setattr(module, name, sequence)
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle', lambda req, bundle: published.append(deepcopy(bundle)) or {})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback', lambda req, bundle, elapsed: callbacks.append(deepcopy(bundle)) or {})
    bundle = modal_app._pipeline_prediction_bundle_impl(request)
    assert len(published) == len(callbacks) == 1
    assert universes == [['1000', '1001', '1003'], ['1000', '1002', '1003']]
    assert bundle['paired_nav_atomic_inference']['status'] == 'complete'
    state['l3_payloads'] = deepcopy(state['payloads'])
    encoded = encode_pipeline_state_envelope({'schema_version': 'pipeline-async-state-v1',
        'run_date': state['run_date'], 'producer_run_id': state['producer_run_id'], 'state': state})
    monkeypatch.setattr(graph, '_read_pipeline_async_state_artifact', lambda *a: decode_pipeline_state_envelope(encoded)['state'])
    observed = {}
    async def downstream(current):
        observed.update(deepcopy(current))
        return {}
    for name in ('node_compute_personas', 'node_recommend', 'node_llm_reasons', 'node_write_d1',
                 'node_paired_nav_setup', 'node_compute_sector_flow', 'node_compute_pit_residual_shadow', 'node_export_dataset_snapshot'):
        monkeypatch.setattr(graph, name, downstream)
    result = asyncio.run(graph.run_pipeline_v2_from_modal_prediction_callback({
        'state_gcs_uri': request['state_gcs_uri'], 'run_date': state['run_date'],
        'run_id': state['producer_run_id'], 'result': bundle}))
    assert observed['paired_nav_atomic_ml']['definitions']['c'*64]['status'] == 'ready'
    assert set(observed['predictions']) == {'1000', '1001', '1003'}
    assert daily_setup_status(observed)['ml_ready_definition_count'] == 3
    # Downstream persistence/native accounting are intentionally NOT exercised
    # here. The real terminal must not claim full closure from this ML fixture.
    assert result['status'] != 'completed'


def test_dispatch_rejects_changed_frozen_request_and_keeps_unavailable_population(dispatched):
    from services.paired_nav_atomic_dispatch import prepare_atomic_request
    _, state, request = dispatched
    saved = deepcopy(state['paired_nav_atomic_dispatch'])
    assert prepare_atomic_request(state, request) == saved
    assert len(saved['definition_checksums']) == 4
    assert list(saved['unavailable']) == ['d'*64]
    changed = deepcopy(state)
    l2 = changed['paired_nav_atomic_l2']
    l2['slates']['c'*64]['payloads'][0]['prices'][0]['close'] = 999
    l2['output_checksum'] = digest({k: v for k, v in l2.items() if k != 'output_checksum'})
    with pytest.raises(ValueError, match='frozen_request_changed'):
        prepare_atomic_request(changed, request)
    # Before dispatch, isolate this invalid candidate while retaining the
    # separately valid duplicate and empty definitions. No zero-result fiction.
    changed.pop('paired_nav_atomic_dispatch')
    output = prepare_atomic_request(changed, request)
    assert set(output['unavailable']) == {'c'*64, 'd'*64}
    assert {c['definition_checksum'] for c in output['request']['contrasts']} == {'e'*64, 'f'*64}
    assert state['paired_nav_atomic_dispatch'] == saved


def test_no_executable_slate_is_not_no_candidate_or_zero_return(dispatched):
    from services.paired_nav_atomic_dispatch import prepare_atomic_request, consume_atomic_results
    graph, state, request = dispatched
    state = deepcopy(state)
    state.pop('paired_nav_atomic_dispatch')
    l2 = state['paired_nav_atomic_l2']
    l2['status'] = 'incomplete'
    l2['slates'] = {k: {'status': 'failed', 'reason': 'paired_nav_atomic_l2_inference_failed'} for k in l2['slates']}
    l2['output_checksum'] = digest({k: v for k, v in l2.items() if k != 'output_checksum'})
    dispatch = prepare_atomic_request(state, request)
    assert dispatch['request'] is None and len(dispatch['unavailable']) == 4
    state['paired_nav_atomic_dispatch'] = dispatch
    state['modal_prediction_bundle'] = _model_bundle(request)
    def forbidden(*a, **kw): pytest.fail('no requested inference cannot invent a prediction')
    result = asyncio.run(consume_atomic_results(state, {}, validate=forbidden, merge=forbidden))
    assert result['slates'] == {} and len(result['definitions']) == 4
    assert all(r['status'] == 'unavailable' for r in result['definitions'].values())
    state['paired_nav_atomic_ml'] = result
    assert daily_setup_status(state)['ml_unavailable_definition_count'] == 4
