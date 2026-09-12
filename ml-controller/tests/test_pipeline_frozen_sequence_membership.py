"""Frozen dispatch -> original callback merge; no network, training or writes."""
import asyncio
from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from graphs import daily_pipeline_v2 as pipeline
from test_active8_cutover_contract import _artifact
from test_pipeline_modal_manifest_parity import _pool_and_rows


def seal(core):
    core = {k: v for k, v in core.items() if k != 'digest'}
    return {**core, 'digest': pipeline._pipeline_modal_canonical_digest(core)}


def membership_contract():
    return seal({'schema_version': 'pipeline-modal-sequence-input-contract-v2',
        'serving_manifest_digest': 'a' * 64,
        'sequence_point_counts': {'2330': 600, '2317': 511, '2454': None},
        'by_model': {'DLinear': {'symbols': ['2330'], 'sequence_contract': {'seq_len': 512}}},
        'shadow_by_model': {'PatchTST': {'symbols': [], 'sequence_contract': {'seq_len': 768}}}})


def read_membership(contract, bundle_contract=None):
    return pipeline._frozen_sequence_membership(
        payloads=[{'symbol': s} for s in ('2330', '2317', '2454')],
        contract=contract, bundle_contract=contract if bundle_contract is None else bundle_contract,
        manifest_digest='a' * 64, contracts={'DLinear': {'seq_len': 512}})


def test_frozen_membership_preserves_exact_counts_and_unknown_legacy():
    contract = membership_contract()
    before = deepcopy(contract)
    usable, excluded, counts = read_membership(contract)
    assert usable == {'DLinear': [{'symbol': '2330'}]}
    assert [r['points'] for r in excluded['DLinear']] == [511, None]
    assert counts == {'2330': 600, '2317': 511, '2454': None}
    assert contract == before
    contract.pop('sequence_point_counts')
    usable, excluded, counts = read_membership(seal(contract))
    assert usable == {'DLinear': [{'symbol': '2330'}]}
    assert counts == {'2330': None, '2317': None, '2454': None}
    assert all(r['points'] is None for r in excluded['DLinear'])


@pytest.mark.parametrize('fault', ['digest', 'echo', 'missing_count', 'negative_count', 'bool_count',
    'extra_count', 'eligibility', 'duplicate', 'foreign', 'artifact', 'model_set', 'shadow_eligibility'])
def test_invalid_frozen_membership_rejected(fault):
    contract = membership_contract()
    if fault == 'missing_count': contract['sequence_point_counts'].pop('2454')
    if fault == 'negative_count': contract['sequence_point_counts']['2454'] = -1
    if fault == 'bool_count': contract['sequence_point_counts']['2454'] = False
    if fault == 'extra_count': contract['sequence_point_counts']['9999'] = 999
    if fault == 'eligibility': contract['by_model']['DLinear']['symbols'].append('2317')
    if fault == 'duplicate': contract['by_model']['DLinear']['symbols'].append('2330')
    if fault == 'foreign': contract['by_model']['DLinear']['symbols'].append('9999')
    if fault == 'artifact': contract['by_model']['DLinear']['sequence_contract']['seq_len'] = 600
    if fault == 'model_set': contract['by_model'].pop('DLinear')
    if fault == 'shadow_eligibility': contract['shadow_by_model']['PatchTST']['symbols'].append('2330')
    contract = seal(contract)
    if fault == 'digest': contract['digest'] = '0' * 64
    with pytest.raises(RuntimeError, match='pipeline_modal_sequence_membership:'):
        read_membership(contract, {} if fault == 'echo' else None)


def test_dispatch_counts_do_not_conflate_empty_and_absent_history():
    payloads = [{'symbol': s} for s in ('2330', '2317', '2454')]
    assert pipeline._dispatch_sequence_point_counts(payloads, [
        {'symbol': '2330', 'prices': [1, 2]}, {'symbol': '2317', 'prices': []}]) == {
            '2330': 2, '2317': 0, '2454': None}
    for series in ([{'symbol': '9999'}], [{'symbol': '2330'}, {'symbol': '2330'}]):
        with pytest.raises(RuntimeError, match='invalid_history_symbols'):
            pipeline._dispatch_sequence_point_counts(payloads, series)


@pytest.fixture
def dispatched(monkeypatch):
    artifact = _artifact()  # synthetic test artifact; no trained model download
    pool, rows = _pool_and_rows(artifact)
    manifest, digest = pipeline._build_pipeline_modal_serving_manifest(
        pool, registry_rows=rows, active8_ensemble=artifact)
    symbols = ['2330', '2317', '2454', '2303', '2881']
    payloads = [{'symbol': s, 'stock_meta': {'market_segment': 'LISTED'}} for s in symbols]
    series = [{'symbol': s, 'prices': [100.] * n}
              for s, n in zip(symbols, (600, 512, 511, 0))]
    state = {'run_date': '2026-09-09', 'producer_run_id': 'frozen-sequence-test',
        'decision_universe_frozen_at': '2026-09-09T10:00:00Z',
        'payloads': payloads, 'l3_payloads': deepcopy(payloads),
        'pipeline_modal_serving_context': {'schema_version': 'pipeline-modal-serving-context-v1',
            'serving_pool': pipeline._pipeline_modal_runtime_pool_from_manifest(pool, manifest),
            'serving_manifest': manifest, 'serving_manifest_digest': digest,
            'model_status': {r['model']: r['effective_status'] for r in manifest['models']},
            'active_versions': {r['model']: r['version'] for r in manifest['models']},
            'pool_versions_loaded': True, 'expected_source_sha': 'a' * 40}}
    monkeypatch.setattr(pipeline, 'build_state_space_series_from_payloads', lambda _: deepcopy(series))
    monkeypatch.setattr(pipeline, 'enrich_state_space_series_with_long_history',
                        lambda *a, **k: (deepcopy(series), {'source': 'frozen-test-artifact'}))
    monkeypatch.setattr(pipeline.LEARNING_D1_CLIENT, 'query', lambda *a, **k: [])
    monkeypatch.setattr(pipeline, '_pipeline_modal_prediction_callback_url', lambda: 'https://never.invalid')
    monkeypatch.setattr(pipeline, '_pipeline_modal_prediction_callback_token', lambda: 'test')
    request = asyncio.run(pipeline._build_pipeline_modal_prediction_payload(
        state, state_gcs_uri='gs://isolated-test/state.json'))
    bundle = {k: deepcopy(request[k]) for k in ('run_date', 'run_id', 'state_gcs_uri',
        'serving_manifest_digest', 'slot_artifact_identities', 'active_artifact_identities',
        'active8_shadow_artifact_identities', 'serving_coverage', 'sequence_input_contract', 'sequence_dataset_meta')}
    bundle.update(schema_version='pipeline-modal-prediction-bundle-v1', n_input=len(symbols),
        modal_source_sha='a' * 40,
        active_artifact_versions={n: i['version'] for n, i in request['active_artifact_identities'].items()},
        active8_sequence_shadow_raw={'schema_version': 'active8-sequence-shadow-bundle-v1',
                                    'production_effect': False, 'vote_weight': 0., 'candidates': {}},
        predict_batch_v2_results=[{'symbol': s, 'rank_scores': {n: (i + 1) / 6.
            for n in ('LightGBM', 'XGBoost', 'ExtraTrees', 'TabM')}} for i, s in enumerate(symbols)],
        gnn_graphsage_raw={'results': [{'symbol': s, 'rank_score': (i + 1) / 6.}
                                     for i, s in enumerate(symbols)]})
    for name, field in [('DLinear', 'dlinear_raw'), ('PatchTST', 'patchtst_raw'), ('iTransformer', 'itransformer_raw')]:
        bundle[field] = {'results': [{'symbol': r['symbol'], 'forecast_pct': (i + 1) * .01}
            for i, r in enumerate(request['sequence_model_series_by_model'][name])]}
    async def no_cost_write(*a, **k):
        return None
    from services import cost_tracker
    monkeypatch.setattr(cost_tracker, 'record_compute_profile_event', no_cost_write)
    return state, request, bundle


@pytest.mark.parametrize('legacy', [False, True])
def test_original_dispatch_to_callback_never_reads_updated_history(monkeypatch, dispatched, legacy):
    state, request, bundle = dispatched
    assert request['sequence_input_contract']['sequence_point_counts'] == {
        '2330': 600, '2317': 512, '2454': 511, '2303': 0, '2881': None}
    assert request['sequence_input_contract']['by_model']['DLinear']['symbols'] == ['2330', '2317']
    changed_history = deepcopy(request['sequence_series'])
    changed_history[0]['prices'] = []
    changed_history[2]['prices'].append(101.)
    old_recheck, _ = pipeline._sequence_model_subsets(changed_history,
        contracts=request['sequence_model_contracts'])
    # Reproduces the previous callback algorithm: two eligibility flips even
    # though the dispatch and the returned forecasts have not changed.
    assert {r['symbol'] for r in old_recheck['DLinear']} == {'2317', '2454'}
    if legacy:
        core = deepcopy(request['sequence_input_contract'])
        core.pop('sequence_point_counts')
        state['pipeline_modal_sequence_input_contract'] = seal(core)
        bundle['sequence_input_contract'] = seal(core)
    def forbidden(*a, **k):
        raise AssertionError('callback re-read changed history/model owner')
    # Dispatch had 511 points for 2454. A later source could now have 512;
    # neither that refresh nor deletion of an eligible history may be consulted.
    for name in ('build_state_space_series_from_payloads', 'enrich_state_space_series_with_long_history',
                 '_load_model_pool_versions', '_load_active8_serving_pool'):
        monkeypatch.setattr(pipeline, name, forbidden)
    pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)
    state['modal_prediction_bundle'] = bundle
    before = deepcopy(bundle)
    result = asyncio.run(pipeline.node_l3_formal_predict(state))
    assert bundle == before, 'callback must not rewrite the frozen raw inference evidence'
    retry = asyncio.run(pipeline.node_l3_formal_predict(state))
    assert retry['predictions'] == result['predictions']
    predictions = result['predictions']
    for symbol, expected in [('2330', True), ('2317', True), ('2454', False), ('2303', False), ('2881', False)]:
        item = predictions[symbol]['l3_model_eligibility']['sequence_models']['DLinear']
        assert item['eligible'] is expected
        assert item['available_sequence_points'] == (None if legacy else request['sequence_input_contract']['sequence_point_counts'][symbol])
    assert all(isinstance(row.get('ensemble_v2'), dict) for row in predictions.values())
    assert result['modal_wait_telemetry']['sequence_dataset']['membership_source'] == 'frozen_dispatch_sequence_input_contract'


def test_real_callback_rejects_inconsistent_counts_before_downstream_writes(monkeypatch, dispatched):
    state, request, bundle = dispatched
    core = deepcopy(state['pipeline_modal_sequence_input_contract'])
    core['sequence_point_counts']['2454'] = 512  # conflicts with sealed model membership
    state['pipeline_modal_sequence_input_contract'] = seal(core)
    bundle['sequence_input_contract'] = seal(core)
    monkeypatch.setattr(pipeline, '_read_pipeline_async_state_artifact', lambda _: deepcopy(state))
    downstream = []
    async def forbidden(*a, **k):
        downstream.append(True)
        raise AssertionError('invalid membership reached downstream consumer')
    for name in ('node_compute_personas', 'node_recommend', 'node_write_d1', 'node_paired_nav_setup'):
        monkeypatch.setattr(pipeline, name, forbidden)
    result = asyncio.run(pipeline.run_pipeline_v2_from_modal_prediction_callback({
        **{k: bundle[k] for k in ('run_date', 'run_id', 'state_gcs_uri')}, 'result': bundle}))
    assert result['status'] == 'error'
    assert 'points_membership_mismatch' in result['error']
    assert not downstream


def test_original_controller_dispatch_modal_engine_and_merge_share_frozen_membership(monkeypatch, dispatched):
    import modal_app
    from app import batch_prediction, dlinear_universal, patchtst_universal, itransformer_universal, serving_resolver
    state, request, _ = dispatched
    original_request = deepcopy(request)
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'a' * 40)
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    def forbidden(*a, **k):
        raise AssertionError('unexpected live source/model lookup')
    monkeypatch.setattr(serving_resolver, 'load_d1_champion_pool', forbidden)
    calls, published, callbacks = [], [], []
    # Model primitives and external I/O only are replaced. Both production
    # orchestration functions, manifest validation and ensemble merge are real.
    def features(payloads, *, pool_snapshot, **kwargs):
        assert pool_snapshot['serving_manifest_digest'] == request['serving_manifest_digest']
        return {'results': [{'symbol': p['symbol'], 'rank_scores': {
            name: (i + 1) / 6. for name in ('LightGBM', 'XGBoost', 'ExtraTrees', 'TabM')}}
            for i, p in enumerate(payloads)]}
    def graph(payloads, **kwargs):
        return {'results': [{'symbol': p['symbol'], 'rank_score': (i + 1) / 6.}
                            for i, p in enumerate(payloads)]}
    def sequence(*, series_list, **kwargs):
        calls.append([r['symbol'] for r in series_list])
        return [{'symbol': r['symbol'], 'forecast_pct': (i + 1) * .01} for i, r in enumerate(series_list)]
    monkeypatch.setattr(batch_prediction, 'predict_stock_v2_chunked_with_metrics', features)
    monkeypatch.setattr(batch_prediction, 'predict_gnn_graphsage_batch', graph)
    for module, name in ((dlinear_universal, 'dlinear_batch_predict'),
                         (patchtst_universal, 'patchtst_batch_predict'),
                         (itransformer_universal, 'itransformer_batch_predict')):
        monkeypatch.setattr(module, name, sequence)
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle',
                        lambda req, result: published.append(deepcopy(result)) or {})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback',
                        lambda req, result, elapsed: callbacks.append(deepcopy(result)) or {})
    bundle = modal_app._pipeline_prediction_bundle_impl(request)
    assert len(published) == len(callbacks) == 1
    assert calls == [['2330', '2317']] * 3
    assert request == original_request
    pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)
    monkeypatch.setattr(pipeline, 'enrich_state_space_series_with_long_history', forbidden)
    monkeypatch.setattr(pipeline, 'build_state_space_series_from_payloads', forbidden)
    state['modal_prediction_bundle'] = bundle
    before = deepcopy(bundle)
    merged = asyncio.run(pipeline.node_l3_formal_predict(state))
    assert bundle == before
    assert len(merged['predictions']) == 5
    assert merged['predictions']['2454']['l3_model_eligibility']['sequence_models']['DLinear'] == {
        'eligible': False, 'required_sequence_points': 512, 'available_sequence_points': 511,
        'reason': 'active8_sequence_history_contract_unmet_optional_masked'}
    assert all(isinstance(p.get('ensemble_v2'), dict) for p in merged['predictions'].values())
