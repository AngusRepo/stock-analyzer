"""The same verified previous native accounts for inference and registration."""
import json
from datetime import datetime, timezone

from services.native_paper_sandbox import PrivatePaperStore
from services.paired_nav_journal import digest, read_snapshot, _timestamp

ARMS = ('baseline', 'candidate')


def read_native_carry(*, pair_id, signal_date, query, objects, now=None):
    rows = query('SELECT session_date,snapshot_id,payload_json,payload_checksum FROM paired_nav_daily_journal_v1 '
                 'WHERE pair_id=? ORDER BY session_date DESC LIMIT 1', [pair_id])
    if not rows:
        if query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair' AND source_run_id=?", [pair_id]):
            raise ValueError('paired_native_previous_session_not_materialized')
        return None
    row = rows[0]
    journal = json.loads(row['payload_json'])
    if (row['session_date'] != signal_date or digest(journal) != row['payload_checksum']
            or journal.get('pair_id') != pair_id or journal.get('snapshot_id') != row['snapshot_id']
            or journal.get('session_date') != signal_date):
        raise ValueError('paired_native_carry_journal_gap_or_corrupt')
    receipt_id = digest(['execution_receipt', signal_date, row['snapshot_id']])
    execution = read_snapshot(query, receipt_id)['payload']['content']
    registration = read_snapshot(query, row['snapshot_id'])['payload']['content']
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or _timestamp(execution['observed_at']) > clock:
        raise ValueError('paired_native_carry_receipt_not_observable')
    if (digest(execution) != journal['execution_checksum']
            or execution.get('snapshot_id') != row['snapshot_id']
            or execution.get('session_date') != signal_date
            or execution.get('pair_id') != pair_id or registration.get('pair_id') != pair_id
            or registration.get('session_date') != signal_date
            or any(execution.get(k) != registration.get(k) for k in journal['pair_identity'])
            or journal['pair_identity'] != {k: registration.get(k) for k in journal['pair_identity']}):
        raise ValueError('paired_native_carry_receipt_corrupt')
    states = {arm: objects.get(execution['native_state_objects'][arm]) for arm in ARMS}
    for arm in ARMS:
        if states[arm]['state_checksum'] != execution['native_state_checksums'][arm]:
            raise ValueError('paired_native_carry_state_corrupt')
        # Validate actual SQL bytes, not only a matching checksum field.
        store = PrivatePaperStore(**states[arm], inputs={})
        store.db.close()
    return {'registration': registration, 'states': states,
        'reference': {'pair_id': pair_id, 'session_date': signal_date,
            'execution_snapshot_id': row['snapshot_id'], 'receipt_snapshot_id': receipt_id,
            'journal_checksum': row['payload_checksum'],
            'native_state_objects': execution['native_state_objects'],
            'native_state_checksums': execution['native_state_checksums']}}
