"""Bounded source/dispatch contracts; no real model forward or remote writes."""
import asyncio
from copy import deepcopy
from datetime import date, timedelta
import hashlib
import json
from types import SimpleNamespace

import pytest

import l4_shadow_job_main as job
from services import l4_native_observation as native
from services import l4_native_day_source as frozen
from services import l4_shadow_observation as observer
from services.l4_challenger_comparison import seal
from services.l4_challenger_registry import Registry
from services.l4_forward_materialization import digest
from services.l4_shadow_producer import read_reference
from services.l4_shadow_daily import configuration_checksum
from services.paired_nav_journal import digest as source_digest
from services.frozen_manifest_budget import canonical_manifest_bytes
from test_l4_challenger_registry import Bucket, Blob
from test_l4_shadow_input_export import DAY, NOW
from test_l4_shadow_native_producer import example, put
from test_l4_native_l2_dependency import context as model_context


class NativeBlob(Blob):
    time_created = NOW

    def exists(self):
        return self.key in self.bucket.objects

    def upload_from_string(self, raw, **kwargs):
        return super().upload_from_string(raw.encode() if isinstance(raw, str) else raw, **kwargs)


class NativeBucket(Bucket):
    def blob(self, key):
        return NativeBlob(self, key)


def reseal_source(value):
    packet = value['state']['payload_source_observations']
    packet['source_checksum'] = source_digest({k: v for k, v in packet.items() if k != 'source_checksum'})


def fixture(monkeypatch, tmp_path):
    from services.ensemble_v2 import ensemble_artifact_id
    from services.l4_distribution import digest as risk_digest
    from graphs import daily_pipeline_v2 as pipeline
    from services import payload_builder, active8_prep_lifecycle, kv_client
    from services import l4_native_dispatch

    entry, original, _, day_inputs = example(monkeypatch)
    bucket = NativeBucket()
    observed = NOW.isoformat()
    registry = Registry(bucket, formal_identity=lambda: first_identity,
                        clock=lambda: observed)
    calls = []
    specs = {}
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA', 'a' * 40)
    def forbidden(*args, **kwargs):
        raise AssertionError('no live/feature-prep/default dispatcher fallback')
    for module, name in ((payload_builder, 'load_market_env'), (payload_builder, 'capture_payload_sources'),
                         (active8_prep_lifecycle, 'ensure_active8_daily_prep'), (native, 'daily_roster'),
                         (kv_client, 'get'), (l4_native_dispatch, 'modal_spawn'),
                         (l4_native_dispatch, 'modal_poll')):
        monkeypatch.setattr(module, name, forbidden)
    async def request(state, *, state_gcs_uri, research_only):
        # Request serialization is stubbed; payload construction, source/cutoff
        # checks, native prepare/collect and durable dispatch are real.
        assert research_only and state_gcs_uri == ''
        calls.append(deepcopy(state))
        return dict(run_id=state['producer_run_id'], run_date=state['run_date'],
                    payloads=deepcopy(state['payloads']),
                    sequence_input_contract={'fixture': True},
                    expected_source_sha='a' * 40)
    monkeypatch.setattr(pipeline, '_build_pipeline_modal_prediction_payload', request)
    for i, name in enumerate(('old-chain', 'new-chain')):
        row, day = deepcopy(entry), deepcopy(day_inputs)
        parent = deepcopy(original['pipeline_modal_serving_context']['serving_manifest']['active8_ensemble'])
        parent.update(knowledge_cutoff_date='2026-10-01', source_manifest_checksum=str(i + 1) * 64)
        parent['fit']['intercept'] = i * .01
        parent['payload_checksum'] = digest({k: v for k, v in parent.items() if k != 'payload_checksum'})
        identity = dict(artifact_id=ensemble_artifact_id(parent), payload_checksum=parent['payload_checksum'],
                        cohort_id=parent['cohort_id'], base_artifact_set_checksum=parent['base_artifact_set_checksum'])
        c = model_context()
        c.update(schema_version='pipeline-modal-serving-context-v1')
        c['serving_manifest']['active8_ensemble'] = parent
        c['serving_manifest_digest'] = hashlib.sha256(canonical_manifest_bytes(c['serving_manifest'])).hexdigest()
        records = []
        for model in c['serving_manifest']['models']:
            metadata = dict(artifact_checksum=model['checksum'],
                deployment_fit=dict(performed=True, validation_models_are_not_served=True,
                                    label_known_date_max='2026-10-01'),
                model_training_config_attestation={'input_lineage': {
                    'source_manifest_checksum': parent['source_manifest_checksum']}})
            records.append(dict(model=model['model'], reference=put(bucket, name+'/'+model['model'], metadata)))
        cutoffs = dict(l3_identity=identity, base_artifact_set_checksum=identity['base_artifact_set_checksum'],
            source_references=records, label_known_max={k: '2026-10-01' for k in ['L3'] + parent['model_order']})
        config = dict(l3_identity=identity, serving_context=put(bucket, name+'/context', c),
                      training_cutoffs=put(bucket, name+'/cutoffs', cutoffs))
        policy = day['l4_allocation_inputs']['alpha_policy']['l4Distribution']
        policy['artifact']['l3_identity'] = identity
        policy['runtime']['l3_identity'] = identity
        day['trading_config']['l4Distribution'] = deepcopy(policy)
        row.update(entry_id=name)
        row['components']['L3'] = identity['payload_checksum']
        row['components']['allocator_policy'] = configuration_checksum(day['trading_config'], day['risk_config'])
        row['serving_identity']['l3_payload_checksum'] = identity['payload_checksum']
        row['training_receipts']['L3'] = seal({**{k: v for k, v in row['training_receipts']['L3'].items() if k != 'checksum'},
                                             'component_checksum': identity['payload_checksum']})
        row = seal({k: v for k, v in row.items() if k != 'checksum'})
        if i == 0:
            first_identity = row['serving_identity']
            registry.initialize(row)
        else:
            registry.register(row, expected_registry_checksum=registry.current()[0]['checksum'])
        signal = day['signal_date']
        roster = [dict(id=1, symbol='2330', market='TW')]
        dates = [(date.fromisoformat(signal) - timedelta(days=n)).isoformat() for n in range(30, -1, -1)]
        prices = [dict(date=d, close=100. + n, adj_close=100. + n, volume=1000)
                  for n, d in enumerate(dates)]
        feature = dict(status='ready', signal_date=signal, source_gcs_prefix='fixed/'+signal)
        packet = dict(schema_version='payload-source-observations-v1', decision_date=signal,
            knowledge_scope='observed_at_capture_not_historical_asof', started_at=observed, observed_at=observed,
            stocks=[dict(id=1, symbol='2330')],
            sources=dict(prices_by_id={'1': prices}, indicators_by_id={'1': []},
                chips_by_sym={'2330': []}, sentiment_by_id={'1': []}, real_acc_by_id={'1': {}},
                model_stats_by_id={'1': {}}, misc_by_id={'1': {}}, tag_rows=[]),
            single_capture_binding=dict(schema_version='daily-single-capture-binding-v1',
                                        feature_source_digest=source_digest(feature)))
        catalog = dict(schema_version='l4-official-observed-listing-v1', business_date=signal,
            observed_at=observed, rows=[dict(symbol='2330', cfi='ESVUFR', listing_date='2000-01-01',
                                            instrument_type='stock')])
        risk = dict(schema_version='l4-dated-risk-v1', signal_date=signal, returns={'2330': [.01] * 30})
        risk['checksum'] = risk_digest(risk)
        source = dict(schema_version=frozen.SCHEMA, signal_date=signal, observed_at=observed,
            source_receipt_shas=['b' * 64], roster=roster, roster_proof={'roster_checksum': digest(roster)},
            classification_reference=put(bucket, name+'/catalog', catalog),
            risk_reference=put(bucket, name+'/risk', risk),
            state=dict(market_env={}, adaptive_params={}, barrier_params={}, lifecycle_weights={},
                trading_config=deepcopy(day['trading_config']), payload_source_observations=packet,
                timexer_feature_source=feature))
        reseal_source(source)
        spec = dict(entry_checksum=row['checksum'], observed_at=observed,
            native_config_reference=put(bucket, name+'/config', config),
            day_inputs_reference=put(bucket, name+'/day', day),
            frozen_day_source_reference=put(bucket, name+'/source', source))
        (tmp_path/(name+'.json')).write_text(json.dumps(spec), encoding='utf-8')
        specs[name] = spec
    bucket.writes.clear()
    return registry, specs, calls


def run(registry, directory, *, spawn, poll, clock=lambda: NOW):
    return asyncio.run(observer.observe_directory(registry, directory, session_date=DAY, now=NOW,
                                                  spawn=spawn, poll=poll, clock=clock))


def test_two_chains_use_own_context_payload_policy_and_original_durable_resume(monkeypatch, tmp_path):
    registry, specs, built = fixture(monkeypatch, tmp_path)
    spawned = []
    async def spawn(request):
        spawned.append(request)
        return 'fc-' + str(len(spawned))
    async def poll(_):
        return {'status': 'running'}
    for _ in range(2):
        result = run(registry, tmp_path, spawn=spawn, poll=poll)
        assert result['status'] == 'pending' and result['next_operation'] == 'observation'
        assert result['daily_ready_published'] is False and result['outer_acceptance_credit'] == 0
    assert len(spawned) == 2
    assert len(built) == 2  # Completed preflight does not rebuild requests on resume.
    assert len({s['pipeline_modal_serving_context']['serving_manifest_digest'] for s in built}) == 2
    for state in built:
        identity = state['pipeline_modal_serving_context']['serving_manifest']['active8_ensemble']
        assert state['payloads'][0]['trading_config']['l4Distribution']['artifact']['l3_identity']['payload_checksum'] == identity['payload_checksum']
        assert state['payloads'][0]['prices'] == state['payload_source_observations']['sources']['prices_by_id']['1']
    assert not any('/shadow_inputs/' in p for p in registry.bucket.writes)
    # Changed day-source reference cannot reuse the first native request/index.
    spec = specs['old-chain']
    source = read_reference(registry.bucket, spec['frozen_day_source_reference'])
    source['source_receipt_shas'].append('c' * 64)
    spec['frozen_day_source_reference'] = put(registry.bucket, 'changed-source', source)
    (tmp_path/'old-chain.json').write_text(json.dumps(spec), encoding='utf-8')
    registry.bucket.writes.clear()
    result = run(registry, tmp_path, spawn=spawn, poll=poll)
    assert result['status'] == 'not_ready'
    assert result['entries']['old-chain'] == 'l4_native_frozen_resume_source_changed'
    assert len(spawned) == 2 and not registry.bucket.writes


@pytest.mark.parametrize('fault', [
    'missing_feature', 'binding', 'source_sha', 'future_price', 'known_at', 'identity',
    'policy', 'future_observed', 'source_day', 'risk_day', 'missing_source',
])
def test_one_invalid_entry_refuses_all_dispatch_and_writes(monkeypatch, tmp_path, fault):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    invalid_name = list(registry.current()[0]['entries'])[-1]
    spec = specs[invalid_name]
    source = read_reference(registry.bucket, spec['frozen_day_source_reference'])
    config = read_reference(registry.bucket, spec['native_config_reference'])
    if fault == 'source_sha':
        spec['frozen_day_source_reference']['sha256'] = '0' * 64
    elif fault == 'missing_source':
        spec.pop('frozen_day_source_reference')
    elif fault in ('identity', 'known_at'):
        if fault == 'identity':
            config['l3_identity']['payload_checksum'] = 'f' * 64
        else:
            cutoff = read_reference(registry.bucket, config['training_cutoffs'])
            cutoff['label_known_max']['L3'] = source['signal_date']
            config['training_cutoffs'] = put(registry.bucket, 'bad/cutoff', cutoff)
        spec['native_config_reference'] = put(registry.bucket, 'bad/config', config)
    else:
        if fault == 'missing_feature':
            source['state'].pop('timexer_feature_source')
        elif fault == 'binding':
            source['state']['payload_source_observations']['single_capture_binding']['feature_source_digest'] = 'f' * 64
        elif fault == 'future_price':
            source['state']['payload_source_observations']['sources']['prices_by_id']['1'][-1]['date'] = '2099-01-01'
        elif fault == 'policy':
            source['state']['trading_config']['changed'] = True
        elif fault == 'future_observed':
            source['observed_at'] = '2099-01-01T00:00:00Z'
        elif fault == 'source_day':
            source['signal_date'] = '2026-10-18'
        elif fault == 'risk_day':
            risk = read_reference(registry.bucket, source['risk_reference'])
            risk['signal_date'] = '2026-10-18'
            source['risk_reference'] = put(registry.bucket, 'bad/risk', risk)
        reseal_source(source)
        spec['frozen_day_source_reference'] = put(registry.bucket, 'bad/source', source)
    (tmp_path/(invalid_name+'.json')).write_text(json.dumps(spec), encoding='utf-8')
    registry.bucket.writes.clear()
    async def forbidden(*args):
        pytest.fail('no dispatch before every entry preflights')
    result = run(registry, tmp_path, spawn=forbidden, poll=forbidden)
    assert result['status'] == 'not_ready' and invalid_name in result['entries']
    assert not registry.bucket.writes


def test_completed_only_exposes_assembly_next_step_and_job_entry(monkeypatch, tmp_path):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    seen = []
    async def completed(**kwargs):
        seen.append(kwargs)
        return dict(status='captured', projection={'path': 'fixture-only'})
    monkeypatch.setattr(native, 'collect', completed)
    result = job.run(operation='observation', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path, clock=lambda: NOW)
    assert result['status'] == 'observations_complete' and result['next_operation'] == 'assemble'
    assert result['daily_ready_published'] is False and len(seen) == 2
    assert not registry.bucket.writes


def test_preflight_crosses_open_refuses_all_new_jobs_before_first_write(monkeypatch, tmp_path):
    registry, _, _ = fixture(monkeypatch, tmp_path)
    current = [NOW]
    original = frozen.prepare_day_source
    async def prepare(**kwargs):
        result = await original(**kwargs)
        current[0] = NOW + timedelta(hours=3)
        return result
    monkeypatch.setattr(frozen, 'prepare_day_source', prepare)
    async def forbidden(*args):
        pytest.fail('preflight crossed open; no job may spawn')
    result = run(registry, tmp_path, spawn=forbidden, poll=forbidden, clock=lambda: current[0])
    assert result['status'] == 'not_ready' and result['dispatched'] is False
    assert set(result['entries']) == {'old-chain', 'new-chain'}
    assert result['next_operation'] is None and result['existing_calls_pending'] is False
    assert result['reason'] == 'shadow_observation_session_dispatch_expired'
    assert not registry.bucket.writes


def test_first_entry_time_prevents_later_entry_from_spawning_after_open(monkeypatch, tmp_path):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    later_name = list(registry.current()[0]['entries'])[-1]
    current, spawned = [NOW], []
    async def spawn(value):
        spawned.append(value)
        return 'fc-first'
    async def poll(_):
        current[0] = NOW + timedelta(hours=3)
        return {'status': 'running'}
    result = run(registry, tmp_path, spawn=spawn, poll=poll, clock=lambda: current[0])
    assert result['status'] == 'not_ready' and len(spawned) == 1
    assert result['entries'][later_name]['reason'] == 'shadow_observation_initial_dispatch_not_preopen'
    config = read_reference(registry.bucket, specs[later_name]['native_config_reference'])
    source = read_reference(registry.bucket, specs[later_name]['frozen_day_source_reference'])
    key = digest(dict(day=source['signal_date'], identity=config['l3_identity'], policy=config))
    assert not any(key in path for path in registry.bucket.writes)


def test_mixed_late_retry_polls_existing_call_without_starting_missing_entry(monkeypatch, tmp_path):
    registry, _, _ = fixture(monkeypatch, tmp_path)
    current, spawned, polled = [NOW], [], []
    first_name, later_name = list(registry.current()[0]['entries'])
    async def spawn(value):
        spawned.append(value)
        return 'fc-existing'
    async def poll(call_id):
        polled.append(call_id)
        current[0] = NOW + timedelta(hours=3)
        return {'status': 'running'}
    assert run(registry, tmp_path, spawn=spawn, poll=poll,
               clock=lambda: current[0])['status'] == 'not_ready'
    assert len(spawned) == len(polled) == 1
    registry.bucket.writes.clear()
    result = asyncio.run(observer.observe_directory(registry, tmp_path, session_date=DAY,
        now=current[0], clock=lambda: current[0], spawn=spawn, poll=poll))
    assert result['status'] == 'not_ready' and len(spawned) == 1 and len(polled) == 2
    assert result['entries'][first_name]['status'] == 'pending'
    assert result['entries'][later_name]['reason'] == 'shadow_observation_initial_dispatch_not_preopen'
    assert result['dispatched'] is False and result['preopen_assembly_available'] is False
    assert result['next_operation'] == 'observation' and result['existing_calls_pending'] is True
    assert result['outer_acceptance_credit'] == 0
    assert not registry.bucket.writes
    # Once that existing call is collected, the permanently missed entry is a
    # terminal session failure, not an invitation to poll forever.
    collected = []
    async def completed(**kwargs):
        collected.append(kwargs)
        return dict(status='captured', projection={'path': 'bounded-completion-fixture'})
    monkeypatch.setattr(native, 'collect', completed)
    result = asyncio.run(observer.observe_directory(registry, tmp_path, session_date=DAY,
        now=current[0], clock=lambda: current[0], spawn=spawn, poll=poll))
    assert len(collected) == 1 and len(spawned) == 1
    assert result['entries'][first_name]['status'] == 'captured'
    assert result['status'] == 'not_ready' and result['next_operation'] is None
    assert result['reason'] == 'shadow_observation_session_dispatch_expired'
    assert result['existing_calls_pending'] is False and result['outer_acceptance_credit'] == 0
    assert not registry.bucket.writes


def test_request_only_resume_after_open_still_refuses_new_spawn(monkeypatch, tmp_path):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    for spec in specs.values():
        config = read_reference(registry.bucket, spec['native_config_reference'])
        context = read_reference(registry.bucket, config['serving_context'])
        source = read_reference(registry.bucket, spec['frozen_day_source_reference'])
        prepared = asyncio.run(frozen.prepare_day_source(bucket=registry.bucket, config=config,
            context=context, reference=spec['frozen_day_source_reference'],
            day=source['signal_date'], now=NOW))
        frozen.publish_prepared(registry.bucket, prepared=prepared)
    registry.bucket.writes.clear()
    async def forbidden(*args):
        pytest.fail('a saved request is not an existing Modal call')
    late = NOW + timedelta(hours=3)
    result = asyncio.run(observer.observe_directory(registry, tmp_path, session_date=DAY,
        now=late, clock=lambda: late, spawn=forbidden, poll=forbidden))
    assert result['status'] == 'not_ready' and result['dispatched'] is False
    assert not registry.bucket.writes


def test_actual_spawn_guard_retains_claim_if_claim_io_crosses_open(monkeypatch, tmp_path):
    registry, _, _ = fixture(monkeypatch, tmp_path)
    first_name = next(iter(registry.current()[0]['entries']))
    current, claims = [NOW], []
    class SlowClaimBlob(NativeBlob):
        def upload_from_string(self, raw, **kwargs):
            result = super().upload_from_string(raw, **kwargs)
            if '/dispatch/' in self.key and self.key.endswith('/claim.json'):
                current[0] = NOW + timedelta(hours=3)
                claims.append(self.key)
            return result
    monkeypatch.setattr(registry.bucket, 'blob', lambda key: SlowClaimBlob(registry.bucket, key))
    async def forbidden(*args):
        pytest.fail('actual spawn must recheck time after claim I/O')
    result = run(registry, tmp_path, spawn=forbidden, poll=forbidden, clock=lambda: current[0])
    assert result['status'] == 'not_ready' and len(claims) == 1
    assert claims[0] in registry.bucket.objects
    assert not any(path.endswith('/receipt.json') for path in registry.bucket.writes)
    # No silent claim deletion or retry: the existing lost-ack owner rejects.
    registry.bucket.writes.clear()
    result = run(registry, tmp_path, spawn=forbidden, poll=forbidden, clock=lambda: current[0])
    assert result['entries'][first_name] == 'l4_native_dispatch_acknowledgement_missing'
    assert not registry.bucket.writes


def test_late_completion_uses_actual_clock_and_does_not_claim_preopen(monkeypatch, tmp_path):
    registry, _, _ = fixture(monkeypatch, tmp_path)
    current, calls = [NOW], []
    async def completed(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            current[0] = NOW + timedelta(hours=3)
        return dict(status='captured', projection={'path': 'fixture-only'})
    monkeypatch.setattr(native, 'collect', completed)
    result = run(registry, tmp_path, spawn=None, poll=None, clock=lambda: current[0])
    assert result['status'] == 'observations_complete' and len(calls) == 2
    assert result['preopen_assembly_available'] is False and result['next_operation'] is None
    assert result['observed_at'] == current[0].isoformat()
    assert result['daily_ready_published'] is False and result['outer_acceptance_credit'] == 0


def test_registry_change_before_first_dispatch_is_rejected(monkeypatch, tmp_path):
    registry, _, _ = fixture(monkeypatch, tmp_path)
    old_current = registry.current
    old_prepare = frozen.prepare_day_source
    async def prepare(**kwargs):
        result = await old_prepare(**kwargs)
        if kwargs['config']['l3_identity']['payload_checksum'] != old_current()[0]['entries']['old-chain']['components']['L3']:
            monkeypatch.setattr(registry, 'current', lambda: ({'changed': True}, 99))
        return result
    monkeypatch.setattr(frozen, 'prepare_day_source', prepare)
    with pytest.raises(ValueError, match='registry_changed'):
        run(registry, tmp_path, spawn=None, poll=None)
    assert not registry.bucket.writes


def test_prepared_request_tampering_is_rejected_before_native_claim(monkeypatch, tmp_path):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    spec = specs['old-chain']
    config = read_reference(registry.bucket, spec['native_config_reference'])
    context = read_reference(registry.bucket, config['serving_context'])
    source = read_reference(registry.bucket, spec['frozen_day_source_reference'])
    prepared = asyncio.run(frozen.prepare_day_source(bucket=registry.bucket, config=config, context=context,
        reference=spec['frozen_day_source_reference'], day=source['signal_date'], now=NOW))
    prepared['request']['payloads'][0]['market'] = 'tampered'
    with pytest.raises(ValueError, match='preparation_changed'):
        asyncio.run(native.prepare(bucket=registry.bucket, config=config, day=source['signal_date'], context=context,
            key=prepared['key'], frozen_day_source_reference=spec['frozen_day_source_reference'],
            prepared_day_source=prepared))
    assert not registry.bucket.writes


@pytest.mark.parametrize('orphan', ['prepare', 'dispatch'])
def test_second_entry_recovery_claim_prevents_first_entry_dispatch(monkeypatch, tmp_path, orphan):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    invalid_name = list(registry.current()[0]['entries'])[-1]
    spec = specs[invalid_name]
    config = read_reference(registry.bucket, spec['native_config_reference'])
    source = read_reference(registry.bucket, spec['frozen_day_source_reference'])
    day = source['signal_date']
    key = digest(dict(day=day, identity=config['l3_identity'], policy=config))
    if orphan == 'prepare':
        put(registry.bucket, native.PREFIX + 'claims/' + key + '.json', {})
    else:
        context = read_reference(registry.bucket, config['serving_context'])
        prepared = asyncio.run(frozen.prepare_day_source(bucket=registry.bucket, config=config,
            context=context, reference=spec['frozen_day_source_reference'], day=day, now=NOW))
        frozen.publish_prepared(registry.bucket, prepared=prepared)
        put(registry.bucket, native.PREFIX + 'dispatch/' + key + '/claim.json', {})
    registry.bucket.writes.clear()
    async def forbidden(*args):
        pytest.fail('known orphan must fail before any spawn')
    result = run(registry, tmp_path, spawn=forbidden, poll=forbidden)
    assert result['status'] == 'not_ready'
    assert result['entries'][invalid_name] == ('l4_native_existing_dispatch_requires_recovery'
        if orphan == 'prepare' else 'l4_native_dispatch_acknowledgement_missing')
    assert not registry.bucket.writes


@pytest.mark.parametrize('created', [None, NOW + timedelta(days=1)])
def test_risk_server_clock_missing_or_late_refuses_all_entries(monkeypatch, tmp_path, created):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    risk_path = read_reference(registry.bucket, specs['new-chain']['frozen_day_source_reference'])['risk_reference']['path']
    old_blob = registry.bucket.blob
    def blob(key):
        value = old_blob(key)
        if key == risk_path:
            value.time_created = created
        return value
    monkeypatch.setattr(registry.bucket, 'blob', blob)
    async def forbidden(*args):
        pytest.fail('risk availability must be checked before dispatch')
    result = run(registry, tmp_path, spawn=forbidden, poll=forbidden)
    assert result['status'] == 'not_ready' and 'new-chain' in result['entries']
    assert not registry.bucket.writes


def test_resume_uses_original_sequence_capture_after_open_without_new_prepare(monkeypatch, tmp_path):
    from graphs import daily_pipeline_v2 as pipeline
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    # Exercise the real sequence capture owner, whose checksum includes wall
    # time. Rebuilding it would change the saved request and break the retry.
    for name, spec in specs.items():
        source = read_reference(registry.bucket, spec['frozen_day_source_reference'])
        source['state']['payload_source_observations']['single_capture_binding']['price_capture'] = {'capture_id': 'fixture'}
        reseal_source(source)
        spec['frozen_day_source_reference'] = put(registry.bucket, name + '/sequence-source', source)
        (tmp_path/(name+'.json')).write_text(json.dumps(spec), encoding='utf-8')
    sequence_calls = []
    async def sequence_request(state, **kwargs):
        series, metadata = pipeline._pipeline_sequence_inputs(state, state['payloads'])
        sequence_calls.append(metadata['frozen_source_checksum'])
        return dict(run_id=state['producer_run_id'], payloads=state['payloads'],
            sequence_series=series, sequence_dataset_meta=metadata,
            sequence_input_contract={'fixture': True}, expected_source_sha='a' * 40)
    monkeypatch.setattr(pipeline, '_build_pipeline_modal_prediction_payload', sequence_request)
    spawned = []
    async def spawn(value):
        spawned.append(value)
        return 'fc-' + str(len(spawned))
    async def poll(_):
        return {'status': 'running'}
    assert run(registry, tmp_path, spawn=spawn, poll=poll)['status'] == 'pending'
    saved = deepcopy(registry.bucket.objects)
    async def forbidden(**kwargs):
        pytest.fail('resume must not rebuild the clocked sequence request')
    monkeypatch.setattr(frozen, 'prepare_day_source', forbidden)
    late = NOW + timedelta(hours=3)
    result = asyncio.run(observer.observe_directory(registry, tmp_path,
        session_date=DAY, now=late, spawn=spawn, poll=poll, clock=lambda: late))
    assert result['status'] == 'pending' and result['preopen_assembly_available'] is False
    assert len(spawned) == len(sequence_calls) == 2 and registry.bucket.objects == saved


@pytest.mark.parametrize('same_source', [False, True])
def test_same_native_key_is_preflighted_before_first_dispatch(monkeypatch, tmp_path, same_source):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    # Registry permits multiple entries for one native L3 chain, e.g. distinct
    # calibration choices. Native key remains the original owner's digest.
    first = registry.current()[0]['entries']['old-chain']
    second = seal({**{k: v for k, v in first.items() if k != 'checksum'}, 'entry_id': 'second'})
    new = Registry(registry.bucket, formal_identity=lambda: first['serving_identity'],
                   clock=lambda: NOW.isoformat())
    # Use a fresh namespace fixture, not an in-place registry mutation.
    b = NativeBucket()
    b.objects = {k: deepcopy(v) for k, v in registry.bucket.objects.items()
                 if not k.startswith('l4_distribution/challenger_registry/')}
    new = Registry(b, formal_identity=lambda: first['serving_identity'], clock=lambda: NOW.isoformat())
    current = new.initialize(first)
    new.register(second, expected_registry_checksum=current['checksum'])
    spec = deepcopy(specs['old-chain'])
    spec['entry_checksum'] = second['checksum']
    if not same_source:
        source = read_reference(b, spec['frozen_day_source_reference'])
        spec['frozen_day_source_reference'] = put(b, 'same-key-other-source', source)
    directory = tmp_path/'shared'
    directory.mkdir()
    (directory/'old-chain.json').write_text(json.dumps(specs['old-chain']), encoding='utf-8')
    (directory/'second.json').write_text(json.dumps(spec), encoding='utf-8')
    b.writes.clear()
    spawned = []
    async def spawn(value):
        spawned.append(value)
        return 'fc-shared'
    async def poll(_):
        return {'status': 'running'}
    result = run(new, directory, spawn=spawn, poll=poll)
    if same_source:
        assert result['status'] == 'pending' and len(spawned) == 1
    else:
        assert result['status'] == 'not_ready'
        assert result['entries']['second'] == 'shadow_observation_native_key_source_conflict'
        assert not b.writes and not spawned


def capture_specs(registry, specs, directory):
    from services.pipeline_async_state_transport import (
        STATE_SCHEMA_V2, encode_pipeline_state_envelope, build_pipeline_payload_identity)
    for key, old in specs.items():
        spec = deepcopy(old)
        source = read_reference(registry.bucket, spec.pop('frozen_day_source_reference'))
        state = deepcopy(source['state'])
        state.update(run_date=source['signal_date'], producer_run_id='actual-capture-fixture',
                     payloads=[{'symbol': '2330'}])
        state['pipeline_payload_identity'] = build_pipeline_payload_identity(state['payloads'])
        envelope = dict(schema_version=STATE_SCHEMA_V2, run_date=state['run_date'],
                        created_at=NOW.isoformat(), state=state)
        raw = encode_pipeline_state_envelope(envelope)
        path = key + '/original.json.gz'
        registry.bucket.objects[path] = (1, raw)
        spec['captured_state_reference'] = dict(path=path, generation='1',
                                               sha256=hashlib.sha256(raw).hexdigest())
        spec['roster_reference'] = put(registry.bucket, key+'/original-roster',
            {k: source[k] for k in ('roster', 'roster_proof')})
        spec.update({k: source[k] for k in ('classification_reference', 'risk_reference')})
        (directory/(key+'.json')).write_text(json.dumps(spec), encoding='utf-8')
    registry.bucket.writes.clear()


def test_original_gzip_capture_packages_and_feeds_observation_without_live_reads(monkeypatch, tmp_path):
    from services import l4_shadow_source_capture as capture
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    capture_specs(registry, specs, tmp_path)
    captured = job.run(operation='capture-sources', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    assert captured['status'] == 'sources_captured'
    saved = deepcopy(registry.bucket.objects)
    assert job.run(operation='capture-sources', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path) == captured
    assert registry.bucket.objects == saved
    source_index = read_reference(registry.bucket, captured['source_index_reference'])
    assert set(source_index['entries']) == {'old-chain', 'new-chain'}
    for key, row in source_index['entries'].items():
        source = read_reference(registry.bucket, row['frozen_day_source_reference'])
        spec = json.loads((tmp_path/(key+'.json')).read_bytes())
        assert source['original_references']['captured_state'] == spec['captured_state_reference']
        assert source['original_created_at'] == NOW.isoformat()
        assert source['state']['trading_config'] == read_reference(registry.bucket, spec['day_inputs_reference'])['trading_config']
    spawned = []
    async def spawn(value):
        spawned.append(value)
        return 'fc-' + str(len(spawned))
    async def poll(_):
        return {'status': 'running'}
    result = asyncio.run(observer.observe_directory(registry, tmp_path, session_date=DAY, now=NOW,
        spawn=spawn, poll=poll, source_index_reference=captured['source_index_reference'], clock=lambda: NOW))
    assert result['status'] == 'pending' and len(spawned) == 2
    bad_specs = {key: json.loads((tmp_path/(key+'.json')).read_bytes()) for key in source_index['entries']}
    bad_specs['old-chain']['observed_at'] = '2026-10-01T00:00:00Z'
    with pytest.raises(ValueError, match='source_index_binding'):
        capture.apply_source_index(registry.bucket, captured['source_index_reference'],
            current=registry.current()[0], session_date=DAY, specs=bad_specs)


def test_missing_original_raw_capture_rejects_packaging_before_any_write(monkeypatch, tmp_path):
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    capture_specs(registry, specs, tmp_path)
    spec = json.loads((tmp_path/'new-chain.json').read_bytes())
    spec['captured_state_reference']['sha256'] = '0' * 64
    (tmp_path/'new-chain.json').write_text(json.dumps(spec), encoding='utf-8')
    result = job.run(operation='capture-sources', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=registry), native_input_directory=tmp_path)
    assert result['status'] == 'not_ready' and 'new-chain' in result['entries']
    assert not registry.bucket.writes


def test_new_source_server_clock_uses_actual_post_upload_observation(monkeypatch, tmp_path):
    from services import l4_shadow_source_capture as capture
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    capture_specs(registry, specs, tmp_path)
    clocks = {}
    class AdvancingBlob(NativeBlob):
        @property
        def time_created(self):
            return clocks.get(self.key, NOW)
        def upload_from_string(self, raw, **kwargs):
            result = super().upload_from_string(raw, **kwargs)
            clocks[self.key] = NOW + timedelta(seconds=1)
            return result
    monkeypatch.setattr(registry.bucket, 'blob', lambda key: AdvancingBlob(registry.bucket, key))
    result = capture.capture_directory(registry, tmp_path, session_date=DAY, now=NOW,
                                       clock=lambda: NOW + timedelta(seconds=2))
    assert result['status'] == 'sources_captured'
    index = read_reference(registry.bucket, result['source_index_reference'])
    assert {r['observed_at'] for r in index['entries'].values()} == {(NOW + timedelta(seconds=1)).isoformat()}
    assert all(r['observed_at'] != NOW.isoformat() for r in index['entries'].values())


def test_real_p6_raw_and_linear_bundle_variants_share_one_upstream_observation(monkeypatch, tmp_path):
    from services.l4_distribution import digest as model_digest
    from test_l4_p6_runtime import setup as p6_fixture
    registry, specs, _ = fixture(monkeypatch, tmp_path)
    capture_specs(registry, specs, tmp_path)
    original_spec = json.loads((tmp_path/'old-chain.json').read_bytes())
    day = read_reference(registry.bucket, original_spec['day_inputs_reference'])
    first = registry.current()[0]['entries']['old-chain']
    _, p6, _, _ = p6_fixture()
    b = NativeBucket()
    b.objects = {k: deepcopy(v) for k, v in registry.bucket.objects.items()
                 if not k.startswith('l4_distribution/challenger_registry/')}
    entries, variants = {}, {}
    for kind in ('raw', 'linear'):
        entry, inputs = deepcopy(first), deepcopy(day)
        bundle = deepcopy(p6['artifact'])
        bundle['l3_identity'] = inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact']['l3_identity']
        bundle['model']['calibration_kind'] = kind
        bundle['model_checksum'] = model_digest(bundle['model'])
        entry['entry_id'], entry['calibration'] = kind, kind
        entry['components']['L4'] = bundle['model_checksum']
        entry['serving_identity']['l4_model_checksum'] = bundle['model_checksum']
        entry['training_receipts']['L4'] = seal({**{k: v for k, v in entry['training_receipts']['L4'].items() if k != 'checksum'},
                                                'component_checksum': bundle['model_checksum']})
        entry = seal({k: v for k, v in entry.items() if k != 'checksum'})
        inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']['artifact'] = bundle
        inputs['trading_config']['l4Distribution']['artifact'] = deepcopy(bundle)
        entries[kind] = entry
        variants[kind] = {**original_spec, 'entry_checksum': entry['checksum'],
                          'day_inputs_reference': put(b, kind+'/allocation', inputs)}
    r = Registry(b, formal_identity=lambda: entries['raw']['serving_identity'], clock=lambda: NOW.isoformat())
    current = r.initialize(entries['raw'])
    r.register(entries['linear'], expected_registry_checksum=current['checksum'])
    directory = tmp_path/'p6-variants'
    directory.mkdir()
    for key, spec in variants.items():
        (directory/(key+'.json')).write_text(json.dumps(spec), encoding='utf-8')
    captured = job.run(operation='capture-sources', session_date=DAY, now=NOW,
        accounts=SimpleNamespace(registry=r), native_input_directory=directory)
    index = read_reference(b, captured['source_index_reference'])
    assert index['entries']['raw']['frozen_day_source_reference'] == index['entries']['linear']['frozen_day_source_reference']
    spawned = []
    async def spawn(value):
        spawned.append(value)
        return 'fc-native-shared'
    async def poll(_):
        return {'status': 'running'}
    result = asyncio.run(observer.observe_directory(r, directory, session_date=DAY, now=NOW,
        spawn=spawn, poll=poll, source_index_reference=captured['source_index_reference'], clock=lambda: NOW))
    assert result['status'] == 'pending' and len(spawned) == 1
    assert entries['raw']['components']['L4'] != entries['linear']['components']['L4']
    # Separate day inputs retain their actual downstream calibration unchanged.
    for kind, spec in variants.items():
        inputs = read_reference(b, spec['day_inputs_reference'])
        assert inputs['trading_config']['l4Distribution']['artifact']['model']['calibration_kind'] == kind


def test_default_prepare_retains_original_input_tuple_and_request_shape(monkeypatch, tmp_path):
    """The optional source parameter must not change the existing single chain."""
    from graphs import daily_pipeline_v2 as pipeline
    from services import payload_builder as builder
    from services import l4_instrument_classification as listing
    from services import l4_risk_history

    registry, specs, built = fixture(monkeypatch, tmp_path)
    spec = specs['old-chain']
    bucket = registry.bucket
    config = read_reference(bucket, spec['native_config_reference'])
    context = read_reference(bucket, config['serving_context'])
    source = read_reference(bucket, spec['frozen_day_source_reference'])
    state = source['state']
    catalog = read_reference(bucket, source['classification_reference'])
    day = source['signal_date']
    key = digest(dict(day=day, identity=config['l3_identity'], policy=config))
    seen = []
    monkeypatch.setattr(native, 'daily_roster', lambda when: (
        deepcopy(source['roster']), deepcopy(source['roster_proof'])))
    monkeypatch.setattr(listing, 'capture', lambda b, when: (
        deepcopy(catalog), source['classification_reference']))
    monkeypatch.setattr(builder, 'capture_payload_sources',
                        lambda roster, when: deepcopy(state['payload_source_observations']))
    monkeypatch.setattr(builder, 'load_market_env', lambda when: (
        builder.MarketEnv(**state['market_env']), deepcopy(state['adaptive_params']),
        deepcopy(state['barrier_params']), deepcopy(state['lifecycle_weights']),
        deepcopy(state['trading_config'])))
    async def original_node(inputs):
        seen.append(deepcopy(inputs))
        payloads = builder.build_payloads(active_stocks=inputs['active_stocks'],
            market_env=builder.MarketEnv(**inputs['market_env']),
            adaptive_params=inputs['adaptive_params'], barrier_params=inputs['barrier_params'],
            lifecycle_weights=inputs['lifecycle_weights'], trading_config=inputs['trading_config'],
            decision_date=day, frozen_sources=inputs['payload_source_observations'])
        return dict(payloads=[dict(vars(p)) for p in payloads],
                    timexer_feature_source=state['timexer_feature_source'])
    monkeypatch.setattr(pipeline, 'node_build_payloads', original_node)
    monkeypatch.setattr(l4_risk_history, 'load_canonical_risk_payloads', lambda **kw: kw['payloads'])
    # The request stub needs this original field for original risk capture.
    original_request = pipeline._build_pipeline_modal_prediction_payload
    async def request(*args, **kwargs):
        result = await original_request(*args, **kwargs)
        return {**result, 'timexer_feature_source': state['timexer_feature_source']}
    monkeypatch.setattr(pipeline, '_build_pipeline_modal_prediction_payload', request)
    reference = asyncio.run(native.prepare(bucket=bucket, config=config, day=day, context=context, key=key))
    actual = seen[0]
    assert actual['run_date'] == day and actual['producer_run_id'] == 'l4-native:' + key
    assert actual['active_stocks'] == source['roster']
    assert {k: actual[k] for k in ('adaptive_params', 'barrier_params', 'lifecycle_weights',
                                  'trading_config', 'payload_source_observations')} == {
        k: state[k] for k in ('adaptive_params', 'barrier_params', 'lifecycle_weights',
                             'trading_config', 'payload_source_observations')}
    assert actual['market_env'] == vars(builder.MarketEnv(**state['market_env']))
    assert actual['pipeline_modal_serving_context'] == {**context, 'expected_source_sha': 'a' * 40}
    envelope = native.read_reference(bucket, reference)
    assert set(envelope) == {'request', 'roster', 'roster_proof', 'classification',
                             'catalog_reference', 'risk_reference'}
    request_body = native.read_reference(bucket, envelope['request'])
    assert request_body['execution_scope'] == native.SCOPE and request_body['max_symbols'] == 5000
    assert 'frozen_day_source_reference' not in envelope
    assert request_body['payloads'] == built[0]['payloads']
