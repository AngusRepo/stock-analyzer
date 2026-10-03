"""Mode A corporate ledger; consumes the same sealed source as native paper.

This is research accounting, never a source materializer or a fill simulator.
The independent paired NAV journal is deliberately not used to book these
entries, so it can still detect errors in both execution implementations.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json
import math

from services.paper_corporate_source import validate_source_schema
from services.paired_nav_journal import digest


def require_corporate_component(manifest):
    """Presence preflight; the original tape/session PIT gates remain mandatory.

    A zero-row declared component is distinct from an absent component. This
    check does not download it or claim its contents cover any held universe.
    """
    metadata = manifest.get('metadata_json') or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except ValueError as exc:
            raise RuntimeError('backtest_corporate_component_metadata_invalid') from exc
    if not isinstance(metadata, dict):
        raise RuntimeError('backtest_corporate_component_metadata_invalid')
    components = metadata.get('components') or {}
    uri = components.get('corporate_source_records') if isinstance(components, dict) else None
    if not isinstance(uri, str) or not uri.strip():
        raise RuntimeError('backtest_corporate_component_missing:' +
                           str(manifest.get('snapshot_id') or 'unknown'))


def load_corporate_tape(frame):
    """Load original immutable preopen receipts, never backdate a new fetch."""
    if frame is None:
        return {}
    if 'record_json' not in frame.columns:
        raise ValueError('backtest_corporate_component_schema_invalid')
    tape = {}
    for row in frame.select('record_json').iter_rows(named=True):
        record = json.loads(row['record_json'])
        snapshot = record['snapshot']
        day = snapshot['session_date']
        identity = record['identity']
        if (identity.get('owner') != 'paper-corporate-source-v1' or identity.get('session_date') != day
                or record['snapshot_checksum'] != digest(snapshot)
                or record['request']['symbols'] != sorted(snapshot['covered_symbols'])
                or set(record['request']['outstanding_action_ids']) - {a['action_id'] for a in snapshot['actions']}):
            raise ValueError('backtest_corporate_receipt_identity_invalid')
        validate_source_schema(snapshot)
        observed = datetime.fromisoformat(snapshot['observed_at'].replace('Z', '+00:00'))
        captured = datetime.fromisoformat(record['captured_at'].replace('Z', '+00:00'))
        opening = datetime.fromisoformat(day + 'T01:00:00+00:00')
        if (observed.tzinfo is None or captured.tzinfo is None or not observed <= captured < opening
                or observed.astimezone(timezone(timedelta(hours=8))).date().isoformat() != day
                or snapshot['blockers']):
            raise ValueError('backtest_corporate_receipt_not_original_preopen')
        if day in tape:
            raise ValueError('backtest_corporate_duplicate_session')
        tape[day] = snapshot
    return tape


def _quantity(shares, ratio):
    value = Decimal(str(shares)) * Decimal(str(ratio))
    return float(value), int(value)


def _cash(shares, action):
    quantity = Decimal(str(shares))
    if action.get('cash_quantity_basis') == 'exchange_fraction':
        quantity *= Decimal(str(action['share_conversion_ratio']))
        quantity -= int(quantity)
    value = quantity * Decimal(str(action['cash_per_share']))
    return float(int(value)) if action.get('cash_rounding') == 'floor_twd' else float(value)


def _terms(action):
    # Settlement dates/rounding may be subsequently announced. Economic terms
    # cannot be rewritten after entitlement recognition.
    keys = ('symbol', 'kind', 'ex_date', 'cash_per_share', 'stock_per_share',
            'cash_quantity_basis', 'share_conversion_ratio', 'related_exchange_action_id')
    result = {key: action.get(key) for key in keys}
    if action['kind'] == 'subscription':
        result['rights'] = {k: action['rights'][k] for k in ('ratio', 'issued_ratio', 'subscription_price', 'policy')}
    return result


def apply_corporate_session(account, snapshot, day, previous_closes, *, research_cash_mode=None, research_subscription_policy=None):
    """Apply before today's exit/entry; commit only after all checks pass."""
    date.fromisoformat(day)
    required = set(account.positions) | {r['symbol'] for r in account.corporate_receivables.values()}
    if snapshot is None:
        if required:
            raise ValueError('backtest_corporate_source_missing:' + day)
        return
    if research_cash_mode not in (None, 'exact_accrual', 'minus_one_twd'):
        raise ValueError('backtest_research_cash_mode_invalid')
    if research_subscription_policy not in (None, 'do_not_subscribe_zero_value'):
        raise ValueError('backtest_research_subscription_policy_invalid')
    if (research_cash_mode or research_subscription_policy) and snapshot.get('schema_version') != 'research-corporate-history-v1':
        raise ValueError('backtest_research_cash_requires_history')
    validate_source_schema(snapshot)
    if (snapshot.get('session_date') != day or snapshot['blockers']
            or required - set(snapshot['covered_symbols'])):
        raise ValueError('backtest_corporate_source_incomplete:' + day)
    checksum = digest({'snapshot': snapshot, 'research_cash_mode': research_cash_mode, 'research_subscription_policy': research_subscription_policy})
    old = account.corporate_sessions.get(day)
    if old is not None:
        if old != checksum:
            raise ValueError('backtest_corporate_source_changed:' + day)
        return
    if account.corporate_sessions and day <= max(account.corporate_sessions):
        raise ValueError('backtest_corporate_session_out_of_order')
    positions, pending = deepcopy(account.positions), deepcopy(account.corporate_receivables)
    cash = account.cash
    assumptions = deepcopy(account.corporate_rounding_assumptions)
    subscription_assumptions = deepcopy(account.corporate_subscription_assumptions)
    by_id = {a['action_id']: a for a in snapshot['actions']}
    for key, right in pending.items():
        action = by_id.get(key)
        if action is None:
            raise ValueError('backtest_corporate_outstanding_source_missing:' + key)
        if _terms(action) != right['terms']:
            raise ValueError('backtest_corporate_outstanding_terms_changed:' + key)
        if right['kind'] == 'subscription':
            units, whole = _quantity(right['eligible_shares'], action['rights']['ratio'])
            right['rights_json'] = json.dumps({**action['rights'], 'quantity': units, 'whole_quantity': whole})
            continue
        right.update(payable_date=action['payable_date'], cash_rounding=action.get('cash_rounding'),
                     fractional_treatment=action.get('fractional_treatment'),
                     cash_due=_cash(right['eligible_shares'], action))
    for symbol, pos in positions.items():
        actions = [a for a in snapshot['actions'] if a['symbol'] == symbol and a['ex_date'] == day]
        if not actions:
            continue
        exchanges = [a for a in actions if a['kind'] == 'exchange']
        dividends = [a for a in actions if a['kind'] in ('cash', 'stock')]
        subscriptions = [a for a in actions if a['kind'] == 'subscription']
        if len(subscriptions) > 1:
            raise ValueError('backtest_subscription_duplicate_event')
        exchange = exchanges[0] if exchanges else None
        if exchange and any(r['symbol'] == symbol and r['shares_due'] > 0 for r in pending.values()):
            raise ValueError('backtest_corporate_combined_conversion_terms_required')
        cash_per_share = sum(a['cash_per_share'] for a in dividends if not a.get('cash_quantity_basis'))
        stock_per_share = sum(a['stock_per_share'] for a in dividends)
        conversion = exchange['stock_per_share'] if exchange else 1.
        capital_return = exchange.get('capital_return_per_share', 0.) if exchange else 0.
        previous = previous_closes.get(symbol)
        if type(previous) not in (int, float) or not math.isfinite(previous) or previous <= cash_per_share:
            raise ValueError('backtest_corporate_previous_close_missing:' + symbol)
        rights = subscriptions[0]['rights'] if subscriptions else None
        paid_ratio = rights['issued_ratio'] if rights else 0.
        paid_amount = paid_ratio * rights['subscription_price'] if rights else 0.
        factor = (previous - cash_per_share + paid_amount) / previous / ((1 + stock_per_share + paid_ratio) * conversion)
        old_shares, old_cost = pos.shares, pos.cost_basis
        if type(old_shares) is not int or old_shares <= 0:
            raise ValueError('backtest_corporate_opening_quantity_invalid')
        if exchange:
            total, whole = _quantity(old_shares, conversion)
            if exchange.get('official_share_ratio') is not None and _quantity(old_shares, exchange['official_share_ratio'])[1] != whole:
                raise ValueError('backtest_corporate_disclosed_quantity_conflict')
            if total != whole and exchange.get('fractional_treatment') != 'book_entry_fee' and not any(
                    a.get('cash_quantity_basis') == 'exchange_fraction'
                    and a.get('related_exchange_action_id') == exchange['action_id'] for a in dividends):
                raise ValueError('backtest_corporate_exchange_fractional_terms_required')
            pos.shares = whole
        pos.average_cost = max(0., old_cost - capital_return) / ((1 + stock_per_share) * conversion)
        for attr in ('entry_price', 'initial_stop', 'tp1_price', 'tp2_price', 'atr14', 'highest_since_entry'):
            setattr(pos, attr, getattr(pos, attr) * factor)
        for action in subscriptions:
            units, whole = _quantity(old_shares, action['rights']['ratio'])
            pending[action['action_id']] = {
                'action_id': action['action_id'], 'symbol': symbol, 'kind': 'subscription',
                'terms': _terms(action), 'eligible_shares': old_shares, 'cash_due': 0.,
                'shares_due': 0., 'whole_shares_due': 0, 'payable_date': None, 'fractional_treatment': None,
                'rights_json': json.dumps({**action['rights'], 'quantity': units, 'whole_quantity': whole}),
                'research_valuation_policy': research_subscription_policy}
            if research_subscription_policy:
                subscription_assumptions.append({'session_date': day, 'symbol': symbol,
                    'action_id': action['action_id'], 'policy': research_subscription_policy,
                    'quantity': units, 'subscription_price': action['rights']['subscription_price'],
                    'value_twd': 0., 'execution_parity_credit': False})
        for action in dividends:
            total, whole = _quantity(old_shares, action['stock_per_share'])
            due = _cash(old_shares, action)
            if not due and not total:
                continue
            if action['action_id'] in pending:
                raise ValueError('backtest_corporate_duplicate_entitlement')
            pending[action['action_id']] = {
                'action_id': action['action_id'], 'symbol': symbol, 'kind': action['kind'],
                'terms': _terms(action), 'eligible_shares': old_shares,
                'cash_due': due, 'shares_due': total, 'whole_shares_due': whole,
                'payable_date': action['payable_date'], 'cash_rounding': action.get('cash_rounding'),
                'fractional_treatment': action.get('fractional_treatment'),
                'position_basis': asdict(pos), 'share_cost_basis': old_cost / (1 + stock_per_share),
            }
    positions = {s: p for s, p in positions.items() if p.shares > 0}
    for key, right in list(pending.items()):
        if right['kind'] == 'subscription':
            if day > json.loads(right['rights_json'])['payment_deadline']:
                del pending[key]
            continue
        if not right['payable_date'] or right['payable_date'] > day:
            continue
        if right['kind'] == 'cash':
            adjustment = 0.
            if right['cash_rounding'] is None:
                context = {'session_date': day, 'symbol': right['symbol'], 'action_id': key,
                           'ex_date': right['terms']['ex_date']}
                if research_cash_mode:
                    # A bounded cash sensitivity, never an invented issuer term.
                    adjustment = -min(1., right['cash_due']) if research_cash_mode == 'minus_one_twd' else 0.
                    assumptions.append({**context, 'mode': research_cash_mode,
                        'cash_due': right['cash_due'], 'adjustment_twd': adjustment,
                        'execution_parity_credit': False})
                elif not right['cash_due'].is_integer():
                    raise ValueError('backtest_corporate_cash_rounding_missing:' + json.dumps(context, sort_keys=True))
            cash += right['cash_due'] + adjustment
        else:
            quantity = right['whole_shares_due']
            if right['shares_due'] != quantity and right['fractional_treatment'] != 'book_entry_fee':
                raise ValueError('backtest_corporate_fractional_delivery_missing:' + json.dumps({'session_date':day, 'symbol':right['symbol'], 'action_id':key, 'ex_date':right['terms']['ex_date']}, sort_keys=True))
            if quantity:
                pos = positions.get(right['symbol'])
                if pos:
                    pos.average_cost = (pos.shares * pos.cost_basis + quantity * right['share_cost_basis']) / (pos.shares + quantity)
                    pos.shares += quantity
                else:
                    # Restore the original adjusted exit owner, not defaults.
                    from services.backtest_engine import OpenPosition
                    positions[right['symbol']] = OpenPosition(**{
                        **right['position_basis'], 'shares': quantity, 'average_cost': right['share_cost_basis']})
        del pending[key]
    account.cash, account.positions, account.corporate_receivables = cash, positions, pending
    account.corporate_rounding_assumptions = assumptions
    account.corporate_subscription_assumptions = subscription_assumptions
    account.corporate_sessions[day] = checksum


def receivables_value(account, mark):
    value = 0.
    for right in account.corporate_receivables.values():
        if right['kind'] == 'subscription':
            if right.get('research_valuation_policy') == 'do_not_subscribe_zero_value':
                continue
            raise ValueError('backtest_subscription_fair_value_unobservable:' + right['action_id'])
        value += right['cash_due']
        shares = right['whole_shares_due'] if right['fractional_treatment'] == 'book_entry_fee' else right['shares_due']
        if shares:
            value += shares * mark(right['symbol'])
    return value
