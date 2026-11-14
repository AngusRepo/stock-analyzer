"""D1-M3: Python cold read of drained Learning datasets == the hot read before the drain."""
import hashlib
import json
import re
import sqlite3
from pathlib import Path

import pytest

from services.retention_archive import SCHEMA
from services.retention_learning_history import DATASETS, READ_BUDGET, archived_learning_rows

LEARNING_SQL = (Path(__file__).resolve().parents[2] / 'worker' / 'domain-schemas' / 'learning.sql').read_text()


def ddl(table):
    start = LEARNING_SQL.index(f'CREATE TABLE IF NOT EXISTS {table} (')
    return LEARNING_SQL[start:LEARNING_SQL.index('\n);', start) + 3]


ROWS = {
    'dataset_snapshots': lambda n, d: {'snapshot_id': f'x_run_report:{d}:{n}', 'kind': 'x_run_report', 'business_date': d,
        'schema_version': 'r2-report-json-v1', 'row_count': 1, 'checksum': f'c{n}', 'primary_store': 'r2', 'access_tier': 'report',
        'r2_key': f'reports/{n}', 'producer_run_id': f'r{n}', 'status': 'ready', 'metadata_json': '{}'},
    's12_structure_snapshots': lambda n, d: {'id': n, 'trade_date': d, 'symbol': str(2300 + n), 'source': 's12_candidate_snapshot',
        'state': 'ready', 'ready': 1, 'invalidated': 0, 'raw_json': json.dumps({'n': n})},
    's12_replay_trade_outcomes': lambda n, d: {'id': n, 'symbol': str(2300 + n), 'market': 'LISTED', 'signal_date': d, 'trade_date': d,
        'setup_id': f's{n}', 'sample_eligible': 1, 'pnl_pct': 0.01 * n, 'source': 'replay', 'detail_json': '{"status":"x"}'},
    'strategy_decision_log': lambda n, d: {'decision_id': f'd{n}', 'date': d, 'symbol': str(2300 + n), 'strategy_id': 's',
        'strategy_version': 'v', 'strategy_status': 'active', 'alpha_bucket': 'core', 'matched': n % 2, 'reason_code': 'ok'},
    'strategy_label_matrix_v4': lambda n, d: {'signal_date': d, 'symbol': str(2300 + n), 'producer_run_id': 'p', 'strategy_id': 's',
        'strategy_version': 'v', 'strategy_status': 'active', 'alpha_bucket': 'core', 'family_id': 'f', 'production_owner': 1,
        'strategy_hit': n % 2, 'weak_label': 0.1, 'affinity': 0.5, 'position_weight': 0.2, 'overlap': 0.0, 'labeler_version': 'l',
        'strategy_registry_checksum': 'c', 'reference_contract_version': 'r'},
}


def drained(dataset):
    """Hot table with 3 old rows + 1 recent; export+delete the old rows exactly like the Worker drain."""
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute(ddl(dataset))
    db.execute(ddl('learning_retention_releases_v1'))
    date_column = DATASETS[dataset][0]
    for n, d in ((1, '2026-06-01'), (2, '2026-06-01'), (3, '2026-06-02'), (4, '2026-10-30')):
        row = ROWS[dataset](n, d)
        db.execute(f"INSERT INTO {dataset}({','.join(row)}) VALUES({','.join('?' * len(row))})", list(row.values()))
    hot_before = [dict(r) for r in db.execute(f'SELECT rowid AS __source_rowid, * FROM {dataset} ORDER BY rowid')]
    rows = [dict(r) for r in db.execute(f"SELECT rowid AS __cursor_key, substr({date_column},1,10) AS __archive_date, * FROM {dataset} "
                                        f"WHERE {date_column} < '2026-07-08' ORDER BY rowid")]
    domain = f'retention_learning_lineage_v1_{dataset}'
    payload = {'schema_version': SCHEMA, 'policy_id': 'learning_lineage_v1', 'dataset_id': dataset, 'source_domain': 'learning',
               'cutoff_date': '2026-07-08', 'source_schema_sql': ddl(dataset).replace('IF NOT EXISTS ', ''), 'rows': rows}
    raw = json.dumps({'schema_version': SCHEMA, 'domain': domain, 'business_date': '2026-11-05', 'payload': payload}).encode()
    manifest = {'artifact_id': 'a1', 'domain': domain, 'schema_version': SCHEMA, 'checksum': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                'row_count': len(rows), 'byte_size': len(raw), 'release_verified_at': None, 'metadata_json': '{}'}
    db.execute(f"DELETE FROM {dataset} WHERE rowid IN ({','.join(str(r['__cursor_key']) for r in rows)})")
    db.execute('INSERT INTO learning_retention_releases_v1(artifact_id,checksum,dataset_id,row_count) VALUES(?,?,?,?)',
               ['a1', manifest['checksum'], dataset, len(rows)])

    def hot(sql, params=()):
        return [dict(r) for r in db.execute(sql, params)]
    return db, hot, hot_before, raw, manifest


@pytest.mark.parametrize('dataset', sorted(DATASETS))
def test_cold_union_hot_equals_hot_before_drain_column_by_column_and_rowid(dataset):
    db, hot, before, raw, manifest = drained(dataset)
    cold = list(archived_learning_rows(dataset, '2000-01-01', '2099-12-31', query_ops=lambda *a: [manifest],
                                       query_hot=hot, download=lambda m: raw))
    after = hot(f'SELECT rowid AS __source_rowid, * FROM {dataset}')
    assert len(cold) == 3 and len(after) == 1
    assert sorted(cold + after, key=lambda r: r['__source_rowid']) == before


def test_hot_revision_wins_and_missing_release_proof_fails_closed():
    db, hot, before, raw, manifest = drained('strategy_decision_log')
    row = {k: v for k, v in before[0].items() if k != '__source_rowid'}
    db.execute(f"INSERT INTO strategy_decision_log({','.join(row)}) VALUES({','.join('?' * len(row))})", list(row.values()))
    read = lambda **kw: list(archived_learning_rows('strategy_decision_log', '2026-06-01', '2026-06-02', query_ops=lambda *a: [manifest],
                                                    query_hot=hot, download=lambda m: raw, **kw))
    assert [r['decision_id'] for r in read()] == ['d2', 'd3']
    assert [r['decision_id'] for r in read(row_filter=lambda r: r['symbol'] == '2303')] == ['d3']
    db.execute('DELETE FROM learning_retention_releases_v1')
    with pytest.raises(RuntimeError, match='release_receipt_incomplete'):
        read()


def test_corrupt_or_foreign_archive_never_returns_short_history():
    _, hot, _, raw, manifest = drained('dataset_snapshots')
    with pytest.raises(ValueError, match='size_invalid'):
        list(archived_learning_rows('dataset_snapshots', '2026-01-01', '2026-12-31', query_ops=lambda *a: [manifest],
                                    query_hot=hot, download=lambda m: raw + b' '))
    with pytest.raises(ValueError, match='checksum'):
        list(archived_learning_rows('dataset_snapshots', '2026-01-01', '2026-12-31', query_ops=lambda *a: [manifest],
                                    query_hot=hot, download=lambda m: raw[:-1] + b' '))
    with pytest.raises(ValueError, match='unsupported'):
        list(archived_learning_rows('canonical_selection_labels_v4', '2026-01-01', '2026-12-31'))


def test_dataset_identity_matches_worker_spec():
    source = (Path(__file__).resolve().parents[2] / 'worker' / 'src' / 'lib' / 'retentionLearningDrainGates.ts').read_text()
    for dataset, (date_column, keys) in DATASETS.items():
        block = source[source.index(f'  {dataset}: {{'):]
        block = block[:block.index('\n  },')]
        assert f"dateColumn: '{date_column}'" in block
        expected = '[' + ', '.join('[' + ', '.join(f"'{c}'" for c in k) + ']' for k in keys) + ']'
        assert re.search(r'identityKeys: ' + re.escape(expected), block), dataset


def test_read_budget_matches_worker_and_bounds_bytes_manifests_rows():
    source = (Path(__file__).resolve().parents[2] / 'worker' / 'src' / 'lib' / 'retentionLearningColdReader.ts').read_text()
    assert 'LEARNING_COLD_READ_BUDGET = { bytes: 64 * 1024 * 1024, manifests: 512, rows: 200_000 }' in source
    assert READ_BUDGET == {'bytes': 64 * 1024 * 1024, 'manifests': 512, 'rows': 200_000}
    _, hot, _, raw, manifest = drained('dataset_snapshots')
    read = lambda budget, m=manifest, data=raw: list(archived_learning_rows(
        'dataset_snapshots', '2026-01-01', '2026-12-31', query_ops=lambda *a: [m], query_hot=hot, download=lambda _: data, budget=budget))
    assert len(read({'bytes': len(raw), 'manifests': 1, 'rows': 3})) == 3
    for budget in ({'bytes': len(raw) - 1, 'manifests': 9, 'rows': 9}, {'bytes': 1e9, 'manifests': 0, 'rows': 9},
                   {'bytes': 1e9, 'manifests': 9, 'rows': 2}):
        with pytest.raises(RuntimeError, match='read_budget_exceeded'):
            read(budget)
    with pytest.raises(ValueError, match='size_invalid'):
        read(None, {**manifest, 'byte_size': len(raw) + 1})
    with pytest.raises(ValueError, match='size_invalid'):
        read(None, {**manifest, 'byte_size': None})


def _resealed(raw, manifest, mutate):
    body = json.loads(raw)
    mutate(body['payload'])
    data = json.dumps(body).encode()
    return data, {**manifest, 'byte_size': len(data), 'checksum': 'sha256:' + hashlib.sha256(data).hexdigest()}


def test_row_dates_must_be_valid_and_before_archive_cutoff():
    _, hot, _, raw, manifest = drained('strategy_decision_log')
    read = lambda data, m, start='2026-01-01', end='2026-12-31': list(archived_learning_rows(
        'strategy_decision_log', start, end, query_ops=lambda *a: [m], query_hot=hot, download=lambda _: data))

    def late(p):
        p['cutoff_date'] = '2026-06-02'
    def bad_date(p):
        p['rows'][0]['date'] = p['rows'][0]['__archive_date'] = '2026/06/01'
    def dup_rowid(p):
        p['rows'][1]['__cursor_key'] = p['rows'][0]['__cursor_key']
    # The shared archive verifier and this reader both reject these; either error is fail-closed.
    for mutate in (late, bad_date, dup_rowid):
        with pytest.raises(ValueError, match='row_identity_invalid|date_invalid'):
            read(*_resealed(raw, manifest, mutate))
    def no_cutoff(p):
        p['cutoff_date'] = '20260708'
    with pytest.raises(ValueError, match='source_mismatch'):
        read(*_resealed(raw, manifest, no_cutoff))
    for start, end in (('2026-6-1', '2026-12-31'), ('2026-12-31', '2026-01-01')):
        with pytest.raises(ValueError, match='request_invalid'):
            read(raw, manifest, start, end)


def test_unreleased_export_is_ignored_only_when_a_released_chunk_serves_its_rows():
    db, hot, _, raw, manifest = drained('dataset_snapshots')
    # An earlier drain exported the same rows (another cutoff), then stopped before its DELETE batch: no receipt.
    orphan_raw, orphan = _resealed(raw, manifest, lambda p: p.update(cutoff_date='2026-07-07'))
    orphan = {**orphan, 'artifact_id': 'a0'}
    read = lambda manifests, blobs: list(archived_learning_rows(
        'dataset_snapshots', '2026-01-01', '2026-12-31', query_ops=lambda *a: manifests, query_hot=hot,
        download=lambda m: blobs[m['artifact_id']]))
    for order in ([orphan, manifest], [manifest, orphan]):
        assert len(read(order, {'a0': orphan_raw, 'a1': raw})) == 3
    # A row that only the unreleased export holds is lost history: fail closed.
    def lost(p):
        p['rows'][0].update(snapshot_id='x_run_report:2026-06-01:lost', __cursor_key=99)
    lost_raw, lost_manifest = _resealed(raw, {**manifest, 'artifact_id': 'a2'}, lost)
    with pytest.raises(RuntimeError, match='release_receipt_incomplete'):
        read([manifest, lost_manifest], {'a1': raw, 'a2': lost_raw})
    # A receipt that disagrees with its manifest is never treated as "not released".
    db.execute('INSERT INTO learning_retention_releases_v1(artifact_id,checksum,dataset_id,row_count) VALUES(?,?,?,?)',
               ['a0', 'sha256:' + '0' * 64, 'dataset_snapshots', 3])
    with pytest.raises(RuntimeError, match='release_receipt_incomplete'):
        read([orphan, manifest], {'a0': orphan_raw, 'a1': raw})


def test_object_size_cap_matches_worker():
    from services import retention_learning_history as history
    source = (Path(__file__).resolve().parents[2] / 'worker' / 'src' / 'lib' / 'retentionLearningColdReader.ts').read_text()
    assert 'const MAX_OBJECT_BYTES = 7 * 1024 * 1024' in source
    assert history.MAX_OBJECT_BYTES == 7 * 1024 * 1024
