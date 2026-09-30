from __future__ import annotations

import base64
import copy
import json
import re
import sqlite3
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services import allocator_forecast_archive as archive
from services import allocator_ev_feature_snapshot_backfill as producer
from services.allocator_ev_fusion_artifact_builder import load_allocator_ev_fusion_training_rows
from test_allocator_ev_fusion_artifact_builder import _champion_history_rows, _ensemble_forecast

ROOT = Path(__file__).resolve().parents[2]
GUARD, SOURCE = producer.AS_OF_GUARD, producer.SNAPSHOT_SOURCE


def row(stock=1, size=6000):
    forecast = json.loads(_ensemble_forecast())
    forecast['original'] = '資料' * size
    return dict(snapshot_date='2026-06-08', stock_id=stock, snapshot_source=SOURCE,
                as_of_guard=GUARD, forecast_data=json.dumps(forecast, ensure_ascii=False))


def sealed(rows, run_id='fixture'):
    body = archive._json(dict(schema_version=archive.ARCHIVE_SCHEMA, domain=archive.DOMAIN,
        business_date=rows[0]['snapshot_date'], payload=dict(run_id=run_id,
        source_table='allocator_ev_feature_snapshots', rows=rows))).encode()
    checksum = archive._sha(body)
    artifact_id = 'artifact:' + archive.DOMAIN + ':' + checksum[-24:]
    manifest = dict(artifact_id=artifact_id, domain=archive.DOMAIN, schema_version=archive.ARCHIVE_SCHEMA,
        retention_class='ten_year_cold_archive', status='ready', checksum_verified_at='2026-09-30',
        producer_run_id=run_id, row_count=len(rows), byte_size=len(body), checksum=checksum)
    outputs = []
    for original in rows:
        pointer = {**archive._hot_projection(original['forecast_data']),
            **{key: original[key] for key in ('snapshot_date', 'stock_id', 'snapshot_source', 'as_of_guard')},
            'schema_version': archive.POINTER_SCHEMA, 'artifact_id': artifact_id, 'checksum': checksum,
            'forecast_checksum': archive._sha(original['forecast_data']),
            'original_bytes': len(original['forecast_data'].encode())}
        outputs.append({**original, 'forecast_checksum': pointer['forecast_checksum'],
                        'forecast_data': archive._json(pointer)})
    return dict(ok=True, writer_enabled=True, activation_id='fixture-activation', manifest=manifest, rows=outputs), body


def test_disabled_writer_posts_once_then_preserves_all_remaining_originals():
    originals = [row(stock) for stock in range(1, 66)]
    before = copy.deepcopy(originals)
    calls, summary = [], {}
    def post(op, payload):
        assert op == 'write'
        calls.append(payload)
        return dict(ok=True, writer_enabled=False, activation_id=None, manifest=None,
                    rows=payload['rows'], reason='activation_missing')
    values, ids = archive.archive_allocator_forecasts(originals, run_id='fixture', post=post, summary=summary)
    assert len(calls) == 1 and len(calls[0]['rows']) == 16
    assert values == [row['forecast_data'] for row in originals] and not ids and originals == before
    assert summary['archived_rows'] == summary['logical_bytes_saved'] == 0
    assert summary['writer_enabled'] is False and summary['retained_inline_rows'] == 65


def test_revocation_keeps_verified_pointers_and_stops_later_batches_without_partial_mutation():
    originals = [row(stock) for stock in range(1, 50)]
    before, calls, bodies = copy.deepcopy(originals), [], {}
    def post(op, payload):
        calls.append(payload)
        if len(calls) == 1:
            receipt, raw = sealed(payload['rows'], payload['run_id'])
            bodies[receipt['manifest']['artifact_id']] = raw
            return receipt
        return dict(ok=True, writer_enabled=False, manifest=None, activation_id=None,
                    rows=payload['rows'], reason='activation_disabled')
    values, ids = archive.archive_allocator_forecasts(originals, run_id='fixture', post=post)
    assert len(calls) == 2 and len(ids) == 1 and originals == before
    assert values[16:] == [v['forecast_data'] for v in originals[16:]]
    hydrated = archive.hydrate_allocator_forecasts([native({**r, 'forecast_data': v}) for r, v in zip(originals, values)], download=bodies.__getitem__)
    assert [v['forecast_data'] for v in hydrated] == [v['forecast_data'] for v in originals]


@pytest.mark.parametrize('fault', ['changed_row', 'manifest', 'activation', 'missing_gate'])
def test_gate_response_cannot_publish_unverified_or_changed_values(fault):
    originals, summary = [row()], {}
    before = copy.deepcopy(originals)
    def post(op, payload):
        receipt = dict(ok=True, writer_enabled=False, manifest=None, activation_id=None, rows=copy.deepcopy(payload['rows']))
        if fault == 'changed_row': receipt['rows'][0]['forecast_data'] = '{}'
        if fault == 'manifest': receipt['manifest'] = {'artifact_id': 'unexpected'}
        if fault == 'activation': receipt['activation_id'] = 'unexpected'
        if fault == 'missing_gate': receipt.pop('writer_enabled')
        return receipt
    with pytest.raises(RuntimeError, match='allocator_forecast_'):
        archive.archive_allocator_forecasts(originals, run_id='fixture', post=post, summary=summary)
    assert originals == before and summary == {}


def native(value):
    return {**value, 'prediction_date': value['snapshot_date'],
        'allocator_ev_feature_snapshot_source': value['snapshot_source'],
        'allocator_ev_feature_snapshot_guard': value['as_of_guard']}


def test_batches_are_bounded_and_hydration_preserves_full_values_order_and_input():
    originals = [row(stock) for stock in range(1, 36)]
    originals[4]['forecast_data'] = '{"small":1}'
    bodies, calls = {}, []
    def post(op, payload):
        calls.append(payload)
        assert op == 'write' and len(payload['rows']) <= 16
        assert len(archive._json(payload).encode()) <= archive.MAX_ARTIFACT_BYTES
        receipt, body = sealed(payload['rows'], payload['run_id'])
        bodies[receipt['manifest']['artifact_id']] = body
        return receipt
    values, ids = archive.archive_allocator_forecasts(originals, run_id='fixture', post=post)
    assert [len(call['rows']) for call in calls] == [16, 16, 2]
    assert len(ids) == 3
    inputs = [native({**original, 'forecast_data': value}) for original, value in zip(originals, values)]
    before = copy.deepcopy(inputs)
    result = archive.hydrate_allocator_forecasts(inputs, download=bodies.__getitem__)
    assert [v['forecast_data'] for v in result] == [v['forecast_data'] for v in originals]
    assert inputs == before and result is not inputs
    assert all(result[i]['stock_id'] == originals[i]['stock_id'] for i in range(len(result)))


def test_single_large_original_keeps_complete_inline_value_without_request_or_mutation():
    source = [row(size=archive.MAX_ARTIFACT_BYTES)]
    before = copy.deepcopy(source)
    summary = {}
    values, ids = archive.archive_allocator_forecasts(source, run_id='fixture', post=lambda *_: pytest.fail('network'), summary=summary)
    assert values == [source[0]['forecast_data']] and ids == []
    assert source == before
    assert summary == dict(artifact_count=0, archived_rows=0, retained_inline_rows=1, oversized_inline_rows=1, logical_bytes_saved=0)


@pytest.mark.parametrize('fault', ['checksum', 'missing', 'duplicate', 'identity', 'hot_fields', 'oversize'])
def test_hydration_failure_never_publishes_partial_input(fault):
    first, raw1 = sealed([row(1)])
    second, raw2 = sealed([row(2)], 'other')
    inputs = [native(first['rows'][0]), native(second['rows'][0])]
    bodies = {first['manifest']['artifact_id']: raw1, second['manifest']['artifact_id']: raw2}
    if fault == 'checksum':
        bodies[second['manifest']['artifact_id']] = raw2.replace(b'original', b'changed!')
    elif fault == 'missing':
        payload = json.loads(raw2)
        payload['payload']['rows'][0]['stock_id'] = 3
        bodies[second['manifest']['artifact_id']] = archive._json(payload).encode()
    elif fault == 'duplicate':
        payload = json.loads(raw2)
        payload['payload']['rows'] *= 2
        bodies[second['manifest']['artifact_id']] = archive._json(payload).encode()
    elif fault == 'identity':
        pointer = json.loads(inputs[1]['forecast_data']); pointer['stock_id'] = 3
        inputs[1]['forecast_data'] = archive._json(pointer)
    elif fault == 'hot_fields':
        pointer = json.loads(inputs[1]['forecast_data']); pointer['ensemble_v2']['model_set_signature'] = 'wrong'
        inputs[1]['forecast_data'] = archive._json(pointer)
    else:
        bodies[second['manifest']['artifact_id']] = b' ' * (archive.MAX_ARTIFACT_BYTES + 1)
    if fault in ('missing', 'duplicate'):
        pointer = json.loads(inputs[1]['forecast_data'])
        pointer['checksum'] = archive._sha(bodies[second['manifest']['artifact_id']])
        inputs[1]['forecast_data'] = archive._json(pointer)
    before = copy.deepcopy(inputs)
    with pytest.raises(RuntimeError):
        archive.hydrate_allocator_forecasts(inputs, download=bodies.__getitem__)
    assert inputs == before


def test_inline_remains_identical_and_does_not_download():
    rows = [row(), {'forecast_data': None}, {'forecast_data': '{}'}]
    assert archive.hydrate_allocator_forecasts(rows, download=lambda *_: pytest.fail('network')) is rows


@pytest.mark.parametrize(('fault', 'reason'), [('compressed', 'compressed_response'),
    ('declared', 'response_byte_limit'), ('streamed', 'response_byte_limit'), ('http', 'http_503')])
def test_transport_caps_before_decoding_and_never_inflates_compressed_body(monkeypatch, fault, reason):
    import httpx
    import services.worker_config_client as config
    touched = []
    class Response:
        status_code = 503 if fault == 'http' else 200
        headers = ({'Content-Encoding': 'gzip'} if fault == 'compressed' else
                   {'Content-Length': str(archive.MAX_ARTIFACT_BYTES + 1)} if fault == 'declared' else {})
        def iter_raw(self, chunk_size):
            touched.append('body')
            assert chunk_size == 65536
            for _ in range(17):
                yield b'x' * 65536
    class Client:
        def stream(self, method, url, **kwargs):
            assert kwargs['headers']['Accept-Encoding'] == 'identity'
            return nullcontext(Response())
    monkeypatch.setattr(httpx, 'Client', lambda **_: nullcontext(Client()))
    monkeypatch.setattr(config, 'worker_auth_headers', lambda: {})
    monkeypatch.setattr(config, 'worker_url', lambda: 'http://fixture.invalid')
    with pytest.raises(RuntimeError, match=reason):
        archive._request('read', {'artifact_id': 'fixture'})
    assert touched == (['body'] if fault == 'streamed' else [])


@pytest.mark.parametrize('fail_second_chunk', [False, True])
def test_multichunk_operations_reuse_one_lazy_client_and_close_on_failure(monkeypatch, fail_second_chunk):
    import httpx
    import services.worker_config_client as config
    events, bodies = [], {}
    calls = {'write': 0, 'read': 0, 'reconcile': 0}
    class Response:
        def __init__(self, raw, status=200):
            self.raw, self.status_code = raw, status
            self.headers = {'Content-Length': str(len(raw))}
        def iter_raw(self, chunk_size):
            for start in range(0, len(self.raw), chunk_size):
                yield self.raw[start:start+chunk_size]
    class Client:
        def __init__(self, **_): events.append('create')
        def __enter__(self): events.append('enter'); return self
        def __exit__(self, *_): events.append('close')
        def stream(self, method, url, **kwargs):
            op = url.rsplit('/', 1)[-1]; payload = json.loads(kwargs['content']); calls[op] += 1
            if op == 'write':
                if fail_second_chunk and calls[op] == 2:
                    return nullcontext(Response(b'{}', 503))
                receipt, body = sealed(payload['rows'], payload['run_id'])
                bodies[receipt['manifest']['artifact_id']] = body
                raw = archive._json(receipt).encode()
            elif op == 'read': raw = bodies[payload['artifact_id']]
            else: raw = archive._json(dict(ok=True, has_more=calls[op] == 1, after_artifact_id='next')).encode()
            return nullcontext(Response(raw))
    monkeypatch.setattr(httpx, 'Client', Client)
    monkeypatch.setattr(config, 'worker_auth_headers', lambda: {})
    monkeypatch.setattr(config, 'worker_url', lambda: 'http://fixture.invalid')
    originals = [row(stock, size=1000) for stock in range(1, 34)]
    before = copy.deepcopy(originals)
    if fail_second_chunk:
        with pytest.raises(RuntimeError, match='http_503'):
            archive.archive_allocator_forecasts(originals, run_id='fixture')
        assert events == ['create', 'enter', 'close'] and originals == before
        return
    values, _ = archive.archive_allocator_forecasts(originals, run_id='fixture')
    assert calls['write'] == 3 and events == ['create', 'enter', 'close']
    result = archive.hydrate_allocator_forecasts([native({**r, 'forecast_data': v}) for r, v in zip(originals, values)])
    assert calls['read'] == 3 and events == ['create', 'enter', 'close'] * 2
    assert [r['forecast_data'] for r in result] == [r['forecast_data'] for r in originals]
    archive.reconcile_allocator_forecast_references('fixture')
    assert calls['reconcile'] == 2 and events == ['create', 'enter', 'close'] * 3
    archive.hydrate_allocator_forecasts([{'forecast_data': '{}'}])
    archive.archive_allocator_forecasts([row(size=0)], run_id='fixture')
    assert events == ['create', 'enter', 'close'] * 3, 'inline-only operations never open a client'


def test_actual_reference_inventory_sql_steps_do_not_grow_with_inactive_history():
    db = sqlite3.connect(':memory:')
    try:
        schema = (ROOT / 'worker/domain-schemas/ops.sql').read_text()
        db.executescript(re.search(r'CREATE TABLE IF NOT EXISTS artifact_hard_references \([\s\S]*?\n\);', schema)[0])
        db.executescript((ROOT / 'worker/domain-migrations/ops/0021_allocator_forecast_active_references.sql').read_text())
        source = (ROOT / 'worker/src/lib/allocatorEvFeatureArchive.ts').read_text()
        sql = re.search(r'`(SELECT owner_id AS run_id FROM artifact_hard_references[\s\S]*?LIMIT 1)`', source)[1]
        sql = sql.replace('${REFERENCE_INDEX}', 'idx_allocator_forecast_active_refs_v1')
        insert = "INSERT INTO artifact_hard_references(reference_id,artifact_id,owner_type,owner_id,active) VALUES(?,?,'allocator_ev_forecast_run',?,?)"
        db.execute(insert, ('live', 'artifact-live', 'zz-live', 1))
        def add_inactive(start, end):
            db.executemany(insert, ((str(i), 'artifact-'+str(i), 'inactive-'+str(i), 0) for i in range(start, end)))
        def measure():
            steps = [0]
            def tick(): steps[0] += 1; return 0
            db.set_progress_handler(tick, 1)
            assert db.execute(sql, ['']).fetchone()[0] == 'zz-live'
            db.set_progress_handler(None, 0)
            return steps[0]
        add_inactive(0, 100)
        small = measure()
        add_inactive(100, 100_000)
        large = measure()
        plan = ' '.join(str(item[-1]) for item in db.execute('EXPLAIN QUERY PLAN '+sql, ['']))
        assert 'SEARCH' in plan and 'idx_allocator_forecast_active_refs_v1' in plan and 'TEMP' not in plan
        assert large <= small + 4 and large < 100
        print(f'allocator_reference_index_steps inactive100={small} inactive100000={large}; {plan}')
    finally: db.close()


def test_full_window_above_previous_256mib_restriction_is_not_rejected(monkeypatch):
    # Symbolic byte lengths avoid allocating 300 MiB. Full key/checksum/value
    # matching still runs; only JSON string encode length is inflated by fixture.
    class Encoded(bytes):
        def __len__(self):
            return 900_000
    class Forecast(str):
        def encode(self, *args, **kwargs):
            return Encoded(super().encode(*args, **kwargs))
    originals = [row(stock, size=1) for stock in range(1, 301)]
    bodies, inputs = {}, []
    real_loads = archive.json.loads
    for original in originals:
        receipt, body = sealed([original], str(original['stock_id']))
        pointer = real_loads(receipt['rows'][0]['forecast_data'])
        pointer['original_bytes'] = 900_000
        inputs.append(native({**original, 'forecast_data': archive._json(pointer)}))
        bodies[receipt['manifest']['artifact_id']] = body
    def loads(raw, *args, **kwargs):
        result = real_loads(raw, *args, **kwargs)
        if isinstance(result, dict) and result.get('schema_version') == archive.ARCHIVE_SCHEMA:
            for item in result['payload']['rows']:
                item['forecast_data'] = Forecast(item['forecast_data'])
        return result
    monkeypatch.setattr(archive.json, 'loads', loads)
    result = archive.hydrate_allocator_forecasts(inputs, download=bodies.__getitem__)
    assert sum(len(item['forecast_data'].encode()) for item in result) > 256 * 1024 * 1024
    assert [item['forecast_data'] for item in result] == [item['forecast_data'] for item in originals]


@pytest.fixture
def real_worker(tmp_path):
    path = tmp_path / 'fixture.sqlite'
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    schema = (ROOT / 'worker/domain-schemas/learning.sql').read_text() + '\n' + (ROOT / 'worker/domain-schemas/ops.sql').read_text()
    for table in ('run_artifacts', 'artifact_hard_references', 'allocator_ev_snapshot_runs',
                  'allocator_ev_feature_snapshots', 'allocator_ev_feature_snapshot_staging'):
        db.executescript(re.search(r'CREATE TABLE IF NOT EXISTS ' + table + r' \([\s\S]*?\n\);', schema)[0])
    db.executescript((ROOT / 'worker/domain-migrations/ops/0020_artifact_deletion_claims.sql').read_text())
    db.executescript((ROOT / 'worker/domain-migrations/ops/0021_allocator_forecast_active_references.sql').read_text())
    bridge = subprocess.Popen(['node', '--import', 'tsx', str(Path(__file__).parent / 'fixtures/allocator_forecast_worker_bridge.ts'), str(path)],
        cwd=ROOT / 'worker', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8')
    calls = []
    def post(operation, payload):
        calls.append(operation)
        bridge.stdin.write(archive._json(dict(operation=operation, payload=payload)) + '\n'); bridge.stdin.flush()
        response = json.loads(bridge.stdout.readline())
        if response.get('error'):
            raise RuntimeError(response['error'])
        return response
    try:
        yield db, post, calls
    finally:
        try: bridge.stdin.close()
        except OSError: pass
        try: bridge.wait(timeout=5)
        except subprocess.TimeoutExpired: bridge.kill(); bridge.wait()
        db.close()


def producer_fixture(db, *, large=True):
    original = row(size=6000 if large else 0)
    candidate = dict(stock_id=1, symbol='2330', recommendation_date='2026-06-08',
        prediction_generated_at='2026-06-08T12:00:00Z', forecast_data=original['forecast_data'], score=70,
        score_components=json.dumps(dict(version='score_v2', semanticVersion='score-v2-active8-components-v3',
          finalScore=70, components=dict(mlEdge=18, fundamentalQuality=19, chipFlow=20, technicalStructure=21))),
        alpha_context='{}', existing_alpha_allocation='{}', current_price=100)
    writes = []
    def query(sql, params=None):
        if 'FROM model_champion_history' in sql:
            return _champion_history_rows()
        if 'canonical_reference_snapshot_candidates_v4' in sql:
            return [candidate]
        if 'FROM allocator_ev_feature_snapshot_staging' in sql or 'FROM allocator_ev_snapshot_runs' in sql:
            return [dict(r) for r in db.execute(sql, params or [])]
        return []
    def write(statements):
        changes = db.total_changes
        with db:
            for sql, params in statements:
                writes.append(sql)
                db.execute(sql, params)
        return dict(success_count=len(statements), error_count=0, changes_total=db.total_changes-changes)
    return candidate, query, write, writes


def test_real_producer_worker_registry_and_full_consumer_roundtrip(real_worker):
    db, post, calls = real_worker
    candidate, query, write, _ = producer_fixture(db)
    result = producer.build_allocator_ev_feature_snapshots_for_date(snapshot_date='2026-06-08',
        query_fn=query, write_fn=write, dry_run=False, forecast_archive_post=post)
    assert result['status'] == 'ok' and calls == ['write', 'reconcile']
    assert result['forecast_archive']['archived_rows'] == 1
    assert result['forecast_archive']['logical_bytes_saved'] > 0
    hot = dict(db.execute('SELECT * FROM allocator_ev_feature_snapshots').fetchone())
    pointer = json.loads(hot['forecast_data'])
    assert pointer['schema_version'] == archive.POINTER_SCHEMA
    assert len(hot['forecast_data'].encode()) < len(candidate['forecast_data'].encode())
    assert db.execute('SELECT COUNT(*) FROM artifact_hard_references WHERE active=1').fetchone()[0] == 1
    assert db.execute('SELECT COUNT(*) FROM allocator_ev_feature_snapshot_staging').fetchone()[0] == 0
    inputs = [native(hot)]
    def download(artifact_id):
        return base64.b64decode(post('read', {'artifact_id': artifact_id})['body_base64'])
    loaded = load_allocator_ev_fusion_training_rows(lambda *_: inputs, end_date='2026-06-08', forecast_archive_download=download)
    # Producer already normalizes its forecast dictionary before both old inline
    # storage and new capture; compare exact staged original and full feature value.
    captured = json.loads(download(pointer['artifact_id']))['payload']['rows'][0]['forecast_data']
    assert captured == producer._dumps(producer._loads(candidate['forecast_data']))
    assert loaded[0]['forecast_data'] == captured
    assert json.loads(loaded[0]['forecast_data']) == json.loads(candidate['forecast_data'])
    assert inputs[0]['forecast_data'] == hot['forecast_data']
    assert loaded[0]['alpha_allocation'] == hot['alpha_allocation']


def test_cleanup_failure_reports_pending_without_repeating_verified_snapshot_publish(real_worker):
    db, post, _ = real_worker
    _, query, write, _ = producer_fixture(db)
    def delayed_cleanup(operation, payload):
        if operation == 'reconcile':
            raise RuntimeError('fixture_ops_cleanup_unavailable')
        return post(operation, payload)
    result = producer.build_allocator_ev_feature_snapshots_for_date(snapshot_date='2026-06-08',
        query_fn=query, write_fn=write, dry_run=False, forecast_archive_post=delayed_cleanup)
    assert result['status'] == 'ok'
    assert result['forecast_archive']['reference_reconciliation']['status'] == 'pending'
    assert db.execute('SELECT status FROM allocator_ev_snapshot_runs').fetchone()[0] == 'ready'
    assert db.execute('SELECT active FROM artifact_hard_references').fetchone()[0] == 1


def test_replacement_publish_releases_superseded_run_but_preserves_new_forecast_reference(real_worker):
    db, post, _ = real_worker
    _, query, write, _ = producer_fixture(db)
    for _ in range(2):
        result = producer.build_allocator_ev_feature_snapshots_for_date(snapshot_date='2026-06-08',
            query_fn=query, write_fn=write, dry_run=False, forecast_archive_post=post)
    refs = list(db.execute('SELECT owner_id,active FROM artifact_hard_references ORDER BY owner_id'))
    assert len(refs) == 2 and [item['active'] for item in refs] == [0, 1]
    assert refs[1]['owner_id'] == result['snapshot_run_id']
    assert result['forecast_archive']['reference_reconciliation']['checked'] == 1
    assert db.execute('SELECT COUNT(*) FROM run_artifacts WHERE status=\'ready\'').fetchone()[0] == 2


def test_capture_failure_occurs_before_any_staging_or_canonical_write(real_worker):
    db, _, _ = real_worker
    _, query, write, writes = producer_fixture(db)
    def failure(*_):
        raise RuntimeError('fixture_capture_failed')
    with pytest.raises(RuntimeError, match='fixture_capture_failed'):
        producer.build_allocator_ev_feature_snapshots_for_date(snapshot_date='2026-06-08',
            query_fn=query, write_fn=write, dry_run=False, forecast_archive_post=failure)
    assert all('INSERT INTO allocator_ev_feature_snapshot' not in sql for sql in writes)
    assert db.execute('SELECT status FROM allocator_ev_snapshot_runs').fetchone()[0] == 'failed'


def test_terminal_run_sql_cannot_reopen_and_range_wrapper_passes_capture_owner(real_worker, monkeypatch):
    db, _, _ = real_worker
    sql, params = producer._snapshot_run_start_statement(run_id='terminal', snapshot_date='2026-06-08',
        expected_rows=1, native_lineage_rows=1, reconstructed_lineage_rows=0, rejected_lineage_rows=0)
    db.execute(sql, params); db.execute("UPDATE allocator_ev_snapshot_runs SET status='ready'"); db.commit()
    assert db.execute(sql, params).rowcount == 0
    assert db.execute('SELECT status FROM allocator_ev_snapshot_runs').fetchone()[0] == 'ready'
    calls = []
    def day(**kwargs):
        calls.append(kwargs)
        return dict(status='ok', snapshots_built=1, written=1)
    monkeypatch.setattr(producer, 'build_allocator_ev_feature_snapshots_for_date', day)
    token = lambda *_: None
    producer.backfill_allocator_ev_feature_snapshots(start_date='2026-06-08', end_date='2026-06-09', forecast_archive_post=token)
    assert len(calls) == 2 and all(c['forecast_archive_post'] is token for c in calls)


def test_failed_run_released_reference_blocks_late_stage_and_publish(real_worker):
    db, post, _ = real_worker
    run_id = 'late-stage'
    sql, params = producer._snapshot_run_start_statement(run_id=run_id, snapshot_date='2026-06-08',
        expected_rows=1, native_lineage_rows=1, reconstructed_lineage_rows=0, rejected_lineage_rows=0)
    db.execute(sql, params); db.commit()
    original = row()
    receipt = post('write', dict(run_id=run_id, rows=[original]))
    db.execute(*producer._snapshot_run_fail_statement(run_id=run_id, error_code='stage_request_timed_out')); db.commit()
    assert post('reconcile', dict(run_id=run_id))['released'] == 1
    stage = producer._snapshot_staging_statement('2026-06-08', dict(stock_id=1, symbol='2330',
        forecast_data=json.loads(receipt['rows'][0]['forecast_data'])), {}, run_id=run_id,
        generated_at='2026-09-30', lineage_cohort_id='test', generation_mode='native',
        model_set_signature='test', target_semantic_version='test')
    assert db.execute(*stage).rowcount == 0
    for statement in producer._snapshot_publish_statements(run_id=run_id, snapshot_date='2026-06-08', expected_rows=1):
        assert db.execute(*statement).rowcount == 0
    assert db.execute('SELECT COUNT(*) FROM allocator_ev_feature_snapshots').fetchone()[0] == 0
    assert db.execute('SELECT COUNT(*) FROM allocator_ev_feature_snapshot_staging').fetchone()[0] == 0
    assert db.execute('SELECT active FROM artifact_hard_references').fetchone()[0] == 0
