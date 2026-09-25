"""Immutable owner-only replacement of an unstarted first native session.

Original predictions, allocations, cash and private state are retained. A new
behavior gets a new pair, never source equivalence or inherited NAV maturity.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import re

from services.paired_nav_journal import digest, encode, read_snapshot, freeze_snapshot, _timestamp, _write

TABLE = 'paired_native_prestart_successions_v1'
SCHEMA = 'paired-native-prestart-successor-v1'


def _available(query):
    return bool(query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [TABLE]))


def _schema(query):
    if not _available(query):
        raise RuntimeError('paired_native_prestart_migration_missing')
    definitions = {r['name']: r['sql'] or '' for r in query(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?", [TABLE])}
    for suffix, operation in (('update', 'UPDATE'), ('delete', 'DELETE'), ('replace', 'INSERT')):
        sql = definitions.get('paired_native_prestart_no_' + suffix + '_v1', '')
        if (not re.search(r'BEFORE\s+' + operation + r'\s+ON\s+' + TABLE, sql, re.I)
                or 'paired_native_immutable_prestart' not in sql):
            raise RuntimeError('paired_native_prestart_immutability_missing')


def succession(query, *, old_snapshot_id=None, new_snapshot_id=None):
    if not _available(query):
        return None
    field, value = ('old_snapshot_id', old_snapshot_id) if old_snapshot_id else ('new_snapshot_id', new_snapshot_id)
    rows = query(f'SELECT * FROM {TABLE} WHERE {field}=?', [value])
    if not rows:
        return None
    _schema(query)
    if len(rows) != 1:
        raise ValueError('paired_native_prestart_duplicate')
    row = rows[0]; body = json.loads(row['payload_json'])
    if (digest(body) != row['payload_checksum'] or body.get('schema_version') != SCHEMA
            or any(body.get(k) != row[k] for k in ('old_snapshot_id', 'new_snapshot_id', 'old_pair_id', 'new_pair_id'))
            or body.get('inherited_mature_sessions') != 0 or body.get('production_effect') is not False
            or _timestamp(row['recorded_at']) >= _timestamp(body['first_phase_at'])):
        raise ValueError('paired_native_prestart_receipt_corrupt')
    for prefix in ('old', 'new'):
        found = query('SELECT payload_checksum,frozen_at FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [body[prefix+'_snapshot_id']])
        if (len(found) != 1 or found[0]['payload_checksum'] != body[prefix+'_payload_checksum']
                or _timestamp(found[0]['frozen_at']) > _timestamp(row['recorded_at'])):
            raise ValueError('paired_native_prestart_receipt_parent_mismatch')
    return body


def assert_collectible(saved, *, query):
    sid = saved['manifest']['snapshot_id']
    if succession(query, old_snapshot_id=sid):
        raise ValueError('paired_native_prestart_superseded')
    if saved['payload']['content'].get('prestart_predecessor_snapshot_id'):
        if not succession(query, new_snapshot_id=sid):
            raise ValueError('paired_native_prestart_uncommitted')


def _source(query, snapshot_id):
    old = read_snapshot(query, snapshot_id)
    m, packet = old['manifest'], old['payload']['content']
    if (m['snapshot_kind'] != 'execution_pair' or m['prospective'] != 1
            or m['source_run_id'] != packet.get('pair_id') or packet.get('previous_session_date') is not None
            or packet.get('prestart_predecessor_snapshot_id')):
        raise ValueError('paired_native_prestart_first_original_session_required')
    allocation = read_snapshot(query, packet['allocation_snapshot_id'])
    # Full role, frozen environment and A/B parent verification, not existence.
    from services.paired_nav_comparison import resolve_comparison
    resolve_comparison(query=query, execution=old)
    if query('SELECT session_date FROM paired_nav_daily_journal_v1 WHERE pair_id=? LIMIT 1', [packet['pair_id']]):
        raise ValueError('paired_native_prestart_history_present')
    if query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt' AND parent_snapshot_id=? LIMIT 1", [snapshot_id]):
        raise ValueError('paired_native_prestart_history_present')
    from services.paired_native_session import validate_schedule
    validate_schedule(packet['schedule'], packet['session_date'])
    return old, allocation


def successor_plan(old, allocation, new_owner):
    packet = old['payload']['content']; plan = deepcopy(allocation['payload']['content'])
    if not re.fullmatch(r'native-paper-v1:[a-f0-9]{64}', new_owner or '') or new_owner == packet['execution_owner_version']:
        raise ValueError('paired_native_prestart_new_owner_invalid')
    if not isinstance(plan['configuration'].get('native_execution_policy'), dict):
        raise ValueError('paired_native_prestart_frozen_policy_required')
    from services.native_execution_equivalence import policy_execution_owner
    plan['configuration']['native_execution_policy']['execution_owner_version'] = policy_execution_owner(new_owner)
    plan['configuration_checksum'] = digest(plan['configuration'])
    if plan['configuration_checksum'] == allocation['payload']['content']['configuration_checksum']:
        raise ValueError('paired_native_prestart_behavior_change_required')
    plan['pair_id'] = plan['root_pair_id'] = digest([plan['owner'], plan['candidate_checksum'], plan['baseline_checksum'], plan['configuration_checksum']])
    plan['execution_replacement'] = {'schema_version': SCHEMA,
        'prior_execution_snapshot_id': old['manifest']['snapshot_id'],
        'prior_execution_checksum': old['manifest']['payload_checksum'],
        'prior_allocation_snapshot_id': allocation['manifest']['snapshot_id'],
        'prior_allocation_checksum': allocation['manifest']['payload_checksum'],
        'new_execution_owner_version': new_owner, 'inherited_mature_sessions': 0}
    return plan


def validate_successor_plan(plan, *, signal_date, frozen_at, query):
    proof = plan.get('execution_replacement') or {}
    if proof.get('schema_version') != SCHEMA:
        raise ValueError('paired_native_prestart_proof_invalid')
    old, allocation = _source(query, proof['prior_execution_snapshot_id'])
    stamp = _timestamp(frozen_at); first = _timestamp(old['payload']['content']['schedule'][0]['observed_at'])
    if (old['manifest']['signal_date'] != signal_date or allocation['manifest']['prospective'] != 1
            or not _timestamp(old['manifest']['frozen_at']) <= stamp < first
            or plan != successor_plan(old, allocation, proof.get('new_execution_owner_version'))):
        raise ValueError('paired_native_prestart_plan_changed_or_late')
    return old, allocation


def successor_packet(old, plan, allocation_id):
    packet = deepcopy(old['payload']['content'])
    packet.update(pair_id=plan['pair_id'], allocation_snapshot_id=allocation_id,
        configuration={**deepcopy(plan['configuration']), 'fees': deepcopy(plan['configuration']['trading_config']['fees'])},
        execution_owner_version=plan['execution_replacement']['new_execution_owner_version'],
        prestart_predecessor_snapshot_id=old['manifest']['snapshot_id'])
    packet['configuration_checksum'] = digest(packet['configuration'])
    return packet


def validate_successor_execution(saved, *, allocation, query):
    plan = allocation['payload']['content']
    old, original_allocation = validate_successor_plan(plan, signal_date=allocation['manifest']['signal_date'],
        frozen_at=allocation['manifest']['frozen_at'], query=query)
    if (saved['payload']['content'] != successor_packet(old, plan, allocation['manifest']['snapshot_id'])
            or not _timestamp(allocation['manifest']['frozen_at']) <= _timestamp(saved['manifest']['frozen_at'])
                < _timestamp(old['payload']['content']['schedule'][0]['observed_at'])):
        raise ValueError('paired_native_prestart_execution_changed_or_late')
    return old, original_allocation


def inspect_unstarted_registration(*, snapshot_id, query, objects, now=None):
    """Read-only preflight; validates original evidence and both private states."""
    clock = now or datetime.now(timezone.utc)
    old, allocation = _source(query, snapshot_id)
    packet = old['payload']['content']
    if not clock < _timestamp(packet['schedule'][0]['observed_at']):
        raise ValueError('paired_native_prestart_window_closed')
    from services.paired_native_collector import frame_identity
    # Any lawful execution forms a contiguous prefix. Its first receipt forbids replacement.
    if objects.lookup_delivery(digest(frame_identity(snapshot_id, packet['schedule'][0]))):
        raise ValueError('paired_native_prestart_frame_present')
    from services.native_paper_sandbox import PrivatePaperStore
    for arm in ('baseline', 'candidate'):
        state = objects.get(packet['initial_state_objects'][arm])
        if state['state_checksum'] != packet['initial_state_checksums'][arm]:
            raise ValueError('paired_native_prestart_initial_state_corrupt')
        store = PrivatePaperStore(**state, inputs={})
        store.db.close()
    return old, allocation


def replace_unstarted_registration(*, snapshot_id, new_owner, query, writer, objects, runner=None, now=None):
    """Called only by an explicitly approved repair, with an exact runtime owner.

    Sealing the successor is not activation. The final immutable row activates it
    and retires the original together. A partial retry cannot execute two pairs.
    """
    clock = now or datetime.now(timezone.utc)
    _schema(query)
    from services.native_paper_sandbox import native_execution_identity
    if native_execution_identity(runner) != new_owner:
        raise ValueError('paired_native_prestart_runtime_not_current')
    existing = succession(query, old_snapshot_id=snapshot_id)
    if existing:
        saved = read_snapshot(query, existing['new_snapshot_id'])
        if saved['payload']['content']['execution_owner_version'] != new_owner:
            raise ValueError('paired_native_prestart_successor_changed')
        validate_successor_execution(saved, allocation=read_snapshot(query, saved['payload']['content']['allocation_snapshot_id']), query=query)
        return existing
    old, allocation = inspect_unstarted_registration(snapshot_id=snapshot_id, query=query, objects=objects, now=clock)
    packet = old['payload']['content']
    plan = successor_plan(old, allocation, new_owner)
    am = freeze_snapshot(signal_date=old['manifest']['signal_date'], source_run_id=plan['pair_id'],
        snapshot_kind='allocation_pair', content=plan, query=query, writer=writer, now=clock)
    content = successor_packet(old, plan, am['snapshot_id'])
    em = freeze_snapshot(signal_date=old['manifest']['signal_date'], source_run_id=plan['pair_id'],
        snapshot_kind='execution_pair', content=content, query=query, writer=writer, now=clock)
    validate_successor_execution(read_snapshot(query, em['snapshot_id']),
        allocation=read_snapshot(query, am['snapshot_id']), query=query)
    body = {'schema_version': SCHEMA, 'old_snapshot_id': snapshot_id, 'new_snapshot_id': em['snapshot_id'],
        'old_pair_id': packet['pair_id'], 'new_pair_id': plan['pair_id'],
        'old_payload_checksum': old['manifest']['payload_checksum'], 'new_payload_checksum': em['payload_checksum'],
        'first_phase_at': packet['schedule'][0]['observed_at'], 'inherited_mature_sessions': 0, 'production_effect': False}
    activated_at = now or datetime.now(timezone.utc)
    if not activated_at < _timestamp(body['first_phase_at']):
        raise ValueError('paired_native_prestart_window_closed')
    _write(writer, [(f'INSERT OR IGNORE INTO {TABLE}(old_snapshot_id,new_snapshot_id,old_pair_id,new_pair_id,payload_json,payload_checksum,recorded_at) VALUES(?,?,?,?,?,?,?)',
        [snapshot_id, em['snapshot_id'], packet['pair_id'], plan['pair_id'], encode(body), digest(body), activated_at.isoformat()])])
    if succession(query, old_snapshot_id=snapshot_id) != body:
        raise RuntimeError('paired_native_prestart_publication_failed')
    return body
