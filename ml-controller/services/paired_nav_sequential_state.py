"""Retired assessment-budget experiment; audit/research only, not runtime policy.

Retained to verify immutable historical reservations, never to reset them.
Nightly accounting and candidate collection do not call this module. The old
policy checksum is intentionally unchanged. Reservations are not test verdicts
and no function here grants promotion or rewrites NAV.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
from typing import Any

from services.paired_nav_journal import Query, Writer, _timestamp, _write, digest, encode, read_snapshot


POLICY = {
    'schema': 'paired-nav-assessment-budget-v1',
    'primary_endpoint': 'candidate_minus_incumbent_costed_daily_nav_return',
    'family_scope': 'model_owner_and_training_cohort',
    'family_alpha': .05,
    'nomination_weight': '1/(i*(i+1))',
    'look_weight': '1/(k*(k+1))',
    'first_assessment_sessions': 10,
    'statistical_validity_attested': False,
}
POLICY_CHECKSUM = digest(POLICY)


def validate_assessment_schema(query: Query) -> None:
    tables = ('paired_nav_nominations_v1', 'paired_nav_assessment_reservations_v1')
    present = query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?)", list(tables))
    if {r['name'] for r in present} != set(tables):
        raise RuntimeError('paired_nav_migration_0042_missing')
    for table, required, keys in (
        (tables[0], set(NOMINATION_COLUMNS) | {'payload_json', 'payload_checksum'},
         {('pair_id',), ('hypothesis_checksum',), ('family_id', 'family_ordinal')}),
        (tables[1], set(ASSESSMENT_COLUMNS) | {'payload_json', 'payload_checksum'},
         {('pair_id', 'session_date'), ('pair_id', 'look_ordinal')}),
    ):
        if not required <= {r['name'] for r in query(f'PRAGMA table_info({table})', [])}:
            raise RuntimeError('paired_nav_assessment_columns_incompatible:' + table)
        unique = set()
        for index in query(f'PRAGMA index_list({table})', []):
            if index['unique']:
                name = index['name']
                if re.fullmatch(r'[A-Za-z0-9_]+', name) is None:
                    raise RuntimeError('paired_nav_assessment_index_invalid')
                unique.add(tuple(r['name'] for r in query(f'PRAGMA index_info({name})', [])))
        if not keys <= unique:
            raise RuntimeError('paired_nav_assessment_uniqueness_missing:' + table)
    for table, stem, reason in ((tables[0], 'nav_nomination', 'nav_nomination_immutable'),
                               (tables[1], 'nav_assessment', 'nav_assessment_immutable')):
        triggers = {r['name']: r['sql'] or '' for r in query(
            "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?", [table])}
        for suffix, operation in (('update', 'UPDATE'), ('delete', 'DELETE'), ('replace', 'INSERT')):
            body = triggers.get(f'{stem}_no_{suffix}_v1', '')
            if (not re.search(r'BEFORE\s+' + operation + r'\s+ON\s+' + table + r'\b', body, re.I)
                    or not re.search(r"RAISE\s*\(\s*ABORT\s*,\s*'" + reason + "'\\s*\\)", body, re.I)
                    or suffix == 'replace' and not re.search(r'RAISE\s*\(\s*IGNORE\s*\)', body, re.I)):
                raise RuntimeError('paired_nav_assessment_immutability_missing:' + stem + '_' + suffix)


def allocation_fraction(index: int) -> float:
    if type(index) is not int or index < 1:
        raise ValueError('paired_nav_invalid_budget_ordinal')
    return 1.0 / (index * (index + 1))


def _verified(row: dict[str, Any], columns: tuple[str, ...]) -> dict[str, Any]:
    body = json.loads(row['payload_json'])
    if digest(body) != row['payload_checksum'] or any(body.get(k) != row[k] for k in columns):
        raise RuntimeError('paired_nav_assessment_record_corrupt')
    if body.get('policy_checksum') != POLICY_CHECKSUM:
        raise RuntimeError('paired_nav_assessment_policy_changed')
    return body


NOMINATION_COLUMNS = ('pair_id', 'hypothesis_checksum', 'family_id', 'family_ordinal',
                      'signal_date', 'allocation_snapshot_id')


def nominate_allocation(*, allocation_snapshot_id: str, query: Query, writer: Writer,
                        now: datetime | None = None) -> dict[str, Any]:
    """Reserve a hypothesis exactly once before its first market outcome.

    New daily allocation snapshots reuse the original nomination. A changed
    comparator/configuration consumes another slot in the SAME cohort family;
    changing an arbitrary pair id cannot duplicate an existing hypothesis.
    """
    validate_assessment_schema(query)
    saved = read_snapshot(query, allocation_snapshot_id)
    manifest, plan = saved['manifest'], saved['payload']['content']
    if manifest['snapshot_kind'] != 'allocation_pair' or manifest['prospective'] != 1:
        raise ValueError('paired_nav_nomination_prospective_plan_required')
    owner = plan.get('owner')
    training = plan.get('candidate_training_run_id')
    if not isinstance(owner, str) or not owner or not isinstance(training, str) or not training:
        raise ValueError('paired_nav_nomination_family_lineage_missing')
    if owner not in {'l4_alpha_ev', 'allocator_ev_fusion'}:
        raise ValueError('paired_nav_nomination_owner_not_integrated')
    identity = {k: plan.get(k) for k in ('pair_id', 'candidate_checksum', 'baseline_checksum', 'configuration_checksum')}
    if not isinstance(identity['pair_id'], str) or not identity['pair_id']:
        raise ValueError('paired_nav_nomination_pair_missing')
    for key in ('candidate_checksum', 'baseline_checksum', 'configuration_checksum'):
        if not isinstance(identity[key], str) or re.fullmatch(r'[0-9a-f]{64}', identity[key]) is None:
            raise ValueError('paired_nav_nomination_identity_invalid:' + key)
    hypothesis = digest([owner, identity['candidate_checksum'], identity['baseline_checksum'], identity['configuration_checksum']])
    family_id = digest([POLICY['family_scope'], owner, training])
    old = query('SELECT * FROM paired_nav_nominations_v1 WHERE pair_id=? OR hypothesis_checksum=?',
                [identity['pair_id'], hypothesis])
    if old:
        if len(old) != 1:
            raise RuntimeError('paired_nav_nomination_identity_conflict')
        body = _verified(old[0], NOMINATION_COLUMNS)
        if (body['pair_identity'] != identity or body['family_id'] != family_id
                or body['hypothesis_checksum'] != hypothesis):
            raise RuntimeError('paired_nav_nomination_identity_conflict')
        return body
    stamp = now or datetime.now(timezone.utc)
    if stamp.tzinfo is None:
        raise ValueError('paired_nav_timezone_required')
    local = stamp.astimezone(timezone(timedelta(hours=8)))
    frozen = _timestamp(manifest['frozen_at'])
    signal = datetime.fromisoformat(manifest['signal_date']).date()
    if (stamp.tzinfo is None or stamp < frozen or not (local.date() == signal
            or local.date() == signal + timedelta(days=1) and local.hour < 9)):
        raise ValueError('paired_nav_nomination_after_outcome_boundary')
    if query('SELECT session_date FROM paired_nav_daily_journal_v1 WHERE pair_id=? LIMIT 1', [identity['pair_id']]):
        raise ValueError('paired_nav_nomination_outcomes_already_observed')
    for _ in range(5):
        previous = query('SELECT COALESCE(MAX(family_ordinal),0) AS n FROM paired_nav_nominations_v1 WHERE family_id=?', [family_id])[0]['n']
        ordinal = int(previous) + 1
        body = {'schema': 'paired-nav-nomination-v1', **identity, 'pair_identity': identity,
            'owner': owner, 'training_run_id': training, 'hypothesis_checksum': hypothesis,
            'family_id': family_id, 'family_ordinal': ordinal,
            'signal_date': manifest['signal_date'], 'allocation_snapshot_id': allocation_snapshot_id,
            'registered_at': stamp.isoformat(), 'policy_checksum': POLICY_CHECKSUM,
            'family_alpha': POLICY['family_alpha'],
            'hypothesis_alpha': POLICY['family_alpha'] * allocation_fraction(ordinal)}
        _write(writer, [('''INSERT OR IGNORE INTO paired_nav_nominations_v1
            (pair_id,hypothesis_checksum,family_id,family_ordinal,signal_date,allocation_snapshot_id,payload_json,payload_checksum)
            SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(family_ordinal)
              FROM paired_nav_nominations_v1 WHERE family_id=?),0)=?
              AND NOT EXISTS (SELECT 1 FROM paired_nav_nominations_v1 WHERE pair_id=? OR hypothesis_checksum=?)''',
            [identity['pair_id'], hypothesis, family_id, ordinal, manifest['signal_date'], allocation_snapshot_id,
             encode(body), digest(body), family_id, previous, identity['pair_id'], hypothesis])])
        rows = query('SELECT * FROM paired_nav_nominations_v1 WHERE pair_id=? OR hypothesis_checksum=?', [identity['pair_id'], hypothesis])
        if rows:
            actual = _verified(rows[0], NOMINATION_COLUMNS)
            if actual['pair_identity'] != identity or actual['family_id'] != family_id:
                raise RuntimeError('paired_nav_nomination_readback_conflict')
            return actual
    raise RuntimeError('paired_nav_nomination_contention_retry')


ASSESSMENT_COLUMNS = ('pair_id', 'session_date', 'look_ordinal', 'journal_checksum')


class DailyAssessmentReservations:
    """Observe verified journal prefixes, then persist only after full audit.

    Ordinals are derived from the immutable journal, not execution attempts or
    scheduler dates. Neither retries nor absent valuations restart the clock.
    These are reservations only: there is no p-value, confidence claim or PASS.
    """

    def __init__(self, query: Query):
        validate_assessment_schema(query)
        self.query = query
        self.nominations = {}
        self.last = {}
        self.history = {}
        self.pending = []
        self.unregistered = set()
        cursor = ''
        while True:
            rows = query('SELECT * FROM paired_nav_nominations_v1 WHERE pair_id>? ORDER BY pair_id LIMIT 100', [cursor])
            if not rows:
                break
            for row in rows:
                body = _verified(row, NOMINATION_COLUMNS)
                expected = POLICY['family_alpha'] * allocation_fraction(body['family_ordinal'])
                if body.get('hypothesis_alpha') != expected or body.get('family_alpha') != POLICY['family_alpha']:
                    raise RuntimeError('paired_nav_nomination_budget_corrupt')
                self.nominations[row['pair_id']] = (body, row['payload_checksum'])
            cursor = rows[-1]['pair_id']
        cursor, cursor_date = '', ''
        while True:
            rows = query('''SELECT * FROM paired_nav_assessment_reservations_v1
                WHERE pair_id>? OR (pair_id=? AND session_date>?)
                ORDER BY pair_id,session_date LIMIT 100''', [cursor, cursor, cursor_date])
            if not rows:
                break
            for row in rows:
                body = _verified(row, ASSESSMENT_COLUMNS)
                if row['pair_id'] not in self.nominations:
                    raise RuntimeError('paired_nav_assessment_nomination_missing')
                nomination, checksum = self.nominations[row['pair_id']]
                previous, previous_checksum = self.last.get(row['pair_id'], ({}, None))
                if (body['look_ordinal'] != previous.get('look_ordinal', 0) + 1
                        or body.get('previous_assessment_checksum') != previous_checksum):
                    raise RuntimeError('paired_nav_assessment_history_gap')
                if (body.get('nomination_checksum') != checksum
                        or body.get('hypothesis_alpha') != nomination['hypothesis_alpha']
                        or body.get('reserved_alpha') != nomination['hypothesis_alpha'] * allocation_fraction(body['look_ordinal'])
                        or body.get('accounted_sessions') != body['look_ordinal'] + POLICY['first_assessment_sessions'] - 1
                        or body.get('family_id') != nomination['family_id']
                        or body.get('family_ordinal') != nomination['family_ordinal']):
                    raise RuntimeError('paired_nav_assessment_budget_corrupt')
                self.last[row['pair_id']] = (body, row['payload_checksum'])
                self.history[(row['pair_id'], row['session_date'])] = body
            cursor, cursor_date = rows[-1]['pair_id'], rows[-1]['session_date']

    def observe(self, prefix: dict[str, Any]) -> None:
        pair_id = prefix['pair_id']
        if pair_id not in self.nominations:
            self.unregistered.add(pair_id)
            return
        nomination, nomination_checksum = self.nominations[pair_id]
        if (prefix['session_date'] <= nomination['signal_date']
                or {k: prefix['pair_identity'].get(k) for k in nomination['pair_identity']} != nomination['pair_identity']):
            raise RuntimeError('paired_nav_assessment_prospective_identity_mismatch')
        count = prefix['accounted_sessions']
        look = count - POLICY['first_assessment_sessions'] + 1
        if look <= 0:
            return
        last, last_checksum = self.last.get(pair_id, ({}, None))
        if last and prefix['session_date'] <= last['session_date']:
            existing = self.history.get((pair_id, prefix['session_date']))
            if (existing is None or existing['journal_checksum'] != prefix['journal_checksum']
                    or existing['look_ordinal'] != look
                    or existing.get('exact_nav_sessions') != prefix['exact_nav_sessions']
                    or existing.get('nomination_checksum') != nomination_checksum):
                raise RuntimeError('paired_nav_assessment_prefix_changed')
            return
        if look != int(last.get('look_ordinal', 0)) + 1:
            raise RuntimeError('paired_nav_assessment_look_gap')
        body = {'schema': 'paired-nav-assessment-reservation-v1',
            'pair_id': pair_id, 'session_date': prefix['session_date'], 'look_ordinal': look,
            'journal_checksum': prefix['journal_checksum'], 'pair_identity': prefix['pair_identity'],
            'accounted_sessions': count, 'exact_nav_sessions': prefix['exact_nav_sessions'],
            'bounded_sessions': count, 'nomination_checksum': nomination_checksum,
            'previous_assessment_checksum': last_checksum, 'policy_checksum': POLICY_CHECKSUM,
            'family_id': nomination['family_id'], 'family_ordinal': nomination['family_ordinal'],
            'hypothesis_alpha': nomination['hypothesis_alpha'],
            'reserved_alpha': nomination['hypothesis_alpha'] * allocation_fraction(look),
            'statistical_validity_attested': False, 'promotion_allowed': False,
            'status': 'awaiting_validated_inference'}
        checksum = digest(body)
        self.pending.append((body, checksum))
        self.last[pair_id] = (body, checksum)
        self.history[(pair_id, prefix['session_date'])] = body

    def persist(self, writer: Writer) -> dict[str, Any]:
        for start in range(0, len(self.pending), 10):
            batch = self.pending[start:start + 10]
            _write(writer, [('''INSERT OR IGNORE INTO paired_nav_assessment_reservations_v1
                (pair_id,session_date,look_ordinal,journal_checksum,payload_json,payload_checksum)
                SELECT ?,?,?,?,?,? WHERE COALESCE((SELECT payload_checksum
                  FROM paired_nav_assessment_reservations_v1 WHERE pair_id=?
                  ORDER BY look_ordinal DESC LIMIT 1),'')=?''',
                [body['pair_id'], body['session_date'], body['look_ordinal'], body['journal_checksum'],
                 encode(body), checksum, body['pair_id'], body['previous_assessment_checksum'] or ''])
                for body, checksum in batch])
            for body, checksum in batch:
                rows = self.query('SELECT * FROM paired_nav_assessment_reservations_v1 WHERE pair_id=? AND session_date=?',
                                  [body['pair_id'], body['session_date']])
                if len(rows) != 1 or rows[0]['payload_checksum'] != checksum or rows[0]['payload_json'] != encode(body):
                    raise RuntimeError('paired_nav_assessment_readback_conflict')
        return {'status': 'nomination_missing' if self.unregistered else 'awaiting_validated_inference',
            'new_reservations': len(self.pending), 'registered_pairs': len(self.nominations),
            'unregistered_pairs': sorted(self.unregistered), 'policy_checksum': POLICY_CHECKSUM,
            'promotion_allowed': False, 'statistical_validity_attested': False}
