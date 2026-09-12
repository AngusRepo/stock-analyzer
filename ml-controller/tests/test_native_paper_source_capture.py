from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest

from services.native_paper_sandbox import PrivatePaperStore, run_native_paper_frames
from services.native_paper_source_capture import NativeSourceCapture, ImmutableNativeObjects, read_only_sql
from test_native_paper_sandbox import checksum, frame, native_runner, snapshot_state, snapshot_input


class Blob:
    def __init__(self, store, key):
        self.store, self.key = store, key
    def upload_from_string(self, raw, **kwargs):
        assert kwargs['if_generation_match'] == 0
        if self.key in self.store:
            raise RuntimeError('precondition_failed')
        self.store[self.key] = raw
    def download_as_text(self):
        if self.key not in self.store:
            from google.api_core.exceptions import NotFound
            raise NotFound('fixture_missing_object')
        return self.store[self.key]


class Bucket:
    def __init__(self):
        self.objects = {}
    def blob(self, key):
        return Blob(self.objects, key)


def test_read_is_durably_published_before_delivery_and_retry_does_not_requery():
    bucket, queries, published = Bucket(), [], {}
    clock = [datetime(2026, 9, 7, tzinfo=timezone.utc)]
    capture = NativeSourceCapture(objects=ImmutableNativeObjects(bucket), deliveries={},
        publish=lambda key, value: published.setdefault(key, value), clock=lambda: clock[0],
        domain_queries={'market': lambda sql, args: queries.append((sql, args)) or [{'close': 100}]})
    request = {'domain': 'market', 'sql': "SELECT close FROM stock_prices WHERE date <= date('now')", 'args': []}
    first = capture.read('source_sql', request, frame())
    assert len(published) == len(bucket.objects) == 1
    assert "date('2026-09-07 00:00:00')" in queries[0][0]
    clock[0] += timedelta(days=2)
    assert capture.read('source_sql', request, frame()) == first
    assert len(queries) == 1
    with pytest.raises(ValueError, match='historical_or_future'):
        capture.read('source_sql', {**request, 'args': [1]}, frame())


@pytest.mark.parametrize('sql', ['DELETE FROM t', 'WITH a AS (SELECT 1) DELETE FROM t',
    "SELECT load_extension('x')", 'SELECT 1; SELECT 2', 'PRAGMA table_info(t)'])
def test_source_transport_rejects_mutations(sql):
    with pytest.raises(ValueError, match='forbidden'):
        read_only_sql(sql)


def test_sqlite_plan_routes_only_read_only_correct_domain_queries():
    f = {**frame(), 'source_tables': {'stock_prices': 'market'}, 'sql_responses': []}
    raw = 'CREATE TABLE stock_prices(stock_id INTEGER,close REAL); CREATE TABLE paper_accounts(id INTEGER);'
    class Capture:
        def read(self, op, packet, current):
            assert op == 'source_sql'
            return {'request': packet, 'response': {'success': True, 'results': [{'close': 123}]}}
    store = PrivatePaperStore(raw, checksum(raw), {f['input_id']: f}, capture_source=Capture())
    try:
        store.dispatch('frame_input', {**frame(), 'now_ms': 1788739200000})
        store.dispatch('frame_begin', {})
        packet = {'domain': 'market', 'sql': 'WITH x AS (SELECT * FROM stock_prices) SELECT close FROM x', 'args': []}
        assert store.dispatch('sql', packet)['results'] == [{'close': 123}]
        assert len(store.current['sql_responses']) == 1
        with pytest.raises(ValueError, match='source_domain_mismatch'):
            store.dispatch('sql', {**packet, 'domain': 'core'})
        with pytest.raises(ValueError, match='source_write_forbidden'):
            store.dispatch('sql', {'domain': 'market', 'sql': 'DELETE FROM stock_prices'})
        with pytest.raises(ValueError, match='mixed_private_source_query'):
            store.dispatch('sql', {'domain': 'market', 'sql': 'SELECT * FROM stock_prices JOIN paper_accounts'})
    finally:
        store.db.close()


def test_lost_publish_ack_never_delivers_an_unrecorded_source_value():
    capture = NativeSourceCapture(objects=ImmutableNativeObjects(Bucket()), deliveries={}, publish=lambda *args: None,
        clock=lambda: datetime(2026, 9, 7, tzinfo=timezone.utc), domain_queries={'market': lambda *args: []})
    with pytest.raises(RuntimeError, match='publish_not_verified'):
        capture.read('source_sql', {'domain': 'market', 'sql': 'SELECT 1', 'args': []}, frame())
    assert capture.deliveries == {}


def test_new_process_reuses_persisted_first_delivery_without_requery():
    bucket = Bucket()
    first = NativeSourceCapture(objects=ImmutableNativeObjects(bucket),
        clock=lambda: datetime(2026, 9, 7, tzinfo=timezone.utc), domain_queries={'market': lambda *args: [{'close': 100}]})
    request = {'domain': 'market', 'sql': 'SELECT 1', 'args': []}
    record = first.read('source_sql', request, frame())
    def forbidden(*args):
        raise AssertionError('old frame must never query newer inputs')
    restarted = NativeSourceCapture(objects=ImmutableNativeObjects(bucket),
        clock=lambda: datetime(2026, 9, 8, tzinfo=timezone.utc), domain_queries={'market': forbidden})
    assert restarted.read('source_sql', request, frame()) == record


def test_morning_long_inference_uses_real_observed_clock_not_scheduled_time():
    f = {'input_id': 'morning', 'stage': 'morning', 'observed_at': '2026-09-07T07:15:00+08:00'}
    clock = [datetime.fromisoformat('2026-09-07T07:18:00+08:00')]
    queries = []
    capture = NativeSourceCapture(objects=ImmutableNativeObjects(Bucket()), clock=lambda: clock[0],
        domain_queries={'market': lambda sql, args: queries.append(sql) or []})
    record = capture.read('source_sql', {'domain': 'market', 'sql': "SELECT datetime('now')", 'args': []}, f)
    assert "2026-09-06 23:18:00" in queries[0]
    assert record['captured_at'] == clock[0].isoformat()
    clock[0] = datetime.fromisoformat('2026-09-07T08:50:00+08:00')
    with pytest.raises(ValueError, match='historical_or_future'):
        capture.read('source_sql', {'domain': 'market', 'sql': 'SELECT 2', 'args': []}, f)


def test_intraday_source_cannot_overrun_next_minute():
    f = {'input_id': 'intraday', 'stage': 'intraday', 'observed_at': '2026-09-07T09:00:00+08:00'}
    stamps = iter([datetime.fromisoformat('2026-09-07T09:00:50+08:00'), datetime.fromisoformat('2026-09-07T09:01:00+08:00')])
    capture = NativeSourceCapture(objects=ImmutableNativeObjects(Bucket()), clock=lambda: next(stamps),
        domain_queries={'market': lambda sql, args: []})
    with pytest.raises(ValueError, match='missed_frame_deadline'):
        capture.read('source_sql', {'domain': 'market', 'sql': 'SELECT 1', 'args': []}, f)


def test_same_request_under_different_frozen_inference_context_cannot_reuse_delivery():
    objects = ImmutableNativeObjects(Bucket())
    calls = []
    class Reader:
        def __init__(self, model):
            self.source_identity = {'frozen_model_checksum': model}
        def __call__(self, request):
            calls.append(self.source_identity)
            return self.source_identity
    make = lambda model: NativeSourceCapture(objects=objects, domain_queries={},
        clock=lambda: datetime(2026, 9, 7, tzinfo=timezone.utc), inference_reads={'frozen_ai': Reader(model)})
    request = {'args': ['same body']}
    first = make('a').read('frozen_ai', request, frame())
    second = make('b').read('frozen_ai', request, frame())
    assert first['response'] != second['response'] and len(calls) == 2
    assert make('a').read('frozen_ai', request, frame()) == first
    assert len(calls) == 2


def test_actual_native_snapshot_records_source_queries_and_replay_ignores_newer_prices(native_runner):
    raw = snapshot_state()
    source = sqlite3.connect(':memory:')
    source.row_factory = sqlite3.Row
    source.executescript(raw)
    reads = []
    def query(sql, args):
        reads.append(sql)
        return [dict(row) for row in source.execute(sql, args).fetchall()]
    f = {**snapshot_input(), 'source_tables': {'stocks': 'core', 'stock_prices': 'market', 'market_risk': 'core'}}
    capture = NativeSourceCapture(objects=ImmutableNativeObjects(Bucket()), domain_queries={'core': query, 'market': query},
        clock=lambda: datetime(2026, 9, 7, 6, 20, tzinfo=timezone.utc))
    args = dict(state_sql=raw, state_checksum=checksum(raw), frames=[f], account_id=2, variables={}, runner=native_runner)
    try:
        first = run_native_paper_frames(**args, frame_inputs={f['input_id']: f}, capture_source=capture)
        assert reads
        assert first['captured_inputs'][f['input_id']]['sql_responses']
        # Change the external database, then replay with no capture capability.
        source.execute('UPDATE stock_prices SET close=999')
        read_count = len(reads)
        second = run_native_paper_frames(**args, frame_inputs=first['captured_inputs'])
        assert second['state_checksum'] == first['state_checksum']
        assert second['frames'][-1]['result']['valuation']['nav'] == 110000
        assert len(reads) == read_count
    finally:
        source.close()
