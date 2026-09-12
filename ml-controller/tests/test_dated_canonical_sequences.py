"""Local source/transport fixtures, not trained forecasts or investment returns."""
import io
import asyncio
import json
import sqlite3
import sys
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest

from services import state_space_series as series
from services import payload_builder


class Blob:
    def __init__(self): self.raw = None
    def exists(self): return self.raw is not None
    def upload_from_string(self, raw, **kwargs): self.raw = raw.encode() if isinstance(raw, str) else bytes(raw)
    def download_as_bytes(self):
        if self.raw is None: raise FileNotFoundError('isolated fixture object missing')
        return self.raw


class Bucket:
    def __init__(self): self.blobs = {}
    def blob(self, path): return self.blobs.setdefault(path, Blob())


def _prep(monkeypatch, closes=None, *, end=7):
    from google.cloud import storage
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'ml-service'))
    from app.long_history_sequence_prep import build_finlab_long_history_sequence_prep
    bucket = Bucket()
    days = [f'2026-09-{d:02}' for d in range(1, end + 1)]
    prices = closes if closes is not None else [88 + 2*d for d in range(1, end + 1)]
    frame = pl.DataFrame({'date': days, '2330': prices})
    for field in ('adj_close', 'adj_open'):
        buf = io.BytesIO()
        frame.write_parquet(buf)
        bucket.blob(f'source/raw/daily_price/{field}.parquet').raw = buf.getvalue()
    # Actual producer reads Parquet, constructs aligned records and emits NPZ
    # plus checksummed manifest. All writes are in-memory, not GCS/retraining.
    result = build_finlab_long_history_sequence_prep({'source_gcs_prefix': 'gs://fixture/source',
        'output_gcs_prefix': 'frozen', 'min_len': 1, 'batch_size': 2}, bucket=bucket)
    assert result['status'] == 'ok'
    monkeypatch.setenv('GCS_BUCKET_NAME', 'fixture')
    monkeypatch.setenv('STOCKVISION_LONG_HISTORY_SEQUENCE_ENABLED', '1')
    monkeypatch.setenv('STOCKVISION_SEQUENCE_LONG_GCS_PREFIX', 'frozen')
    monkeypatch.setattr(storage, 'Client', lambda: SimpleNamespace(bucket=lambda name: bucket))
    return bucket


@pytest.fixture
def canonical(monkeypatch):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE canonical_market_daily(stock_id TEXT,date TEXT,adj_close REAL,as_of_date TEXT,source TEXT)')
    db.executemany('INSERT INTO canonical_market_daily VALUES(?,?,?,?,?)', [
        ('2330', '2026-09-05', 98, '2026-09-05', 'finlab.price'),
        ('2330', '2026-09-06', 100, '2026-09-06', 'finlab.price'),
        ('2330', '2026-09-07', 102, '2026-09-07', 'finlab.price'),
        ('2330', '2026-09-04', 96, '2026-09-07', 'finlab.price'),
        ('2330', '2026-09-03', 999, '2026-09-03', 'other.provider')])
    calls = []
    def query(sql, params, **kwargs):
        calls.append(params)
        assert 'FROM canonical_market_daily' in sql and 'stock_prices' not in sql
        return [dict(row) for row in db.execute(sql, params)]
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', query)
    yield db, calls
    db.close()


def _payload():
    # The legacy adj_close was also raw-filled; neither column is authoritative
    # for the adjusted sequence. Real canonical rows above are 98 and 100.
    return [{'symbol': '2330', 'stock_id': 1, 'prices': [
        {'date': '2026-09-05', 'close': 200, 'adj_close': 200},
        {'date': '2026-09-06', 'close': 202, 'adj_close': 202}]}]


def _run(payloads=None, target=6):
    payloads = _payload() if payloads is None else payloads
    return series.enrich_state_space_series_with_long_history(series.build_state_space_series_from_payloads(payloads),
        payloads=payloads, decision_date='2026-09-06', target_points=target)


def test_actual_prep_to_sql_reader_aligns_adjusted_dates_and_never_uses_future_raw_fill(monkeypatch, canonical):
    _prep(monkeypatch)
    payload = _payload()
    before = deepcopy(payload)
    out, meta = _run(payload)
    assert out[0]['prices'] == [90, 92, 94, 96, 98, 100]
    assert out[0]['dates'] == [f'2026-09-{d:02}' for d in range(1, 7)]
    assert out[0]['status'] == 'ready' and out[0]['price_basis'] == 'finlab_adjusted_close'
    assert meta['history']['manifest_checksum']
    assert [row['date'] for row in meta['canonical_observations']] == ['2026-09-05', '2026-09-06']
    assert meta['knowledge_scope'] == 'observed_at_capture_not_historical_asof'
    assert payload == before


def test_complete_canonical_target_does_not_require_any_weekly_artifact(monkeypatch, canonical):
    monkeypatch.setattr(series, 'load_dated_long_history_records', lambda **kw: pytest.fail('unnecessary GCS read'))
    out, meta = _run(target=2)
    assert out[0]['prices'] == [98, 100]
    assert meta['history'] is None and meta['source_issues'] == []


def test_old_adjustment_vintage_is_not_blindly_spliced_to_new_prices(monkeypatch, canonical):
    _prep(monkeypatch, [45, 46, 47, 48, 49, 50, 51])
    out, meta = _run()
    assert out[0]['prices'] == [98, 100]
    assert meta['source_issues'] == [{'symbol': '2330', 'reason': 'sequence_adjusted_vintage_mismatch'}]


def test_missing_current_adjusted_price_cannot_become_stale_or_raw_sequence(monkeypatch, canonical):
    db, _ = canonical
    db.execute("UPDATE canonical_market_daily SET adj_close=NULL WHERE date='2026-09-06'")
    _prep(monkeypatch, end=5)
    out, meta = _run()
    assert out[0]['prices'] == []
    assert out[0]['missing_adjusted_dates'] == ['2026-09-06']
    assert meta['unavailable_symbols'] == ['2330']


@pytest.mark.parametrize('fault', ['manifest', 'batch', 'missing', 'raw-lane', 'undated', 'duplicate-day', 'nonfinite'])
def test_corrupt_history_never_turns_into_a_partial_success_cache(monkeypatch, canonical, fault):
    import hashlib
    import numpy as np
    bucket = _prep(monkeypatch)
    blob = bucket.blob('frozen/prep/sequence_manifest.json')
    manifest = json.loads(blob.raw)
    batch = bucket.blob('frozen/prep/batch_0.npz')
    if fault == 'manifest': manifest['manifest_checksum'] = 'f' * 64
    if fault == 'batch': batch.raw += b'corrupt'
    if fault == 'missing': batch.raw = None
    if fault in {'raw-lane', 'undated', 'duplicate-day', 'nonfinite'}:
        with np.load(io.BytesIO(batch.raw), allow_pickle=True) as data:
            rows = data['sequence_records'].tolist()
        if fault == 'raw-lane': rows[0]['source_lane'] = 'emerging_price_diversity'
        if fault == 'undated': del rows[0]['dates']
        if fault == 'duplicate-day': rows[0]['dates'][1] = rows[0]['dates'][0]
        if fault == 'nonfinite': rows[0]['close'][1] = float('nan')
        buf = io.BytesIO()
        np.savez_compressed(buf, sequence_records=np.asarray(rows, dtype=object))
        batch.raw = buf.getvalue()
        manifest['output_checksums']['frozen/prep/batch_0.npz'] = hashlib.sha256(batch.raw).hexdigest()
        unsigned = {k: v for k, v in manifest.items() if k != 'manifest_checksum'}
        manifest['manifest_checksum'] = hashlib.sha256(json.dumps(unsigned, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    blob.raw = json.dumps(manifest).encode()
    out, meta = _run()
    assert out[0]['prices'] == [98, 100], 'only independently verified daily data remains'
    assert meta['source_issues'] and meta['history'] is None


def test_pipeline_source_helper_reuses_same_frozen_sequence(monkeypatch, canonical):
    from graphs import daily_pipeline_v2 as graph
    _prep(monkeypatch)
    monkeypatch.setattr(graph, 'daily_sequence_target_points', lambda: 6)
    state = {'run_date': '2026-09-06', 'payloads': _payload()}
    first, meta = graph._pipeline_sequence_inputs(state, state['payloads'])
    saved = deepcopy(state['pipeline_sequence_observations'])
    assert first[0]['prices'] == [90, 92, 94, 96, 98, 100]
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', lambda *a, **k: pytest.fail('re-read canonical'))
    monkeypatch.setattr(series, 'load_dated_long_history_records', lambda **k: pytest.fail('re-read GCS'))
    assert graph._pipeline_sequence_inputs(state, state['payloads']) == (first, meta)
    first[0]['prices'][0] = 999
    assert state['pipeline_sequence_observations'] == saved
    changed = deepcopy(state['payloads'])
    changed[0]['prices'][0]['close'] = 1
    with pytest.raises(ValueError, match='raw_inputs_changed'):
        graph._pipeline_sequence_inputs(state, changed)
    with pytest.raises(ValueError, match='observed_after_parent'):
        series.read_frozen_sequence_inputs(saved, decision_date='2026-09-06', payloads=state['payloads'],
                                          observed_before='2026-09-01T00:00:00Z')


def _l2_dispatch_state(monkeypatch, mode='ready'):
    from datetime import datetime, timezone
    from graphs import daily_pipeline_v2 as graph
    from services import modal_client
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 6, 14, tzinfo=timezone.utc)
    monkeypatch.setattr(graph, 'datetime', Clock)
    monkeypatch.setattr(graph, 'daily_sequence_target_points', lambda: 6)
    monkeypatch.setattr(graph, '_timesfm_l175_release_policy', lambda: {})
    monkeypatch.setattr(graph, '_load_model_pool_versions', lambda: ({}, {'TimesFM': 'fixture-v1'}, {}, True))
    monkeypatch.setattr(graph, '_load_active8_serving_pool', lambda: ({}, {}))
    monkeypatch.setattr(graph, '_timesfm_sync_gate', lambda **kw: (mode != 'blocked', {'sequence_contract_points': 2}))
    calls = []
    async def predict(rows, **kw):
        calls.append(deepcopy(rows))
        if mode == 'error':
            raise RuntimeError('isolated model failure')
        return {'results': [{'symbol': r['symbol'], 'forecast_pct': .02, 'horizon': 5} for r in rows]}
    monkeypatch.setattr(modal_client, 'timesfm_batch_predict', predict)
    monkeypatch.setattr(graph, 'batch_predict_contract', lambda **kw: {'chunk_size': 1})
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_url', lambda: 'https://fixture.invalid/callback')
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_token', lambda: 'isolated-fixture')
    # This test covers real source/node/dispatch wiring, not model promotion.
    manifest = {'schema_version': graph.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
                'models': [], 'active8_shadow_candidates': []}
    return {'run_date': '2026-09-06', 'producer_run_id': 'dated-sequence-fixture', 'payloads': _payload(),
        'pipeline_modal_serving_context': {'schema_version': 'pipeline-modal-serving-context-v1',
            'active_versions': {'TimesFM': 'fixture-v1'}, 'serving_pool': {}, 'model_status': {},
            'serving_manifest': manifest, 'serving_manifest_digest': graph._pipeline_modal_canonical_digest(manifest)}}, calls


@pytest.mark.parametrize('mode', ['ready', 'blocked', 'error'])
def test_real_l2_node_return_transport_and_ml_request_share_dated_source(monkeypatch, canonical, mode):
    from graphs import daily_pipeline_v2 as graph
    from services.pipeline_async_state_transport import encode_pipeline_state_envelope, decode_pipeline_state_envelope
    _prep(monkeypatch)
    state, calls = _l2_dispatch_state(monkeypatch, mode)
    # Mimic LangGraph: only returned node updates persist to the next node.
    result = asyncio.run(graph.node_l2_timesfm_enrich(deepcopy(state)))
    assert result['timesfm_l2_summary']['status'] == mode
    assert 'pipeline_sequence_observations' in result
    state.update(result)
    state['l3_payloads'] = deepcopy(state['payloads'])
    envelope = {'schema_version': 'pipeline-async-state-v1', 'run_date': state['run_date'],
        'producer_run_id': state['producer_run_id'], 'created_at': '2026-09-06T14:01:00Z', 'state': state}
    restored = decode_pipeline_state_envelope(encode_pipeline_state_envelope(envelope))['state']
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', lambda *a, **kw: pytest.fail('second canonical read'))
    monkeypatch.setattr(series, 'load_dated_long_history_records', lambda **kw: pytest.fail('second history read'))
    request = asyncio.run(graph._build_pipeline_modal_prediction_payload(restored, state_gcs_uri='gs://fixture/state'))
    assert request['sequence_series'][0]['prices'] == [90, 92, 94, 96, 98, 100]
    assert request['sequence_series'][0]['dates'][-1] == '2026-09-06'
    assert request['sequence_input_contract']['sequence_point_counts'] == {'2330': 6}
    assert request['sequence_dataset_meta']['frozen_source_checksum'] == result['pipeline_sequence_observations']['source_checksum']
    assert len(calls) == (0 if mode == 'blocked' else 1)
    if mode == 'ready':
        assert calls[0] == request['sequence_series']
        assert request['payloads'][0]['stock_meta']['timesfm_l175_sidecar']['features']['forecast_return'] == .02
        assert request['payloads'][0]['prices'] == _payload()[0]['prices']


@pytest.mark.parametrize('fault', [None, 'late', 'mutated_during_build', 'request_only', 'mutated_during_write'])
def test_frozen_recovery_uses_actual_request_builder_without_live_sequence_reads(monkeypatch, canonical, fault):
    from graphs import daily_pipeline_v2 as graph
    from services import pipeline_snapshot_recovery as recovery
    from services.paired_nav_journal import digest
    _prep(monkeypatch)
    state, _ = _l2_dispatch_state(monkeypatch)
    state.update(asyncio.run(graph.node_l2_timesfm_enrich(deepcopy(state))))
    state['l3_payloads'] = deepcopy(state['payloads'])
    source_context = deepcopy(state['pipeline_modal_serving_context'])
    if fault == 'late':
        packet = state['pipeline_sequence_observations']
        packet['observed_at'] = '2026-09-06T14:02:00Z'
        packet['source_checksum'] = digest({k: v for k, v in packet.items() if k != 'source_checksum'})
    uri = 'gs://fixture/2026-09-06/source/partial_state.json.gz'
    envelope = {'payload': {'run_date': state['run_date'], 'producer_run_id': state['producer_run_id'],
        'created_at': '2026-09-06T14:01:00Z'}, 'state': state, 'artifact': {'gcs_uri': uri, 'generation': '1', 'sha256': 'a'*64}}
    monkeypatch.setattr(recovery, 'load_pipeline_state_envelope', lambda *a: deepcopy(envelope))
    monkeypatch.setattr(recovery, 'long_history_sequence_artifact_evidence', lambda **kw: pytest.fail('mutable history metadata read'))
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, 'query', lambda *a, **kw: pytest.fail('live canonical read'))
    monkeypatch.setattr(series, 'load_dated_long_history_records', lambda **kw: pytest.fail('live history read'))
    async def attach(restored):
        restored['pipeline_modal_serving_context'] = deepcopy(source_context)
        return restored['pipeline_modal_serving_context']
    async def build(restored, **kw):
        request = await graph._build_pipeline_modal_prediction_payload(restored, **kw)
        if fault == 'mutated_during_build':
            packet = restored['pipeline_sequence_observations']
            packet['series'][0]['prices'][0] = 999
            packet['source_checksum'] = digest({k: v for k, v in packet.items() if k != 'source_checksum'})
        if fault == 'request_only':
            request['sequence_series'][0]['prices'][0] = 999
        return request
    written, spawned = [], []
    def write(restored):
        written.append(deepcopy(restored))
        if fault == 'mutated_during_write':
            restored['pipeline_sequence_observations']['series'][0]['prices'][0] = 999
        return 'gs://fixture/derived/partial_state.json.gz'
    def spawn(request):
        spawned.append(deepcopy(request))
        return {'function_call_id': 'isolated', 'n_input': 1}
    def run():
        return asyncio.run(recovery.run_pipeline_snapshot_recovery(source_gcs_uri=uri, run_date=state['run_date'],
            producer_run_id='recovery-fixture', query_fn=lambda *a: [{'next_session_date': '2026-09-07'}],
            attach_serving_context=attach, write_state_artifact=write, build_modal_payload=build, spawn_prediction_bundle=spawn))
    if fault:
        error = {'late': 'observed_after_parent', 'mutated_during_build': 'sequence_artifact_changed',
                 'request_only': 'sequence_request_mismatch', 'mutated_during_write': 'sequence_snapshot_invalid'}[fault]
        with pytest.raises(ValueError, match=error):
            run()
        assert len(written) == (1 if fault == 'mutated_during_write' else 0)
        assert not spawned
    else:
        result = run()
        assert result['status'] == 'deferred' and len(written) == len(spawned) == 1
        assert spawned[0]['sequence_series'] == state['pipeline_sequence_observations']['series']
        assert spawned[0]['snapshot_recovery_lineage']['eligible_for_native_learning'] is False
        assert spawned[0]['state_gcs_uri'] == 'gs://fixture/derived/partial_state.json.gz'
