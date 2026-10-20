"""Small contract examples only; these do not certify a real archived session."""
from copy import deepcopy
import asyncio
import base64
from datetime import datetime
import hashlib
import io
import json
import sys
from types import SimpleNamespace

import numpy as np
import pytest

import l4_shadow_job_main as job
from services import l4_shadow_native_producer as producer
from services import l4_tabpack_weights as weights
from services.l4_challenger_comparison import digest, seal
from services.l4_challenger_registry import Registry
from services.l4_private_execution import frozen_legacy_loader
from services.frozen_manifest_budget import canonical_manifest_bytes
from services.paired_nav_recommendation_path import run_and_capture_recommendation_path
from services.l4_shadow_daily import configuration_checksum
from test_l4_shadow_input_export import native_source, DAY, NOW
from test_l4_challenger_registry import Bucket
from test_native_paper_sandbox import native_runner, frame


def example(monkeypatch):
    from services.alpha_model_roster import TIMEXER_MODELS
    from services.ensemble_v2 import (ensemble_artifact_id, ARTIFACT_SCHEMA_VERSION,
        ENSEMBLE_V2_SEMANTIC_VERSION, CALIBRATION_SCHEMA_VERSION, SIGNAL_POLICY_VERSION)
    from services import recommendation_service

    entry, source = native_source('old-chain', 'a')
    day_inputs = {k: deepcopy(v) for k, v in source.items() if k not in
                  ('checksum', 'schema', 'rules_document_sha256', 'entry_checksum', 'observed_at')}
    policy = day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']
    order = list(TIMEXER_MODELS)
    base = {name: dict(artifact_id=name + ':frozen', version='frozen', checksum='sha256:' + 'e' * 64,
                       candidate_type='oof_full_fit_release') for name in order}
    parent = dict(cohort_id='cohort-A', schema_version=ARTIFACT_SCHEMA_VERSION,
        ensemble_semantic_version=ENSEMBLE_V2_SEMANTIC_VERSION,
        calibration_schema_version=CALIBRATION_SCHEMA_VERSION,
        base_artifact_set_checksum=digest(base), base_artifacts=base, model_order=order,
        observation_artifacts=base, observation_artifact_set_checksum=digest(base),
        selected_models=order, excluded_models=[],
        feature_names=[f'{name}.rank' for name in order] + [f'{name}.available' for name in order],
        fit=dict(method='nonnegative_rank_ridge_full_fit_after_heldout_chronological_oof_validation',
                 rank_coefficient_constraint='nonnegative', outer_folds=5, coefficients=[.01] * 16, intercept=0.),
        validation=dict(decision='PASS', failed_gates=[], rank_ic_equal_date_market_lcb90=.1,
                        top_bottom_net_return_spread_lcb90=.1),
        signal_policy=dict(schema_version=SIGNAL_POLICY_VERSION, top_k=None,
                           buy_rule='conformal_lower_bound_gt_zero', sell_rule='conformal_upper_bound_lt_zero',
                           buy_coverage=.9, strong_coverage=.95),
        calibration=dict(absolute_residual_quantiles={'0.9': .1, '0.95': .2},
                         probability_x_thresholds=[0., 1.], probability_y_thresholds=[0., 1.]))
    parent['payload_checksum'] = digest(parent)
    identity = {**policy['artifact']['l3_identity'], 'artifact_id': ensemble_artifact_id(parent),
                'base_artifact_set_checksum': parent['base_artifact_set_checksum'],
                'payload_checksum': parent['payload_checksum']}
    entry['components']['L3'] = parent['payload_checksum']
    entry['serving_identity']['l3_payload_checksum'] = parent['payload_checksum']
    entry['training_receipts']['L3'] = seal({**{k: v for k, v in entry['training_receipts']['L3'].items()
                                              if k != 'checksum'}, 'component_checksum': parent['payload_checksum']})
    policy['artifact']['l3_identity'] = identity
    policy['runtime']['l3_identity'] = identity
    predictions = deepcopy(policy['runtime']['predictions'])
    for prediction in predictions.values():
        prediction['rank_scores']['TimeXer'] = .5
        prediction['model_score_lineage']['raw_scores']['TimeXer'] = .5
        prediction['ensemble_v2'].update(artifact_id=identity['artifact_id'],
            artifact_checksum=parent['payload_checksum'],
            base_artifact_set_checksum=identity['base_artifact_set_checksum'], model_order=order)
    policy['runtime']['predictions'] = deepcopy(predictions)
    manifest = dict(active8_ensemble=parent, models=[dict(model=name, **value) for name, value in base.items()])
    state = dict(run_date=day_inputs['signal_date'], predictions=predictions,
                 payloads=[{'symbol': s} for s in predictions],
                 pipeline_modal_serving_context=dict(schema_version='pipeline-modal-serving-context-v1',
                     serving_manifest=manifest,
                     serving_manifest_digest=hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()))
    # Exercise the real capture/replay wrappers and boundary validation; keep
    # ranking math out of this wiring test (covered by its existing suite).
    rows = deepcopy(day_inputs['recommendations'])
    monkeypatch.setattr(recommendation_service, 'filter_and_score_recommendations',
                        lambda *a, **kw: (deepcopy(rows), 0, {}))
    monkeypatch.setattr(recommendation_service, 'apply_core_family_evidence',
                        lambda recs, *a, **kw: recs)
    capture_inputs = dict(screener_recs=deepcopy(rows), predictions=deepcopy(predictions),
                          payloads=deepcopy(state['payloads']),
                          filter_options=dict(persona_opinions={}, persona_weight=0,
                              regime_label='bull', regime_surface={}, alpha_policy=deepcopy(
                                  day_inputs['l4_allocation_inputs']['alpha_policy']),
                              fundamental_quality_by_symbol={}, pit_sector_alpha_by_symbol={},
                              run_date=state['run_date']))
    _, context = run_and_capture_recommendation_path(inputs=capture_inputs)
    day_inputs['trading_config']['l4Distribution'] = deepcopy(policy)
    entry['components']['allocator_policy'] = configuration_checksum(day_inputs['trading_config'], day_inputs['risk_config'])
    entry = seal({k: v for k, v in entry.items() if k != 'checksum'})
    return entry, state, context, day_inputs


def build(entry, state, context, day_inputs):
    return producer.build_source(entry=entry, state=state, recommendation_context=context,
                                 day_inputs=day_inputs, observed_at=DAY + 'T06:00:00+08:00', now=NOW)


def test_captured_full_chain_becomes_native_packet_without_formal_account(monkeypatch):
    entry, state, context, day_inputs = example(monkeypatch)
    before = deepcopy((state, context, day_inputs))
    day_inputs['l4_allocation_inputs']['opb_reward_ledger'] = [{'formal': 'must-not-copy'}]
    source = build(entry, state, context, day_inputs)
    runtime = source['l4_allocation_inputs']['alpha_policy']['l4Distribution']['runtime']
    assert 'account' not in runtime
    assert 'opb_reward_ledger' not in source['l4_allocation_inputs']
    assert runtime['predictions'] == context['post_predictions']
    assert source['serving_identity'] == entry['serving_identity']
    assert (state, context) == before[:2]
    assert 'account' in day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['runtime']


@pytest.mark.parametrize('fault', ['projection', 'other_chain', 'manifest', 'base_model', 'coefficients',
                                  'partial_context', 'payload', 'filter_policy'])
def test_missing_or_changed_native_boundaries_do_not_get_a_packet(monkeypatch, fault):
    entry, state, context, day_inputs = example(monkeypatch)
    if fault == 'projection':
        state.pop('predictions')
        state['feature_rows'] = [{'symbol': 'A', 'features': {}}]
    elif fault == 'other_chain':
        state['predictions']['A']['ensemble_v2']['artifact_checksum'] = 'c' * 64
    elif fault == 'manifest':
        state['pipeline_modal_serving_context']['serving_manifest_digest'] = '0' * 64
    elif fault in ('base_model', 'coefficients'):
        pinned = state['pipeline_modal_serving_context']
        if fault == 'base_model':
            pinned['serving_manifest']['models'][0]['version'] = 'latest'
        else:
            pinned['serving_manifest']['active8_ensemble']['fit']['coefficients'][0] = .99
        pinned['serving_manifest_digest'] = hashlib.sha256(
            canonical_manifest_bytes(pinned['serving_manifest'])).hexdigest()
    elif fault == 'partial_context':
        context = {'inputs': {'screener_recs': context['inputs']['screener_recs']}}
    elif fault == 'payload':
        context['inputs']['payloads'][0]['extra'] = 'unsealed'
    else:
        context['inputs']['filter_options']['alpha_policy']['l4Distribution']['constraints']['max_positions'] = 3
    with pytest.raises(ValueError):
        build(entry, state, context, day_inputs)


def put(bucket, name, value):
    raw = json.dumps(value, sort_keys=True).encode()
    bucket.objects[name] = (1, raw)
    return dict(path=name, generation='1', sha256=hashlib.sha256(raw).hexdigest())


def directory(monkeypatch, tmp_path, *, incomplete=False):
    entry, state, context, day_inputs = example(monkeypatch)
    bucket = Bucket()
    registry = Registry(bucket, formal_identity=lambda: entry['serving_identity'], clock=lambda: NOW.isoformat())
    registry.initialize(entry)
    if incomplete:
        context = {'inputs': {'screener_recs': context['inputs']['screener_recs']}}
    spec = dict(entry_checksum=entry['checksum'], observed_at=DAY + 'T06:00:00+08:00',
                state_reference=put(bucket, 'archived-state', state),
                recommendation_context_reference=put(bucket, 'recommendation-capture', context),
                day_inputs_reference=put(bucket, 'native-day-inputs', day_inputs))
    (tmp_path / (entry['entry_id'] + '.json')).write_text(json.dumps(spec), encoding='utf-8')
    bucket.writes.clear()
    return registry, spec


def test_produce_job_reaches_existing_export_and_preserves_references(monkeypatch, tmp_path):
    registry, spec = directory(monkeypatch, tmp_path)
    result = job.run(operation='produce', session_date=DAY, now=NOW,
                     accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    assert result['status'] == 'published'
    assert len(registry.bucket.writes) == 2
    source = json.loads(registry.bucket.objects[registry.bucket.writes[0]][1])
    assert all(spec[key]['sha256'] in source['source_receipt_shas'] for key in
               ('state_reference', 'recommendation_context_reference', 'day_inputs_reference'))
    assert result['outer_acceptance_credit'] == 0


def test_incomplete_real_style_projection_is_not_ready_and_writes_nothing(monkeypatch, tmp_path):
    registry, _ = directory(monkeypatch, tmp_path, incomplete=True)
    result = asyncio.run(producer.produce_directory(registry, tmp_path, session_date=DAY, now=NOW))
    assert result['status'] == 'not_ready'
    assert result['entries'] == {'old-chain': 'shadow_native_recommendation_context_incomplete'}
    assert registry.bucket.writes == []


def input_directory(monkeypatch, tmp_path, fault=None):
    registry, spec = directory(monkeypatch, tmp_path)
    context_ref = spec.pop('recommendation_context_reference')
    captured = json.loads(registry.bucket.objects[context_ref['path']][1])['inputs']
    if fault == 'source':
        captured['recommendation_source_context'] = {'invalid': True}
    elif fault == 'prediction':
        captured['predictions']['A']['ensemble_v2']['artifact_checksum'] = 'c' * 64
    spec['recommendation_inputs_reference'] = put(registry.bucket, 'recommendation-inputs', captured)
    if fault == 'ambiguous':
        spec['recommendation_context_reference'] = context_ref
    (tmp_path / 'old-chain.json').write_text(json.dumps(spec), encoding='utf-8')
    return registry, spec


def test_daily_inputs_use_original_capture_owner_and_archive_complete_context(monkeypatch, tmp_path):
    registry, spec = input_directory(monkeypatch, tmp_path)
    result = job.run(operation='produce', session_date=DAY, now=NOW,
                     accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    assert result['status'] == 'published'
    assert len(registry.bucket.writes) == 3
    capture_path, source_path, index_path = registry.bucket.writes
    assert '/recommendation-contexts/' in capture_path
    context = json.loads(registry.bucket.objects[capture_path][1])
    from services.paired_nav_recommendation_path import replay_recommendation_context
    assert replay_recommendation_context(context) == context['expected']
    source = json.loads(registry.bucket.objects[source_path][1])
    ref = source['recommendation_context_reference']
    assert ref['path'] == capture_path
    assert hashlib.sha256(registry.bucket.objects[capture_path][1]).hexdigest() == ref['sha256']
    assert ref['sha256'] in source['source_receipt_shas']
    assert spec['recommendation_inputs_reference']['sha256'] in source['source_receipt_shas']
    assert index_path.endswith('/index.json')
    assert result['outer_acceptance_credit'] == 0


@pytest.mark.parametrize('fault', ['source', 'prediction', 'ambiguous'])
def test_fresh_capture_rejects_invalid_original_boundary_without_any_write(monkeypatch, tmp_path, fault):
    registry, _ = input_directory(monkeypatch, tmp_path, fault)
    result = asyncio.run(producer.produce_directory(registry, tmp_path, session_date=DAY, now=NOW))
    assert result['status'] == 'not_ready'
    assert registry.bucket.writes == []


def test_failed_capture_is_not_accepted_even_if_original_owner_has_serving_rows(monkeypatch):
    entry, state, context, day_inputs = example(monkeypatch)
    from services import paired_nav_recommendation_path as path
    monkeypatch.setattr(path, 'run_and_capture_recommendation_path',
                        lambda **kw: ({'recommendations': context['expected']['recommendations']},
                                      {'status': 'shadow_failed', 'reason': 'source_changed'}))
    with pytest.raises(ValueError, match='recommendation_capture_failed'):
        producer.capture_recommendation_context(entry=entry, state=state,
            recommendation_inputs=context['inputs'], day_inputs=day_inputs)


def test_fresh_capture_invalid_second_entry_has_zero_publication(monkeypatch, tmp_path):
    registry, spec = input_directory(monkeypatch, tmp_path)
    current, _ = registry.current()
    second = seal({**{k: v for k, v in current['entries']['old-chain'].items() if k != 'checksum'},
                   'entry_id': 'z-invalid'})
    registry.register(second, expected_registry_checksum=current['checksum'])
    bad = deepcopy(spec)
    bad['entry_checksum'] = second['checksum']
    inputs = json.loads(registry.bucket.objects[spec['recommendation_inputs_reference']['path']][1])
    inputs['predictions']['A']['ensemble_v2']['artifact_checksum'] = 'c' * 64
    bad['recommendation_inputs_reference'] = put(registry.bucket, 'invalid-inputs', inputs)
    (tmp_path / 'z-invalid.json').write_text(json.dumps(bad), encoding='utf-8')
    registry.bucket.writes.clear()
    result = asyncio.run(producer.produce_directory(registry, tmp_path, session_date=DAY, now=NOW))
    assert result['status'] == 'not_ready'
    assert set(result['entries']) == {'z-invalid'}
    assert registry.bucket.writes == []


@pytest.mark.parametrize('failure_stage', ['sources', 'index'])
def test_fresh_capture_partial_publication_retry_never_overwrites(monkeypatch, tmp_path, failure_stage):
    from test_l4_challenger_registry import Blob

    registry, _ = input_directory(monkeypatch, tmp_path)
    original = Blob.upload_from_string
    failed = []
    def interrupted(blob, raw, **options):
        selected = ('/sources/' in blob.key if failure_stage == 'sources'
                    else blob.key.endswith('/index.json'))
        if selected and not failed:
            failed.append(blob.key)
            raise RuntimeError('simulated_transport_interrupt')
        return original(blob, raw, **options)
    monkeypatch.setattr(Blob, 'upload_from_string', interrupted)
    with pytest.raises(RuntimeError, match='simulated_transport_interrupt'):
        asyncio.run(producer.produce_directory(registry, tmp_path, session_date=DAY, now=NOW))
    partial = {key: registry.bucket.objects[key] for key in registry.bucket.writes}
    assert partial and not any(key.endswith('/index.json') for key in partial)
    result = asyncio.run(producer.produce_directory(registry, tmp_path, session_date=DAY, now=NOW))
    assert result['status'] == 'published'
    assert all(registry.bucket.objects[key] == value for key, value in partial.items())
    assert len(registry.bucket.writes) == 3
    written = deepcopy(registry.bucket.objects)
    assert asyncio.run(producer.produce_directory(
        registry, tmp_path, session_date=DAY, now=NOW)) == result
    assert registry.bucket.objects == written
    assert len(registry.bucket.writes) == 3


def test_preallocation_distribution_skips_artifact_and_weight_readers(monkeypatch):
    from services import l4_alpha_ev_producer as alpha
    from services import allocator_ev_fusion as fusion

    def forbidden(*args, **kwargs):
        raise AssertionError('preallocation must not load live model bytes')
    monkeypatch.setattr(alpha, '_policy_artifact', forbidden)
    monkeypatch.setattr(fusion, 'policy_artifact', forbidden)
    monkeypatch.setattr(weights, '_load', forbidden)
    policy = {'l4Distribution': {'artifact': {'model_checksum': 'a' * 64}}}
    assert alpha.materialize_l4_alpha_ev({}, prediction={}, policy=policy) is None
    assert fusion.materialize_allocator_ev_fusion({}, l4_value=None, l4_source='missing',
        l4_payload=None, market_heat_expected_return=0., policy=policy) is None


def test_fresh_producer_to_native_accounts_two_days_isolated_and_idempotent(
        monkeypatch, tmp_path, native_runner):
    """Engineering fixture: real owners/Worker, synthetic account and market data."""
    from services.l4_shadow_accounts import Accounts
    from services.l4_shadow_producer import produce_day, read_reference
    from test_l4_shadow_daily import setup as daily_setup, read_cash
    from services import recommendation_service

    _, _, daily, opening, _ = daily_setup(native_runner, full_session=True)
    entry, state, context, inputs = example(monkeypatch)
    for key in ('stock_rows', 'seed_rows', 'execution_context', 'risk_config'):
        inputs[key] = deepcopy(daily[key])
    inputs['trading_config'] = {
        **deepcopy(daily['trading_config']), 'l4Distribution': inputs['trading_config']['l4Distribution']}
    for row, prepared in zip(inputs['recommendations'], daily['recommendations']):
        row.update(stock_id=prepared['stock_id'], score=prepared['score'],
                   score_seed_inputs=deepcopy(prepared['score_seed_inputs']))
    context['inputs']['screener_recs'] = deepcopy(inputs['recommendations'])
    monkeypatch.setattr(recommendation_service, 'filter_and_score_recommendations',
                        lambda rows, *a, **kw: (deepcopy(rows), 0, {}))
    entry['components']['allocator_policy'] = configuration_checksum(
        inputs['trading_config'], inputs['risk_config'])
    entry['components']['execution_context'] = digest(inputs['execution_context'])
    entry = seal({k: v for k, v in entry.items() if k != 'checksum'})
    second = seal({**{k: v for k, v in entry.items() if k != 'checksum'}, 'entry_id': 'second-account'})
    clock = [NOW.isoformat()]
    registry = Registry(Bucket(), formal_identity=lambda: entry['serving_identity'], clock=lambda: clock[0])
    current = registry.initialize(entry)
    registry.register(second, expected_registry_checksum=current['checksum'])
    accounts = Accounts(registry, runner=native_runner)
    for model in (entry, second):
        accounts.initialize(model['entry_id'], state_sql=opening['state_sql'],
            state_checksum=opening['state_checksum'], account_id=1,
            opening_receipt=seal(dict(scope='paper_shadow', state_checksum=opening['state_checksum'],
                                      source='synthetic_daily_native_fixture')))
    for signal, day, balance in [('2026-10-19', '2026-10-20', 1000100),
                                  ('2026-10-20', '2026-10-21', 1000300)]:
        clock[0] = day + 'T06:01:00+08:00'
        now = datetime.fromisoformat(clock[0])
        state['run_date'] = signal
        inputs.update(signal_date=signal, session_date=day, next_open=day + 'T09:00:00+08:00')
        for row in inputs['seed_rows']:
            row['date'] = signal
        policy = inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']
        policy['runtime']['signal_date'] = signal
        policy['runtime']['account']['signal_date'] = signal
        inputs['trading_config']['l4Distribution'] = deepcopy(policy)
        recommendation = deepcopy(context['inputs'])
        recommendation['filter_options'].update(run_date=signal, alpha_policy=deepcopy(
            inputs['l4_allocation_inputs']['alpha_policy']))
        for model in (entry, second):
            spec = dict(entry_checksum=model['checksum'], observed_at=clock[0],
                state_reference=put(registry.bucket, day + '/state', state),
                recommendation_inputs_reference=put(registry.bucket, day + '/inputs', recommendation),
                day_inputs_reference=put(registry.bucket, day + '/day', inputs))
            (tmp_path / (model['entry_id'] + '.json')).write_text(json.dumps(spec), encoding='utf-8')
        before = {model['entry_id']: read_cash(accounts.current(model['entry_id'])[0])
                  for model in (entry, second)}
        published = asyncio.run(producer.produce_directory(registry, tmp_path, session_date=day, now=now))
        assert published['status'] == 'published'
        index = read_reference(registry.bucket, published['source_index_reference'])
        prepared = produce_day(accounts, index, session_date=day, now=now)
        assert prepared['outer_acceptance_credit'] == 0
        assert produce_day(accounts, index, session_date=day, now=now) == prepared
        for model in (entry, second):
            assert read_cash(accounts.current(model['entry_id'])[0]) == before[model['entry_id']]
        untouched = accounts.current(second['entry_id'])[0]
        for model in (entry, second):
            key = model['entry_id']
            head, _ = accounts.current(key)
            observed = frame(day)
            action = dict(action_id=day + ':settlement', expected_state_checksum=head['checksum'],
                          serving_identity=model['serving_identity'], frames=[observed],
                          frame_inputs={observed['input_id']: observed}, variables={})
            receipt = accounts.advance(key, **action)
            assert accounts.advance(key, **action) == receipt
            assert read_cash(accounts.current(key)[0]) == {1: balance, 2: 12345}
            if key == entry['entry_id']:
                assert accounts.current(second['entry_id'])[0] == untouched


@pytest.mark.parametrize('changed_projection', [False, True])
def test_completed_observation_remerges_raw_bundle_without_dispatch(monkeypatch, changed_projection):
    from services import l4_native_observation as native
    _, state, _, day_inputs = example(monkeypatch)
    identity = day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact']['l3_identity']
    day = state['run_date']
    bucket = Bucket()
    def save(name, value):
        ref = put(bucket, name, value)
        # Existing native references have SHA but no required generation.
        return {k: ref[k] for k in ('path', 'sha256')}
    pinned = save('pinned-context', state['pipeline_modal_serving_context'])
    cutoff = save('training-cutoffs', {'source_references': []})
    request = save('request', dict(run_id='native-test', expected_source_sha='9' * 40,
                                   payloads=state['payloads'], sequence_input_contract={}))
    raw_bundle = save('raw-bundle', dict(execution_scope=native.SCOPE, merged=state['predictions']))
    roster = [{'symbol': s} for s in state['predictions']]
    classification = dict(accepted_evidence={s: {'cfi': 'ESVUFR'} for s in state['predictions']},
                          excluded_symbols=[])
    envelope = dict(request=request, roster=roster, classification=classification,
                    roster_proof={'source': 'unit-test'},
                    catalog_reference={'path': 'catalog', 'sha256': 'b' * 64},
                    risk_reference={'path': 'risk', 'sha256': 'c' * 64})
    projection = native.projection(state['predictions'], identity=identity, day=day, roster=roster,
                                   classification=classification, known_max='2026-10-01')
    if changed_projection:
        projection['features_checksum'] = '0' * 64
    original = dict(scope=native.SCOPE, projection=projection, request=request,
                    raw_bundle_reference=raw_bundle, classification=envelope['catalog_reference'],
                    risk_reference=envelope['risk_reference'], roster_checksum=digest(roster),
                    roster_proof=envelope['roster_proof'], training_cutoffs=cutoff)
    original_ref = save('original', original)
    snapshot = dict(projection, snapshot_id='l4-native:test', frozen_at='2026-10-19T20:00:00Z',
                    original_reference=original_ref, original_sha256=original_ref['sha256'],
                    verified_original_sha256=original_ref['sha256'])
    observation = dict(config=dict(l3_identity=identity, serving_context=pinned, training_cutoffs=cutoff),
                       projection=save('projection', snapshot), envelope=save('envelope', envelope))
    calls = []
    def checked_context(context, given_identity, cutoffs, given_day, records):
        assert given_identity == identity and given_day == day
        calls.append('context')
        return '2026-10-01'
    monkeypatch.setattr(native, 'validate_context', checked_context)
    async def merge(restored, *, research_only):
        assert research_only is True
        calls.append('merge')
        return {'predictions': deepcopy(restored['modal_prediction_bundle']['merged'])}
    def validate_bundle(restored, bundle):
        assert restored['modal_prediction_bundle'] is bundle
        calls.append('bundle')
    import graphs
    pipeline = SimpleNamespace(_validate_pipeline_modal_feature_bundle_before_writes=validate_bundle,
                               node_ml_predict=merge)
    monkeypatch.setitem(sys.modules, 'graphs.daily_pipeline_v2', pipeline)
    monkeypatch.setattr(graphs, 'daily_pipeline_v2', pipeline, raising=False)
    async def forbidden(*args, **kwargs):
        raise AssertionError('must not dispatch or capture new inference')
    monkeypatch.setattr(native, 'prepare', forbidden)
    monkeypatch.setattr(native, 'collect', forbidden)
    if changed_projection:
        with pytest.raises(ValueError, match='original_projection_changed'):
            asyncio.run(producer.collect_completed_prediction_state(
                bucket=bucket, observation=observation, identity=identity, day=day))
    else:
        merged = asyncio.run(producer.collect_completed_prediction_state(
            bucket=bucket, observation=observation, identity=identity, day=day))
        assert merged['predictions'] == state['predictions']
        assert 'feature_rows' not in merged
    assert calls == ['context', 'bundle', 'merge']
    assert bucket.writes == []


def archive():
    buffer = io.BytesIO()
    np.savez(buffer, x=np.ones((2, 2), dtype=np.float32))
    raw = buffer.getvalue()
    sha = hashlib.sha256(raw).hexdigest()
    ref = dict(path=weights.PREFIX + sha + '.npz', sha256=sha, bytes=len(raw))
    bundle = {'model': {'residual_tabpack': {'schema_version': weights.SCHEMA, 'weights': ref}}}
    objects = {ref['path']: {'reference': ref, 'base64': base64.b64encode(raw).decode()}}
    return raw, ref, bundle, objects


def test_legacy_reader_is_exact_scoped_and_restored_after_exception(monkeypatch):
    raw, ref, bundle, objects = archive()
    def no_remote(*args):
        raise AssertionError('live reader must not be reached')
    monkeypatch.setattr(weights, '_load', no_remote)
    monkeypatch.setenv('GCS_BUCKET_NAME', 'never-read')
    reader = frozen_legacy_loader({'legacy_weight_objects': objects}, bundle)
    with pytest.raises(RuntimeError, match='frame failed'):
        with weights.private_weight_reader(reader):
            assert np.array_equal(weights.load(ref)['x'], np.ones((2, 2), dtype=np.float32))
            with pytest.raises(ValueError, match='reference_changed'):
                reader({**ref, 'bytes': len(raw) + 1})
            raise RuntimeError('frame failed')
    with pytest.raises(AssertionError, match='live reader'):
        weights.load(ref)


@pytest.mark.parametrize('fault', ['missing', 'extra', 'reference', 'bytes'])
def test_legacy_reader_inventory_fails_closed(fault):
    _, ref, bundle, objects = archive()
    if fault == 'missing':
        objects = {}
    elif fault == 'extra':
        objects['other'] = {}
    elif fault == 'reference':
        objects[ref['path']]['reference'] = {**ref, 'bytes': ref['bytes'] + 1}
    else:
        objects[ref['path']]['base64'] = base64.b64encode(b'wrong').decode()
    with pytest.raises(ValueError):
        frozen_legacy_loader({'legacy_weight_objects': objects}, bundle)
