"""Immutable NAV cold payloads with bounded D1 read views.

The original manifest, checksum and prospective clock never change. Full payloads
are gzip objects under a held, content-addressed prefix. A view is explicitly a
projection, never passed off as the original payload checksum.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

PREFIX = 'paired-nav-cold/v1/'
COLD_DAYS = 3650
VIEW_LIMIT = 2 * 1024 * 1024
TABLE = 'paired_nav_cold_objects_v1'


def available(query):
    return bool(query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [TABLE]))


def production_store():
    bucket_name = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not bucket_name:
        return None
    from google.cloud import storage
    return ColdObjects(storage.Client().bucket(bucket_name))


class ColdObjects:
    def __init__(self, bucket):
        self.bucket = bucket

    def put(self, path, checksum):
        from google.api_core.exceptions import PreconditionFailed
        key = PREFIX + checksum + '.json.gz'
        blob = self.bucket.blob(key, chunk_size=8 * 1024 * 1024)
        # Object hold protects this prefix from unrelated bucket lifecycle rules.
        # Release is a separately governed operation after the retention deadline.
        try:
            blob.upload_from_filename(path, content_type='application/gzip', if_generation_match=0)
        except PreconditionFailed:
            pass  # Immutable retry; verify the existing object below.
        blob.reload()
        if blob.temporary_hold is not True:
            # Python Storage uploads omit temporaryHold from writable metadata.
            # Explicitly patch the observed object generation before publication.
            generation, metageneration = blob.generation, blob.metageneration
            blob.temporary_hold = True
            blob.patch(if_generation_match=generation, if_metageneration_match=metageneration)
            blob.reload()
        if blob.temporary_hold is not True:
            raise RuntimeError('paired_nav_cold_object_hold_missing')
        return key

    def download(self, key, path):
        if not key.startswith(PREFIX) or '..' in key:
            raise ValueError('paired_nav_cold_key_invalid')
        self.bucket.blob(key, chunk_size=8 * 1024 * 1024).download_to_filename(path)


def _canonical(value):
    return json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).iterencode(value)


@contextmanager
def packed(pieces):
    """Bounded serialization; never construct a second full raw JSON string."""
    with tempfile.TemporaryDirectory(prefix='nav-cold-') as directory:
        path = os.path.join(directory, 'payload.gz')
        hasher, size, chars = hashlib.sha256(), 0, 0
        with open(path, 'wb') as output:
            with gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as zipped:
                for piece in pieces:
                    # iterencode can emit a large single string: bound encoding copies.
                    for start in range(0, len(piece), 20000):
                        chunk = piece[start:start + 20000]
                        raw = chunk.encode('utf-8')
                        hasher.update(raw); size += len(raw); chars += len(chunk)
                        zipped.write(raw)
        yield path, hasher.hexdigest(), size, max(1, (chars + 19999) // 20000)


@contextmanager
def verified_file(store, key, checksum, byte_count):
    with tempfile.TemporaryDirectory(prefix='nav-read-') as directory:
        path = os.path.join(directory, 'payload.gz')
        store.download(key, path)
        hasher, size = hashlib.sha256(), 0
        with gzip.open(path, 'rb') as source:
            while raw := source.read(1024 * 1024):
                size += len(raw)
                if size > byte_count:
                    raise RuntimeError('paired_nav_cold_size_mismatch')
                hasher.update(raw)
        if size != byte_count or hasher.hexdigest() != checksum:
            raise RuntimeError('paired_nav_cold_checksum_mismatch')
        yield path


def parse_file(path):
    import ijson
    with gzip.open(path, 'rb') as source:
        # JSON floats match the original json.loads contract, not Decimal.
        iterator = ijson.items(source, '', use_float=False)
        value = next(iterator)
        if next(iterator, None) is not None:
            raise RuntimeError('paired_nav_cold_multiple_payloads')
        from decimal import Decimal
        pending = [value]
        while pending:
            container = pending.pop()
            entries = container.items() if isinstance(container, dict) else enumerate(container) if isinstance(container, list) else ()
            for key, child in entries:
                if isinstance(child, Decimal):
                    container[key] = float(child)
                elif isinstance(child, (dict, list)):
                    pending.append(child)
        return value



def migration_payload(path, kind):
    """Read only the bounded D1 projection when migrating a large context.

    The packed original was already checksum-verified and is archived unchanged.
    Reconstructing its complete history in Python is unnecessary for this step.
    """
    if kind != 'allocation_context':
        return parse_file(path)
    import ijson
    from decimal import Decimal
    wanted = {'schema_version', 'snapshot_kind', 'signal_date', 'source_run_id'}
    wanted.update('content.' + k for k in ('upstream_allocation_context_snapshot_id',
        'trading_config', 'risk_config', 'formal_baseline_identity', 'opb_control_execution'))
    wanted.update('content.inputs.' + k for k in ('nav_control_context', 'ranking_config', 'ensemble_v2_cfg'))
    wanted.update('content.capture.' + k for k in ('status', 'allocation_contract'))
    wanted.add('content.capture.opb_packet.status')
    wanted.update('content.capture.opb_packet.prior_artifact.' + k for k in
        ('production_control_ready', 'candidate_checksum', 'publication_receipt_checksum'))
    payload, builder, selected, depth = {'content': {}}, None, None, 0
    def assign(key, value):
        parent = payload
        parts = key.split('.')
        for part in parts[:-1]:
            parent = parent.setdefault(part, {})
        parent[parts[-1]] = value
    with gzip.open(path, 'rb') as source:
        for prefix, event, value in ijson.parse(source, use_float=False):
            if isinstance(value, Decimal):
                value = float(value)
            if builder is None and prefix in wanted:
                selected, builder, depth = prefix, ijson.ObjectBuilder(), 0
            if builder is not None:
                builder.event(event, value)
                depth += int(event in ('start_map', 'start_array')) - int(event in ('end_map', 'end_array'))
                if depth == 0:
                    assign(selected, builder.value)
                    builder = None
            elif prefix == 'content.capture.allocation_candidates' and event == 'start_array':
                assign(prefix, [])
            elif prefix == 'content.capture.allocation_candidates.item' and event not in ('end_map', 'end_array'):
                assign('content.capture.allocation_candidates', [None])
    return payload


def view_for(payload):
    kind = payload['snapshot_kind']
    if kind == 'execution_pair':
        return None  # Python execution consumes the full cold object.
    if kind == 'allocation_pair':
        content = payload['content']
        view = {k: content[k] for k in ('owner', 'candidate_checksum',
            'candidate_artifact_id', 'baseline_checksum', 'configuration_checksum', 'pair_id',
            'configuration', 'route_effect') if k in content}
        tag = ((content.get('configuration') or {}).get('strategy_bundle') or {}).get('strategy_ab') or {}
        if tag.get('role') == 'B' and (tag.get('baseline_primary') or {}).get('role') == 'A':
            view['allocation_preview'] = {role: [
                {key: row[key] for key in ('symbol', 'allocation_weight')}
                for row in (content[arm]['output'])]
                for role, arm in (('A', 'baseline'), ('B', 'candidate'))}
        return {**payload, 'content': view}
    if kind != 'allocation_context':
        return payload  # Allocation plans and fill receipts preserve original bytes.
    content = payload['content']
    inputs, capture = content.get('inputs') or {}, content.get('capture') or {}
    parent = {k: content[k] for k in ('upstream_allocation_context_snapshot_id', 'trading_config',
        'risk_config', 'formal_baseline_identity', 'opb_control_execution') if k in content}
    parent['inputs'] = {k: inputs[k] for k in ('nav_control_context', 'ranking_config', 'ensemble_v2_cfg') if k in inputs}
    parent['capture'] = {k: capture[k] for k in ('status', 'allocation_contract') if k in capture}
    # Only emptiness matters; never turn missing/invalid candidates into an empty pool.
    candidates = capture.get('allocation_candidates')
    if isinstance(candidates, list):
        parent['capture']['allocation_candidates'] = [] if not candidates else [None]
    packet = capture.get('opb_packet') or {}
    parent['capture']['opb_packet'] = {'status': packet.get('status'), 'prior_artifact': {
        k: (packet.get('prior_artifact') or {}).get(k) for k in
        ('production_control_ready', 'candidate_checksum', 'publication_receipt_checksum')}}
    return {**payload, 'content': parent}


def _row(query, snapshot_id):
    rows = query('SELECT * FROM paired_nav_cold_objects_v1 WHERE snapshot_id=?', [snapshot_id])
    return rows[0] if len(rows) == 1 else None


def load(query, manifest, store=None, *, materialize=True):
    if not available(query):
        return None
    row = _row(query, manifest['snapshot_id'])
    if row is None:
        return None
    if row['payload_checksum'] != manifest['payload_checksum']:
        raise RuntimeError('paired_nav_cold_manifest_mismatch')
    store = store or production_store()
    if store is None:
        raise RuntimeError('paired_nav_cold_store_unavailable')
    with verified_file(store, row['object_key'], row['payload_checksum'], row['payload_bytes']) as path:
        return parse_file(path) if materialize else True


def seal(*, query, writer, snapshot_id, payload, store, stamp, packed_payload=None):
    from services.paired_nav_journal import _write, encode
    if not available(query):
        raise RuntimeError('paired_nav_cold_migration_0048_missing')
    view = view_for(payload)
    raw_view = encode(view) if view is not None else ''
    if len(raw_view.encode('utf-8')) > VIEW_LIMIT:
        raise RuntimeError('paired_nav_cold_view_too_large')
    def publish(bundle):
        path, checksum, size, part_count = bundle
        old = _row(query, snapshot_id)
        if old and old['payload_checksum'] != checksum:
            raise RuntimeError('paired_nav_cold_immutable_conflict')
        key = store.put(path, checksum)
        with verified_file(store, key, checksum, size):
            pass
        chunks = [raw_view[i:i + 20000] for i in range(0, len(raw_view), 20000)]
        view_checksum = hashlib.sha256(raw_view.encode('utf-8')).hexdigest()
        for start in range(0, len(chunks), 10):
            _write(writer, [('INSERT OR IGNORE INTO paired_nav_cold_views_v1(snapshot_id,part_no,payload_text) VALUES(?,?,?)',
                [snapshot_id, i, chunks[i]]) for i in range(start, min(start + 10, len(chunks)))])
        rows = query('SELECT part_no,payload_text FROM paired_nav_cold_views_v1 WHERE snapshot_id=? ORDER BY part_no', [snapshot_id])
        if [r['part_no'] for r in rows] != list(range(len(chunks))) or ''.join(r['payload_text'] for r in rows) != raw_view:
            raise RuntimeError('paired_nav_cold_view_readback_failed')
        columns = ('snapshot_id,payload_checksum,object_key,payload_bytes,original_part_count,'
            'view_kind,view_checksum,view_part_count,verified_at,retain_until')
        values = [snapshot_id, checksum, key, size, part_count,
            'opb_context_v1' if payload['snapshot_kind'] == 'allocation_context' else 'allocation_proof_v1' if payload['snapshot_kind'] == 'allocation_pair' else 'full' if view is not None else 'none',
            view_checksum, len(chunks), stamp.isoformat(), (stamp + timedelta(days=COLD_DAYS)).isoformat()]
        _write(writer, [(f'INSERT OR IGNORE INTO {TABLE}({columns}) VALUES({",".join("?" for _ in values)})', values)])
        row = _row(query, snapshot_id)
        if not row or any(row[k] != v for k, v in zip(columns.split(',')[:8], values[:8])):
            raise RuntimeError('paired_nav_cold_receipt_readback_failed')
        return row
    if packed_payload is not None:
        return publish(packed_payload)
    with packed(_canonical(payload)) as bundle:
        return publish(bundle)


def legacy_pieces(query, snapshot_id, count=None):
    cursor = -1
    while True:
        rows = query('SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? AND part_no>? ORDER BY part_no LIMIT 50', [snapshot_id, cursor])
        if not rows:
            break
        for row in rows:
            if row['part_no'] != cursor + 1:
                raise RuntimeError('paired_nav_parts_incomplete')
            cursor = row['part_no']
            yield row['payload_text']
    if count is not None and cursor + 1 != count:
        raise RuntimeError('paired_nav_parts_incomplete')


def migrate_snapshot(*, query, writer, snapshot_id, store=None, now=None):
    """Archive + verify only. Original manifest and hot payload stay untouched."""
    rows = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
    if len(rows) != 1:
        raise RuntimeError('paired_nav_orphan_requires_recovery_not_migration')
    manifest = rows[0]
    store = store or production_store()
    if store is None:
        raise RuntimeError('paired_nav_cold_store_unavailable')
    if _row(query, snapshot_id):
        load(query, manifest, store, materialize=False)
        return _row(query, snapshot_id)
    with packed(legacy_pieces(query, snapshot_id, manifest['part_count'])) as bundle:
        if bundle[1] != manifest['payload_checksum']:
            raise RuntimeError('paired_nav_snapshot_checksum_mismatch')
        payload = migration_payload(bundle[0], manifest['snapshot_kind'])
        if any(payload[k] != manifest[k] for k in ('snapshot_kind', 'signal_date', 'source_run_id')):
            raise RuntimeError('paired_nav_manifest_identity_mismatch')
        return seal(query=query, writer=writer, snapshot_id=snapshot_id, payload=payload, store=store,
            stamp=now or datetime.now(timezone.utc), packed_payload=bundle)


def release_hot_copy(*, query, writer, snapshot_id, expected_checksum, approval_id, store=None):
    """Explicitly approved, exact-object retirement after fresh cold readback.

    Hard references still resolve through the unchanged manifest and cold reader.
    Missing-manifest rows are never eligible for this deletion path.
    """
    from services.paired_nav_journal import _write
    if not isinstance(approval_id, str) or not approval_id.strip():
        raise ValueError('paired_nav_hot_release_approval_required')
    rows = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
    if len(rows) != 1 or rows[0]['payload_checksum'] != expected_checksum:
        raise RuntimeError('paired_nav_hot_release_identity_invalid')
    receipt = _row(query, snapshot_id)
    if not receipt or receipt['payload_checksum'] != expected_checksum:
        raise RuntimeError('paired_nav_hot_release_cold_missing')
    store = store or production_store()
    if store is None:
        raise RuntimeError('paired_nav_cold_store_unavailable')
    released = query('SELECT snapshot_id FROM paired_nav_hot_releases_v1 WHERE snapshot_id=?', [snapshot_id])
    with verified_file(store, receipt['object_key'], expected_checksum, receipt['payload_bytes']) as path:
        if not released:
            # Works for both full old copies and a verified recovered prefix.
            # A previously approved interrupted release resumes exact remaining rows.
            with gzip.open(path, 'rt', encoding='utf-8', newline='') as source:
                for piece in legacy_pieces(query, snapshot_id):
                    if source.read(len(piece)) != piece:
                        raise RuntimeError('paired_nav_hot_release_source_mismatch')
    _write(writer, [('INSERT OR IGNORE INTO paired_nav_hot_releases_v1(snapshot_id,payload_checksum,approval_id) VALUES(?,?,?)',
        [snapshot_id, expected_checksum, approval_id])])
    removed = 0
    while True:
        # The release receipt fences all inserts; original triggers fence updates.
        # Delete only selected immutable keys, without retransmitting MB of text.
        parts = query('SELECT part_no FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no LIMIT 250', [snapshot_id])
        if not parts:
            break
        keys = json.dumps([row['part_no'] for row in parts])
        _write(writer, [('DELETE FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? AND part_no IN (SELECT value FROM json_each(?))',
            [snapshot_id, keys])])
        if query('SELECT part_no FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? AND part_no<=? LIMIT 1', [snapshot_id, parts[-1]['part_no']]):
            raise RuntimeError('paired_nav_hot_release_readback_failed')
        removed += len(parts)
    return {'snapshot_id': snapshot_id, 'deleted_parts': removed, 'payload_checksum': expected_checksum}
