"""Close changed comparisons only after every promised session is reconciled.

This is experiment identity/continuation, NOT statistical efficacy or promotion.
Immutable old evidence remains available; a successor has a separate baseline
comparison and receives no copied NAV maturity. No account is liquidated here.
"""
from datetime import datetime, timezone
import json
import re

from services.paired_nav_journal import digest, encode, read_snapshot, _timestamp, _write

TABLE = 'paired_nav_lifecycle_closures_v1'


def validate_schema(query):
    rows = query("SELECT name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('table','trigger')", [TABLE])
    definitions = {r['name']: r['sql'] or '' for r in rows}
    if TABLE not in definitions:
        raise RuntimeError('paired_nav_migration_0043_missing')
    for suffix, operation in (('update', 'UPDATE'), ('delete', 'DELETE'), ('replace', 'INSERT')):
        sql = definitions.get('paired_nav_lifecycle_no_' + suffix + '_v1', '')
        if (not re.search(r'BEFORE\s+' + operation + r'\s+ON\s+' + TABLE + r'\b', sql, re.I)
                or not re.search(r"RAISE\s*\(\s*ABORT\s*,\s*'paired_nav_immutable_lifecycle'\s*\)", sql, re.I)
                or suffix == 'replace' and not re.search(r'RAISE\s*\(\s*IGNORE\s*\)', sql, re.I)):
            raise RuntimeError('paired_nav_lifecycle_immutability_missing')


def _decode(row):
    body = json.loads(row['payload_json'])
    keys = ('pair_id', 'root_pair_id', 'successor_pair_id', 'successor_snapshot_id',
            'transition_signal_date', 'final_session_date')
    if (digest(body) != row['payload_checksum'] or body.get('schema_version') != 'paired-nav-lifecycle-closure-v1'
            or body.get('reason') != 'comparison_changed' or body.get('promotion_allowed') is not False
            or any(body.get(key) != row[key] for key in keys)):
        raise ValueError('paired_nav_lifecycle_receipt_corrupt')
    return body


def closure_for_pair(pair_id, *, signal_date, query, observed_at=None):
    rows = query(f'SELECT * FROM {TABLE} WHERE pair_id=? AND transition_signal_date<=?', [pair_id, signal_date])
    if len(rows) > 1:
        raise ValueError('paired_nav_lifecycle_duplicate_closure')
    if not rows:
        return None
    body = _decode(rows[0])
    # Replaying an immutable review must not import a later lifecycle event.
    # Decode first: a historical cutoff never excuses corrupt source evidence.
    if observed_at is not None and _timestamp(rows[0]['recorded_at']) > observed_at:
        return None
    return body


def resolve_pair_id(root_pair_id, *, signal_date, query):
    """A rollback to an earlier baseline cannot reopen its already closed ledger."""
    validate_schema(query)
    rows = query(f'SELECT * FROM {TABLE} WHERE root_pair_id=? AND transition_signal_date<=? '
                 'ORDER BY pair_id', [root_pair_id, signal_date])
    for row in rows:
        _decode(row)
    return digest(['paired-nav-successor-v1', root_pair_id,
                   [r['payload_checksum'] for r in rows]]) if rows else root_pair_id


def registered_pairs(*, signal_date, query):
    rows = query("SELECT m.snapshot_id FROM paired_nav_frozen_manifests_v1 m JOIN "
        "(SELECT source_run_id,MAX(signal_date) day FROM paired_nav_frozen_manifests_v1 "
        "WHERE snapshot_kind='execution_pair' AND prospective=1 AND signal_date<? GROUP BY source_run_id) latest "
        "ON m.source_run_id=latest.source_run_id AND m.signal_date=latest.day "
        "WHERE m.snapshot_kind='execution_pair' ORDER BY m.source_run_id", [signal_date])
    active = []
    for row in rows:
        execution = read_snapshot(query, row['snapshot_id'])
        packet = execution['payload']['content']
        if closure_for_pair(packet['pair_id'], signal_date=signal_date, query=query):
            continue
        # Legacy execution-only receipts are not allocation lifecycle registrations.
        if not packet.get('allocation_snapshot_id'):
            continue
        allocation = read_snapshot(query, packet['allocation_snapshot_id'])
        plan = allocation['payload']['content']
        if (allocation['manifest']['snapshot_kind'] != 'allocation_pair'
                or allocation['manifest']['prospective'] != 1
                or allocation['manifest']['signal_date'] != execution['manifest']['signal_date']
                or any(packet.get(k) != plan.get(k) for k in
                       ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum'))):
            raise ValueError('paired_nav_lifecycle_registration_parent_mismatch')
        active.append({'execution': execution, 'allocation': allocation})
    return active


def prepare_comparison_transitions(*, plans, signal_date, query, now=None):
    """Read-only transition plan; old registrations remain pinned until commit.

    Validate ALL final receipts before registering successors. Preparing a new
    allocation alone is not enough to retire the old daily-inference owner.
    """
    if not plans:
        return []
    validate_schema(query)
    clock = now or datetime.now(timezone.utc)
    successors, existing = {}, {}
    for item in plans:
        saved = read_snapshot(query, item['snapshot_id'])
        manifest, plan = saved['manifest'], saved['payload']['content']
        if (manifest['snapshot_kind'] != 'allocation_pair' or manifest['prospective'] != 1
                or manifest['signal_date'] != signal_date or _timestamp(manifest['frozen_at']) > clock
                or item['pair_id'] != plan['pair_id'] or item['owner'] != plan['owner']):
            raise ValueError('paired_nav_lifecycle_successor_invalid')
        key = (plan['owner'], plan['candidate_checksum'])
        if key in successors:
            raise ValueError('paired_nav_lifecycle_multiple_successors')
        successors[key] = saved
        for row in query(f'SELECT * FROM {TABLE} WHERE successor_snapshot_id=?', [item['snapshot_id']]):
            existing[row['pair_id']] = _decode(row)
    transitions = []
    for old in registered_pairs(signal_date=signal_date, query=query):
        prior = old['allocation']['payload']['content']
        target = successors.get((prior['owner'], prior['candidate_checksum']))
        if target is None:
            continue  # Absence is not a retirement or loss of an existing lane.
        new = target['payload']['content']
        if new['pair_id'] == prior['pair_id']:
            continue
        changes = [key for key in ('baseline_checksum', 'configuration_checksum') if prior[key] != new[key]]
        if not changes:
            raise ValueError('paired_nav_lifecycle_unexplained_pair_change')
        transitions.append((old, target, changes))
    if not transitions:
        return [existing[key] for key in sorted(existing)]
    from services.paired_nav_evidence import read_verified_nav_evidence
    evidence = read_verified_nav_evidence(business_date=signal_date, query=query, now=clock)
    pairs = {p.pair_id: p for p in evidence.pairs}
    pending = []
    for old, target, changes in transitions:
        prior = old['allocation']['payload']['content']
        execution = old['execution']
        new = target['payload']['content']
        series = pairs.get(prior['pair_id'])
        if (series is None or series.observations[-1].snapshot_id != execution['manifest']['snapshot_id']
                or series.observations[-1].session_date != execution['payload']['content']['session_date']
                or series.observations[-1].session_date > signal_date):
            raise ValueError('paired_nav_lifecycle_final_session_not_reconciled')
        body = {'schema_version': 'paired-nav-lifecycle-closure-v1', 'reason': 'comparison_changed',
            'pair_id': prior['pair_id'], 'root_pair_id': prior.get('root_pair_id', prior['pair_id']),
            'successor_pair_id': new['pair_id'], 'successor_snapshot_id': target['manifest']['snapshot_id'],
            'transition_signal_date': signal_date, 'final_session_date': series.observations[-1].session_date,
            'final_execution_snapshot_id': execution['manifest']['snapshot_id'],
            'prior_allocation_snapshot_id': old['allocation']['manifest']['snapshot_id'],
            'changed_fields': changes, 'final_evidence': series.summary(),
            'successor_allocation_checksum': target['manifest']['payload_checksum'],
            'promotion_allowed': False, 'inherited_mature_sessions': 0}
        pending.append(body)
    existing.update({body['pair_id']: body for body in pending})
    return [existing[key] for key in sorted(existing)]


def close_changed_comparisons(*, plans, signal_date, query, writer, now=None):
    """Commit only after every successor has a verified execution registration.

    Called by the post-registration pipeline boundary. Interrupted registration
    leaves old candidate pins intact; interrupted closure is immutable/retryable.
    No historical execution or maturity is manufactured by this transition.
    """
    clock = now or datetime.now(timezone.utc)
    pending = prepare_comparison_transitions(plans=plans, signal_date=signal_date,
        query=query, now=clock)
    for item in plans:
        snapshot_id = digest(['execution_pair', signal_date, item['pair_id']])
        rows = query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
        if len(rows) != 1:
            raise ValueError('paired_nav_lifecycle_successor_not_registered')
        registered = read_snapshot(query, snapshot_id)
        manifest, packet = registered['manifest'], registered['payload']['content']
        if (manifest['snapshot_kind'] != 'execution_pair' or manifest['prospective'] != 1
                or manifest['signal_date'] != signal_date or _timestamp(manifest['frozen_at']) > clock
                or packet.get('allocation_snapshot_id') != item['snapshot_id']
                or any(packet.get(key) != item[key] for key in ('pair_id', 'owner'))):
            raise ValueError('paired_nav_lifecycle_successor_registration_mismatch')
    for body in pending:
        keys = ('pair_id', 'root_pair_id', 'successor_pair_id', 'successor_snapshot_id',
                'transition_signal_date', 'final_session_date')
        _write(writer, [(f'INSERT OR IGNORE INTO {TABLE}('
            + ','.join(keys) + ',payload_json,payload_checksum,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)',
            [body[k] for k in keys] + [encode(body), digest(body), clock.isoformat()])])
        confirmed = closure_for_pair(body['pair_id'], signal_date=signal_date, query=query)
        if confirmed != body:
            raise RuntimeError('paired_nav_lifecycle_write_readback_failed')
    return pending
