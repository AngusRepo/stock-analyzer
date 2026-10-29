"""C28-02 P2 T1: PIT-lagged TimeXer daily sources ride on the legacy feature-only prep."""
import asyncio
import json

import pytest

from services import pipeline_input_events as events
from services import pit_daily_sources as pds
from services.pit_certification import CONTRACT_VERSION, contract_content_sha256, load_contract
from test_pipeline_input_events import Bucket, Jobs, batch_result, prep_stage, store  # noqa: F401

V = CONTRACT_VERSION
PREFIX = 'universal/oof_forward_prep_v2/test'
VPREFIX = f'{PREFIX}-pit-{V}'


def _report(**extra):
    return {'rows': 6000, 'pit_contract_version': V,
            'pit_contract_sha256': contract_content_sha256(load_contract()), **extra}


def _event_prep(store, monkeypatch, variant_reports):
    """Legacy event prep with PIT variants; variant_reports[i] is batch i's report (None = absent)."""
    specs = pds.variant_specs(PREFIX, [V])
    real = events.defer_prep
    monkeypatch.setattr(events, 'defer_prep', lambda **kw: real(**kw, pit_variants=specs))
    path, stage = prep_stage(store, monkeypatch)
    assert stage['spec']['pit_variants'] == specs
    for index, report in enumerate(variant_reports):
        batch_result(store, path, stage, index,
                     **({'pit_variants': {VPREFIX: report}} if report is not None else {}))
        store.blob(f'{VPREFIX}/prep/batch_{index}.npz').upload_from_string(b'lagged')
    store.blob(f'{VPREFIX}/prep/feature_names.json').upload_from_string(b'["price"]')
    return path, stage


def _legacy_source(store):
    receipt = events.read(store, PREFIX + '/prep/immutable_receipt.json')
    return receipt, {'schema_version': 'timexer-feature-source-v1', 'status': 'ready', 'signal_date': '2026-10-02',
                     'source_gcs_prefix': PREFIX, 'source_receipt_checksum': receipt['receipt_checksum']}


def test_variant_specs_accept_only_the_known_contract():
    assert pds.variant_specs(PREFIX + '/', [V, V]) == [{
        'gcs_prefix': VPREFIX, 'pit_contract_version': V,
        'pit_contract_sha256': contract_content_sha256(load_contract())}]
    assert pds.variant_specs(PREFIX, []) == []
    with pytest.raises(ValueError, match='pit_variant_version_unknown'):
        pds.variant_specs(PREFIX, ['pit-availability-contract-v9'])


def test_legacy_stage_spec_is_unchanged_without_variants(store, monkeypatch):
    _, stage = prep_stage(store, monkeypatch)
    assert 'pit_variants' not in stage['spec']


def test_event_prep_seals_the_variant_bound_to_the_legacy_capture(store, monkeypatch):
    path, _ = _event_prep(store, monkeypatch, [_report(), _report()])
    jobs = Jobs()
    assert events.dispatch_ready(path, jobs_client=jobs, store=store)['status'] == 'dispatched'
    legacy, source = _legacy_source(store)
    variant = events.read(store, VPREFIX + '/prep/immutable_receipt.json')
    assert variant['pit_variant_of'] == legacy['receipt_checksum']
    assert variant['output_rows'] == 12000 and variant['batch_count'] == 2
    assert all(variant[key] == legacy[key] for key in pds.CAPTURE_KEYS)
    result = pds.variant_sources(store, source, [V])
    assert result['failures'] == {} and result['schema_version'] == pds.STATE_SCHEMA
    assert result['sources'][V] == {**source, 'source_gcs_prefix': VPREFIX,
                                    'source_receipt_checksum': variant['receipt_checksum'], 'pit_contract_version': V}
    # Sealing twice is a no-op, never an overwrite.
    stage = events.read(store, path)
    assert pds.seal_variants(store, legacy_receipt=legacy, results=[
        {'pit_variants': {VPREFIX: _report()}}] * 2, specs=stage['spec']['pit_variants'])[VPREFIX] == {'status': 'already_sealed'}


@pytest.mark.parametrize('second', [None, {'error': 'pit_variant_time_budget_exceeded'}, _report(rows=0),
                                    _report(pit_contract_sha256='0' * 64)])
def test_a_failed_variant_batch_leaves_the_legacy_prep_sealed(store, monkeypatch, second):
    path, _ = _event_prep(store, monkeypatch, [_report(), second])
    jobs = Jobs()
    assert events.dispatch_ready(path, jobs_client=jobs, store=store)['status'] == 'dispatched'
    assert len(jobs.calls) == 1
    _, source = _legacy_source(store)
    assert events.read(store, VPREFIX + '/prep/immutable_receipt.json') is None
    result = pds.variant_sources(store, source, [V])
    assert result['sources'] == {} and 'pit_variant_receipt_missing' in result['failures'][V]


def test_a_seal_exception_never_reaches_the_legacy_prep(store, monkeypatch):
    path, _ = _event_prep(store, monkeypatch, [_report(), _report()])
    def broken(*a, **k):
        raise RuntimeError('gcs down')
    monkeypatch.setattr(pds, 'seal_variants', broken)
    jobs = Jobs()
    assert events.dispatch_ready(path, jobs_client=jobs, store=store)['status'] == 'dispatched'
    assert events.read(store, PREFIX + '/prep/immutable_receipt.json')['training_dispatched'] is False


def test_variant_feature_names_must_match_the_legacy_prep(store, monkeypatch):
    path, _ = _event_prep(store, monkeypatch, [_report(), _report()])
    store.blob(f'{VPREFIX}/prep/feature_names.json').raw = b'["other"]'
    events.dispatch_ready(path, jobs_client=Jobs(), store=store)
    assert events.read(store, VPREFIX + '/prep/immutable_receipt.json') is None


def _rewrite(store, mutate):
    blob = store.blob(VPREFIX + '/prep/immutable_receipt.json')
    receipt = json.loads(blob.raw)
    mutate(receipt)
    receipt['receipt_checksum'] = pds._checksum(receipt)
    blob.raw = json.dumps(receipt).encode()


@pytest.mark.parametrize('tamper,reason', [
    (lambda r: r.update(price_capture={'capture_id': 'other'}), 'pit_variant_capture_mismatch'),
    (lambda r: r.update(pit_variant_of='0' * 64), 'pit_variant_capture_mismatch'),
    (lambda r: r.update(business_date='2026-10-01'), 'pit_variant_capture_mismatch'),
    (lambda r: r.update(pit_contract_sha256='0' * 64), 'pit_variant_contract_mismatch'),
    (lambda r: r.update(pit_contract_version='pit-availability-contract-v0'), 'pit_variant_contract_mismatch'),
    (lambda r: r.update(training_dispatched=True), 'pit_variant_receipt_invalid'),
    (lambda r: r.update(output_gcs_prefix=PREFIX), 'pit_variant_receipt_invalid'),
    (lambda r: r['output_checksums'].pop(f'{VPREFIX}/prep/batch_1.npz'), 'pit_variant_receipt_invalid'),
])
def test_a_variant_not_built_from_the_same_capture_and_contract_is_refused(store, monkeypatch, tamper, reason):
    path, _ = _event_prep(store, monkeypatch, [_report(), _report()])
    events.dispatch_ready(path, jobs_client=Jobs(), store=store)
    _, source = _legacy_source(store)
    _rewrite(store, tamper)
    result = pds.variant_sources(store, source, [V])
    assert result['sources'] == {} and reason in result['failures'][V]


def test_unchecksummed_variant_edit_and_wrong_legacy_reference_are_refused(store, monkeypatch):
    path, _ = _event_prep(store, monkeypatch, [_report(), _report()])
    events.dispatch_ready(path, jobs_client=Jobs(), store=store)
    _, source = _legacy_source(store)
    blob = store.blob(VPREFIX + '/prep/immutable_receipt.json')
    original = blob.raw
    blob.raw = original.replace(b'"output_rows": 12000', b'"output_rows": 12001')
    assert 'pit_variant_receipt_invalid' in pds.variant_sources(store, source, [V])['failures'][V]
    blob.raw = original
    stale = pds.variant_sources(store, {**source, 'source_receipt_checksum': '0' * 64}, [V])
    assert stale['sources'] == {} and 'pit_variant_legacy_receipt_invalid' in stale['failures'][V]


# ---- required_versions: which PIT contracts this run's TimeXers need ----

class MetaBucket:
    def __init__(self, objects):
        self.objects, self.reads = objects, []
    def blob(self, path):
        bucket = self
        class Blob:
            def download_as_bytes(self):
                bucket.reads.append(path)
                return json.dumps(bucket.objects[path]).encode()
        return Blob()


def _state(manifest):
    return {'run_date': '2026-10-30', 'decision_universe_frozen_at': '2026-10-30T05:30:00Z',
            'pipeline_modal_serving_context': {'serving_manifest': manifest}}


META = {'tx/legacy.json': {'version': 'v1'},
        'tx/pit.json': {'version': 'v2', 'input_scope': {'pit_contract_version': V}},
        'tx/candidate.json': {'version': 'v3', 'training': {'pit_contract_version': V}},
        'tx/ambiguous.json': {'a': {'pit_contract_version': V}, 'b': {'pit_contract_version': 'other'}}}


def test_legacy_only_manifest_touches_no_bucket_and_no_registry():
    manifest = {'models': [{'model': 'TabM', 'metadata_path': 'tabm.json'}]}
    def no_bucket():
        raise AssertionError('bucket opened')
    assert pds.required_versions(_state(manifest), query=lambda *a: pytest.fail('query'), bucket_factory=no_bucket) == []


def test_manifest_and_shadow_timexers_decide_the_versions():
    bucket = MetaBucket(META)
    manifest = {'models': [{'model': 'TimeXer', 'metadata_path': 'tx/legacy.json'},
                           {'model': 'TabM', 'metadata_path': 'tx/pit.json'}],
                'active8_shadow_candidates': {'s': {'model': 'TimeXer', 'metadata_path': 'tx/pit.json'}}}
    assert pds.required_versions(_state(manifest), query=lambda *a: pytest.fail('query'),
                                 bucket_factory=lambda: bucket) == [V]
    assert sorted(bucket.reads) == ['tx/legacy.json', 'tx/pit.json']
    legacy = {'models': [{'model': 'TimeXer', 'metadata_path': 'tx/legacy.json'}]}
    assert pds.required_versions(_state(legacy), query=None, bucket_factory=lambda: MetaBucket(META)) == []
    ambiguous = {'models': [{'model': 'TimeXer', 'metadata_path': 'tx/ambiguous.json'}]}
    with pytest.raises(ValueError, match='pit_contract_version_ambiguous'):
        pds.required_versions(_state(ambiguous), query=None, bucket_factory=lambda: MetaBucket(META))


def _candidate_query(registry):
    calls = []
    def query(sql, params):
        calls.append((sql, params))
        if 'active8_ensemble_artifacts_v1' in sql:
            assert params == ['2026-10-30T05:30:00Z', '2026-10-30']
            return [{'payload_json': json.dumps({'observation_artifacts': {'TimeXer': {'artifact_id': 'tx-c'}}})},
                    {'payload_json': json.dumps({'observation_artifacts': {'TabM': {'artifact_id': 'tabm'}}})}]
        assert params == ['tx-c']
        return registry
    return query, calls


def test_nav_candidate_timexers_are_read_through_the_registry():
    query, calls = _candidate_query([{'artifact_id': 'tx-c', 'metadata_path': 'tx/candidate.json'}])
    manifest = {'active8_ensemble': {'models': []}}
    assert pds.required_versions(_state(manifest), query=query, bucket_factory=lambda: MetaBucket(META)) == [V]
    assert len(calls) == 2
    query, _ = _candidate_query([])
    with pytest.raises(ValueError, match='pit_daily_candidate_registry_missing'):
        pds.required_versions(_state(manifest), query=query, bucket_factory=lambda: MetaBucket(META))


def test_single_b_and_non_ensemble_days_read_no_candidates(monkeypatch):
    from services import paper_strategy_mode
    monkeypatch.setattr(paper_strategy_mode, 'from_manifest', lambda *a, **k: {'mode': 'single_b'})
    fail = lambda *a: pytest.fail('candidate query')
    assert pds.required_versions(_state({'active8_ensemble': {}}), query=fail, bucket_factory=None) == []
    monkeypatch.setattr(paper_strategy_mode, 'from_manifest', lambda *a, **k: None)
    assert pds.required_versions(_state({'active8_ensemble': None}), query=fail, bucket_factory=None) == []


# ---- daily pipeline wiring ----

def test_a_version_prediction_error_only_records_a_failure(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    def broken(*a, **k):
        raise RuntimeError('d1 down')
    monkeypatch.setattr(pds, 'required_versions', broken)
    versions, value = graph._pit_daily_versions(_state({}))
    assert versions == [] and value['sources'] == {} and 'd1 down' in value['prediction_error']


def _node(monkeypatch, versions, sources=None):
    from test_paired_nav_atomic_daily_inputs import _setup
    from services import active8_prep_lifecycle as prep
    from services import walk_forward_retrain
    graph, state, _ = _setup(monkeypatch)
    calls = []
    async def ensure(**kw):
        calls.append(kw)
        return {'status': 'ready', 'signal_date': kw['end_date'], 'source_receipt_checksum': 'fixture-capture'}
    monkeypatch.setattr(prep, 'ensure_active8_daily_prep', ensure)
    monkeypatch.setattr(pds, 'required_versions', lambda state, **kw: list(versions))
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: 'bucket')
    def variant_sources(bucket, legacy, required):
        calls.append(('variants', bucket, legacy, list(required)))
        if sources is None:
            raise AssertionError('variant sources read on a legacy day')
        return sources
    monkeypatch.setattr(pds, 'variant_sources', variant_sources)
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    return graph, state, calls


def test_legacy_day_keeps_the_existing_prep_request_and_state(monkeypatch):
    graph, state, calls = _node(monkeypatch, [])
    output = asyncio.run(graph.node_build_payloads(state))
    assert len(calls) == 1 and 'pit_variant_versions' not in calls[0]
    assert 'timexer_pit_feature_sources' not in output
    assert [p['symbol'] for p in output['payloads']] == ['1000', '1001']


def test_pit_day_builds_variants_with_the_same_prep_and_never_on_resume(monkeypatch):
    value = {'schema_version': pds.STATE_SCHEMA, 'required_versions': [V], 'sources': {V: {'x': 1}}, 'failures': {}}
    graph, state, calls = _node(monkeypatch, [V], value)
    output = asyncio.run(graph.node_build_payloads(state))
    assert calls[0]['pit_variant_versions'] == (V,) and calls[0]['feature_only'] is True
    assert calls[1] == ('variants', 'bucket', output['timexer_feature_source'], [V])
    assert output['timexer_pit_feature_sources'] == value
    # A resumed state already holds the capture: no prep, no prediction, no variant rebuild.
    state.update(output)
    monkeypatch.setattr(graph, '_pit_daily_versions', lambda state: pytest.fail('re-predicted'))
    calls.clear()
    again = asyncio.run(graph.node_build_payloads(state))
    assert calls == [] and again['timexer_pit_feature_sources'] == value


def test_a_failed_variant_never_blocks_the_legacy_payloads(monkeypatch):
    value = {'schema_version': pds.STATE_SCHEMA, 'required_versions': [V], 'sources': {},
             'failures': {V: 'ValueError: pit_variant_receipt_missing'}}
    graph, state, _ = _node(monkeypatch, [V], value)
    output = asyncio.run(graph.node_build_payloads(state))
    assert [p['symbol'] for p in output['payloads']] == ['1000', '1001']
    assert output['timexer_pit_feature_sources']['sources'] == {}


def test_an_unknown_version_never_reaches_the_legacy_prep_request(monkeypatch):
    # Verifier finding: an unknown version used to make the trigger reject the whole legacy prep.
    value = {'schema_version': pds.STATE_SCHEMA, 'required_versions': [V], 'sources': {V: {'x': 1}}, 'failures': {}}
    graph, state, calls = _node(monkeypatch, ['pit-availability-contract-v9', V], value)
    output = asyncio.run(graph.node_build_payloads(state))
    assert calls[0]['pit_variant_versions'] == (V,)
    assert calls[1][3] == [V]
    pit = output['timexer_pit_feature_sources']
    assert pit['sources'] == {V: {'x': 1}}
    assert pit['failures'] == {'pit-availability-contract-v9': 'pit_variant_version_unknown'}
    assert pit['required_versions'] == sorted(['pit-availability-contract-v9', V])


def test_only_unknown_versions_keep_the_legacy_request_unchanged(monkeypatch):
    graph, state, calls = _node(monkeypatch, ['pit-availability-contract-v9'])
    output = asyncio.run(graph.node_build_payloads(state))
    assert len(calls) == 1 and 'pit_variant_versions' not in calls[0]
    assert output['timexer_pit_feature_sources']['failures'] == {
        'pit-availability-contract-v9': 'pit_variant_version_unknown'}
    assert output['timexer_pit_feature_sources']['sources'] == {}


def test_a_contract_load_error_is_a_prediction_error_not_a_prep_rejection(monkeypatch):
    from services import pit_certification
    graph, state, calls = _node(monkeypatch, [V])
    def broken():
        raise OSError('contract unreadable')
    monkeypatch.setattr(pit_certification, 'load_contract', broken)
    output = asyncio.run(graph.node_build_payloads(state))
    assert len(calls) == 1 and 'pit_variant_versions' not in calls[0]
    assert 'contract unreadable' in output['timexer_pit_feature_sources']['prediction_error']


def test_a_variant_source_read_error_only_fails_that_version(monkeypatch):
    graph, state, calls = _node(monkeypatch, [V], {})
    def broken(*a, **k):
        raise RuntimeError('gcs down')
    monkeypatch.setattr(pds, 'variant_sources', broken)
    output = asyncio.run(graph.node_build_payloads(state))
    assert [p['symbol'] for p in output['payloads']] == ['1000', '1001']
    pit = output['timexer_pit_feature_sources']
    assert pit['sources'] == {} and 'gcs down' in pit['failures'][V]


def test_l4_price_evidence_ignores_pit_variant_receipts():
    import hashlib
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from services import l4_forward_refresh as refresh
    manifest = json.dumps({'end_date': '2026-10-14'}).encode()
    blobs = {}
    class B:
        def __init__(self, name, raw, hour):
            self.name, self.raw, self.generation = name, raw, 1
            self.time_created = datetime(2026, 10, 14, hour, tzinfo=timezone.utc)
        def download_as_bytes(self, **kw):
            return self.raw
    legacy = 'universal/oof_forward_prep_v2/2026-10-14-abc'
    for prefix, hour in [(legacy, 12), (f'{legacy}-pit-{V}', 13)]:
        receipt = dict(status='ready', business_date='2026-10-14', output_gcs_prefix=prefix,
                       price_capture={'capture_manifest_path': 'prices', 'capture_manifest_sha256': hashlib.sha256(manifest).hexdigest()})
        receipt['receipt_checksum'] = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
        blobs[prefix + '/prep/immutable_receipt.json'] = B(prefix + '/prep/immutable_receipt.json', json.dumps(receipt).encode(), hour)
    blobs['prices'] = B('prices', manifest, 12)
    bucket = SimpleNamespace(list_blobs=lambda prefix: [b for n, b in blobs.items() if n.startswith(prefix)],
                             blob=lambda name: blobs[name])
    _, proof = refresh.current_price_capture(bucket, '2026-10-14', cutoff='2026-10-14T15:00:00+00:00')
    assert proof['path'] == legacy + '/prep/immutable_receipt.json'


def test_request_key_only_for_ready_sources_and_never_for_research():
    from graphs.daily_pipeline_v2 import _pit_feature_source_sets
    from services.formal_feature_contract import LEGACY_SEMANTIC
    source = {'schema_version': 'timexer-feature-source-v1', 'source_gcs_prefix': VPREFIX, 'pit_contract_version': V}
    state = {'timexer_pit_feature_sources': {'sources': {V: source}, 'failures': {}}}
    assert _pit_feature_source_sets(state, [LEGACY_SEMANTIC], research_only=False) == {
        'timexer_pit_feature_sources': {V: {'schema_version': 'timexer-feature-source-set-v1',
                                            'sources': {LEGACY_SEMANTIC: source}}}}
    assert _pit_feature_source_sets(state, [LEGACY_SEMANTIC], research_only=True) == {}
    assert _pit_feature_source_sets(state, None, research_only=False) == {}
    assert _pit_feature_source_sets({}, [LEGACY_SEMANTIC], research_only=False) == {}
    failed = {'timexer_pit_feature_sources': {'sources': {}, 'failures': {V: 'missing'}}}
    assert _pit_feature_source_sets(failed, [LEGACY_SEMANTIC], research_only=False) == {}


@pytest.mark.parametrize('change,error', [
    ({'pit_variant_versions': [V]}, 'pit_variant_requires_inference_prep'),
    ({'pit_variant_versions': [V], 'prep_only': True}, 'pit_variant_requires_inference_prep'),
    ({'pit_variant_versions': ['pit-availability-contract-v9'], 'prep_only': True, 'inference_only': True, 'train_model_groups': []},
     'pit_variant_version_unknown'),
])
def test_trigger_accepts_variants_only_for_a_known_contract_on_an_inference_prep(change, error):
    from routers import retrain_trigger as rt
    result = asyncio.run(rt.trigger_universal_retrain(rt.UniversalRetrainTriggerRequest(**change), None))
    assert result == {'status': 'rejected', 'error': error}


def test_r33_profile_cannot_request_variants():
    from routers import retrain_trigger as rt
    req = rt.UniversalRetrainTriggerRequest(pit_variant_versions=[V], prep_only=True, inference_only=True, train_model_groups=[],
                                            model_profile_schema_version=rt.R33_PROFILE)
    assert asyncio.run(rt.trigger_universal_retrain(req, None)) == {
        'status': 'rejected', 'error': 'pit_variant_requires_inference_prep'}


def test_lifecycle_refuses_variants_on_a_training_prep():
    from services import active8_prep_lifecycle as lifecycle
    with pytest.raises(ValueError, match='pit_variant_requires_feature_only_prep'):
        asyncio.run(lifecycle.ensure_active8_daily_prep(
            end_date='2026-10-30', pit_variant_versions=(V,),
            model_profile_schema_version='active8-release-model-profiles-v4-timexer-price'))


def test_the_prediction_request_forwards_research_only_to_the_pit_key():
    # L4 native observation builds research_only requests; their shape must not gain the PIT key.
    import inspect
    from graphs import daily_pipeline_v2 as graph
    source = inspect.getsource(inspect.unwrap(graph._build_pipeline_modal_prediction_payload))
    assert ("**_pit_feature_source_sets(state, semantics if needs_timexer else None, research_only=research_only)"
            in source)
