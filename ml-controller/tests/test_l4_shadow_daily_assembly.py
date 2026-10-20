"""Small engineering contracts; no historical or production acceptance credit."""
from copy import deepcopy
import base64
import hashlib
import json
from types import SimpleNamespace

import pytest

import l4_shadow_job_main as job
from services import l4_shadow_daily_assembly as assembly
from services import l4_shadow_native_producer as producer
from services.l4_challenger_comparison import digest, seal
from services.l4_challenger_registry import Registry
from services.frozen_manifest_budget import canonical_manifest_bytes
from services.l4_forward_materialization import digest as native_digest
from services.l4_native_observation import PREFIX
from services.l4_shadow_producer import read_reference
from test_l4_challenger_registry import Bucket
from test_l4_shadow_input_export import DAY, NOW
from test_l4_shadow_native_producer import example, put


def variant(entry, state, day_inputs):
    """A distinct L3 parent; both entries retain identical observed raw payloads."""
    from services.ensemble_v2 import ensemble_artifact_id

    entry, state, day_inputs = deepcopy((entry, state, day_inputs))
    manifest = state['pipeline_modal_serving_context']['serving_manifest']
    parent = manifest['active8_ensemble']
    parent['fit']['intercept'] += .01
    parent['payload_checksum'] = digest({k: v for k, v in parent.items() if k != 'payload_checksum'})
    identity = deepcopy(day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact']['l3_identity'])
    identity.update(payload_checksum=parent['payload_checksum'], artifact_id=ensemble_artifact_id(parent))
    for prediction in state['predictions'].values():
        prediction['ensemble_v2'].update(artifact_checksum=identity['payload_checksum'],
                                         artifact_id=identity['artifact_id'])
        prediction['rank_scores']['LightGBM'] += .05
    state['pipeline_modal_serving_context']['serving_manifest_digest'] = hashlib.sha256(
        canonical_manifest_bytes(manifest)).hexdigest()
    policy = day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']
    policy['artifact']['l3_identity'] = identity
    policy['runtime'].update(l3_identity=identity, predictions=deepcopy(state['predictions']))
    day_inputs['trading_config']['l4Distribution'] = deepcopy(policy)
    entry['entry_id'] = 'second-chain'
    entry['components']['L3'] = identity['payload_checksum']
    entry['serving_identity']['l3_payload_checksum'] = identity['payload_checksum']
    entry['training_receipts']['L3'] = seal({
        **{k: v for k, v in entry['training_receipts']['L3'].items() if k != 'checksum'},
        'component_checksum': identity['payload_checksum']})
    entry = seal({k: v for k, v in entry.items() if k != 'checksum'})
    return entry, state, day_inputs


def source_directory(monkeypatch, tmp_path, *, native_configs=False):
    first, first_state, context, first_day = example(monkeypatch)
    second, second_state, second_day = variant(first, first_state, first_day)
    bucket = Bucket()
    registry = Registry(bucket, formal_identity=lambda: first['serving_identity'], clock=lambda: NOW.isoformat())
    current = registry.initialize(first)
    registry.register(second, expected_registry_checksum=current['checksum'])
    common = put(bucket, 'common/recommendation-context', context)
    states = {}
    for entry, state, day_inputs in ((first, first_state, first_day), (second, second_state, second_day)):
        key = entry['entry_id']
        spec = dict(entry_checksum=entry['checksum'], observed_at=NOW.isoformat(),
            recommendation_context_reference=common,
            day_inputs_reference=put(bucket, key + '/day', day_inputs))
        if native_configs:
            identity = day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact']['l3_identity']
            config = dict(l3_identity=identity, serving_context={'path': key + '/pinned', 'sha256': 'c' * 64},
                          training_cutoffs={'path': key + '/cutoffs', 'sha256': 'd' * 64},
                          source_description='凍結台股原始來源')
            spec['native_config_reference'] = put(bucket, key + '/config', config)
            observed_key = native_digest(dict(day=state['run_date'], identity=identity, policy=config))
            for kind in ('requests', 'index'):
                put(bucket, PREFIX + kind + '/' + observed_key + '.json',
                    {'path': key + '/' + kind, 'sha256': digest([key, kind])})
            states[identity['payload_checksum']] = state
        else:
            spec['state_reference'] = put(bucket, key + '/state', state)
        (tmp_path / (key + '.json')).write_text(json.dumps(spec), encoding='utf-8')
    bucket.writes.clear()
    return registry, {first['entry_id']: first_state, second['entry_id']: second_state}, states


@pytest.mark.parametrize('native_configs', [False, True])
def test_registry_assembly_keeps_distinct_l3_predictions_and_immutable_outputs(
        monkeypatch, tmp_path, native_configs):
    from services import l4_native_observation as native
    from services import l4_native_dispatch as dispatch
    from services import kv_client

    registry, expected, states = source_directory(monkeypatch, tmp_path, native_configs=native_configs)
    calls = []
    def forbidden(*args, **kwargs):
        raise AssertionError('assembly must not dispatch or resolve a live config')
    monkeypatch.setattr(native, 'prepare', forbidden)
    monkeypatch.setattr(native, 'collect', forbidden)
    monkeypatch.setattr(dispatch, 'advance', forbidden)
    monkeypatch.setattr(kv_client, 'get', forbidden)
    if native_configs:
        async def completed(*, bucket, observation, identity, day):
            assert observation['config']['l3_identity'] == identity
            value = states[identity['payload_checksum']]
            assert value['run_date'] == day
            calls.append(identity['payload_checksum'])
            return deepcopy(value)
        monkeypatch.setattr(producer, 'collect_completed_prediction_state', completed)
    result = job.run(operation='assemble', session_date=DAY, now=NOW,
                     accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    assert result['status'] == 'published'
    index = read_reference(registry.bucket, result['source_index_reference'])
    captures = []
    for key, reference in index['sources'].items():
        source = read_reference(registry.bucket, reference)
        context = read_reference(registry.bucket, source['recommendation_context_reference'])
        captures.append(context['content_checksum'])
        assert context['inputs']['predictions'] == expected[key]['predictions']
        assert context['post_predictions'] == expected[key]['predictions']
        assert source['serving_identity']['l3_payload_checksum'] == (
            expected[key]['pipeline_modal_serving_context']['serving_manifest']['active8_ensemble']['payload_checksum'])
    assert len(set(captures)) == 2
    assert len(calls) == (2 if native_configs else 0)
    saved = deepcopy(registry.bucket.objects)
    writes = list(registry.bucket.writes)
    assert job.run(operation='assemble', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path) == result
    assert registry.bucket.objects == saved and registry.bucket.writes == writes
    assert result['outer_acceptance_credit'] == 0


@pytest.mark.parametrize('fault', ['payload', 'missing_payload_source', 'policy', 'context_sha',
                                  'context_code', 'day', 'other_state'])
def test_one_bad_entry_rejects_whole_assembly_before_publication(monkeypatch, tmp_path, fault):
    registry, _, _ = source_directory(monkeypatch, tmp_path)
    path = tmp_path / 'second-chain.json'
    spec = json.loads(path.read_bytes())
    if fault in ('payload', 'other_state'):
        state = read_reference(registry.bucket, spec['state_reference'])
        if fault == 'payload':
            state['payloads'][0]['prices'] = [{'close': 999, 'date': '2026-10-19'}]
        else:
            first = json.loads((tmp_path / 'old-chain.json').read_bytes())
            state = read_reference(registry.bucket, first['state_reference'])
        spec['state_reference'] = put(registry.bucket, 'changed/state', state)
    elif fault == 'policy':
        day = read_reference(registry.bucket, spec['day_inputs_reference'])
        day['trading_config']['alphaFramework'] = {'changed': True}
        spec['day_inputs_reference'] = put(registry.bucket, 'changed/day', day)
    else:
        context = read_reference(registry.bucket, spec['recommendation_context_reference'])
        if fault == 'context_sha':
            context['expected']['sell_count'] += 1
        else:
            if fault == 'missing_payload_source':
                context['inputs'].pop('payloads')
            elif fault == 'context_code':
                context['source_identity']['paired_nav_recommendation_path.py'] = 'f' * 64
            else:
                context['inputs']['filter_options']['run_date'] = '2026-10-18'
            from services.paired_nav_journal import digest as context_digest
            context['content_checksum'] = context_digest({k: v for k, v in context.items()
                                                         if k != 'content_checksum'})
        spec['recommendation_context_reference'] = put(registry.bucket, 'changed/context', context)
    path.write_text(json.dumps(spec), encoding='utf-8')
    registry.bucket.writes.clear()
    result = job.run(operation='assemble', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    assert result['status'] == 'not_ready'
    assert set(result['entries']) == {'second-chain'}
    assert registry.bucket.writes == []


@pytest.mark.parametrize('fault', ['missing_completion', 'config_sha', 'other_identity'])
def test_completed_observation_lookup_never_uses_another_chain_or_dispatches(monkeypatch, tmp_path, fault):
    registry, _, states = source_directory(monkeypatch, tmp_path, native_configs=True)
    spec = json.loads((tmp_path / 'second-chain.json').read_bytes())
    identity = read_reference(registry.bucket, spec['native_config_reference'])['l3_identity']
    reference = deepcopy(spec['native_config_reference'])
    if fault == 'missing_completion':
        config = read_reference(registry.bucket, reference)
        key = native_digest(dict(day='2026-10-19', identity=identity, policy=config))
        del registry.bucket.objects[PREFIX + 'index/' + key + '.json']
    elif fault == 'config_sha':
        reference['sha256'] = '0' * 64
    else:
        identity = deepcopy(identity)
        identity['payload_checksum'] = next(k for k in states if k != identity['payload_checksum'])
    with pytest.raises(ValueError):
        assembly.resolve_completed_observation(bucket=registry.bucket, config_reference=reference,
                                                identity=identity, day='2026-10-19')
    assert registry.bucket.writes == []


@pytest.mark.parametrize('fault', [None, 'missing_universe', 'other_model'])
def test_p6_assembly_rebuilds_full_pool_through_original_universe_owner(
        monkeypatch, tmp_path, fault):
    from services.l4_distribution import digest as l4_digest
    from test_l4_p6_runtime import setup as p6_setup

    entry, state, context, day_inputs = example(monkeypatch)
    _, p6, _, load = p6_setup()
    policy = day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']
    identity = deepcopy(policy['artifact']['l3_identity'])
    bundle = deepcopy(p6['artifact'])
    bundle['l3_identity'] = identity
    policy['artifact'] = bundle
    # A deliberately stale runtime must be replaced, not blessed by a new SHA.
    policy['runtime']['p6_native_pool'] = {'features_checksum': 'f' * 64}
    day_inputs['trading_config']['l4Distribution'] = deepcopy(policy)
    day_inputs['l4_allocation_inputs']['p6_weight_objects'] = {
        row['weights']['path']: {'reference': row['weights'],
                                'base64': base64.b64encode(load(row['weights'])).decode()}
        for row in bundle['model']['seeds']}
    entry['components']['L4'] = bundle['model_checksum']
    entry['serving_identity']['l4_model_checksum'] = bundle['model_checksum']
    entry['training_receipts']['L4'] = seal({
        **{k: v for k, v in entry['training_receipts']['L4'].items() if k != 'checksum'},
        'component_checksum': bundle['model_checksum']})
    entry = seal({k: v for k, v in entry.items() if k != 'checksum'})
    universe = dict(schema_version='p6-inference-universe-v1', signal_date=state['run_date'],
        model_checksum=bundle['model_checksum'], l3_identity=identity,
        roster=[{'symbol': s} for s in state['predictions']], roster_proof={'fixture': True},
        classification={'accepted_evidence': {s: {'cfi': 'ESVUFR'} for s in state['predictions']},
                        'excluded_symbols': []},
        classification_reference={'path': 'fixture/classification', 'sha256': 'c' * 64},
        listing_exclusions=[], routed_symbols=sorted(state['predictions']),
        route_admission_changed=False, second_inference_required=False)
    if fault == 'other_model':
        universe['model_checksum'] = 'f' * 64
    state['p6_inference_universe'] = {**universe, 'checksum': l4_digest(universe)}
    if fault == 'missing_universe':
        state.pop('p6_inference_universe')
    bucket = Bucket()
    registry = Registry(bucket, formal_identity=lambda: entry['serving_identity'], clock=lambda: NOW.isoformat())
    registry.initialize(entry)
    spec = dict(entry_checksum=entry['checksum'], observed_at=NOW.isoformat(),
        state_reference=put(bucket, 'state', state),
        recommendation_context_reference=put(bucket, 'environment', context),
        day_inputs_reference=put(bucket, 'day', day_inputs))
    (tmp_path / (entry['entry_id'] + '.json')).write_text(json.dumps(spec), encoding='utf-8')
    bucket.writes.clear()
    result = job.run(operation='assemble', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    if fault:
        assert result['status'] == 'not_ready' and bucket.writes == []
    else:
        assert result['status'] == 'published'
        index = read_reference(bucket, result['source_index_reference'])
        source = read_reference(bucket, index['sources'][entry['entry_id']])
        assert source['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact'] == bundle
        assert bundle['model_checksum'] != (
            context['inputs']['filter_options']['alpha_policy']['l4Distribution']['artifact']['model_checksum'])
        pool = source['l4_allocation_inputs']['alpha_policy']['l4Distribution']['runtime']['p6_native_pool']
        assert pool['l3_identity'] == identity
        assert pool['features_checksum'] == l4_digest(pool['feature_rows'])
        assert pool['eligible_symbols'] == sorted(state['predictions'])
        assert pool['features_checksum'] != 'f' * 64
