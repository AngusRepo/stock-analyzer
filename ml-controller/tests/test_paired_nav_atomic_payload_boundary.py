"""Actual payload builder evidence: a frozen per-symbol union is NOT a slate.

These prices are software fixtures, not investment returns or promotion proof.
All data readers are replaced locally; the real feature builder is executed.
"""
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
import asyncio
import json
from types import SimpleNamespace

import pytest

from services import payload_builder as builder


def _frozen_loaders(monkeypatch):
    stocks = [{'id': i + 1, 'symbol': str(1000 + i), 'market': 'LISTED',
               'market_segment': 'LISTED', 'eligible_for_pending_buy': 1}
              for i in range(3)]
    prices = {i + 1: [{'date': f'2026-09-{d:02d}', 'close': final if d == 6 else 100,
                      'volume': 2_000_000} for d in range(1, 7)]
              for i, final in enumerate([110, 90, 130])}

    def load_prices(ids, *, as_of_date):
        assert as_of_date == '2026-09-06'
        return {sid: deepcopy(prices[sid]) for sid in ids}

    def tags(sql, params):
        assert 'finlab_taxonomy_tags' in sql
        assert params == ['2026-09-06']
        return [{'symbol': row['symbol'], 'tag': 'Semiconductor'} for row in stocks]

    monkeypatch.setattr(builder, '_bulk_load_prices', load_prices)
    for name in ('_bulk_load_indicators', '_bulk_load_chips', '_bulk_load_sentiment', '_bulk_load_per_stock_misc'):
        monkeypatch.setattr(builder, name, lambda *args, **kwargs: {})
    monkeypatch.setattr(builder, '_bulk_load_accuracies', lambda ids: ({}, {}))
    monkeypatch.setattr(builder.MARKET_D1_CLIENT, 'query', tags)
    return stocks


def _build(stocks):
    return [asdict(row) for row in builder.build_payloads(stocks, builder.MarketEnv(), {}, {}, {}, '2026-09-06')]


def test_actual_builder_same_stock_needs_own_slate_peer_features(monkeypatch):
    stocks = _frozen_loaders(monkeypatch)
    formal = _build(stocks[:2])[0]
    candidate = _build([stocks[0], stocks[2]])[0]
    union = _build(stocks)[0]
    assert formal['prices'] == candidate['prices'] == union['prices']
    # A=+10%, B=-10%, C=+30% in this deterministic fixture.
    assert [row['stock_meta']['sector_peer_return_1d'] for row in (formal, candidate, union)] == [0, .2, .1]
    assert [row['stock_meta']['sector_peer_return_5d'] for row in (formal, candidate, union)] == [0, .2, .1]
    assert [row['stock_meta']['stock_vs_sector'] for row in (formal, candidate, union)] == [.1, -.1, 0]
    assert formal != candidate != union


def test_actual_builder_same_symbols_different_pending_eligibility_cannot_share_payload(monkeypatch):
    stocks = _frozen_loaders(monkeypatch)
    formal = _build(stocks[:2])
    changed = deepcopy(stocks[:2])
    changed[0]['eligible_for_pending_buy'] = 0
    candidate = _build(changed)
    assert formal[0]['stock_meta']['eligible_for_pending_buy'] is True
    assert candidate[0]['stock_meta']['eligible_for_pending_buy'] is False
    assert formal[0]['prices'] == candidate[0]['prices']
    assert formal[1] == candidate[1]
    assert formal != candidate


def test_actual_builder_to_service_slate_consumer_preserves_each_candidates_features(monkeypatch):
    # Import the real compute-only ML service consumer, not a Controller copy.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'ml-service'))
    from app.paired_nav_atomic_inference import run_atomic_slates
    from app.paired_nav_inference import checksum
    from services.state_space_series import build_state_space_series_from_payloads
    stocks = _frozen_loaders(monkeypatch)
    formal = _build(stocks[:2])
    changed = deepcopy(stocks[:2])
    changed[0]['eligible_for_pending_buy'] = 0
    alternatives = [_build([stocks[0], stocks[2]]), _build(changed)]
    slates = {}
    def add(payloads):
        inputs = {'symbols': [row['symbol'] for row in payloads], 'payloads': deepcopy(payloads),
                  'sequence_series': build_state_space_series_from_payloads(payloads)}
        key = checksum(inputs)
        slates[key] = inputs
        return key
    baseline_key = add(formal)
    candidate_keys = [add(rows) for rows in alternatives]
    packet = {'schema_version': 'paired-nav-atomic-slates-v2', 'signal_date': '2026-09-06',
              'source_checksum': checksum('local_frozen_source'), 'slates': slates,
              'contrasts': [{'definition_checksum': checksum(i), 'baseline_key': baseline_key, 'candidate_key': key}
                            for i, key in enumerate(candidate_keys)]}
    serving_digest = checksum('local_frozen_models')
    contract = {'schema_version': 'pipeline-modal-sequence-input-contract-v2', 'serving_manifest_digest': serving_digest,
                'by_model': {}, 'shadow_by_model': {},
                'sequence_point_counts': {row['symbol']: 6 for row in formal}}
    parent = {'run_date': '2026-09-06', 'run_id': 'local_builder_consumer', 'state_gcs_uri': 'gs://never-read/local',
              'payloads': formal, 'sequence_series': build_state_space_series_from_payloads(formal),
              'serving_manifest_digest': serving_digest, 'slot_artifact_identities': {}, 'active_artifact_identities': {},
              'active8_shadow_artifact_identities': {}, 'serving_coverage': {}, 'expected_source_sha': 'a' * 40,
              'sequence_model_contracts': {}, 'active8_shadow_sequence_contracts': {},
              'sequence_model_series_by_model': {}, 'active8_shadow_sequence_series_by_model': {},
              'sequence_input_contract': {**contract, 'digest': checksum(contract)},
              'paired_nav_atomic_slates': {**packet, 'packet_checksum': checksum(packet)}}
    before, calls = deepcopy(parent), []
    def model_primitive(child):
        # Echo actual received features; no trained model/return claim.
        return {'schema_version': 'pipeline-modal-prediction-bundle-v1',
            **{key: deepcopy(child[key]) for key in ('run_date', 'run_id', 'state_gcs_uri', 'serving_manifest_digest',
                'slot_artifact_identities', 'active_artifact_identities', 'active8_shadow_artifact_identities',
                'serving_coverage', 'sequence_input_contract')},
            'n_input': len(child['payloads']), 'modal_source_sha': child['expected_source_sha'],
            'predict_batch_v2_results': [{'symbol': row['symbol'], 'received_meta': deepcopy(row['stock_meta'])}
                                         for row in child['payloads']]}
    def compute(child):
        calls.append(deepcopy(child))
        return model_primitive(child)
    result = run_atomic_slates(parent, compute=compute, formal_bundle=model_primitive(parent))
    assert result['status'] == 'complete'
    assert len(calls) == 2
    observed = [result['slates'][key]['result']['predict_batch_v2_results'][0]['received_meta']
                for key in [baseline_key, *candidate_keys]]
    assert [row['sector_peer_return_1d'] for row in observed] == [0, .2, 0]
    assert [row['stock_vs_sector'] for row in observed] == [.1, -.1, .1]
    assert [row['eligible_for_pending_buy'] for row in observed] == [True, True, False]
    assert all(result['slates'][key]['reused_formal'] is False for key in candidate_keys)
    assert parent == before
    assert result['nav_maturity_credit'] == 0 and result['promotion_allowed'] is False


def _from_sources(stocks, packet):
    return [asdict(row) for row in builder.build_payloads(stocks, builder.MarketEnv(), {}, {}, {},
                                                         '2026-09-06', frozen_sources=packet)]


def test_capture_once_replays_own_slate_features_without_new_reads_or_source_mutation(monkeypatch):
    stocks = _frozen_loaders(monkeypatch)
    calls = []
    for name in ('_bulk_load_prices', '_bulk_load_indicators', '_bulk_load_chips', '_bulk_load_sentiment',
                 '_bulk_load_accuracies', '_bulk_load_per_stock_misc'):
        original = getattr(builder, name)
        def record(*args, _original=original, _name=name, **kwargs):
            calls.append(_name)
            return _original(*args, **kwargs)
        monkeypatch.setattr(builder, name, record)
    packet = builder.capture_payload_sources(stocks, '2026-09-06')
    before = deepcopy(packet)
    assert len(calls) == len(set(calls)) == 6
    def forbidden(*args, **kwargs):
        pytest.fail('replay cannot query newer raw data')
    for name in set(calls):
        monkeypatch.setattr(builder, name, forbidden)
    monkeypatch.setattr(builder.MARKET_D1_CLIENT, 'query', forbidden)
    restored = json.loads(json.dumps(packet))
    formal = _from_sources(stocks[:2], restored)
    candidate = _from_sources([stocks[0], stocks[2]], restored)
    assert formal[0]['stock_meta']['sector_peer_return_1d'] == 0
    assert candidate[0]['stock_meta']['sector_peer_return_1d'] == .2
    assert formal[0]['prices'] == candidate[0]['prices']
    formal[0]['prices'][0]['close'] = 999
    assert candidate[0]['prices'][0]['close'] == 100
    assert _from_sources(stocks[:2], restored)[0]['prices'][0]['close'] == 100
    assert packet == restored == before
    assert packet['knowledge_scope'] == 'observed_at_capture_not_historical_asof'
    assert 'prospective' not in packet, 'capturing current accuracy cannot backdate historical evidence'


@pytest.mark.parametrize('fault', ['checksum', 'date', 'missing-field', 'missing-stock-value',
                                  'future-price', 'future-chip', 'identity', 'observation-order'])
def test_corrupt_or_incomplete_frozen_source_never_falls_back_to_live_or_zero(monkeypatch, fault):
    from services.paired_nav_journal import digest
    stocks = _frozen_loaders(monkeypatch)
    packet = builder.capture_payload_sources(stocks, '2026-09-06')
    if fault == 'date': packet['decision_date'] = '2026-09-05'
    if fault == 'missing-field': del packet['sources']['prices_by_id']
    if fault == 'missing-stock-value': del packet['sources']['prices_by_id']['1']
    if fault == 'future-price': packet['sources']['prices_by_id']['1'][0]['date'] = '2026-09-07'
    if fault == 'future-chip': packet['sources']['chips_by_sym']['1000'] = [{'date': '2026-09-07'}]
    if fault == 'identity': packet['stocks'][0]['id'] = 99
    if fault == 'observation-order': packet['started_at'] = '2100-01-01T00:00:00Z'
    packet['source_checksum'] = digest({key: value for key, value in packet.items() if key != 'source_checksum'})
    if fault == 'checksum': packet['source_checksum'] = '0' * 64
    monkeypatch.setattr(builder, 'capture_payload_sources', lambda *args: pytest.fail('live fallback'))
    with pytest.raises(ValueError, match='payload_source_'):
        _from_sources(stocks[:2], packet)


def test_actual_daily_node_and_compressed_state_roundtrip_reuse_observed_sources(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from google.cloud import storage
    stocks = _frozen_loaders(monkeypatch)
    state = {'run_date': '2026-09-06', 'producer_run_id': 'local-frozen-source',
             'active_stocks': stocks[:2], 'market_env': {}}
    update = asyncio.run(graph.node_build_payloads(state))
    state.update(update)
    before = deepcopy(state)
    blobs = {}
    class Blob:
        def __init__(self, name):
            self.name = name
        def upload_from_string(self, raw, *, content_type):
            assert content_type == 'application/gzip'
            blobs[self.name] = raw
        def download_as_bytes(self):
            return blobs[self.name]
    monkeypatch.setenv('GCS_BUCKET_NAME', 'local-only-in-memory')
    monkeypatch.setattr(storage, 'Client', lambda: SimpleNamespace(bucket=lambda name: SimpleNamespace(blob=Blob)))
    uri = graph._write_pipeline_async_state_artifact(state)
    restored = graph._read_pipeline_async_state_artifact(uri)
    assert restored['payload_source_observations'] == before['payload_source_observations']
    monkeypatch.setattr(builder, 'capture_payload_sources', lambda *args: pytest.fail('retry queried a new snapshot'))
    repeated = asyncio.run(graph.node_build_payloads(restored))
    assert repeated == update
    assert state == before
    with pytest.raises(ValueError, match='payload_source_slate_not_covered'):
        _from_sources(stocks, restored['payload_source_observations'])
