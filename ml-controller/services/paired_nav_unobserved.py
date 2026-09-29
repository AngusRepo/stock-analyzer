"""Immutable zero-NAV closure for an expired pair with no first native frame.

This never reconstructs a quote, execution receipt, journal or NAV return.
The old pair remains in the population; a new comparison starts independently.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json

from services.paired_nav_journal import _timestamp, _write, digest, encode, read_snapshot
from services.native_paper_time import frame_capture_deadline

TABLE = 'paired_nav_unobserved_pairs_v1'


def unobserved_pair(*, execution_snapshot_id: str, query, observed_at=None):
    if not query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [TABLE]):
        return None
    rows = query(f'SELECT * FROM {TABLE} WHERE execution_snapshot_id=?', [execution_snapshot_id])
    if len(rows) > 1:
        raise ValueError('paired_nav_unobserved_duplicate')
    if not rows or observed_at is not None and _timestamp(rows[0]['recorded_at']) > observed_at:
        return None
    row = rows[0]
    body = json.loads(row['payload_json'])
    if (digest(body) != row['payload_checksum']
            or body.get('schema_version') != 'paired-nav-unobserved-first-session-v1'
            or body.get('reason') != 'first_frame_expired_without_delivery'
            or any(body.get(k) != row[k] for k in ('execution_snapshot_id', 'pair_id', 'session_date'))
            or body.get('nav_maturity_credit') != 0 or body.get('promotion_allowed') is not False
            or body.get('production_effect') is not False):
        raise ValueError('paired_nav_unobserved_receipt_corrupt')
    return body


def certify_unobserved_first_session(*, execution_snapshot_id: str, query, writer,
                                     objects, now: datetime | None = None):
    """Certify only a past first frame with no delivery or accounting evidence."""
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError('paired_nav_timezone_required')
    if not query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [TABLE]):
        raise RuntimeError('paired_nav_unobserved_migration_missing')
    existing = unobserved_pair(execution_snapshot_id=execution_snapshot_id, query=query)
    if existing is not None:
        return existing
    saved = read_snapshot(query, execution_snapshot_id)
    manifest, packet = saved['manifest'], saved['payload']['content']
    if (manifest['snapshot_kind'] != 'execution_pair' or manifest['prospective'] != 1
            or packet.get('pair_id') != manifest['source_run_id']
            or not packet.get('allocation_snapshot_id')):
        raise ValueError('paired_nav_unobserved_pair_identity_invalid')
    from services.paired_native_session import validate_schedule
    from services.paired_native_collector import frame_identity
    from services.paired_native_prestart import succession

    schedule = packet['schedule']
    validate_schedule(schedule, packet['session_date'])
    first = schedule[0]
    deadline = frame_capture_deadline(first)
    if clock < deadline or clock.astimezone(deadline.tzinfo).date().isoformat() <= packet['session_date']:
        raise ValueError('paired_nav_unobserved_session_not_closed')
    if succession(query, old_snapshot_id=execution_snapshot_id):
        raise ValueError('paired_nav_unobserved_pair_superseded')
    if (query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt' "
              'AND parent_snapshot_id=? LIMIT 1', [execution_snapshot_id])
            or query('SELECT snapshot_id FROM paired_nav_daily_journal_v1 WHERE snapshot_id=? LIMIT 1',
                     [execution_snapshot_id])):
        raise ValueError('paired_nav_unobserved_accounting_exists')
    delivery_id = digest(frame_identity(execution_snapshot_id, first))
    if objects.lookup_delivery(delivery_id) is not None:
        raise ValueError('paired_nav_unobserved_first_frame_exists')
    body = {'schema_version': 'paired-nav-unobserved-first-session-v1',
            'reason': 'first_frame_expired_without_delivery',
            'execution_snapshot_id': execution_snapshot_id, 'pair_id': packet['pair_id'],
            'session_date': packet['session_date'],
            'execution_payload_checksum': manifest['payload_checksum'],
            'execution_owner_version': packet['execution_owner_version'],
            'first_frame_delivery_id': delivery_id,
            'first_phase_at': first['observed_at'], 'first_frame_deadline_at': deadline.isoformat(),
            'observed_at': clock.isoformat(), 'nav_maturity_credit': 0,
            'production_effect': False, 'promotion_allowed': False}
    _write(writer, [(f'INSERT OR IGNORE INTO {TABLE}('
        'execution_snapshot_id,pair_id,session_date,payload_json,payload_checksum,recorded_at) '
        'VALUES(?,?,?,?,?,?)', [execution_snapshot_id, packet['pair_id'], packet['session_date'],
        encode(body), digest(body), clock.isoformat()])])
    confirmed = unobserved_pair(execution_snapshot_id=execution_snapshot_id, query=query)
    if confirmed != body:
        raise RuntimeError('paired_nav_unobserved_readback_failed')
    return confirmed
