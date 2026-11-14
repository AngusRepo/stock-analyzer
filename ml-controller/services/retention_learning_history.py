"""D1-M3 cold Learning history for drained learning_lineage_v1 datasets (beyond predictions).

Mirrors worker/src/lib/retentionLearningColdReader.ts: only hot-window-drain archives with a
successful release proof count as history; a hot row with the same natural identity wins;
any checksum, identity or receipt gap raises instead of returning a shorter history.
"""
from __future__ import annotations
import hashlib
import json
import re
from services.retention_archive import download_archive, verify_archive
from services.retention_history import source_release_verified
from services.retention_history_keys import history_keys
from services.d1_domain_client import client_proxy_for_domain

OPS = client_proxy_for_domain('ops')
LEARNING = client_proxy_for_domain('learning')
POLICY = 'learning_lineage_v1'
SCHEMA = 'd1-retention-hot-window-drain-v1'
# Same total read budget as LEARNING_COLD_READ_BUDGET (worker/src/lib/retentionLearningColdReader.ts).
READ_BUDGET = {'bytes': 64 * 1024 * 1024, 'manifests': 512, 'rows': 200_000}
# Same per-object cap as retentionLearningColdReader.ts (drain chunks are <= 1 MiB of rows).
MAX_OBJECT_BYTES = 7 * 1024 * 1024
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

# Keep in step with LEARNING_COLD_IDENTITY (worker/src/lib/retentionLearningDrainGates.ts).
DATASETS = {
    'dataset_snapshots': ('business_date', (('snapshot_id',),)),
    's12_replay_trade_outcomes': ('trade_date', (('id',), ('symbol', 'trade_date', 'setup_id'), ('symbol', 'signal_date', 'setup_id'))),
    's12_structure_snapshots': ('trade_date', (('id',), ('trade_date', 'symbol', 'source'))),
    'strategy_decision_log': ('date', (('decision_id',), ('date', 'symbol', 'strategy_id', 'strategy_version'))),
    'strategy_label_matrix_v4': ('signal_date', (('signal_date', 'symbol', 'producer_run_id', 'strategy_id', 'strategy_version'),)),
}


def _key(columns, row):
    values = [row.get(c) for c in columns]
    return None if any(v is None for v in values) else json.dumps([','.join(columns), *values], ensure_ascii=False)


def _hot_keys(hot, dataset, rows):
    present = set()
    for columns in DATASETS[dataset][1]:
        wanted = [{c: r[c] for c in columns} for r in rows if _key(columns, r) is not None]
        join = ' AND '.join(f"t.{c} IS json_extract(j.value,'$.{c}')" for c in columns)
        for offset in range(0, len(wanted), 200):
            found = hot(f"SELECT {','.join('t.' + c for c in columns)} FROM {dataset} t JOIN json_each(?) j ON {join}",
                        [json.dumps(wanted[offset:offset + 200], ensure_ascii=False)])
            present.update(_key(columns, r) for r in found)
    return present


def archived_learning_rows(dataset, start_date, end_date, *, row_filter=None, query_ops=None, query_hot=None, download=None,
                           budget=None):
    if dataset not in DATASETS:
        raise ValueError('retention_learning_dataset_unsupported:' + str(dataset))
    if not all(isinstance(d, str) and DATE_RE.match(d) for d in (start_date, end_date)) or start_date > end_date:
        raise ValueError('retention_learning_request_invalid')
    date_column, identity = DATASETS[dataset]
    limits = budget or READ_BUDGET
    read_bytes = read_manifests = read_rows = 0
    ops = query_ops or OPS.query
    hot = query_hot or LEARNING.query
    fetch = download or download_archive
    domain = f'retention_{POLICY}_{dataset}'
    last = ''
    # Rows of exported-but-never-released chunks that are absent from hot; resolved after the scan.
    unreleased = []
    with history_keys() as remember:
        while True:
            manifests = ops("""SELECT a.artifact_id,a.domain,a.schema_version,a.checksum,a.row_count,a.byte_size,a.metadata_json,
               (SELECT MAX(i.completed_at) FROM data_retention_run_items i
                 WHERE i.status='success' AND i.deleted_rows=a.row_count
                   AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.artifact_id') END=a.artifact_id
                   AND CASE WHEN json_valid(i.evidence_json) THEN json_extract(i.evidence_json,'$.checksum') END=a.checksum) release_verified_at
               FROM run_artifacts a
               WHERE a.domain=? AND a.schema_version=? AND a.retention_class='ten_year_cold_archive' AND a.status='ready'
                 AND a.checksum_verified_at IS NOT NULL AND a.payload_deleted_at IS NULL AND a.artifact_id>?
                 AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_end') END,'9999-12-31')>=?
                 AND COALESCE(CASE WHEN json_valid(a.metadata_json) THEN json_extract(a.metadata_json,'$.coverage_start') END,'0000-01-01')<=?
               ORDER BY a.artifact_id LIMIT 100""", [domain, SCHEMA, last, start_date, end_date])
            if not manifests:
                break
            for manifest in manifests:
                last = manifest['artifact_id']
                size = manifest.get('byte_size')
                if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_OBJECT_BYTES:
                    raise ValueError('retention_learning_archive_size_invalid')
                read_manifests += 1
                read_bytes += size
                if read_manifests > limits['manifests'] or read_bytes > limits['bytes']:
                    raise RuntimeError('retention_learning_read_budget_exceeded:' + dataset)
                raw = fetch(manifest)
                if len(raw) != size:
                    raise ValueError('retention_learning_archive_size_invalid')
                payload = verify_archive(raw, manifest)
                cutoff = payload.get('cutoff_date')
                if (payload['dataset_id'] != dataset or payload['source_domain'] != 'learning'
                        or payload.get('policy_id') != POLICY or not isinstance(cutoff, str) or not DATE_RE.match(cutoff)):
                    raise ValueError('retention_learning_source_mismatch')
                relevant = []
                rowids = set()
                for row in payload['rows']:
                    when = str(row.get(date_column) or '')[:10]
                    rowid = row.get('__cursor_key')
                    if (not isinstance(rowid, int) or isinstance(rowid, bool) or rowid in rowids
                            or row.get('__archive_date') != when or not DATE_RE.match(when) or when >= cutoff):
                        raise ValueError('retention_learning_row_identity_invalid')
                    rowids.add(rowid)
                    if not start_date <= when <= end_date:
                        continue
                    clean = {k: v for k, v in row.items() if k not in {'__cursor_key', '__archive_date'}}
                    if row_filter is not None and not row_filter(clean):
                        continue
                    relevant.append((rowid, clean))
                read_rows += len(relevant)
                if read_rows > limits['rows']:
                    raise RuntimeError('retention_learning_read_budget_exceeded:' + dataset)
                if not relevant:
                    continue
                present = _hot_keys(hot, dataset, [r for _, r in relevant])
                missing = [(rowid, r) for rowid, r in relevant
                           if not any(_key(c, r) in present for c in identity if _key(c, r) is not None)]
                if not missing:
                    continue
                if not manifest.get('release_verified_at') and not source_release_verified(hot, manifest, 'learning', dataset):
                    if _receipt_exists(hot, manifest['artifact_id']):  # a receipt that disagrees with its manifest
                        raise RuntimeError('retention_learning_release_receipt_incomplete:' + manifest['artifact_id'])
                    # Never released (DELETE and receipt commit together): history only if a released
                    # chunk serves the same identity, checked after every manifest has been read.
                    unreleased.extend((_identity(identity, rowid, clean), _digest(clean)) for rowid, clean in missing)
                    continue
                for rowid, clean in missing:
                    if remember(_identity(identity, rowid, clean), _digest(clean)):
                        yield {**clean, '__source_rowid': rowid}
            if len(manifests) < 100:
                break
        for key, digest in unreleased:
            try:
                new = remember(key, digest)
            except RuntimeError:  # a released chunk holds a newer version of this identity
                continue
            if new:
                raise RuntimeError('retention_learning_release_receipt_incomplete:' + dataset)


def _receipt_exists(hot, artifact_id):
    table = 'learning_retention_releases_v1'
    if not hot("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]):
        return False
    return bool(hot(f'SELECT 1 AS present FROM {table} WHERE artifact_id=?', [artifact_id]))


def _identity(identity, rowid, row):
    return _key(identity[0], row) or json.dumps(['rowid', rowid])


def _digest(row):
    return hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).digest()
