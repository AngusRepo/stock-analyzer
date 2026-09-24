from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import gzip
import hashlib
import json
import sqlite3
import tracemalloc

import pytest

from services import paired_nav_cold as cold
from services.paired_nav_journal import freeze_snapshot, read_snapshot, reuse_frozen_snapshot, encode, digest
from test_paired_nav_journal import DB, NOW


class Objects:
    def __init__(self):
        self.data = {}
        self.broken = False
    def put(self, path, checksum):
        key = cold.PREFIX + checksum + '.json.gz'
        self.data.setdefault(key, Path(path).read_bytes())
        return key
    def download(self, key, path):
        Path(path).write_bytes(b'broken' if self.broken else self.data[key])


@pytest.fixture
def env(monkeypatch):
    db, objects = DB(), Objects()
    migration = Path(__file__).parents[2] / 'worker/domain-migrations/learning/0048_paired_nav_cold_storage.sql'
    db.conn.executescript(migration.read_text(encoding='utf-8'))
    monkeypatch.setattr(cold, 'production_store', lambda: objects)
    return db, objects


def freeze(db, content=None, kind='allocation_context', run='fixture'):
    return freeze_snapshot(signal_date='2026-09-09', source_run_id=run, snapshot_kind=kind,
        content=content or {'value': 1}, query=db.query, writer=db.writer, now=NOW)


def test_cold_write_roundtrip_no_hot_payload_and_idempotent_clock(env):
    db, objects = env
    content = {'history': ['台股 α ' + str(i) for i in range(20000)], 'float': 1.23, 'huge': 10 ** 40}
    manifest = freeze(db, content)
    assert db.query('SELECT * FROM paired_nav_frozen_parts_v1', []) == []
    assert read_snapshot(db.query, manifest['snapshot_id'])['payload']['content'] == content
    assert freeze(db, content) == manifest
    receipt = db.query('SELECT * FROM paired_nav_cold_objects_v1', [])[0]
    assert receipt['view_kind'] == 'opb_context_v1'
    assert receipt['payload_bytes'] > 250000
    assert len(db.query('SELECT * FROM paired_nav_cold_views_v1', [])) == 1
    assert len(objects.data) == 1
    with pytest.raises(RuntimeError, match='immutable'):
        freeze(db, {'changed': True})


def test_large_parent_is_parsed_once_per_shadow_scope(env, monkeypatch):
    db, objects = env
    parent = freeze(db, {'history': list(range(1000))}, run='parent')
    other = freeze(db, {'value': 2}, run='other')
    downloads = []
    original_download = objects.download

    def counted_download(key, path):
        downloads.append(key)
        original_download(key, path)

    monkeypatch.setattr(objects, 'download', counted_download)
    with reuse_frozen_snapshot(parent['snapshot_id']):
        first = read_snapshot(db.query, parent['snapshot_id'])
        assert read_snapshot(db.query, parent['snapshot_id']) is first
        read_snapshot(db.query, other['snapshot_id'])
        read_snapshot(db.query, other['snapshot_id'])
    assert len(downloads) == 3
    assert read_snapshot(db.query, parent['snapshot_id']) is not first
    assert len(downloads) == 4


def test_corrupt_or_missing_cold_never_falls_back_to_hot(env):
    db, objects = env
    manifest = freeze(db)
    key = next(iter(objects.data))
    objects.data[key] = gzip.compress(b'{}')
    with pytest.raises(RuntimeError, match='cold_checksum'):
        read_snapshot(db.query, manifest['snapshot_id'])
    del objects.data[key]
    with pytest.raises(KeyError):
        read_snapshot(db.query, manifest['snapshot_id'])


def test_upload_readback_failure_does_not_publish_manifest(env):
    db, objects = env
    objects.broken = True
    with pytest.raises(gzip.BadGzipFile):
        freeze(db)
    assert not db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])
    assert not db.query('SELECT * FROM paired_nav_cold_objects_v1', [])
    objects.broken = False
    assert freeze(db)['snapshot_id']


def test_legacy_migration_preserves_bytes_clock_and_requires_release_approval(env, monkeypatch):
    db, objects = env
    monkeypatch.setattr(cold, 'production_store', lambda: None)
    content = {'history': ['漢字' * 10000] * 5, 'price': 5.0}
    manifest = freeze(db, content)
    before = read_snapshot(db.query, manifest['snapshot_id'])
    original = deepcopy(manifest)
    monkeypatch.setattr(cold, 'production_store', lambda: objects)
    cold.migrate_snapshot(query=db.query, writer=db.writer, snapshot_id=manifest['snapshot_id'], store=objects, now=NOW)
    assert read_snapshot(db.query, manifest['snapshot_id']) == before
    assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])[0] == original
    with pytest.raises(sqlite3.IntegrityError, match='immutable_part'):
        db.conn.execute('DELETE FROM paired_nav_frozen_parts_v1')
    args = dict(query=db.query, writer=db.writer, snapshot_id=manifest['snapshot_id'], expected_checksum=manifest['payload_checksum'], store=objects)
    with pytest.raises(ValueError, match='approval_required'):
        cold.release_hot_copy(**args, approval_id='')
    result = cold.release_hot_copy(**args, approval_id='local-test-approval')
    assert result['deleted_parts'] == manifest['part_count']
    assert read_snapshot(db.query, manifest['snapshot_id']) == before
    assert cold.release_hot_copy(**args, approval_id='local-test-approval')['deleted_parts'] == 0
    with pytest.raises(sqlite3.IntegrityError, match='immutable_manifest'):
        db.conn.execute('DELETE FROM paired_nav_frozen_manifests_v1')
    with pytest.raises(sqlite3.IntegrityError, match='immutable_cold'):
        db.conn.execute('UPDATE paired_nav_cold_objects_v1 SET payload_checksum=?', ['a' * 64])


def test_incomplete_legacy_prefix_recovers_only_same_input(env):
    db, _ = env
    content = {'history': '台股' * 30000}
    payload = dict(schema_version='paired-nav-journal-v1', snapshot_kind='allocation_context',
        signal_date='2026-09-09', source_run_id='fixture', content=content)
    snapshot_id = digest(['allocation_context', '2026-09-09', 'fixture'])
    db.writer([('INSERT INTO paired_nav_frozen_parts_v1 VALUES(?,?,?)', [snapshot_id, 0, encode(payload)[:20000]])])
    with pytest.raises(RuntimeError, match='orphan_requires_recovery'):
        cold.migrate_snapshot(query=db.query, writer=db.writer, snapshot_id=snapshot_id)
    with pytest.raises(RuntimeError, match='orphan_input_conflict'):
        freeze(db, {'other': 1})
    assert not db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])
    assert freeze(db, content)['snapshot_id'] == snapshot_id
    assert read_snapshot(db.query, snapshot_id)['payload'] == payload
    result = cold.release_hot_copy(query=db.query, writer=db.writer, snapshot_id=snapshot_id,
        expected_checksum=digest(payload), approval_id='recovered-prefix-fixture')
    assert result['deleted_parts'] == 1
    with pytest.raises(sqlite3.IntegrityError, match='hot_copy_retired'):
        db.conn.execute('INSERT INTO paired_nav_frozen_parts_v1 VALUES(?,?,?)', [snapshot_id, 0, 'stale writer'])


def test_views_preserve_required_fields_and_receipt_number_spelling(env):
    db, _ = env
    content = {'owner':'l4', 'configuration': {'price': 5.0}, 'route_effect': {'screener_run_id': 'x'},
        'unused_history': ['data'] * 20000}
    manifest = freeze(db, content, kind='allocation_pair')
    row = db.query('SELECT * FROM paired_nav_cold_objects_v1', [])[0]
    assert row['view_kind'] == 'allocation_proof_v1'
    view = ''.join(r['payload_text'] for r in db.query('SELECT * FROM paired_nav_cold_views_v1 ORDER BY part_no', []))
    assert json.loads(view)['content'] == {k: v for k, v in content.items() if k != 'unused_history'}
    receipt = freeze(db, {'price': 5.0, 'snapshot_id': 'parent'}, kind='execution_receipt', run='receipt')
    raw = ''.join(r['payload_text'] for r in db.query('SELECT * FROM paired_nav_cold_views_v1 WHERE snapshot_id=? ORDER BY part_no', [receipt['snapshot_id']]))
    assert '5.0' in raw and hashlib.sha256(raw.encode()).hexdigest() == receipt['payload_checksum']


def test_allocation_proof_excludes_unbounded_policy_but_retains_full_cold_payload(env):
    db, _ = env
    policy = {'model_payload': 'x' * (3 * 1024 * 1024)}
    configuration = {'allocator_policies': policy, 'trading_config': {'cap': .5},
                     'formal_baseline_identity': {'artifact_id': 'baseline'}}
    content = {'owner': 'ensemble', 'configuration': configuration,
               'configuration_checksum': digest(configuration), 'pair_id': 'large-policy'}
    manifest = freeze(db, content, kind='allocation_pair')
    raw = ''.join(row['payload_text'] for row in db.query(
        'SELECT payload_text FROM paired_nav_cold_views_v1 WHERE snapshot_id=? ORDER BY part_no',
        [manifest['snapshot_id']]))
    view = json.loads(raw)['content']
    assert len(raw.encode('utf-8')) < cold.VIEW_LIMIT
    assert view['configuration'] == {k: v for k, v in configuration.items()
                                     if k != 'allocator_policies'}
    assert view['configuration_checksum'] == digest(configuration)
    assert read_snapshot(db.query, manifest['snapshot_id'])['payload']['content'] == content


def test_large_strategy_bundle_uses_compact_proof_without_changing_cold_policy(env):
    db, _ = env
    bundle = {'schema_version': 'paired-nav-strategy-bundle-v1',
        'baseline_l3_identity': {'artifact_id': 'baseline'},
        'candidate_l3_identity': {'artifact_id': 'candidate'},
        'bundle_checksum': 'b' * 64,
        'strategy_ab': {'role': 'B', 'baseline_primary': {'role': 'A'}},
        'baseline_trading_config': {'policy': 'x' * 100000},
        'candidate_trading_config': {'l4Distribution': {'runtime': 'y' * 2500000}}}
    configuration = {'strategy_bundle': bundle, 'trading_config': {'cap': .5}}
    content = {'owner': 'ensemble', 'configuration': configuration,
        'configuration_checksum': digest(configuration), 'pair_id': 'large-strategy',
        'baseline': {'output': [{'symbol': '2485', 'allocation_weight': .25}]},
        'candidate': {'output': [{'symbol': '6538', 'allocation_weight': .17}]}}
    manifest = freeze(db, content, kind='allocation_pair')
    raw = ''.join(row['payload_text'] for row in db.query(
        'SELECT payload_text FROM paired_nav_cold_views_v1 WHERE snapshot_id=? ORDER BY part_no',
        [manifest['snapshot_id']]))
    proof = json.loads(raw)['content']
    assert len(raw.encode('utf-8')) < cold.VIEW_LIMIT
    assert proof['configuration']['strategy_bundle'] == {
        k: bundle[k] for k in ('schema_version', 'baseline_l3_identity',
                               'candidate_l3_identity', 'bundle_checksum', 'strategy_ab')}
    assert proof['configuration_checksum'] == digest(configuration)
    assert read_snapshot(db.query, manifest['snapshot_id'])['payload']['content'] == content


def test_large_serialization_does_not_allocate_second_full_json():
    content = {'history': [{'symbol': str(i), 'values': list(range(100))} for i in range(10000)]}
    tracemalloc.start()
    with cold.packed(cold._canonical(content)) as bundle:
        _, peak = tracemalloc.get_traced_memory()
        assert bundle[2] > 3000000
        assert peak < 2 * 1024 * 1024
    tracemalloc.stop()


def test_missing_migration_blocks_new_cold_writes(monkeypatch):
    monkeypatch.setattr(cold, 'production_store', lambda: Objects())
    with pytest.raises(RuntimeError, match='migration_0048_missing'):
        freeze(DB())


def test_cold_object_create_only_and_hold_fail_closed(tmp_path):
    from google.api_core.exceptions import PreconditionFailed
    class Blob:
        temporary_hold = None
        existing = False
        retained = False
        patch_effective = True
        generation = 123
        metageneration = 1
        def patch(self, **kwargs):
            assert kwargs == {'if_generation_match': 123, 'if_metageneration_match': 1}
            assert self.temporary_hold is True
            if self.patch_effective:
                self.retained = True
        def upload_from_filename(self, path, **kwargs):
            assert kwargs['if_generation_match'] == 0
            if self.existing:
                raise PreconditionFailed('exists')
            self.existing = True
        def reload(self):
            self.temporary_hold = self.retained
    blob = Blob()
    class Bucket:
        def blob(self, key, **kwargs):
            assert key.startswith(cold.PREFIX)
            return blob
    store = cold.ColdObjects(Bucket())
    path = tmp_path / 'payload'
    path.write_bytes(b'fixture')
    assert store.put(path, 'a' * 64) == store.put(path, 'a' * 64)
    blob.retained = False
    blob.patch_effective = False
    with pytest.raises(RuntimeError, match='hold_missing'):
        store.put(path, 'a' * 64)


def test_idempotent_cold_retry_does_not_materialize_second_payload(env, monkeypatch):
    db, _ = env
    original = freeze(db, {'history': list(range(1000))})
    def forbidden(*args):
        raise AssertionError('retry allocated another full Python payload')
    monkeypatch.setattr(cold, 'parse_file', forbidden)
    assert freeze(db, {'history': list(range(1000))}) == original


def test_context_migration_projection_equals_full_view_without_materialization(env, monkeypatch):
    db, objects = env
    content = {'inputs': {'nav_control_context': {'value': 5.5}, 'history': ['large'] * 10000},
        'capture': {'status': 'ready', 'allocation_candidates': [{'symbol': '1234'}],
            'allocation_contract': {'count': 2}, 'opb_packet': {'status': 'ready',
                'prior_artifact': {'production_control_ready': True, 'candidate_checksum': 'x'}}},
        'risk_config': {'cap': 0.68}, 'ignored': ['unused'] * 10000}
    monkeypatch.setattr(cold, 'production_store', lambda: None)
    manifest = freeze(db, content)
    original = read_snapshot(db.query, manifest['snapshot_id'])['payload']
    monkeypatch.setattr(cold, 'parse_file', lambda path: (_ for _ in ()).throw(AssertionError('full materialization')))
    cold.migrate_snapshot(query=db.query, writer=db.writer, snapshot_id=manifest['snapshot_id'], store=objects, now=NOW)
    raw = ''.join(row['payload_text'] for row in db.query('SELECT payload_text FROM paired_nav_cold_views_v1 ORDER BY part_no', []))
    assert json.loads(raw) == cold.view_for(original)


def test_release_resumes_after_committed_delete_with_lost_response(env, monkeypatch):
    db, objects = env
    monkeypatch.setattr(cold, 'production_store', lambda: None)
    manifest = freeze(db, {'history': 'x' * 5100000})
    cold.migrate_snapshot(query=db.query, writer=db.writer, snapshot_id=manifest['snapshot_id'], store=objects, now=NOW)
    def interrupted(statements):
        result = db.writer(statements)
        if statements[0][0].startswith('DELETE'):
            raise RuntimeError('response_lost')
        return result
    args = dict(query=db.query, snapshot_id=manifest['snapshot_id'], expected_checksum=manifest['payload_checksum'],
        approval_id='local-interrupted-release', store=objects)
    with pytest.raises(RuntimeError, match='response_lost'):
        cold.release_hot_copy(**args, writer=interrupted)
    remaining = db.query('SELECT COUNT(*) n FROM paired_nav_frozen_parts_v1', [])[0]['n']
    assert remaining == manifest['part_count'] - 250 and remaining > 0
    result = cold.release_hot_copy(**args, writer=db.writer)
    assert result['deleted_parts'] == remaining
    assert cold.load(db.query, manifest, objects, materialize=False) is True


def test_ab_allocation_preview_preserves_weights_without_large_inputs(env):
    db, _ = env
    content = {'configuration': {'strategy_bundle': {'strategy_ab': {
        'role': 'B', 'baseline_primary': {'role': 'A'}}}},
        'baseline': {'output': [{'symbol': '2485', 'allocation_weight': .25, 'history': list(range(10000))}]},
        'candidate': {'output': [{'symbol': '6538', 'allocation_weight': .17, 'history': list(range(10000))}]}}
    manifest = freeze(db, content, kind='allocation_pair')
    raw = ''.join(row['payload_text'] for row in db.query(
        'SELECT * FROM paired_nav_cold_views_v1 WHERE snapshot_id=? ORDER BY part_no', [manifest['snapshot_id']]))
    preview = json.loads(raw)['content']['allocation_preview']
    assert preview == {'A': [{'symbol': '2485', 'allocation_weight': .25}],
                       'B': [{'symbol': '6538', 'allocation_weight': .17}]}
    assert len(raw) < 2000
    assert read_snapshot(db.query, manifest['snapshot_id'])['payload']['content'] == content


def test_inventory_projection_verifies_full_object_and_excludes_history(env):
    from services.paired_nav_journal import read_inventory_snapshot
    db, objects = env
    content = {'upstream_allocation_context_snapshot_id': 'parent',
        'recommendation_context': {'inputs': {'screener_recs': [{'symbol': '2330', 'value': 1.23}],
            'payloads': {'history': list(range(10000))}},
            'l3_candidate_selection': {'status': 'failed', 'reason': 'preserved'}},
        'inputs': {'return_history': list(range(10000))}}
    manifest = freeze(db, content)
    projected = read_inventory_snapshot(db.query, manifest['snapshot_id'])
    assert projected['read_projection'] == 'selection_inventory_v1'
    assert projected['manifest'] == manifest
    context = projected['payload']['content']
    assert 'inputs' not in context
    assert context['recommendation_context']['inputs'] == {'screener_recs': [{'symbol': '2330', 'value': 1.23}]}
    assert context['recommendation_context']['l3_candidate_selection'] == content['recommendation_context']['l3_candidate_selection']
    assert read_snapshot(db.query, manifest['snapshot_id'])['payload']['content'] == content
    # Even corruption in omitted history must invalidate the projection.
    key = next(iter(objects.data))
    raw = gzip.decompress(objects.data[key]).replace(b'9999', b'9998')
    objects.data[key] = gzip.compress(raw)
    with pytest.raises(RuntimeError, match='checksum_mismatch'):
        read_inventory_snapshot(db.query, manifest['snapshot_id'])


def test_stream_decode_matches_json_numbers_and_shared_keys(tmp_path):
    payload = {'rows': [{'repeated_key': 0.1234567890123456, 'integer': 10**40,
        'array': [None, False, -0.0, 1e-250, 1e250]} for _ in range(4)]}
    path = tmp_path / 'payload.gz'
    path.write_bytes(gzip.compress(encode(payload).encode()))
    result = cold.parse_file(path)
    assert encode(result) == encode(payload)
    assert type(result) is dict and type(result['rows'][0]) is dict
    first_key = next(iter(result['rows'][0]))
    assert next(iter(result['rows'][1])) is first_key
