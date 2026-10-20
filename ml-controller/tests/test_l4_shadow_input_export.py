from copy import deepcopy
from datetime import datetime
import json
from types import SimpleNamespace

import pytest

import l4_shadow_job_main as job
from services.l4_challenger_comparison import digest, seal
from services.l4_challenger_registry import Registry
from services.l4_shadow_daily import configuration_checksum
from services.l4_shadow_input_export import publish_day, source_from_packet
from services.l4_shadow_producer import DAILY_PREFIX, build_daily_packet, read_reference
from services.paired_native_session import STRATEGY_SESSION_POLICY
from test_l4_challenger_registry import Bucket, entry
from test_l4_distribution_runtime import fixture

DAY = '2026-10-20'
NOW = datetime.fromisoformat(DAY + 'T06:01:00+08:00')


def native_source(name, letter):
    rows, policy, history = fixture()
    identity = deepcopy(policy['runtime']['l3_identity'])
    identity['payload_checksum'] = letter * 64
    policy['artifact']['l3_identity'] = identity
    policy['runtime'].update(signal_date='2026-10-19', l3_identity=identity)
    policy['runtime']['account']['signal_date'] = '2026-10-19'
    for prediction in policy['runtime']['predictions'].values():
        prediction['ensemble_v2']['artifact_checksum'] = identity['payload_checksum']
    packet = {
        'signal_date': '2026-10-19', 'session_date': DAY,
        'next_open': DAY + 'T09:00:00+08:00', 'source_receipt_shas': ['3' * 64],
        'recommendations': rows,
        'l4_allocation_inputs': {'recommendations': rows, 'return_history': history,
                                 'alpha_policy': {'l4Distribution': policy}},
        'trading_config': {'l4Distribution': policy}, 'risk_config': {'system': {}},
        'seed_rows': [],
        'execution_context': {
            'session_policy': STRATEGY_SESSION_POLICY, 'variables': {}, 'source_tables': {},
            'capture_kv_reads': True, 'kv_read_policy': {},
        },
    }
    model = entry(name, letter=letter)
    model['components'].update(
        L4=policy['artifact']['model_checksum'],
        allocator_policy=configuration_checksum(packet['trading_config'], packet['risk_config']),
        execution_context=digest(packet['execution_context']))
    model['serving_identity']['l4_model_checksum'] = model['components']['L4']
    model['training_receipts'] = {
        key: seal({**{k: v for k, v in receipt.items() if k != 'checksum'},
                   'component_checksum': model['components'][key]})
        for key, receipt in model['training_receipts'].items()
    }
    model = seal({key: value for key, value in model.items() if key != 'checksum'})
    packet['serving_identity'] = model['serving_identity']
    packet = seal(packet)
    source = source_from_packet(packet, model, observed_at=DAY + 'T06:00:00+08:00', now=NOW)
    return model, source


def setup():
    bucket = Bucket()
    old, old_source = native_source('old-chain', 'a')
    new, new_source = native_source('new-chain', 'c')
    registry = Registry(bucket, formal_identity=lambda: old['serving_identity'],
                        clock=lambda: NOW.isoformat())
    current = registry.initialize(old)
    registry.register(new, expected_registry_checksum=current['checksum'])
    bucket.writes.clear()
    return bucket, registry, {'old-chain': old_source, 'new-chain': new_source}


def reseal(value):
    return seal({key: value for key, value in value.items() if key != 'checksum'})


def test_full_inventory_is_immutable_and_index_is_published_last():
    bucket, registry, sources = setup()
    result = publish_day(registry, sources, session_date=DAY, now=NOW)
    assert result['status'] == 'published' and result['outer_acceptance_credit'] == 0
    assert bucket.writes[-1] == DAILY_PREFIX + DAY + '/index.json'
    assert len(bucket.writes) == 3
    index = read_reference(bucket, result['source_index_reference'])
    for key, ref in index['sources'].items():
        assert read_reference(bucket, ref) == sources[key]
        saved = build_daily_packet(sources[key], registry.current()[0]['entries'][key],
                                   session_date=DAY, now=NOW)
        assert saved['serving_identity'] == sources[key]['serving_identity']
    writes = list(bucket.writes)
    assert publish_day(registry, sources, session_date=DAY, now=NOW) == result
    assert bucket.writes == writes


def test_empty_registry_cannot_publish_an_empty_ready_index():
    bucket = Bucket()
    registry = SimpleNamespace(bucket=bucket, current=lambda: ({'entries': {}}, 1))
    with pytest.raises(ValueError, match='inventory_invalid'):
        publish_day(registry, {}, session_date=DAY, now=NOW)
    assert bucket.writes == []


@pytest.mark.parametrize('change', ['missing_entry', 'unknown_entry', 'identity',
                                   'actual_prediction', 'execution_policy', 'future_source'])
def test_invalid_sources_write_nothing(change):
    bucket, registry, sources = setup()
    if change == 'missing_entry':
        sources.pop('new-chain')
    elif change == 'unknown_entry':
        sources['unregistered'] = sources['new-chain']
    else:
        old = deepcopy(sources['old-chain'])
        policy = old['l4_allocation_inputs']['alpha_policy']['l4Distribution']
        if change == 'identity':
            # A new-chain packet with an old entry name is not an old-chain run.
            old['serving_identity'] = sources['new-chain']['serving_identity']
        elif change == 'actual_prediction':
            policy['runtime']['predictions']['A']['ensemble_v2']['artifact_checksum'] = 'c' * 64
            old['trading_config']['l4Distribution'] = policy
        elif change == 'execution_policy':
            old['risk_config']['system']['another_policy'] = True
        else:
            old['observed_at'] = DAY + 'T06:02:00+08:00'
        sources['old-chain'] = reseal(old)
    with pytest.raises(ValueError):
        publish_day(registry, sources, session_date=DAY, now=NOW)
    assert bucket.writes == []


def test_changed_registry_before_index_has_no_ready_index(monkeypatch):
    bucket, registry, sources = setup()
    current = registry.current
    calls = []

    def changing():
        value, generation = current()
        calls.append(True)
        if len(calls) > 1:
            value = {**value, 'checksum': 'f' * 64}
        return value, generation

    monkeypatch.setattr(registry, 'current', changing)
    with pytest.raises(ValueError, match='registry_changed'):
        publish_day(registry, sources, session_date=DAY, now=NOW)
    assert DAILY_PREFIX + DAY + '/index.json' not in bucket.objects
    assert len(bucket.writes) == 2


def test_partial_source_failure_does_not_publish_index_and_retry_is_idempotent(monkeypatch):
    bucket, registry, sources = setup()
    original = bucket.blob
    seen = []

    def transient(path):
        if '/sources/' in path and path not in seen:
            seen.append(path)
            if len(seen) == 2:
                raise RuntimeError('source upload interrupted')
        return original(path)

    monkeypatch.setattr(bucket, 'blob', transient)
    with pytest.raises(RuntimeError, match='interrupted'):
        publish_day(registry, sources, session_date=DAY, now=NOW)
    assert DAILY_PREFIX + DAY + '/index.json' not in bucket.objects
    monkeypatch.setattr(bucket, 'blob', original)
    result = publish_day(registry, sources, session_date=DAY, now=NOW)
    assert result['status'] == 'published' and len(bucket.writes) == 3


def test_source_changed_after_daily_index_does_not_overwrite_it():
    bucket, registry, sources = setup()
    first = publish_day(registry, sources, session_date=DAY, now=NOW)
    index_raw = bucket.objects[first['source_index_reference']['path']]
    changed = deepcopy(sources)
    changed['new-chain']['source_receipt_shas'].append('4' * 64)
    changed['new-chain'] = reseal(changed['new-chain'])
    with pytest.raises(ValueError, match='source_bytes_changed'):
        publish_day(registry, changed, session_date=DAY, now=NOW)
    assert bucket.objects[first['source_index_reference']['path']] == index_raw


def test_job_publishes_exact_native_source_files_without_preparing_accounts(tmp_path):
    bucket, registry, sources = setup()
    for key, source in sources.items():
        (tmp_path / (key + '.json')).write_text(json.dumps(source), encoding='utf-8')
    result = job.run(operation='export', session_date=DAY, now=NOW,
                     accounts=SimpleNamespace(registry=registry),
                     native_source_directory=tmp_path)
    assert result['status'] == 'published'
    assert all(path.startswith(DAILY_PREFIX) for path in bucket.writes)


def test_job_missing_local_input_directory_writes_nothing():
    bucket, registry, _ = setup()
    with pytest.raises(ValueError, match='source_directory_missing'):
        job.run(operation='export', session_date=DAY, now=NOW,
                accounts=SimpleNamespace(registry=registry),
                native_source_directory='does-not-exist')
    assert bucket.writes == []
