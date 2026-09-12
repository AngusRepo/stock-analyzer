"""Actual NAV publisher -> original frozen manifest -> inference, NOT real ROI."""
from copy import deepcopy
import asyncio
import json
from pathlib import Path
import sys

import pytest

from graphs import daily_pipeline_v2 as graph
from services import model_serving_resolver as resolver
from services import ensemble_v2 as ensemble
from services.active8_score_semantics import (MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
    MODEL_SCORE_SEMANTIC_VERSION, MODEL_TARGET_SEMANTIC_VERSION)
from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment


@pytest.fixture
def frozen(ready, monkeypatch):
    client, candidate, *_ = ready
    publish(ready)
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', client)
    pool = resolver.load_d1_champion_pool(sidecar_models=())
    artifact = graph._load_active8_ensemble_snapshot(pool)
    rows = graph._pipeline_modal_registry_identity_rows(pool)
    manifest, checksum = graph._build_pipeline_modal_serving_manifest(pool,
        registry_rows=rows, active8_ensemble=artifact)
    return ready, pool, artifact, manifest, checksum


def test_original_frozen_nav_path_reaches_controller_and_modal_same_arithmetic(frozen):
    from services.active8_nav_inference import restore_frozen_nav_inference
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ml-service'))
    from app.serving_resolver import build_pool_from_frozen_manifest
    from app.active8_ensemble_runtime import score_active8_ensemble
    ready, pool, artifact, manifest, checksum = frozen
    modal_pool = build_pool_from_frozen_manifest(manifest, expected_digest=checksum)
    context = manifest['active8_nav_inference']
    grant = restore_frozen_nav_inference(context, artifact=artifact, pool_models=pool['models'])
    scores = {name: .7 for name in ensemble.ACTIVE_ALPHA_MODELS}
    prediction = {'rank_scores': scores, 'model_score_lineage': {
        'schema_version': MODEL_SCORE_LINEAGE_SCHEMA_VERSION, 'semantic_version': MODEL_SCORE_SEMANTIC_VERSION,
        'target_semantic_version': MODEL_TARGET_SEMANTIC_VERSION, 'complete': True, 'blockers': []}}
    ensemble.attach_ensemble_v2(prediction, artifact, pool['models'], nav_authority=grant)
    result = score_active8_ensemble(rank_scores=scores, artifact=artifact,
        pool_models=modal_pool['models'], current_price=100., nav_authority=grant)
    assert prediction['ensemble_v2']['signal'] == result.signal
    assert prediction['ensemble_v2']['ml_expected_net_return'] == pytest.approx(.032)
    assert result.forecast_pct == prediction['ensemble_v2']['ml_expected_net_return']
    assert prediction['ensemble_v2']['expected_return'] is None  # L4 owns allocator EV.
    assert artifact['validation']['decision'] == 'FAIL'
    assert ready[0].batches == 1


@pytest.mark.parametrize('fault', ['missing', 'checksum', 'review', 'candidate', 'model', 'scope', 'json_pass'])
def test_frozen_inference_does_not_accept_missing_or_mismatched_authority(frozen, fault):
    from services.active8_nav_inference import restore_frozen_nav_inference
    from services.paired_nav_journal import digest
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ml-service'))
    from app.serving_resolver import build_pool_from_frozen_manifest
    _, _, artifact, original, _ = frozen
    manifest = deepcopy(original)
    if fault == 'missing':
        manifest.pop('active8_nav_inference')
    elif fault == 'model':
        manifest['models'][0]['checksum'] = 'sha256:' + '0' * 64
    else:
        context = manifest['active8_nav_inference']
        if fault == 'checksum': context['context_checksum'] = '0' * 64
        elif fault == 'review':
            context['review_records'][0]['body']['family']['hypotheses'][0]['numerical_support'] = False
        elif fault == 'candidate': context['artifact_checksum'] = '0' * 64
        elif fault == 'scope': context['scope'] = 'live_publication'
        else: manifest['active8_nav_inference'] = {'decision': 'PASS'}
        if fault in {'review','candidate','scope'}:
            context['context_checksum'] = digest({k: v for k, v in context.items() if k != 'context_checksum'})
    with pytest.raises((ValueError, RuntimeError)):
        build_pool_from_frozen_manifest(manifest, expected_digest=graph._pipeline_modal_canonical_digest(manifest))


def test_frozen_compute_grant_cannot_become_live_publication_or_model_pool_authority(frozen):
    from services.active8_nav_inference import restore_frozen_nav_inference, capture_frozen_nav_inference
    _, pool, artifact, manifest, _ = frozen
    grant = restore_frozen_nav_inference(manifest['active8_nav_inference'], artifact=artifact, pool_models=pool['models'])
    with pytest.raises(ValueError, match='original_grant_required'):
        capture_frozen_nav_inference(grant, artifact=artifact, pool_models=pool['models'])
    with pytest.raises(ValueError, match='grant_not_original'):
        resolver.build_pool_from_champion_pointers(pointers=[], artifacts=[], nav_grant=grant)
    with pytest.raises(RuntimeError, match='authority_invalid'):
        ensemble.validate_active8_ensemble_artifact(artifact, pool['models'], nav_authority={'decision':'PASS'})


@pytest.mark.parametrize('prepared', [{}, {'selected_models': ['TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']}], indirect=True)
def test_original_dispatch_modal_compute_and_controller_merge_use_same_nav_receipt(frozen, monkeypatch):
    ready, pool, artifact, manifest, checksum = frozen
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ml-service'))
    import modal_app
    from app import batch_prediction, dlinear_universal, patchtst_universal, itransformer_universal, serving_resolver
    from services import cost_tracker
    symbols = ['2330','2317','2454','2303','2881']
    payloads = [{'symbol': s, 'stock_meta': {'market_segment': 'LISTED'}} for s in symbols]
    series = [{'symbol': s, 'prices': [100.] * n} for s, n in zip(symbols, (100,64,63,0))]
    state = {'run_date': '2026-09-22', 'producer_run_id': 'original-nav-inference',
        'decision_universe_frozen_at': '2026-09-22T10:00:00Z',
        'payloads': payloads, 'l3_payloads': deepcopy(payloads),
        'pipeline_modal_serving_context': {'schema_version': 'pipeline-modal-serving-context-v1',
            'serving_pool': graph._pipeline_modal_runtime_pool_from_manifest(pool, manifest),
            'serving_manifest': manifest, 'serving_manifest_digest': checksum,
            'model_status': {r['model']: r['effective_status'] for r in manifest['models']},
            'active_versions': {r['model']: r['version'] for r in manifest['models']},
            'pool_versions_loaded': True, 'expected_source_sha': 'a' * 40}}
    monkeypatch.setattr(graph, 'build_state_space_series_from_payloads', lambda _: deepcopy(series))
    monkeypatch.setattr(graph, 'enrich_state_space_series_with_long_history',
        lambda *a, **k: (deepcopy(series), {'source': 'isolated-market-fixture'}))
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_url', lambda: 'https://never.invalid')
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_token', lambda: 'test-only')
    async def no_cost_write(*a, **k):
        return None
    monkeypatch.setattr(cost_tracker, 'record_compute_profile_event', no_cost_write)
    request = asyncio.run(graph._build_pipeline_modal_prediction_payload(state, state_gcs_uri='gs://isolated/state.json'))
    assert state['paired_nav_l3_dispatch']['status'] != 'failed', state['paired_nav_l3_dispatch']
    # Use the original request serializer and original generation/hash-fenced
    # hydration, replacing only the storage transport. Raw NAV requests may not
    # enter the external Modal function as caller-supplied authority packets.
    from services.pipeline_modal_request_transport import prepare_pipeline_modal_request
    from google.cloud import storage
    compressed, reference = prepare_pipeline_modal_request(request)
    reference.update(request_generation='7', request_gcs_uri=(
        f"gs://isolated/pipeline-v2/{request['run_date']}/{request['run_id']}/modal_request/{reference['request_sha256']}.json.gz"))
    class Blob:
        def download_as_bytes(self, *, if_generation_match):
            assert if_generation_match == 7
            return compressed
    class Client:
        def bucket(self, name):
            assert name == 'isolated'
            return self
        def blob(self, name):
            assert reference['request_sha256'] in name
            return Blob()
    monkeypatch.setattr(storage, 'Client', Client)
    monkeypatch.setattr(modal_app, 'get_gcs_bucket_name', lambda: 'isolated')
    with pytest.raises(ValueError, match='requires_generation_bound_request'):
        modal_app._hydrate_pipeline_prediction_request_reference(request)
    request = modal_app._hydrate_pipeline_prediction_request_reference(reference)
    assert request['serving_manifest']['active8_nav_inference'] == manifest['active8_nav_inference']
    original_request = deepcopy(request)
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'a' * 40)
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    def forbidden(*a, **k):
        raise AssertionError('frozen inference must not read current owner/history or publish')
    monkeypatch.setattr(serving_resolver, 'load_d1_champion_pool', forbidden)
    def features(payloads, *, pool_snapshot, **kwargs):
        assert pool_snapshot['serving_manifest_digest'] == checksum
        return {'results': [{'symbol': p['symbol'], 'rank_scores': {
            name: (i+1)/6. for name in ('LightGBM','XGBoost','ExtraTrees','TabM')}} for i,p in enumerate(payloads)]}
    def gnn(payloads, **kwargs):
        return {'results': [{'symbol': p['symbol'], 'rank_score': (i+1)/6.} for i,p in enumerate(payloads)]}
    def sequence(*, series_list, **kwargs):
        return [{'symbol': p['symbol'], 'forecast_pct': (i+1)*.01} for i,p in enumerate(series_list)]
    monkeypatch.setattr(batch_prediction, 'predict_stock_v2_chunked_with_metrics', features)
    monkeypatch.setattr(batch_prediction, 'predict_gnn_graphsage_batch', gnn)
    for module,name in ((dlinear_universal,'dlinear_batch_predict'),(patchtst_universal,'patchtst_batch_predict'),
                        (itransformer_universal,'itransformer_batch_predict')):
        monkeypatch.setattr(module, name, sequence)
    publications, callbacks = [], []
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle',
        lambda req,result: publications.append(deepcopy(result)) or {})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback',
        lambda req,result,elapsed: callbacks.append(deepcopy(result)) or {})
    bundle = modal_app._pipeline_prediction_bundle_impl(request)
    assert len(publications) == len(callbacks) == 1
    assert request == original_request
    graph._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)
    state['modal_prediction_bundle'] = bundle
    before = deepcopy(bundle)
    for name in ('build_state_space_series_from_payloads','enrich_state_space_series_with_long_history',
                 '_load_model_pool_versions','_load_active8_serving_pool'):
        monkeypatch.setattr(graph, name, forbidden)
    merged = asyncio.run(graph.node_l3_formal_predict(state))
    retried = asyncio.run(graph.node_l3_formal_predict(state))
    assert merged['nav_inference_receipt'] == next(iter(merged['predictions'].values()))['nav_inference_execution']['receipt']
    assert retried['nav_inference_receipt'] == merged['nav_inference_receipt']
    assert retried['predictions'] == merged['predictions'] and bundle == before
    assert len(merged['predictions']) == len(symbols)
    for prediction in merged['predictions'].values():
        result = prediction['ensemble_v2']
        assert result['artifact_checksum'] == artifact['payload_checksum']
        assert result['adoption_basis'] == 'committed_paired_nav'
        assert result['nav_inference_context_checksum'] == manifest['active8_nav_inference']['context_checksum']
        assert result['validation']['decision'] == 'FAIL'
    assert ready[0].batches == 1
