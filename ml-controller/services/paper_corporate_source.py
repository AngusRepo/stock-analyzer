"""Single immutable pre-open source owner; no ledger, order or pointer writes.

Source publication precedes accounting. Lost acknowledgements reuse the sealed
delivery, not a fresh FinLab revision. The source scope cannot change mid-day.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import math
import re

from services.paired_nav_journal import digest, encode, _timestamp
from services.finlab_corporate_actions import fetch_paper_corporate_source

TW = timezone(timedelta(hours=8))


def validate_source_schema(snapshot):
    """Same economic shape required by the native Worker, before publishing.

    An invalid or blocked attempt must not poison the first-writer delivery and
    make every later preopen retry reuse an unusable source.
    """
    if (not re.fullmatch(r'[a-f0-9]{64}', str(snapshot.get('source_checksum', '')))
            or snapshot.get('tax_basis') != 'gross_before_personal_tax'
            or not isinstance(snapshot.get('actions'), list)
            or not isinstance(snapshot.get('blockers'), dict)):
        raise ValueError('corporate_source_schema_invalid')
    ids = set()
    for action in snapshot['actions']:
        try:
            ex = date.fromisoformat(action['ex_date'])
            payable = date.fromisoformat(action['payable_date']) if action['payable_date'] is not None else None
            amounts = (action['cash_per_share'], action['stock_per_share'])
            valid = (isinstance(action['action_id'], str) and bool(action['action_id'])
                and action['action_id'] not in ids and action['symbol'] in snapshot['covered_symbols']
                and action['kind'] in ('cash', 'stock', 'exchange', 'subscription') and (payable is None or payable >= ex)
                and (action['kind'] != 'exchange' or payable == ex)
                and (action.get('capital_return_per_share') is None or action['kind'] == 'exchange'
                     and type(action['capital_return_per_share']) in (float, int)
                     and math.isfinite(action['capital_return_per_share']) and action['capital_return_per_share'] >= 0)
                and (action.get('cash_quantity_basis') is None or action['kind'] == 'cash'
                     and action['cash_quantity_basis'] == 'exchange_fraction'
                     and type(action.get('share_conversion_ratio')) in (float, int)
                     and math.isfinite(action['share_conversion_ratio']) and action['share_conversion_ratio'] > 0
                     and isinstance(action.get('related_exchange_action_id'), str) and bool(action['related_exchange_action_id']))
                and (action.get('cash_quantity_basis') is not None or
                     action.get('share_conversion_ratio') is None and action.get('related_exchange_action_id') is None)
                and all(type(v) in (float, int) and math.isfinite(v) and v >= 0 for v in amounts)
                and (amounts == (0, 0) and payable is None if action['kind'] == 'subscription' else
                     amounts[0] > 0 and amounts[1] == 0 if action['kind'] == 'cash' else amounts[1] > 0 and amounts[0] == 0)
                and (action.get('cash_rounding') is None or action['kind'] == 'cash' and action['cash_rounding'] == 'floor_twd')
                and (action.get('fractional_treatment') is None or action['kind'] in ('stock', 'exchange') and action['fractional_treatment'] == 'book_entry_fee')
                and (action.get('official_share_ratio') is None or action['kind'] == 'exchange'
                     and action.get('fractional_treatment') == 'book_entry_fee'
                     and type(action['official_share_ratio']) in (float, int)
                     and math.isfinite(action['official_share_ratio']) and action['official_share_ratio'] > 0))
        except (KeyError, TypeError, ValueError):
            valid = False
        if not valid:
            raise ValueError('corporate_source_action_invalid')
        if action['kind'] == 'subscription':
            from services.subscription_rights import validate_rights
            validate_rights(action.get('rights'), action['ex_date'])
        ids.add(action['action_id'])
    by_id = {a['action_id']: a for a in snapshot['actions']}
    exchanges = set()
    for action in snapshot['actions']:
        if action['kind'] != 'exchange':
            continue
        event = (action['symbol'], action['ex_date'])
        same_event = [a for a in snapshot['actions'] if (a['symbol'], a['ex_date']) == event]
        if event in exchanges or any(a['kind'] in ('stock', 'subscription') for a in same_event):
            raise ValueError('corporate_source_combined_share_conversion_terms_required')
        exchanges.add(event)
        cash = sum(a['cash_per_share'] for a in same_event if a['kind'] == 'cash' and not a.get('cash_quantity_basis'))
        if action.get('capital_return_per_share', 0) > cash:
            raise ValueError('corporate_source_capital_cash_leg_missing')
    for action in snapshot['actions']:
        if action.get('cash_quantity_basis') != 'exchange_fraction':
            continue
        exchange = by_id.get(action['related_exchange_action_id'], {})
        if (exchange.get('kind') != 'exchange' or exchange.get('symbol') != action['symbol']
                or exchange.get('ex_date') != action['ex_date']
                or exchange.get('stock_per_share') != action['share_conversion_ratio']):
            raise ValueError('corporate_source_fraction_exchange_identity_mismatch')


def materialize_corporate_source(*, session_date: str, scope_id: str, symbols: list[str],
                                outstanding_action_ids: list[str], objects, reader=None, clock=None,
                                historical_cash_dates=None) -> dict:
    day = date.fromisoformat(session_date)
    if not re.fullmatch(r'paper-account-1|paired-[a-f0-9]{64}', scope_id):
        raise ValueError('corporate_source_scope_invalid')
    symbols, outstanding = sorted(set(symbols)), sorted(set(outstanding_action_ids))
    if (len(symbols) > 2000 or len(outstanding) > 2000
            or any(not re.fullmatch(r'[0-9A-Za-z]{4,8}', s) for s in symbols)
            or any(not re.fullmatch(r'[a-f0-9]{64}', s) for s in outstanding)
            or outstanding and not symbols):
        raise ValueError('corporate_source_request_invalid')
    identity = {'owner': 'paper-corporate-source-v1', 'session_date': session_date, 'scope_id': scope_id}
    delivery_id = digest(identity)
    expected_request = {'symbols': symbols, 'outstanding_action_ids': outstanding}
    from services.corporate_opening_history import normalize_historical_cash_dates
    history = normalize_historical_cash_dates(historical_cash_dates, symbols=symbols, session_date=session_date)
    # Preserve existing empty-history deliveries. Nonempty discovery scope is
    # sealed with the request and cannot silently expand during a retry.
    history_args = {'historical_cash_dates': history} if history else {}
    expected_request.update(history_args)
    def verify(record):
        if record['identity'] != identity or record['request'] != expected_request:
            raise ValueError('corporate_source_frozen_scope_changed')
        if record['snapshot_checksum'] != digest(record['snapshot']):
            raise ValueError('corporate_source_snapshot_corrupt')
        validate_source_schema(record['snapshot'])
        if record['snapshot']['blockers']:
            raise ValueError('corporate_source_blocked_delivery')
        return record
    old = objects.lookup_delivery(delivery_id)
    if old:
        return verify(objects.get(old))
    clock = clock or (lambda: datetime.now(timezone.utc))
    started = clock()
    def before_open(value):
        return (value.tzinfo is not None and value.astimezone(TW).date() == day
                and value < _timestamp(session_date + 'T01:00:00Z'))
    if not before_open(started):
        raise ValueError('corporate_source_live_preopen_required')
    if symbols:
        snapshot = (reader or fetch_paper_corporate_source)(symbols=symbols, session_date=session_date,
            outstanding_action_ids=tuple(outstanding), **history_args)
    else:
        # Empty opening account has no entitlements. Never claim coverage of
        # unqueried symbols, and never use this for an account holding stocks.
        snapshot = {'schema_version': 'paper-corporate-source-v1', 'session_date': session_date,
            'observed_at': started.isoformat(), 'source_checksum': digest(expected_request),
            'covered_symbols': [], 'actions': [], 'blockers': {},
            'tax_basis': 'gross_before_personal_tax', 'source': 'verified_empty_opening_universe'}
    ended = clock()
    if not before_open(ended) or ended < started:
        raise ValueError('corporate_source_capture_missed_open')
    if (snapshot.get('schema_version') != 'paper-corporate-source-v1'
            or snapshot.get('session_date') != session_date
            or sorted(snapshot.get('covered_symbols', [])) != symbols
            or not started <= _timestamp(snapshot['observed_at']) <= ended
            or set(outstanding) - {a['action_id'] for a in snapshot['actions']}):
        raise ValueError('corporate_source_incomplete_or_not_current_capture')
    record = {'identity': identity, 'request': expected_request, 'snapshot': snapshot,
        'snapshot_checksum': digest(snapshot), 'captured_at': ended.isoformat(),
        'account_mutations': 0, 'prospective_backfill_credit': 0}
    validate_source_schema(snapshot)
    if snapshot['blockers']:
        # Retain raw evidence, but do not publish it as consumable accounting
        # authority. No account has consumed it; a new preopen attempt is safe.
        objects.put({**record, 'ready_for_accounting': False})
        raise ValueError('corporate_source_blocked_before_publication')
    key = objects.put(record)
    authoritative = objects.publish_delivery(delivery_id, key)
    # First writer wins even when two live fetches return identical economic
    # terms with different capture timestamps; exact request remains mandatory.
    return verify(objects.get(authoritative))


def production_objects():
    import os
    from google.cloud import storage
    from services.native_paper_source_capture import ImmutableNativeObjects
    bucket = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not bucket:
        raise RuntimeError('corporate_source_bucket_missing')
    return ImmutableNativeObjects(storage.Client().bucket(bucket))
