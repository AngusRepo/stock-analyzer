"""Durable numerical NAV reviews; not a pre-outcome policy or serving owner.

One protocol locks calculation/allocation parameters. One family/review slot can
only be consumed once. The supplied writer must commit each complete record as
one transaction. Legacy staged headers count as reservations, not completed
reviews. Recovery recomputes the ORIGINAL as-of evidence before filling parts.
Neither this storage nor a numerical finding can authorize formal promotion.
"""
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
import re

from services.paired_nav_effect_inference import NavEffectPolicy
from services.paired_nav_family_review import NavReviewBudget, _review_evidence
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import Query, Writer, digest, encode, _write, _timestamp

RECORDS = 'paired_nav_review_records_v1'
PARTS = 'paired_nav_review_parts_v1'


def validate_review_store(query: Query):
    expected = {
        RECORDS: {'record_id','record_kind','protocol_id','family_id','review_id','as_of_date','payload_checksum','part_count','created_at'},
        PARTS: {'record_id','part_no','payload_text'},
    }
    for table, columns in expected.items():
        if not columns <= {r['name'] for r in query(f'PRAGMA table_info({table})', [])}:
            raise RuntimeError('nav_review_migration_0044_missing_or_incompatible')
        keys = set()
        for index in query(f'PRAGMA index_list({table})', []):
            if index['unique']:
                name = index['name']
                if not re.fullmatch(r'[A-Za-z0-9_]+', name):
                    raise RuntimeError('nav_review_index_invalid')
                keys.add(tuple(r['name'] for r in query(f'PRAGMA index_info({name})', [])))
        required = {('record_id',), ('protocol_id','family_id','review_id','record_kind')} if table == RECORDS else {('record_id','part_no')}
        if not required <= keys:
            raise RuntimeError('nav_review_uniqueness_missing')
        stem, reason = ('nav_review_record', 'nav_review_record_immutable') if table == RECORDS else ('nav_review_part', 'nav_review_part_immutable')
        triggers = {r['name']: r['sql'] for r in query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?", [table])}
        for suffix, operation in (('update','UPDATE'), ('delete','DELETE'), ('replace','INSERT')):
            body = triggers.get(f'{stem}_no_{suffix}_v1', '') or ''
            if (not re.search(r'BEFORE\s+' + operation + r'\s+ON\s+' + table, body, re.I)
                    or not re.search(r"RAISE\s*\(\s*ABORT\s*,\s*'" + reason + r"'\s*\)", body, re.I)
                    or suffix == 'replace' and not re.search(r'RAISE\s*\(\s*IGNORE\s*\)', body, re.I)):
                raise RuntimeError('nav_review_immutable_guard_missing')


def _key(protocol_id, family_id='', review_id='', kind=None):
    kind = kind or ('review' if family_id else 'protocol')
    return digest(['paired-nav-review-record-v1', protocol_id, family_id, review_id, kind])


def _header(query, record_id):
    rows = query(f'SELECT * FROM {RECORDS} WHERE record_id=?', [record_id])
    if len(rows) > 1:
        raise RuntimeError('nav_review_duplicate_record')
    if not rows:
        return None
    row = rows[0]
    if (row['record_id'] != _key(row['protocol_id'], row['family_id'], row['review_id'], row['record_kind'])
            or type(row['part_count']) is not int or row['part_count'] < 1
            or row['record_kind'] not in ({'review','reservation'} if row['family_id'] and row['review_id'] else {'protocol'})):
        raise RuntimeError('nav_review_record_identity_mismatch')
    return row


def read_review_record(*, query: Query, record_id: str) -> dict:
    validate_review_store(query)
    header = _header(query, record_id)
    if header is None:
        raise RuntimeError('nav_review_record_missing')
    parts = query(f'SELECT part_no,payload_text FROM {PARTS} WHERE record_id=? ORDER BY part_no', [record_id])
    if [p['part_no'] for p in parts] != list(range(header['part_count'])):
        raise RuntimeError('nav_review_parts_incomplete')
    body = json.loads(''.join(p['payload_text'] for p in parts))
    if (digest(body) != header['payload_checksum'] or body['record_kind'] != header['record_kind']
            or body['protocol_id'] != header['protocol_id'] or body['family_id'] != header['family_id']
            or body['review_id'] != header['review_id'] or body['as_of_date'] != header['as_of_date']):
        raise RuntimeError('nav_review_payload_mismatch')
    return {'header': header, 'body': body}


def _freeze(*, body, query, writer, now):
    raw = encode(body)
    parts = [raw[i:i+20000] for i in range(0, len(raw), 20000)]
    record_id = _key(body['protocol_id'], body['family_id'], body['review_id'], body['record_kind'])
    previous = _header(query, record_id)
    checksum = digest(body)
    if previous and (previous['payload_checksum'] != checksum or previous['part_count'] != len(parts)):
        raise RuntimeError('nav_review_immutable_input_conflict')
    # A committed reservation must retain its complete original census even if
    # the HTTP acknowledgement is lost and new plans arrive before retry. Never
    # split a record into independently committed header and payload batches.
    statements = [(f'INSERT OR IGNORE INTO {RECORDS}(record_id,record_kind,protocol_id,family_id,review_id,as_of_date,payload_checksum,part_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [record_id, body['record_kind'], body['protocol_id'], body['family_id'], body['review_id'], body['as_of_date'], checksum, len(parts), now.isoformat()])]
    statements.extend((f'INSERT OR IGNORE INTO {PARTS}(record_id,part_no,payload_text) VALUES(?,?,?)',
        [record_id, index, part]) for index, part in enumerate(parts))
    _write(writer, statements)
    reserved = _header(query, record_id)
    if reserved is None or reserved['payload_checksum'] != checksum:
        raise RuntimeError('nav_review_reservation_readback_failed')
    return read_review_record(query=query, record_id=record_id)


def _family_body(report, family, protocol, reservation):
    ids = set(family['pair_ids'])
    return {'schema': 'paired-nav-recorded-family-review-v1', 'record_kind': 'review',
        'protocol_id': protocol['body']['protocol_id'], 'family_id': family['family_id'],
        'review_id': report['review_id'], 'as_of_date': report['as_of_date'],
        'protocol_checksum': protocol['header']['payload_checksum'],
        'reservation_checksum': reservation['header']['payload_checksum'],
        'source_review_checksum': report['review_checksum'], 'chain_checksum': report['chain_checksum'],
        'population_checksum': report['candidate_population']['population_checksum'],
        'family': family, 'effects': [p for p in report['effects'] if p['pair_id'] in ids],
        'policy_provenance': 'recorded_not_preoutcome_attested', 'promotion_allowed': False}


def record_nav_family_reviews(*, business_date: str, query: Query, writer: Writer,
        effect_policy: NavEffectPolicy, budget: NavReviewBudget, review_id: str,
        now: datetime | None = None, _source_loader=None, _family_ids=None) -> dict:
    budget.allocation(review_id)
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None:
        raise ValueError('nav_review_timezone_required')
    if date.fromisoformat(business_date) > clock.astimezone(timezone(timedelta(hours=8))).date():
        raise ValueError('nav_review_future_asof')
    validate_review_store(query)
    prior = _header(query, _key(budget.protocol_id))
    if prior and _timestamp(prior['created_at']) > clock:
        raise ValueError('nav_review_clock_precedes_protocol')
    protocol = _freeze(body={'schema': 'paired-nav-review-protocol-v1', 'record_kind': 'protocol',
        'protocol_id': budget.protocol_id, 'family_id': '', 'review_id': '',
        'as_of_date': prior['as_of_date'] if prior else business_date,
        'effect_policy': asdict(effect_policy), 'budget_policy': asdict(budget),
        'policy_provenance': 'recorded_not_preoutcome_attested', 'promotion_allowed': False},
        query=query, writer=writer, now=clock)
    cache = {}
    def source(day, snapshot_ids=None, observed_at=None):
        key = (day, tuple(snapshot_ids) if snapshot_ids is not None else None, observed_at)
        if key not in cache:
            args = {'_population_snapshot_ids': snapshot_ids} if snapshot_ids is not None else {}
            if observed_at is not None:
                args['_population_observed_at'] = observed_at
            cache[key] = (_source_loader(business_date=day, query=query, **args) if _source_loader else
                read_verified_nav_evidence(business_date=day, query=query, now=clock, **args))
        return cache[key]
    population = json.loads(source(business_date).population_json)
    current = {f['family_id']: f for f in population['families']}
    existing = query(f'SELECT family_id,record_id FROM {RECORDS} WHERE protocol_id=? AND review_id=? AND record_kind=?',
        [budget.protocol_id, review_id, 'reservation'])
    family_ids = sorted(set(current) | {row['family_id'] for row in existing})
    if _family_ids is not None:
        family_ids = [key for key in family_ids if key in _family_ids]
    completed, waiting, failures = [], [], []
    for family_id in family_ids:
        try:
            old = _header(query, _key(budget.protocol_id, family_id, review_id, 'reservation'))
            if old:
                if old['as_of_date'] > business_date or _timestamp(old['created_at']) > clock:
                    raise ValueError('nav_review_future_record')
            old_body = None
            if old:
                try:
                    old_body = read_review_record(query=query, record_id=old['record_id'])['body']
                except RuntimeError as exc:
                    if str(exc) != 'nav_review_parts_incomplete':
                        raise
                    # An acknowledged header can precede its payload parts.
                    # Reconstruct only if _freeze verifies the EXACT old hash;
                    # never change its source or consume a replacement slot.
            evidence = source(old['as_of_date'] if old else business_date,
                old_body.get('population_snapshot_ids') if old_body else None,
                _timestamp(old['created_at']) if old else None)
            inventory = json.loads(evidence.population_json)
            matches = [f for f in inventory['families'] if f['family_id'] == family_id]
            if len(matches) != 1:
                raise RuntimeError('nav_review_original_family_missing')
            family = matches[0]
            members = [p for p in inventory['pairs'] if p['family_id'] == family_id]
            if not old:
                reasons = []
                owner = family['owner']
                if (any(p['owner'] == owner for p in inventory['unmaterialized_selections'])
                        or any(p['owner'] == owner or p['owner'] == 'expected_return' and owner in {'l4_alpha_ev','allocator_ev_fusion'} for p in inventory['unresolved_selection_sources'])
                        or any(inventory[k] for k in ('unresolved_legacy_allocation_snapshot_ids','unresolved_legacy_execution_snapshot_ids','unresolved_journal_pair_ids'))):
                    reasons.append('family_denominator_unresolved')
                if family['hypothesis_count'] / (effect_policy.resamples + 1) > budget.allocation(review_id):
                    reasons.append('tail_resolution_insufficient')
                if not any(p['accounted_sessions'] >= effect_policy.min_sessions
                        and p['exact_nav_sessions'] == p['accounted_sessions'] and p['lifecycle_status'] != 'comparison_closed' for p in members):
                    reasons.append('no_evaluable_hypothesis')
                if any(p['unaccounted_session_dates'] for p in members):
                    reasons.append('registered_evidence_missing')
                if reasons:
                    waiting.append({'family_id': family_id, 'reasons': reasons})
                    continue
            reservation = _freeze(body={'schema': 'paired-nav-review-reservation-v1',
                'record_kind': 'reservation', 'protocol_id': budget.protocol_id,
                'family_id': family_id, 'review_id': review_id, 'as_of_date': evidence.business_date,
                'protocol_checksum': protocol['header']['payload_checksum'],
                'chain_checksum': evidence.coverage['chain_checksum'],
                'population_checksum': inventory['population_checksum'], 'family': family,
                **({'population_snapshot_ids': list(evidence.population_snapshot_ids)}
                    if (old_body is None or 'population_snapshot_ids' in old_body) and evidence.population_snapshot_ids else {}),
                'review_alpha': budget.allocation(review_id), 'promotion_allowed': False},
                query=query, writer=writer, now=clock)
            # No statistic is evaluated for this family before read-back of its
            # immutable reservation. Sibling failures must not spend its look.
            report = _review_evidence(evidence, effect_policy=effect_policy, budget=budget,
                review_id=review_id, family_ids={family_id})
            saved = _freeze(body=_family_body(report, report['families'][0], protocol, reservation), query=query, writer=writer, now=clock)
            completed.append({'status': 'existing_review_verified' if old else 'recorded_review', **saved})
        except Exception as exc:
            reason = str(exc).split(':', 1)[0]
            failures.append({'family_id': family_id, 'error_type': type(exc).__name__,
                'reason': reason if re.fullmatch(r'nav_review_[a-z_]+', reason) else 'nav_review_recording_failed'})
    usage = {}
    for row in query(f'SELECT family_id,review_id FROM {RECORDS} WHERE protocol_id=? AND record_kind=?', [budget.protocol_id, 'reservation']):
        usage[row['family_id']] = usage.get(row['family_id'], Decimal(0)) + Decimal(str(budget.allocation(row['review_id'])))
    return {'status': 'partial_review_recording' if failures else 'awaiting_review_evidence' if waiting else 'reviews_recorded',
        'requested_as_of_date': business_date, 'protocol': protocol, 'reviews': completed,
        'waiting_families': waiting, 'failures': failures,
        'reserved_alpha_by_family': {key: float(value) for key, value in sorted(usage.items())},
        'reservation_includes_incomplete_headers': True, 'promotion_allowed': False}
