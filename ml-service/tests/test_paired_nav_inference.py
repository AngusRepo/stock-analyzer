from copy import deepcopy
import pytest

from app.paired_nav_inference import run_candidate_bundles, checksum
from app import serving_resolver as resolver
from tests.test_frozen_serving_identity import _manifest, _patchtst_shadow_candidate


def parent_request():
    manifest = _manifest()
    series = [{'symbol': '2330', 'prices': list(range(70))}]
    requests = []
    for version in ('old', 'new'):
        rows = []
        for name in resolver.DIRECT_ALPHA_MODELS:
            row = deepcopy(_patchtst_shadow_candidate())
            row.update(model=name, version=version, artifact_id=f'{name}:{version}',
                artifact_path=f'{name}/{version}.bin', metadata_path=f'{name}/{version}.json',
                checksum='sha256:' + checksum([name, version]))
            row['schema'].update(feature_semantic_version=resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
                gnn_graph_semantic_version=resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION if name == 'GNN' else None)
            row['schema']['sequence_contract'] = ({**row['schema']['sequence_contract'],
                'model': name, 'version': version, 'artifact_id': row['artifact_id']}
                if name in resolver.SEQUENCE_ALPHA_MODELS else None)
            rows.append(row)
        base = {r['model']: {k: r[k] for k in ('artifact_id', 'version', 'checksum', 'candidate_type')} for r in rows}
        contracts = {r['model']: {**r['schema']['sequence_contract'], 'artifact_path': r['artifact_path']}
            for r in rows if r['model'] in resolver.SEQUENCE_ALPHA_MODELS}
        requests.append({'bundle_key': checksum(base), 'candidates': rows,
            'sequence_series_by_model': {name: deepcopy(series) for name in contracts}, 'sequence_contracts': contracts})
    return {'serving_manifest': manifest, 'serving_manifest_digest': checksum(manifest),
        'sequence_series': series, 'sequence_input_contract': {'by_model': {}},
        'run_date': '2026-09-07', 'run_id': 'test', 'state_gcs_uri': 'gs://fixture/state',
        'active_versions': {}, 'payloads': [{'symbol': '2330', 'prices': [1, 2, 3]}],
        'callback_token': 'fixture-not-real', 'callback_url': 'https://fixture.invalid',
        'paired_nav_l3_requests': requests}


def returned(child):
    return {**{k: child[k] for k in ('run_date', 'run_id', 'state_gcs_uri',
        'serving_manifest_digest', 'active8_shadow_artifact_identities')}}


def test_both_versions_use_same_inputs_and_formal_owner_without_child_publication():
    parent = parent_request()
    before = deepcopy(parent)
    called = []
    def compute(child):
        assert 'paired_nav_l3_requests' not in child
        assert 'callback_token' not in child and 'callback_url' not in child
        assert child['payloads'] == before['payloads']
        assert child['serving_manifest']['models'] == before['serving_manifest']['models']
        assert child['serving_manifest']['active8_ensemble'] == before['serving_manifest']['active8_ensemble']
        version = child['serving_manifest']['active8_shadow_candidates'][0]['version']
        called.append(version)
        return {**returned(child), 'fixture_score': -1 if version == 'old' else 1}
    result = run_candidate_bundles(parent, compute=compute)
    assert called == ['old', 'new']
    assert [r['result']['fixture_score'] for r in result['bundles'].values()] == [-1, 1]
    assert parent == before
    assert result['production_effect'] is False


def test_single_candidate_compute_failure_does_not_copy_another_result():
    parent = parent_request()
    def compute(child):
        if child['serving_manifest']['active8_shadow_candidates'][0]['version'] == 'old':
            raise RuntimeError('private detail not propagated')
        return returned(child)
    result = run_candidate_bundles(parent, compute=compute)
    assert result['status'] == 'failed'
    assert list(result['bundles'].values())[0] == {'status': 'failed', 'error_type': 'RuntimeError'}
    assert list(result['bundles'].values())[1]['status'] == 'complete'


@pytest.mark.parametrize('fault', ['market_override', 'future_sequence', 'grant_serving', 'wrong_base', 'duplicate_bundle'])
def test_rejects_changed_inputs_or_authority_before_compute(fault):
    parent = parent_request()
    request = parent['paired_nav_l3_requests'][0]
    if fault == 'market_override': request['payloads'] = []
    elif fault == 'future_sequence': request['sequence_series_by_model']['DLinear'][0]['prices'].append(999)
    elif fault == 'grant_serving': request['candidates'][0]['production_effect'] = True
    elif fault == 'wrong_base': request['bundle_key'] = 'wrong'
    elif fault == 'duplicate_bundle': parent['paired_nav_l3_requests'].append(deepcopy(request))
    called = []
    with pytest.raises((ValueError, resolver.ServingPoolResolutionError)):
        run_candidate_bundles(parent, compute=lambda child: called.append(child) or returned(child))
    if fault != 'duplicate_bundle': assert not called


def test_real_parent_wrapper_publishes_once_for_all_versions(monkeypatch):
    import modal_app
    parent = parent_request()
    calls, publications, callbacks = [], [], []
    def compute(request):
        calls.append(deepcopy(request))
        return {**returned({**request, 'active8_shadow_artifact_identities':
            resolver.active8_shadow_candidate_identities(request['serving_manifest'])}), 'elapsed_s': 0.01}
    monkeypatch.setattr(modal_app, '_compute_pipeline_prediction_bundle', compute)
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle',
        lambda request, bundle: publications.append(deepcopy(bundle)) or {'status': 'fixture'})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback',
        lambda request, bundle, elapsed: callbacks.append(deepcopy(bundle)) or {'status': 'fixture'})
    result = modal_app._pipeline_prediction_bundle_impl(parent)
    assert len(calls) == 3 and len(publications) == len(callbacks) == 1
    assert result['paired_nav_l3_inference']['status'] == 'complete'
    assert result['serving_manifest_digest'] == parent['serving_manifest_digest']
    assert len(result['paired_nav_l3_inference']['bundles']) == 2


def test_bad_nav_request_does_not_erase_formal_result_or_claim_nav_complete(monkeypatch):
    import modal_app
    parent = parent_request()
    parent['paired_nav_l3_requests'][0]['bundle_key'] = 'corrupt'
    monkeypatch.setattr(modal_app, '_compute_pipeline_prediction_bundle',
        lambda request: {'formal_output': {'2330': 'fixture'}, 'elapsed_s': 0.01})
    publications = []
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle',
        lambda request, bundle: publications.append(bundle) or {})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback', lambda *args: {})
    result = modal_app._pipeline_prediction_bundle_impl(parent)
    assert result['formal_output'] == {'2330': 'fixture'}
    assert result['paired_nav_l3_inference']['status'] == 'failed'
    assert len(publications) == 1
