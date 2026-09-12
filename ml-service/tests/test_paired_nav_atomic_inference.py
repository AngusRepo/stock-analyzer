from copy import deepcopy
import pytest

from app.paired_nav_atomic_inference import run_atomic_slates
from app.paired_nav_inference import checksum
from app import serving_resolver as resolver
from tests.test_frozen_serving_identity import _manifest


def request():
    manifest = _manifest()
    all_payloads = [{'symbol': str(1001 + i), 'signal': value} for i, value in enumerate((1, 2, 8))]
    series = [{'symbol': p['symbol'], 'prices': [p['signal']] * 3} for p in all_payloads]
    contracts = {name: {'seq_len': 3} for name in resolver.SEQUENCE_ALPHA_MODELS}
    sequence_contract = {'schema_version': 'pipeline-modal-sequence-input-contract-v2',
        'serving_manifest_digest': checksum(manifest),
        'by_model': {name: {'symbols': ['1001', '1002'], 'sequence_contract': contract} for name, contract in contracts.items()},
        'shadow_by_model': {}}
    slates, contrasts = {}, []
    def add(symbols):
        inputs = {'symbols': symbols, 'payloads': [deepcopy(p) for p in all_payloads if p['symbol'] in symbols],
                  'sequence_series': [deepcopy(p) for p in series if p['symbol'] in symbols]}
        key = checksum(inputs)
        slates[key] = inputs
        return key
    baseline_key = add(['1001', '1002'])
    for index, symbols in enumerate((['1002', '1003'], ['1002', '1003'], [], ['1001', '1002'])):
        contrasts.append({'definition_checksum': checksum(index), 'baseline_key': baseline_key, 'candidate_key': add(symbols)})
    packet = {'schema_version': 'paired-nav-atomic-slates-v2', 'signal_date': '2026-09-09', 'source_checksum': checksum('source'),
        'slates': slates, 'contrasts': contrasts}
    return {'schema_version': 'pipeline-modal-prediction-request-v1',
        'run_date': '2026-09-09', 'run_id': 'atomic-test', 'state_gcs_uri': 'gs://isolated-test/state',
        'payloads': deepcopy(all_payloads[:2]), 'sequence_series': deepcopy(series[:2]),
        'sequence_model_contracts': contracts,
        'sequence_model_series_by_model': {name: deepcopy(series[:2]) for name in contracts},
        'active8_shadow_sequence_contracts': {}, 'active8_shadow_sequence_series_by_model': {},
        'sequence_input_contract': {**sequence_contract, 'digest': checksum(sequence_contract)},
        'serving_manifest': manifest, 'serving_manifest_digest': checksum(manifest),
        'slot_artifact_identities': resolver.serving_manifest_identities(manifest),
        'active_artifact_identities': resolver.serving_manifest_identities(manifest, serving_only=True),
        'active8_shadow_artifact_identities': resolver.active8_shadow_candidate_identities(manifest),
        'serving_coverage': resolver.serving_manifest_coverage(manifest),
        'model_status': {r['model']: r['effective_status'] for r in manifest['models']},
        'active_versions': {r['model']: r['version'] for r in manifest['models'] if r['effective_status'] in ('active', 'degraded')},
        'expected_source_sha': 'a' * 40, 'callback_url': 'https://never-called.invalid', 'callback_token': 'fixture',
        'paired_nav_atomic_slates': {**packet, 'packet_checksum': checksum(packet)}}


def reseal(parent):
    packet = parent['paired_nav_atomic_slates']
    packet['packet_checksum'] = checksum({k: v for k, v in packet.items() if k != 'packet_checksum'})


def rekey(parent):
    packet = parent['paired_nav_atomic_slates']
    keys = {key: checksum(value) for key, value in packet['slates'].items()}
    packet['slates'] = {keys[key]: value for key, value in packet['slates'].items()}
    for contrast in packet['contrasts']:
        for field in ('baseline_key', 'candidate_key'):
            contrast[field] = keys.get(contrast[field], contrast[field])
    reseal(parent)


def slate_key(parent, symbols):
    return next(key for key, value in parent['paired_nav_atomic_slates']['slates'].items() if value['symbols'] == symbols)


def test_child_point_counts_are_recomputed_from_own_frozen_slate():
    parent = request()
    core = {k: v for k, v in parent['sequence_input_contract'].items() if k != 'digest'}
    core['sequence_point_counts'] = {'1001': 3, '1002': 3}
    parent['sequence_input_contract'] = {**core, 'digest': checksum(core)}
    candidate = parent['paired_nav_atomic_slates']['slates'][slate_key(parent, ['1002', '1003'])]
    candidate['sequence_series'][1]['prices'] = [1] * 5
    rekey(parent)
    calls = []
    def compute(child):
        calls.append(deepcopy(child))
        return stub_bundle(child)
    result = run_atomic_slates(parent, compute=compute, formal_bundle=stub_bundle(parent))
    assert result['status'] == 'complete'
    assert len(calls) == 1
    assert calls[0]['sequence_input_contract']['sequence_point_counts'] == {'1002': 3, '1003': 5}
    assert parent['sequence_input_contract']['sequence_point_counts'] == {'1001': 3, '1002': 3}


def stub_bundle(child):
    return {**{k: deepcopy(child[k]) for k in ('run_date', 'run_id', 'state_gcs_uri', 'serving_manifest_digest',
        'slot_artifact_identities', 'active_artifact_identities', 'active8_shadow_artifact_identities',
        'sequence_input_contract', 'serving_coverage')},
        'n_input': len(child['payloads']),
        'schema_version': 'pipeline-modal-prediction-bundle-v1', 'modal_source_sha': child['expected_source_sha'],
        'predict_batch_v2_results': [{'symbol': p['symbol']} for p in child['payloads']]}


def test_distinct_slate_compute_and_shared_slate_reuse_preserve_frozen_formal_inputs():
    parent = request()
    before, calls = deepcopy(parent), []
    def compute(child):
        calls.append(deepcopy(child))
        assert 'callback_token' not in child and 'callback_url' not in child
        assert 'paired_nav_atomic_slates' not in child and 'paired_nav_l3_requests' not in child
        assert child['serving_manifest'] == parent['serving_manifest']
        return stub_bundle(child)
    result = run_atomic_slates(parent, compute=compute, formal_bundle=stub_bundle(parent))
    assert result['status'] == 'complete' and len(result['contrasts']) == 4
    assert len(calls) == 1 and [r['symbol'] for r in calls[0]['payloads']] == ['1002', '1003']
    assert len(result['slates']) == 3
    assert result['slates'][slate_key(parent, [])] == {'status': 'empty_universe', 'symbols': []}
    for name, series in calls[0]['sequence_model_series_by_model'].items():
        assert [r['symbol'] for r in series] == ['1002', '1003']
        assert calls[0]['sequence_input_contract']['by_model'][name]['symbols'] == ['1002', '1003']
    assert parent == before
    assert result['production_effect'] is False and result['nav_maturity_credit'] == 0


@pytest.mark.parametrize('fault', ['checksum', 'date', 'payload', 'history', 'missing-stock', 'extra-stock',
    'duplicate-stock', 'duplicate-definition', 'pre-overlay-baseline', 'authority', 'bad-contract'])
def test_invalid_source_is_rejected_before_any_candidate_compute(fault):
    parent = request()
    packet = parent['paired_nav_atomic_slates']
    baseline = packet['slates'][slate_key(parent, ['1001', '1002'])]
    candidate = packet['slates'][slate_key(parent, ['1002', '1003'])]
    if fault == 'date': packet['signal_date'] = '2026-09-10'
    if fault == 'payload': baseline['payloads'][0]['signal'] = 99
    if fault == 'history': baseline['sequence_series'][0]['prices'][0] = 99
    if fault == 'missing-stock':
        candidate['payloads'].pop()
        candidate['sequence_series'].pop()
    if fault == 'extra-stock': packet['slates']['orphan'] = {'symbols': ['9999'], 'payloads': [{'symbol': '9999', 'signal': 10}], 'sequence_series': []}
    if fault == 'duplicate-stock': candidate['payloads'].append(deepcopy(candidate['payloads'][0]))
    if fault == 'duplicate-definition': packet['contrasts'][1]['definition_checksum'] = packet['contrasts'][0]['definition_checksum']
    if fault == 'pre-overlay-baseline': packet['contrasts'][0]['baseline_key'] = packet['contrasts'][0]['candidate_key']
    if fault == 'authority': packet['serving_manifest'] = {'promotion_allowed': True}
    if fault == 'bad-contract': parent['sequence_model_contracts']['DLinear']['seq_len'] = 0
    rekey(parent)
    if fault == 'checksum': packet['packet_checksum'] = '0' * 64
    calls = []
    with pytest.raises(ValueError):
        run_atomic_slates(parent, compute=lambda child: calls.append(child), formal_bundle=stub_bundle(parent))
    assert not calls


@pytest.mark.parametrize('fault', ['exception', 'missing-result', 'wrong-model', 'wrong-sequence', 'wrong-count'])
def test_candidate_failure_cannot_borrow_formal_forecast(fault):
    parent = request()
    def compute(child):
        if fault == 'exception': raise RuntimeError('private detail')
        bundle = stub_bundle(child)
        if fault == 'missing-result': bundle['predict_batch_v2_results'].pop()
        if fault == 'wrong-model': bundle['slot_artifact_identities'] = {}
        if fault == 'wrong-sequence': bundle['sequence_input_contract'] = {}
        if fault == 'wrong-count': bundle['n_input'] = 0
        return bundle
    result = run_atomic_slates(parent, compute=compute, formal_bundle=stub_bundle(parent))
    candidate = result['slates'][slate_key(parent, ['1002', '1003'])]
    assert result['status'] == candidate['status'] == 'failed'
    assert 'result' not in candidate and 'private detail' not in str(result)
    assert result['slates'][slate_key(parent, ['1001', '1002'])]['status'] == 'complete'


def test_source_not_present_preserves_existing_parent_and_invalid_request_is_explicit(monkeypatch):
    import modal_app
    parent = request()
    parent.pop('paired_nav_atomic_slates')
    assert run_atomic_slates(parent, compute=lambda _: pytest.fail('unrequested compute'), formal_bundle={}) is None
    parent = request()
    parent['paired_nav_atomic_slates']['packet_checksum'] = 'corrupt'
    monkeypatch.setattr(modal_app, '_compute_pipeline_prediction_bundle', lambda _: {**stub_bundle(parent), 'elapsed_s': 0})
    published, callbacks = [], []
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle', lambda req, bundle: published.append(deepcopy(bundle)) or {})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback', lambda req, bundle, elapsed: callbacks.append(bundle) or {})
    result = modal_app._pipeline_prediction_bundle_impl(parent)
    assert result['predict_batch_v2_results'] == stub_bundle(parent)['predict_batch_v2_results']
    assert result['paired_nav_atomic_inference']['status'] == 'failed'
    assert result['paired_nav_atomic_inference']['error_code'] == 'atomic_inference_packet_invalid'
    assert len(published) == len(callbacks) == 1


@pytest.mark.parametrize('same_symbols_new_features', [False, True])
def test_original_engine_recomputes_graph_and_cross_section_without_changing_formal_publication(monkeypatch, same_symbols_new_features):
    import modal_app
    from app import batch_prediction, dlinear_universal, patchtst_universal, itransformer_universal
    parent = request()
    changed_key = None
    if same_symbols_new_features:
        packet = parent['paired_nav_atomic_slates']
        baseline_key = slate_key(parent, ['1001', '1002'])
        changed = deepcopy(packet['slates'][baseline_key])
        changed['payloads'][0]['stock_meta'] = {'sector_peer_return_1d': .2, 'eligible_for_pending_buy': False}
        changed_key = checksum(changed)
        packet['slates'][changed_key] = changed
        packet['contrasts'].append({'definition_checksum': checksum('new-features'), 'baseline_key': baseline_key, 'candidate_key': changed_key})
        reseal(parent)
    before = deepcopy(parent)
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'a' * 40)
    monkeypatch.setattr(modal_app, '_setup_env', lambda: None)
    monkeypatch.setattr(resolver, 'load_d1_champion_pool', lambda **_: pytest.fail('second serving owner read'))
    calls, publications, callbacks, observed_meta = [], [], [], []
    # Synthetic model primitives, NOT trained market artifacts. The original
    # orchestration, frozen-model resolution and coverage checks execute intact.
    def feature(payloads, *, pool_snapshot, **kwargs):
        symbols = [p['symbol'] for p in payloads]
        calls.append(('feature', symbols))
        observed_meta.append(deepcopy(payloads[0].get('stock_meta')))
        assert pool_snapshot['serving_manifest_digest'] == parent['serving_manifest_digest']
        values = sorted(p['signal'] for p in payloads)
        return {'results': [{'symbol': p['symbol'], 'rank_scores': {name: values.index(p['signal']) / max(1, len(values) - 1)
            for name in ('LightGBM', 'XGBoost', 'ExtraTrees', 'TabM')}} for p in payloads]}
    def graph(payloads, **kwargs):
        calls.append(('graph', [p['symbol'] for p in payloads]))
        return {'results': [{'symbol': p['symbol'], 'score': sum(r['signal'] for r in payloads)} for p in payloads]}
    def sequence(*, series_list, **kwargs):
        return [{'symbol': p['symbol'], 'score': p['prices'][-1]} for p in series_list]
    monkeypatch.setattr(batch_prediction, 'predict_stock_v2_chunked_with_metrics', feature)
    monkeypatch.setattr(batch_prediction, 'predict_gnn_graphsage_batch', graph)
    for module, name in ((dlinear_universal, 'dlinear_batch_predict'), (patchtst_universal, 'patchtst_batch_predict'),
                         (itransformer_universal, 'itransformer_batch_predict')):
        monkeypatch.setattr(module, name, sequence)
    monkeypatch.setattr(modal_app, '_persist_pipeline_prediction_bundle', lambda req, bundle: publications.append(deepcopy(bundle)) or {})
    monkeypatch.setattr(modal_app, '_post_pipeline_prediction_callback', lambda req, bundle, elapsed: callbacks.append(deepcopy(bundle)) or {})
    result = modal_app._pipeline_prediction_bundle_impl(parent)
    atomic = result['paired_nav_atomic_inference']
    assert atomic['status'] == 'complete'
    assert len(publications) == len(callbacks) == 1
    expected = [('feature', ['1001', '1002']), ('graph', ['1001', '1002']),
                ('feature', ['1002', '1003']), ('graph', ['1002', '1003'])]
    if same_symbols_new_features:
        expected += [('feature', ['1001', '1002']), ('graph', ['1001', '1002'])]
        assert atomic['slates'][changed_key]['reused_formal'] is False
        assert observed_meta == [None, None, {'sector_peer_return_1d': .2, 'eligible_for_pending_buy': False}]
    assert calls == expected
    candidate = atomic['slates'][slate_key(parent, ['1002', '1003'])]['result']
    formal_common = next(r for r in result['predict_batch_v2_results'] if r['symbol'] == '1002')
    alternative_common = next(r for r in candidate['predict_batch_v2_results'] if r['symbol'] == '1002')
    assert formal_common['rank_scores']['LightGBM'] == 1
    assert alternative_common['rank_scores']['LightGBM'] == 0
    assert result['gnn_graphsage_raw']['results'][0]['score'] == 3
    assert candidate['gnn_graphsage_raw']['results'][0]['score'] == 10
    assert parent == before


def test_same_symbols_different_features_or_eligibility_compute_separately_and_exact_duplicates_reuse():
    parent = request()
    packet = parent['paired_nav_atomic_slates']
    baseline_key = slate_key(parent, ['1001', '1002'])
    alternative = deepcopy(packet['slates'][baseline_key])
    alternative['payloads'][0]['stock_meta'] = {'sector_peer_return_1d': .2, 'stock_vs_sector': -.1,
                                               'eligible_for_pending_buy': False}
    alternative_key = checksum(alternative)
    packet['slates'][alternative_key] = alternative
    for definition in ('different-inputs', 'identical-second-definition'):
        packet['contrasts'].append({'definition_checksum': checksum(definition), 'baseline_key': baseline_key,
                                    'candidate_key': alternative_key})
    reseal(parent)
    before, calls = deepcopy(parent), []
    def compute(child):
        calls.append(deepcopy(child))
        bundle = stub_bundle(child)
        bundle['observed_payloads'] = deepcopy(child['payloads'])
        child['payloads'][0]['signal'] = 999  # A model cannot mutate the sealed source.
        return bundle
    result = run_atomic_slates(parent, compute=compute, formal_bundle=stub_bundle(parent))
    assert result['status'] == 'complete'
    assert len(calls) == 2, 'one changed universe plus one same-symbol changed-input universe'
    same_symbols = result['slates'][alternative_key]
    assert same_symbols['reused_formal'] is False
    assert same_symbols['result']['observed_payloads'][0]['stock_meta'] == alternative['payloads'][0]['stock_meta']
    assert result['slates'][baseline_key]['reused_formal'] is True
    assert result['contrasts'][-1]['candidate_key'] == result['contrasts'][-2]['candidate_key']
    assert parent == before


def test_slate_checksum_and_explicit_history_scope_fail_before_compute():
    for fault in ('slate-checksum', 'extra-series', 'invalid-series', 'missing-reference', 'child-authority'):
        parent = request()
        packet = parent['paired_nav_atomic_slates']
        candidate = packet['slates'][slate_key(parent, ['1002', '1003'])]
        if fault == 'slate-checksum': candidate['payloads'][0]['signal'] = 99
        if fault == 'extra-series': candidate['sequence_series'].append({'symbol': '9999', 'prices': [1]})
        if fault == 'invalid-series': candidate['sequence_series'][0]['prices'] = 'not a history'
        if fault == 'missing-reference': packet['contrasts'][0]['candidate_key'] = '0' * 64
        if fault == 'child-authority': candidate['serving_manifest'] = {'production_effect': True}
        if fault == 'slate-checksum': reseal(parent)
        else: rekey(parent)
        calls = []
        with pytest.raises(ValueError):
            run_atomic_slates(parent, compute=lambda child: calls.append(child), formal_bundle=stub_bundle(parent))
        assert calls == []


def test_unreleased_legacy_union_cannot_claim_candidate_specific_inputs():
    parent = request()
    parent['paired_nav_atomic_slates']['schema_version'] = 'paired-nav-atomic-slates-v1'
    reseal(parent)
    with pytest.raises(ValueError, match='legacy_union_requires_per_slate_inputs'):
        run_atomic_slates(parent, compute=lambda _: pytest.fail('unverified legacy input'), formal_bundle=stub_bundle(parent))


def test_explicit_empty_candidate_population_does_not_invent_predictions_or_maturity():
    parent = request()
    parent['paired_nav_atomic_slates']['slates'] = {}
    parent['paired_nav_atomic_slates']['contrasts'] = []
    reseal(parent)
    result = run_atomic_slates(parent, compute=lambda _: pytest.fail('no candidate compute requested'), formal_bundle=stub_bundle(parent))
    assert result['status'] == 'complete' and result['slates'] == {} and result['contrasts'] == []
    assert result['promotion_allowed'] is False and result['nav_maturity_credit'] == 0


@pytest.mark.parametrize('field', ['prices', 'stock_id', 'adaptive_params', 'sequence', 'omitted-sequence'])
def test_candidate_can_change_derived_features_but_not_shared_market_facts_or_model_policy(field):
    parent = request()
    candidate = parent['paired_nav_atomic_slates']['slates'][slate_key(parent, ['1002', '1003'])]
    if field == 'sequence': candidate['sequence_series'][0]['prices'][0] = 999
    elif field == 'omitted-sequence': candidate['sequence_series'].pop(0)
    else: candidate['payloads'][0][field] = {'unexpected': 'changed'}
    rekey(parent)
    with pytest.raises(ValueError, match='shared_(raw_source|history)_changed'):
        run_atomic_slates(parent, compute=lambda _: pytest.fail('inconsistent source'), formal_bundle=stub_bundle(parent))
