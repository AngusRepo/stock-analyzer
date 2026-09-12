"""Source composition and evidence-derived close for private paired execution.

Only the opening union of BOTH arms owns corporate entitlement coverage. The
formal account's universe is never substituted for a private account's holdings.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from services.native_paper_sandbox import PrivatePaperStore
from services.paired_nav_journal import digest, encode, _timestamp, read_snapshot
from services.paired_native_session import ARMS, validate_schedule
from services.paired_native_collector import frame_identity
from services.paper_corporate_source import materialize_corporate_source


def _opening_corporate_scope(packet, objects, now=None):
    from services.corporate_opening_history import read_corporate_cash_discovery_dates
    symbols, outstanding, history = set(), set(), {}
    for arm in ARMS:
        state = objects.get(packet['initial_state_objects'][arm])
        if state['state_checksum'] != packet['initial_state_checksums'][arm]:
            raise ValueError('paired_native_opening_state_changed')
        store = PrivatePaperStore(**state, inputs={})
        try:
            symbols.update(row[0] for row in store.db.execute(
                'SELECT symbol FROM paper_positions WHERE account_id=? AND shares>0', [packet['account_id']]))
            for row in store.db.execute('SELECT symbol,action_id FROM paper_corporate_entitlements_v1 '
                                       'WHERE account_id=? AND settled=0', [packet['account_id']]):
                symbols.add(row[0])
                outstanding.add(row[1])
            def query(sql, params):
                cursor = store.db.execute(sql, params)
                names = [column[0] for column in cursor.description]
                return [dict(zip(names, row)) for row in cursor.fetchall()]
            dates = read_corporate_cash_discovery_dates(query, account_id=packet['account_id'],
                before_date=packet['session_date'], now=now)
            for symbol, owned_dates in dates.items():
                symbols.add(symbol)
                history.setdefault(symbol, set()).update(owned_dates)
        finally:
            store.db.close()
    return sorted(symbols), sorted(outstanding), {s: sorted(ds) for s, ds in sorted(history.items())}


def opening_corporate_universe(packet, objects):
    symbols, outstanding, _ = _opening_corporate_scope(packet, objects)
    return symbols, outstanding


def pair_corporate_source(*, snapshot_id, packet, objects, reader=None, clock=None):
    symbols, outstanding, history = _opening_corporate_scope(packet, objects, now=clock() if clock else None)
    return materialize_corporate_source(session_date=packet['session_date'], scope_id='paired-' + snapshot_id,
        symbols=symbols, outstanding_action_ids=outstanding, objects=objects, reader=reader, clock=clock,
        historical_cash_dates=history)


def build_source_receipt(*, snapshot_id, objects, query, now=None):
    """Derive completeness from the immutable chain + the actual ledger marker.

    Does not fetch late prices, accept caller-provided marks/booleans, or grant
    maturity. The original engine is still independently replayed afterwards.
    """
    packet = read_snapshot(query, snapshot_id)['payload']['content']
    schedule = packet['schedule']
    validate_schedule(schedule, packet['session_date'])
    clock = now or datetime.now(timezone.utc)
    if clock < _timestamp(schedule[-1]['observed_at']):
        raise ValueError('paired_native_session_not_closed')
    source = pair_corporate_source(snapshot_id=snapshot_id, packet=packet, objects=objects,
        reader=lambda **_: (_ for _ in ()).throw(ValueError('paired_native_close_source_backfill_forbidden')),
        clock=lambda: clock)
    snapshot = source['snapshot']
    if snapshot.get('blockers'):
        raise ValueError('paired_native_corporate_source_blocked')
    previous, records, opening_record = None, [], None
    for frame in schedule:
        identity = frame_identity(snapshot_id, frame)
        key = objects.lookup_delivery(digest(identity))
        if key is None:
            raise ValueError('paired_native_frame_receipt_missing:' + frame['input_id'])
        record = objects.get(key)
        if record['identity'] != identity or record['previous_frame_object'] != previous:
            raise ValueError('paired_native_frame_chain_mismatch')
        if set(record['states']) != set(ARMS) or set(record['frames']) != set(ARMS):
            raise ValueError('paired_native_both_arms_required')
        records.append(key)
        if opening_record is None:
            opening_record = record
        previous = key
    marks = {}
    for arm in ARMS:
        store = PrivatePaperStore(**record['states'][arm], inputs={})
        try:
            marker = store.db.execute('SELECT source_checksum FROM paper_corporate_sessions_v1 '
                'WHERE account_id=? AND session_date=?', [packet['account_id'], packet['session_date']]).fetchone()
            consumed = [item['response'] for item in opening_record['inputs'][arm].get('kv_responses', [])
                if item['request'] == {'key': 'market:corporate_actions:v1:' + packet['session_date']}]
            if (marker is None or marker[0] != snapshot['source_checksum']
                    or len(consumed) != 1 or json.loads(consumed[0]) != snapshot):
                raise ValueError('paired_native_corporate_ledger_source_mismatch')
        finally:
            store.db.close()
        result = record['frames'][arm]['result']
        if result['stage'] != 'snapshot' or result['account_id'] != packet['account_id']:
            raise ValueError('paired_native_closing_valuation_identity_invalid')
        for symbol, value in result['valuation']['marks'].items():
            if symbol in marks and marks[symbol] != value:
                raise ValueError('paired_native_two_arm_closing_mark_conflict')
            marks[symbol] = value
    return {'owner': 'paired-native-derived-source-receipt-v1', 'session_date': packet['session_date'],
        'complete': True, 'schedule_checksum': digest(schedule), 'closed_at': clock.isoformat(),
        'corporate_actions_complete': True, 'corporate_actions': snapshot['actions'], 'closing_marks': marks,
        'corporate_source_checksum': source['snapshot_checksum'], 'frame_objects': records}


class PairSourceKV:
    def __init__(self, *, snapshot_id, packet, objects, kv_read, corporate_reader=None, clock=None):
        self.snapshot_id, self.packet, self.objects = snapshot_id, packet, objects
        self.kv_read, self.corporate_reader, self.clock = kv_read, corporate_reader, clock

    @property
    def source_identity(self):
        return {'owner': 'paired-native-source-kv-v1', 'snapshot_id': self.snapshot_id}

    def __call__(self, key):
        if key == 'market:corporate_actions:v1:' + self.packet['session_date']:
            source = pair_corporate_source(snapshot_id=self.snapshot_id, packet=self.packet,
                objects=self.objects, reader=self.corporate_reader, clock=self.clock)
            return encode(source['snapshot'])
        return self.kv_read(key)
