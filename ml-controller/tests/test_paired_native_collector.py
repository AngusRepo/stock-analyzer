from datetime import datetime, timezone
import json
import gzip
import shutil
import sqlite3

import pytest

from services.paired_native_collector import collect_frame, close_collected_session, frame_identity
from services.native_paper_source_capture import NativeSourceCapture, ImmutableNativeObjects
from services.paired_nav_journal import read_snapshot, freeze_snapshot, digest, mature_staged_pairs
from test_paired_native_session import paired_fixture
from test_native_paper_sandbox import native_runner, checksum
from test_native_paper_source_capture import Bucket
from services.paired_native_sources import PairSourceKV, build_source_receipt
from services.paired_native_runtime import KV_READ_POLICY


class DiskBucket:
    """Immutable test objects on disk, like GCS (not all checkpoints in RAM)."""
    def __init__(self, directory):
        self.directory = directory
        if shutil.disk_usage(directory).free < 512 * 1024 * 1024:
            raise RuntimeError('native_test_requires_512mb_free_for_complete_checkpoints')

    def blob(self, key):
        path = self.directory / key
        class Blob:
            def upload_from_string(self, raw, **kwargs):
                assert kwargs['if_generation_match'] == 0
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open('xb') as output:
                    output.write(gzip.compress(raw.encode('utf-8'), mtime=0))

            def download_as_text(self):
                if not path.is_file():
                    from google.api_core.exceptions import NotFound
                    raise NotFound('fixture_missing_object')
                raw = path.read_bytes()
                return (gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw).decode('utf-8')
        return Blob()


class CompressedMemoryBucket:
    """Bounded lossless test store when local disk is scarce; no skipped frames."""
    def __init__(self):
        self.data = {}
        self.bytes = 0

    def blob(self, key):
        owner = self
        class Blob:
            def upload_from_string(self, raw, **kwargs):
                assert kwargs['if_generation_match'] == 0
                if key in owner.data:
                    raise FileExistsError('immutable_test_object')
                payload = gzip.compress(raw.encode('utf-8'), mtime=0)
                if owner.bytes + len(payload) > 256 * 1024 * 1024:
                    raise RuntimeError('compressed_test_object_budget_exceeded')
                assert gzip.decompress(payload).decode('utf-8') == raw
                owner.data[key] = payload
                owner.bytes += len(payload)

            def download_as_text(self):
                if key not in owner.data:
                    from google.api_core.exceptions import NotFound
                    raise NotFound('fixture_missing_object')
                return gzip.decompress(owner.data[key]).decode('utf-8')
        return Blob()


def test_compressed_memory_objects_keep_exact_bytes_and_reject_overwrite():
    store = CompressedMemoryBucket()
    blob = store.blob('test')
    payload = '完整不可變證據' * 100000
    blob.upload_from_string(payload, if_generation_match=0)
    assert blob.download_as_text() == payload and store.bytes < len(payload)
    with pytest.raises(FileExistsError):
        blob.upload_from_string('replaced', if_generation_match=0)
    assert blob.download_as_text() == payload


def test_disk_checkpoints_are_lossless_and_still_immutable(tmp_path):
    bucket = DiskBucket(tmp_path)
    raw = '{"sealed":"' + 'x' * 1_000_000 + '"}'
    blob = bucket.blob('checkpoint.json')
    blob.upload_from_string(raw, if_generation_match=0)
    assert blob.download_as_text() == raw
    assert (tmp_path / 'checkpoint.json').stat().st_size < len(raw) / 10
    with pytest.raises(FileExistsError):
        blob.upload_from_string('changed', if_generation_match=0)
    assert blob.download_as_text() == raw


def fixture(runner, bucket=None):
    db, args = paired_fixture(runner)
    objects = ImmutableNativeObjects(bucket or Bucket())
    packet = read_snapshot(db.query, args['snapshot_id'])['payload']['content']
    packet['source_tables'] = {}
    packet['initial_state_objects'] = {arm: objects.put(state) for arm, state in args['states'].items()}
    packet['pair_id'] = 'collector-fixture'
    seal = freeze_snapshot(signal_date='2026-09-04', source_run_id=packet['pair_id'], snapshot_kind='execution_pair',
        content=packet, query=db.query, writer=db.writer, now=datetime(2026, 9, 4, 14, tzinfo=timezone.utc))
    return db, args, objects, packet, seal['snapshot_id']


def test_two_arms_durable_frame_retry_and_next_frame_reuse_exact_state(native_runner):
    db, args, objects, packet, snapshot_id = fixture(native_runner)
    capture = NativeSourceCapture(objects=objects, domain_queries={})
    kwargs = dict(snapshot_id=snapshot_id, objects=objects, query=db.query,
                  capture_source=capture, runner=native_runner,
                  now=datetime.fromisoformat(packet['schedule'][0]['observed_at']))
    first = collect_frame(**kwargs, frame_index=0)
    assert collect_frame(**kwargs, frame_index=0) == first
    second = collect_frame(**kwargs, frame_index=1)
    assert second['previous_frame_object'] == objects.lookup_delivery(digest(frame_identity(snapshot_id, packet['schedule'][0])))
    assert first['states']['baseline'] == first['states']['candidate']
    assert second['session_complete'] is False
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    with pytest.raises(ValueError, match='frame_receipt_missing'):
        close_collected_session(snapshot_id=snapshot_id, objects=objects, query=db.query, writer=db.writer,
            source_receipt=args['tapes']['baseline']['source_receipt'], runner=native_runner, now=args['now'])


def test_no_skipping_missing_predecessor_or_future_frame(native_runner):
    db, args, objects, packet, snapshot_id = fixture(native_runner)
    kwargs = dict(snapshot_id=snapshot_id, objects=objects, query=db.query, capture_source=None, runner=native_runner)
    with pytest.raises(ValueError, match='previous_frame_missing'):
        collect_frame(**kwargs, frame_index=2, now=datetime.fromisoformat(packet['schedule'][2]['observed_at']))
    with pytest.raises(ValueError, match='frame_not_due'):
        collect_frame(**kwargs, frame_index=0, now=datetime(2026, 9, 4, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match='expired_frame_without_receipt'):
        collect_frame(**kwargs, frame_index=0, now=args['now'])


@pytest.mark.parametrize('unpriced', [False, True])
def test_full_nonempty_two_arm_frame_collection_restart_replay_and_nightly_close(native_runner, tmp_path, unpriced):
    db, args, objects, packet, _ = fixture(native_runner, CompressedMemoryBucket())
    # The helper constructs earlier deliberate missing-receipt fixtures. Do
    # not leave those unrelated due pairs in this complete-day test database.
    db.conn.close()
    db = type(db)()
    raw = args['states']['baseline']['state_sql']
    with sqlite3.connect(':memory:') as private:
        private.executescript(raw)
        private.executescript("""
          INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE'),(2,'0050','fixture','TWSE');
          INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date,initial_stop,trailing_stop)
          VALUES(2,'2330','fixture',100,100,100,'2026-09-01',99,99);
          DELETE FROM _native_private_kv WHERE key='market:corporate_actions:v1:2026-09-07';
        """)
        if unpriced:
            private.execute("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-09-04',100)")
            private.execute("UPDATE paper_positions SET initial_stop=101,trailing_stop=101 WHERE account_id=2")
        raw = '\n'.join(private.iterdump())
    state = {'state_sql': raw, 'state_checksum': checksum(raw)}
    packet.update(pair_id='nonempty-collector-fixture', variables={'SHIOAJI_PROXY_URL': 'https://broker.fixture'},
        capture_kv_reads=True, kv_read_policy=KV_READ_POLICY,
        initial_account={'cash': 99000, 'nav': 109000, 'positions': {'2330': 100}, 'marks': {'2330': 100}},
        initial_state_objects={arm: objects.put(state) for arm in ('baseline', 'candidate')},
        initial_state_checksums={arm: state['state_checksum'] for arm in ('baseline', 'candidate')})
    seal = freeze_snapshot(signal_date='2026-09-04', source_run_id=packet['pair_id'], snapshot_kind='execution_pair',
        content=packet, query=db.query, writer=db.writer, now=datetime(2026, 9, 4, 14, tzinfo=timezone.utc))
    source_clock = [datetime.fromisoformat(packet['schedule'][0]['observed_at'])]
    source_calls = []
    def corporate_reader(**request):
        source_calls.append(request)
        from test_subscription_rights import action
        return {'schema_version': 'paper-corporate-source-v1', 'session_date': packet['session_date'],
            'observed_at': source_clock[0].isoformat(), 'source_checksum': 'a' * 64,
            'covered_symbols': request['symbols'], 'actions': [action()] if unpriced else [],
            'blockers': {}, 'tax_basis': 'gross_before_personal_tax'}
    pair_kv = PairSourceKV(snapshot_id=seal['snapshot_id'], packet=packet, objects=objects,
        kv_read=lambda _: None, corporate_reader=corporate_reader, clock=lambda: source_clock[0])
    class Broker:
        def read(self, operation, request, frame):
            if operation == 'source_kv':
                return {'request': request, 'captured_at': frame['observed_at'], 'response': pair_kv(request['key'])}
            assert operation == 'frozen_fetch' and request['url'].startswith('https://broker.fixture/')
            quote = {'status': 'ok', 'last': 98, 'bid': 98, 'ask': 98.1,
                'bid_volume': 1000, 'ask_volume': 1000, 'reference_price': 100,
                'source_time': frame['observed_at'], 'confirmed_at': frame['observed_at'],
                'quote_age_ms': 0, 'source_age_ms': 0, 'low': 98, 'high': 100, 'open': 100,
                'total_volume': 100000, 'session_epoch': 1}
            payload = json.loads(request['body']) if request['body'] else {}
            if payload.get('lot_type') == 'odd_lot' or 'odd_lot' in request['url']:
                quote['lot_type'] = 'odd_lot'
            batch = request['url'].endswith(('/orderbooks', '/quotes', '/snapshots'))
            return {'request': request, 'captured_at': frame['observed_at'],
                'response': {'status': 200, 'headers': {}, 'body': json.dumps({'data': {'2330': quote} if batch else quote})}}
    for index, frame in enumerate(packet['schedule']):
        source_clock[0] = datetime.fromisoformat(frame['observed_at'])
        # Each call starts fresh Node + private SQLite processes, then resumes
        # only the immediately preceding immutable BOTH-arm checkpoint.
        receipt = collect_frame(snapshot_id=seal['snapshot_id'], frame_index=index, objects=objects,
            query=db.query, capture_source=Broker(), runner=native_runner,
            now=datetime.fromisoformat(frame['observed_at']))
        assert receipt['frames']['baseline'] == receipt['frames']['candidate']
    source = build_source_receipt(snapshot_id=seal['snapshot_id'], objects=objects, query=db.query, now=args['now'])
    assert len(source_calls) == 1 and source_calls[0]['symbols'] == ['2330']
    assert len(source['frame_objects']) == 281 and source['complete'] is True
    result = close_collected_session(snapshot_id=seal['snapshot_id'], objects=objects,
        query=db.query, writer=db.writer, source_receipt=source, runner=native_runner, now=args['now'])
    fills = result['execution']['arms']['baseline']['fills']
    assert sum(row['shares'] for row in fills) == 100
    assert result['execution']['session_complete'] is True
    assert mature_staged_pairs(business_date='2026-09-07', query=db.query, writer=db.writer, now=args['now'])['processed_pair_sessions'] == 1
    journal = json.loads(db.query('SELECT payload_json FROM paired_nav_daily_journal_v1', [])[0]['payload_json'])
    if unpriced:
        assert journal['net_return_delta'] is None and journal['arms']['candidate']['nav'] is None
        assert result['execution']['valuation_complete'] is False
        assert len(journal['arms']['candidate']['corporate_receivables']) == 1
        # The actual native state, not a reset/bootstrap, must register tomorrow.
        from test_native_paper_bootstrap import fixture as source_fixture
        from test_paired_native_registration import freeze_model_context, calendar, NOW
        from services.paired_native_registration import register_allocation_pair
        from services.native_paper_sandbox import native_runtime_manifest
        source_db, query_source = source_fixture()
        try:
            allocation = {k: packet[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum',
                'configuration', 'configuration_checksum')}
            allocation.update(owner='l4_alpha_ev', baseline={'recommendations': []}, candidate={'recommendations': []})
            freeze_model_context(db, allocation)
            plan = freeze_snapshot(signal_date='2026-09-07', source_run_id=packet['pair_id'],
                snapshot_kind='allocation_pair', content=allocation, query=db.query, writer=db.writer, now=NOW)
            domains = set(native_runtime_manifest(native_runner)['tables'].values())
            next_day = register_allocation_pair(snapshot_id=plan['snapshot_id'], query=db.query, writer=db.writer,
                domain_queries={d: query_source for d in domains}, kv_read=calendar, objects=objects,
                account_id=2, variables=packet['variables'], kv_read_policy=packet['kv_read_policy'], runner=native_runner, now=NOW)
            carried = read_snapshot(db.query, next_day['snapshot_id'])['payload']['content']
            assert carried['previous_session_date'] == '2026-09-07'
            for arm in ('baseline', 'candidate'):
                with sqlite3.connect(':memory:') as private:
                    private.executescript(objects.get(carried['initial_state_objects'][arm])['state_sql'])
                    assert private.execute('SELECT COUNT(*) FROM paper_corporate_entitlements_v1 WHERE account_id=2 AND settled=0').fetchone()[0] == 1
        finally:
            source_db.close()
    else:
        assert journal['net_return_delta'] == 0 and journal['arms']['candidate']['nav'] < 109000
    assert journal['promotion_allowed'] is False and journal['ev_prediction_dates_added'] == 0


def test_new_pending_entry_two_arm_publication_reconciles_actual_fees_and_nav(native_runner, tmp_path, record_property):
    from test_native_pending_entry import ready_entry_case
    db, _, objects, packet, _ = fixture(native_runner, CompressedMemoryBucket())
    db.conn.close()
    db = type(db)()
    raw, variables, schedule, market = ready_entry_case(True)
    with sqlite3.connect(':memory:') as private:
        private.executescript(raw)
        # Force this test through the real shared corporate source owner.
        private.execute("DELETE FROM _native_private_kv WHERE key='market:corporate_actions:v1:2026-09-07'")
        raw = '\n'.join(private.iterdump())
    state = {'state_sql': raw, 'state_checksum': checksum(raw)}
    configuration = {**packet['configuration'], 'risk_config': {**packet['configuration']['risk_config'],
        'system': {**packet['configuration']['risk_config']['system'], 'killSwitch': False}}}
    packet.update(pair_id='new-entry-collector-fixture', variables=variables, schedule=schedule,
        configuration=configuration, configuration_checksum=digest(configuration),
        capture_kv_reads=True, kv_read_policy=KV_READ_POLICY,
        initial_account={'cash': 5000000., 'nav': 5000000., 'positions': {}, 'marks': {}},
        initial_state_objects={arm: objects.put(state) for arm in ('baseline', 'candidate')},
        initial_state_checksums={arm: state['state_checksum'] for arm in ('baseline', 'candidate')})
    seal = freeze_snapshot(signal_date='2026-09-04', source_run_id=packet['pair_id'], snapshot_kind='execution_pair',
        content=packet, query=db.query, writer=db.writer, now=datetime(2026, 9, 4, 14, tzinfo=timezone.utc))
    current = [datetime.fromisoformat(schedule[0]['observed_at'])]
    pair_kv = PairSourceKV(snapshot_id=seal['snapshot_id'], packet=packet, objects=objects,
        kv_read=lambda _: None, clock=lambda: current[0])
    class Sources:
        def read(self, operation, request, frame):
            if operation == 'source_kv':
                return {'request': request, 'captured_at': frame['observed_at'], 'response': pair_kv(request['key'])}
            return market.read(operation, request, frame)
    for index, frame in enumerate(schedule):
        current[0] = datetime.fromisoformat(frame['observed_at'])
        result = collect_frame(snapshot_id=seal['snapshot_id'], frame_index=index, objects=objects,
            query=db.query, capture_source=Sources(), runner=native_runner, now=current[0])
        assert result['frames']['baseline'] == result['frames']['candidate']
        if index % 50 == 0:
            print('sealed-frame', index, 'state-bytes', len(result['states']['baseline']['state_sql'].encode()), flush=True)
    record_property('final_state_bytes', len(result['states']['baseline']['state_sql'].encode()))
    record_property('collected_frames', len(schedule))
    now = datetime(2026, 9, 7, 7, tzinfo=timezone.utc)
    source = build_source_receipt(snapshot_id=seal['snapshot_id'], objects=objects, query=db.query, now=now)
    closed = close_collected_session(snapshot_id=seal['snapshot_id'], objects=objects,
        query=db.query, writer=db.writer, source_receipt=source, runner=native_runner, now=now)
    fills = closed['execution']['arms']['baseline']['fills']
    assert sum(f['side'] == 'buy' for f in fills) == 1
    assert sum(f['commission'] for f in fills) > 0 and market.llm_calls
    assert mature_staged_pairs(business_date='2026-09-07', query=db.query, writer=db.writer, now=now)['processed_pair_sessions'] == 1
    rows = db.query('SELECT payload_json FROM paired_nav_daily_journal_v1', [])
    journal = json.loads(rows[0]['payload_json'])
    assert len(rows) == 1 and journal['net_return_delta'] == 0
    assert journal['arms']['candidate']['costs'] > 0
    assert journal['promotion_allowed'] is False and journal['ev_prediction_dates_added'] == 0
