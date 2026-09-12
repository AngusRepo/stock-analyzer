"""Immutable, costed, self-financing shadow accounts; never an order submitter.

Allocation context and executable paired evidence are deliberately different
objects. This module cannot infer fills from EV scores, T+5 labels, or selected
stock returns. The same frozen execution owner must supply fills for BOTH arms.
One observation is a complete market session, not one symbol or one replay.
"""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

Query = Callable[[str, list[Any]], list[dict[str, Any]]]
Writer = Callable[..., dict[str, Any]]
SCHEMA = 'paired-nav-journal-v1'


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(encode(value).encode('utf-8')).hexdigest()


def number(value: Any, field: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or value is None or isinstance(value, str) and not value.strip():
        raise ValueError(f'paired_nav_invalid_number:{field}')
    try:
        result = float(value)
    except (ValueError, TypeError) as exc:
        raise ValueError(f'paired_nav_invalid_number:{field}') from exc
    if not math.isfinite(result) or minimum is not None and result < minimum:
        raise ValueError(f'paired_nav_invalid_number:{field}')
    return result


def _timestamp(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('paired_nav_timezone_required')
    return result.astimezone(timezone.utc)


def _write(writer: Writer, statements: list[tuple[str, list[Any]]]) -> None:
    ack = writer(statements)
    if (not isinstance(ack, dict) or type(ack.get('success_count')) is not int
            or type(ack.get('error_count')) is not int or ack['success_count'] != len(statements)
            or ack['error_count'] != 0 or ack.get('partial_failure')
            or ack.get('mode') == 'allocator_contract_noop'):
        raise RuntimeError('paired_nav_write_incomplete')


def _parts(query: Query, snapshot_id: str, count: int) -> str:
    rows = query('SELECT part_no,payload_text FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=? ORDER BY part_no', [snapshot_id])
    if [r['part_no'] for r in rows] != list(range(count)):
        raise RuntimeError('paired_nav_parts_incomplete')
    return ''.join(r['payload_text'] for r in rows)


def read_snapshot(query: Query, snapshot_id: str) -> dict[str, Any]:
    rows = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
    if len(rows) != 1:
        raise RuntimeError('paired_nav_manifest_missing')
    manifest = rows[0]
    raw = _parts(query, snapshot_id, manifest['part_count'])
    if hashlib.sha256(raw.encode('utf-8')).hexdigest() != manifest['payload_checksum']:
        raise RuntimeError('paired_nav_snapshot_checksum_mismatch')
    payload = json.loads(raw)
    if (payload['signal_date'] != manifest['signal_date']
            or payload['source_run_id'] != manifest['source_run_id']
            or payload['snapshot_kind'] != manifest['snapshot_kind']):
        raise RuntimeError('paired_nav_manifest_identity_mismatch')
    return {'manifest': manifest, 'payload': payload}


def freeze_snapshot(*, signal_date: str, source_run_id: str, snapshot_kind: str,
                    content: dict[str, Any], query: Query, writer: Writer,
                    now: datetime | None = None) -> dict[str, Any]:
    """Retry identical content only. Never silently replace a pre-outcome input.

    Historical contexts may be archived for diagnosis but are NOT prospective.
    The first write time is retained on idempotent retries. No client timestamp
    can turn a newly created historical snapshot into prospective evidence.
    """
    day = date.fromisoformat(signal_date)
    if not source_run_id or snapshot_kind not in {'allocation_context', 'allocation_pair', 'execution_pair', 'execution_receipt'}:
        raise ValueError('paired_nav_snapshot_identity_invalid')
    stamp = now or datetime.now(timezone.utc)
    if stamp.tzinfo is None:
        raise ValueError('paired_nav_timezone_required')
    taipei = stamp.astimezone(timezone(timedelta(hours=8)))
    if day > taipei.date():
        raise ValueError('paired_nav_future_signal_date')
    payload = {'schema_version': SCHEMA, 'snapshot_kind': snapshot_kind,
               'signal_date': signal_date, 'source_run_id': source_run_id, 'content': content}
    raw = encode(payload)
    checksum = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    snapshot_id = digest([snapshot_kind, signal_date, source_run_id])
    old = query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
    if old:
        saved = read_snapshot(query, snapshot_id)
        if saved['manifest']['payload_checksum'] != checksum:
            raise RuntimeError('paired_nav_immutable_input_conflict')
        return saved['manifest']
    from services.paired_nav_schema import validate_paired_nav_schema
    validate_paired_nav_schema(query)
    prospective = day == taipei.date() or (taipei.hour < 9 and day == taipei.date() - timedelta(days=1))
    if snapshot_kind == 'execution_pair' and content.get('allocation_snapshot_id'):
        parent = read_snapshot(query, content['allocation_snapshot_id'])
        parent_manifest = parent['manifest']
        first_phase = _timestamp(content['schedule'][0]['observed_at'])
        if (parent_manifest['snapshot_kind'] != 'allocation_pair'
                or parent_manifest['signal_date'] != signal_date
                or _timestamp(parent_manifest['frozen_at']) > stamp):
            raise ValueError('paired_nav_execution_parent_invalid')
        # Weekends/holidays do not invalidate an already-frozen Friday signal.
        # This does NOT rescue historical predictions: the actual allocation
        # parent must itself be prospective, and execution must not have begun.
        prospective = parent_manifest['prospective'] == 1 and stamp < first_phase
    # <= 80 KB even for four-byte Unicode; bounded well below D1's value limit.
    chunks = [raw[start:start + 20000] for start in range(0, len(raw), 20000)]
    for start in range(0, len(chunks), 10):
        statements = [('INSERT OR IGNORE INTO paired_nav_frozen_parts_v1(snapshot_id,part_no,payload_text) VALUES(?,?,?)',
                       [snapshot_id, index, chunks[index]]) for index in range(start, min(start + 10, len(chunks)))]
        _write(writer, statements)
    if _parts(query, snapshot_id, len(chunks)) != raw:
        raise RuntimeError('paired_nav_parts_readback_conflict')
    _write(writer, [('INSERT OR IGNORE INTO paired_nav_frozen_manifests_v1(snapshot_id,signal_date,source_run_id,frozen_at,payload_checksum,part_count,prospective,snapshot_kind,parent_snapshot_id) VALUES(?,?,?,?,?,?,?,?,?)',
                    [snapshot_id, signal_date, source_run_id, stamp.isoformat(), checksum, len(chunks), int(prospective), snapshot_kind,
                     content.get('snapshot_id') if snapshot_kind == 'execution_receipt' else None])])
    saved = read_snapshot(query, snapshot_id)
    if saved['manifest']['payload_checksum'] != checksum:
        raise RuntimeError('paired_nav_manifest_readback_conflict')
    return saved['manifest']


def account_value(account: dict[str, Any], marks: dict[str, Any]) -> float:
    total = number(account.get('cash'), 'cash', minimum=0)
    positions = account.get('positions')
    if not isinstance(positions, dict):
        raise ValueError('paired_nav_positions_missing')
    for symbol, quantity in positions.items():
        shares = number(quantity, f'{symbol}.shares', minimum=0)
        if shares:
            price = number(marks.get(symbol), f'{symbol}.mark', minimum=0)
            if price == 0:
                raise ValueError(f'paired_nav_zero_mark:{symbol}')
            total += shares * price
    for right in account.get('corporate_receivables', []):
        if right.get('kind') == 'subscription':
            raise ValueError('paired_nav_subscription_fair_value_unobservable:' + right['action_id'])
        total += number(right.get('cash_due'), 'corporate.cash_due', minimum=0)
        shares = number(right.get('shares_due'), 'corporate.shares_due', minimum=0)
        if right.get('fractional_treatment') == 'book_entry_fee':
            shares = number(right.get('whole_shares_due'), 'corporate.whole_shares_due', minimum=0)
        if shares:
            price = number(marks.get(right['symbol']), 'corporate.mark', minimum=0)
            if price <= 0:
                raise ValueError('paired_nav_corporate_mark_missing')
            total += shares * price
    if not math.isfinite(total) or total < 0:
        raise ValueError('paired_nav_invalid_total_nav')
    return total


def account_valuation(account: dict[str, Any], marks: dict[str, Any]) -> dict[str, Any]:
    """Known capital is a lower bound, NOT a zero mark for an unpriced right.

    Only fully documented, non-obligatory subscription rights may be uncertain.
    Missing stock prices, cash, quantities or contractual terms remain errors.
    """
    from services.subscription_rights import validate_rights
    known, unknown, upper_extra = [], [], 0.0
    for row in account.get('corporate_receivables', []):
        if row.get('kind') != 'subscription':
            known.append(row)
            continue
        rights = json.loads(row['rights_json'])
        validate_rights(rights, row['ex_date'])
        quantity = Decimal(str(row['eligible_shares'])) * Decimal(str(rights['ratio']))
        if (row['cash_due'] != 0 or row['shares_due'] != 0 or quantity <= 0
                or rights.get('quantity') != float(quantity) or rights.get('whole_quantity') != int(quantity)):
            raise ValueError('paired_nav_subscription_quantity_mismatch')
        price = number(marks.get(row['symbol']), 'subscription.underlying_mark', minimum=0)
        if price <= 0:
            raise ValueError('paired_nav_subscription_underlying_mark_missing')
        # Paying a positive exercise price cannot deliver more than the underlying
        # share value. Include fractions conservatively; this is NOT fair value.
        upper_extra += float(quantity) * price
        unknown.append(row['action_id'])
    lower = account_value({**account, 'corporate_receivables': known}, marks)
    upper = lower + upper_extra
    if not math.isfinite(upper):
        raise ValueError('paired_nav_valuation_bound_invalid')
    return {'nav': None if unknown else lower, 'nav_lower_bound': lower,
            'nav_upper_bound': upper, 'unpriced_rights': sorted(unknown),
            'valuation_complete': not unknown}


def _corporate_receivables(previous, actions, positions, session_date, *, cash_history=None, corrections=None):
    """Independent accounting reconciliation, not an execution/fill engine."""
    pending = {r['action_id']: dict(r) for r in previous.get('corporate_receivables', [])}
    seen = set()
    for action in actions:
        if action.get('kind') == 'exchange':
            continue  # Exact delivered conversion is reconciled after old-share accrual.
        if 'kind' not in action:
            continue  # Legacy explicit split receipts are handled below.
        action_id, symbol = action['action_id'], action['symbol']
        if not action_id or action_id in seen or action['kind'] not in ('cash', 'stock', 'subscription'):
            raise ValueError('paired_nav_corporate_action_identity_invalid')
        seen.add(action_id)
        ex_date = date.fromisoformat(action['ex_date']).isoformat()
        if action['kind'] == 'subscription':
            from services.subscription_rights import validate_rights
            rights = action.get('rights')
            validate_rights(rights, ex_date)
            if action['cash_per_share'] != 0 or action['stock_per_share'] != 0 or action['payable_date'] is not None:
                raise ValueError('paired_nav_subscription_terms_invalid')
            old = pending.get(action_id)
            quantity = old['eligible_shares'] if old else positions.get(symbol, 0)
            if old:
                prior = json.loads(old['rights_json'])
                if (old['symbol'] != symbol or old['ex_date'] != ex_date or old['kind'] != 'subscription'
                        or any(prior[k] != rights[k] for k in ('ratio', 'issued_ratio', 'subscription_price', 'policy'))):
                    raise ValueError('paired_nav_corporate_outstanding_terms_changed')
            if old or ex_date == session_date and quantity > 0:
                units = Decimal(str(quantity)) * Decimal(str(rights['ratio']))
                pending[action_id] = {'action_id': action_id, 'symbol': symbol, 'kind': 'subscription',
                    'ex_date': ex_date, 'eligible_shares': quantity, 'cash_due': 0, 'shares_due': 0,
                    'whole_shares_due': 0, 'fractional_treatment': None, 'payable_date': None,
                    'rights_json': encode({**rights, 'quantity': float(units), 'whole_quantity': int(units)})}
                if session_date > rights['payment_deadline']:
                    del pending[action_id]
            continue
        payable = action['payable_date']
        if payable is not None and date.fromisoformat(payable).isoformat() < ex_date:
            raise ValueError('paired_nav_corporate_pay_date_invalid')
        cash = number(action['cash_per_share'], 'corporate.cash', minimum=0)
        stock = number(action['stock_per_share'], 'corporate.stock', minimum=0)
        fractional = action.get('fractional_treatment')
        rounding = action.get('cash_rounding')
        if rounding is not None and (rounding != 'floor_twd' or action['kind'] != 'cash'):
            raise ValueError('paired_nav_corporate_cash_rounding_invalid')
        def cash_amount(quantity, policy):
            units = Decimal(str(quantity))
            if action.get('cash_quantity_basis') is not None:
                if action['cash_quantity_basis'] != 'exchange_fraction' or action['kind'] != 'cash' or not action.get('related_exchange_action_id'):
                    raise ValueError('paired_nav_corporate_cash_quantity_basis_invalid')
                conversion = number(action.get('share_conversion_ratio'), 'exchange.ratio', minimum=0)
                if conversion <= 0:
                    raise ValueError('paired_nav_corporate_exchange_ratio_invalid')
                if not any(a.get('kind') == 'exchange' and a.get('action_id') == action['related_exchange_action_id']
                           and a.get('symbol') == symbol and a.get('ex_date') == ex_date
                           and a.get('stock_per_share') == conversion for a in actions):
                    raise ValueError('paired_nav_corporate_fraction_exchange_identity_mismatch')
                converted = units * Decimal(str(conversion))
                units = converted - int(converted)
            value = units * Decimal(str(cash))
            return float(int(value)) if policy == 'floor_twd' else float(value)
        if fractional is not None and (fractional != 'book_entry_fee' or action['kind'] != 'stock'):
            raise ValueError('paired_nav_corporate_fractional_treatment_invalid')
        if (action['kind'] == 'cash' and (cash <= 0 or stock != 0)
                or action['kind'] == 'stock' and (stock <= 0 or cash != 0)):
            raise ValueError('paired_nav_corporate_terms_invalid')
        if action_id in pending:
            right = pending[action_id]
            if (right['symbol'] != symbol or right['kind'] != action['kind'] or right['ex_date'] != ex_date
                    or not math.isclose(right['cash_due'], cash_amount(right['eligible_shares'], right.get('cash_rounding')), abs_tol=1e-8)
                    or not math.isclose(right['shares_due'], right['eligible_shares'] * stock, abs_tol=1e-8)):
                raise ValueError('paired_nav_corporate_outstanding_terms_changed')
            right['payable_date'] = payable
            right['fractional_treatment'] = fractional
            right['cash_rounding'] = rounding
            right['cash_due'] = cash_amount(right['eligible_shares'], rounding)
        else:
            quantity = positions.get(symbol, 0) if ex_date == session_date else 0
            late = False
            if cash_history is not None and action['kind'] == 'cash' and ex_date < session_date:
                if action_id in cash_history['recognized_cash_ids']:
                    continue
                if action.get('cash_quantity_basis') or any(a.get('kind') == 'exchange'
                        and a.get('symbol') == symbol and a.get('ex_date') == ex_date for a in actions):
                    raise ValueError('paired_nav_historical_capital_event_requires_reconciliation')
                if ex_date not in cash_history['openings']:
                    raise ValueError('paired_nav_historical_opening_basis_missing:' + ex_date)
                quantity = number(cash_history['openings'][ex_date].get(symbol, 0), 'historical.shares', minimum=0)
                if not quantity.is_integer():
                    raise ValueError('paired_nav_historical_opening_quantity_invalid')
                late = quantity > 0
            if quantity <= 0:
                continue
            exact_stock = Decimal(str(quantity)) * Decimal(str(stock))
            if exact_stock == 0 and cash_amount(quantity, rounding) == 0:
                continue
            pending[action_id] = {'action_id': action_id, 'symbol': symbol, 'kind': action['kind'],
                'ex_date': ex_date, 'eligible_shares': quantity, 'cash_due': cash_amount(quantity, rounding),
                'cash_rounding': rounding,
                'shares_due': float(exact_stock), 'whole_shares_due': int(exact_stock),
                'fractional_treatment': fractional, 'payable_date': payable}
            if late:
                if corrections is None:
                    raise ValueError('paired_nav_correction_audit_required')
                corrections.append({'action_id': action_id, 'symbol': symbol, 'ex_date': ex_date,
                    'recognized_date': session_date, 'eligible_shares': quantity,
                    'cash_due': cash_amount(quantity, rounding)})
    if set(pending) - seen:
        raise ValueError('paired_nav_corporate_outstanding_source_missing')
    cash_delivery = 0.
    for action_id, right in list(pending.items()):
        if not right['payable_date'] or right['payable_date'] > session_date:
            continue
        if right['kind'] == 'cash' and not float(right['cash_due']).is_integer() and right.get('cash_rounding') is None:
            raise ValueError('paired_nav_corporate_cash_rounding_missing')
        cash_delivery += right['cash_due']
        shares = right['shares_due']
        if right.get('fractional_treatment') == 'book_entry_fee':
            shares = right['whole_shares_due']
        if shares:
            if not float(shares).is_integer():
                raise ValueError('paired_nav_corporate_fractional_delivery_missing')
            positions[right['symbol']] = positions.get(right['symbol'], 0.) + shares
        del pending[action_id]
    return cash_delivery, sorted(pending.values(), key=lambda r: r['action_id'])


def replay_session(*, previous: dict[str, Any], fills: list[dict[str, Any]],
                   marks: dict[str, Any], corporate_actions: list[dict[str, Any]],
                   session_date: str, fees: dict[str, Any], allow_unpriced_rights: bool = False,
                   cash_history=None) -> dict[str, Any]:
    """Book immutable execution-owner fills, actual fees/taxes exactly once.

    Does not presume daily rebalance, liquidate positions, invent a fill from an
    OHLC bar, subtract an EV hurdle, or remove an unpriced held stock.
    Corporate actions must be explicit; adjusted-price return is not a fill.
    """
    date.fromisoformat(session_date)
    opening_nav = number(previous.get('nav_lower_bound') if allow_unpriced_rights and previous.get('nav') is None
                         else previous.get('nav'), 'previous.nav', minimum=0)
    cash = number(previous.get('cash'), 'previous.cash', minimum=0)
    positions = {str(s): number(q, f'{s}.shares', minimum=0) for s, q in previous['positions'].items()}
    corporate_ids = [a.get('action_id') for a in corporate_actions]
    if any(not isinstance(key, str) or not key for key in corporate_ids) or len(corporate_ids) != len(set(corporate_ids)):
        raise ValueError('paired_nav_corporate_action_identity_invalid')
    commission = number(fees.get('commission'), 'commission', minimum=0)
    minimum_fee = number(fees.get('minCommission'), 'minCommission', minimum=0)
    tax_rate = number(fees.get('tax'), 'tax', minimum=0)
    if commission >= 1 or tax_rate >= 1:
        raise ValueError('paired_nav_fee_unit_invalid')
    corrections = []
    delivered, receivables = _corporate_receivables(previous, corporate_actions, positions, session_date,
        cash_history=cash_history, corrections=corrections)
    correction_fields = {}
    if corrections:
        # The omitted fixed cash asset already belonged to the previous period.
        # Correct today's opening denominator, not today's investment gain.
        correction_fields = {'cash_corrections': corrections, 'reported_opening_nav': opening_nav,
            'return_opening_nav': opening_nav + math.fsum(c['cash_due'] for c in corrections)}
        opening_nav = correction_fields['return_opening_nav']
    cash += delivered
    action_ids: set[str] = set()
    exchanged_symbols: set[tuple[str, str]] = set()
    for action in corporate_actions:
        if action.get('kind') == 'exchange':
            symbol, action_id = str(action['symbol']), str(action['action_id'])
            ex = date.fromisoformat(action['ex_date']).isoformat()
            event = (symbol, ex)
            if not action_id or action_id in action_ids or event in exchanged_symbols:
                raise ValueError('paired_nav_corporate_exchange_identity_invalid')
            action_ids.add(action_id)
            exchanged_symbols.add(event)
            if action.get('payable_date') != ex or action.get('cash_per_share') != 0:
                raise ValueError('paired_nav_corporate_exchange_terms_invalid')
            ratio = number(action.get('stock_per_share'), 'exchange.ratio', minimum=0)
            if ratio <= 0:
                raise ValueError('paired_nav_corporate_exchange_ratio_invalid')
            if ex != session_date:
                continue
            capital_return = number(action.get('capital_return_per_share', 0), 'exchange.capital_return', minimum=0)
            cash_legs = sum(number(a['cash_per_share'], 'exchange.cash_leg', minimum=0) for a in corporate_actions
                if a.get('kind') == 'cash' and a.get('symbol') == symbol and a.get('ex_date') == ex
                and not a.get('cash_quantity_basis'))
            if capital_return > cash_legs:
                raise ValueError('paired_nav_corporate_capital_cash_leg_missing')
            if (any(a.get('kind') == 'stock' and a.get('symbol') == symbol and a.get('ex_date') == ex
                    for a in corporate_actions)
                    or any(r['symbol'] == symbol and r['shares_due'] > 0 for r in receivables)):
                raise ValueError('paired_nav_corporate_combined_conversion_terms_required')
            converted = Decimal(str(positions.get(symbol, 0))) * Decimal(str(ratio))
            official = action.get('official_share_ratio')
            if official is not None:
                official = number(official, 'exchange.official_ratio', minimum=0)
                if official <= 0 or action.get('fractional_treatment') != 'book_entry_fee':
                    raise ValueError('paired_nav_corporate_official_ratio_invalid')
                official_quantity = Decimal(str(positions.get(symbol, 0))) * Decimal(str(official))
                if int(official_quantity) != int(converted):
                    raise ValueError('paired_nav_corporate_disclosed_quantity_conflict')
            if converted != int(converted) and action.get('fractional_treatment') != 'book_entry_fee' and not any(a.get('kind') == 'cash'
                and a.get('cash_quantity_basis') == 'exchange_fraction'
                and a.get('related_exchange_action_id') == action_id and a.get('share_conversion_ratio') == ratio
                for a in corporate_actions):
                raise ValueError('paired_nav_corporate_exchange_fractional_terms_required')
            if converted:
                positions[symbol] = int(converted)
            continue
        if 'kind' in action:
            continue
        symbol, action_id = str(action['symbol']), str(action['action_id'])
        if not action_id or action_id in action_ids or action.get('session_date') != session_date:
            raise ValueError('paired_nav_corporate_action_identity_invalid')
        action_ids.add(action_id)
        ratio = number(action.get('split_ratio'), 'split_ratio', minimum=0)
        dividend = number(action.get('cash_per_old_share'), 'cash_per_old_share', minimum=0)
        if ratio <= 0:
            raise ValueError('paired_nav_split_ratio_invalid')
        quantity = positions.get(symbol, 0.0)
        cash += quantity * dividend
        positions[symbol] = quantity * ratio
    seen: set[str] = set()
    costs, turnover = 0.0, 0.0
    bought_today: dict[str, float] = {}
    last_time: datetime | None = None
    for fill in fills:
        fill_id, symbol, side = str(fill['fill_id']), str(fill['symbol']), fill['side']
        executed = _timestamp(fill['executed_at'])
        if (not fill_id or fill_id in seen or side not in {'buy', 'sell'} or
                executed.astimezone(timezone(timedelta(hours=8))).date().isoformat() != session_date or
                last_time is not None and executed < last_time):
            raise ValueError('paired_nav_fill_identity_or_sequence_invalid')
        seen.add(fill_id)
        last_time = executed
        shares = number(fill.get('shares'), 'fill.shares', minimum=0)
        price = number(fill.get('price'), 'fill.price', minimum=0)
        if not shares.is_integer() or shares <= 0 or price <= 0:
            raise ValueError('paired_nav_fill_quantity_or_price_invalid')
        notional = shares * price
        # JS Math.round parity for positive fees, matching paperTradeMath.
        fee = max(math.floor(notional * commission + 0.5), minimum_fee)
        day_trade = fill.get('is_day_trade', False)
        if type(day_trade) is not bool or day_trade and side != 'sell':
            raise ValueError('paired_nav_day_trade_flag_invalid')
        effective_tax = tax_rate
        if day_trade:
            if shares > bought_today.get(symbol, 0.0):
                raise ValueError('paired_nav_day_trade_without_same_day_buy')
            effective_tax = number(fees.get('dayTradeTax'), 'dayTradeTax', minimum=0)
            if effective_tax >= 1:
                raise ValueError('paired_nav_fee_unit_invalid')
            bought_today[symbol] -= shares
        tax = math.floor(notional * effective_tax + 0.5) if side == 'sell' else 0.0
        if fill.get('commission') != fee or fill.get('tax') != tax:
            raise ValueError('paired_nav_execution_cost_mismatch')
        costs += fee + tax
        turnover += notional
        if side == 'buy':
            cash -= notional + fee
            positions[symbol] = positions.get(symbol, 0.0) + shares
            bought_today[symbol] = bought_today.get(symbol, 0.0) + shares
        else:
            if shares > positions.get(symbol, 0.0):
                raise ValueError('paired_nav_sell_without_position')
            cash += notional - fee - tax
            positions[symbol] -= shares
        if cash < -1e-8:
            raise ValueError('paired_nav_negative_cash')
    positions = {s: q for s, q in positions.items() if q > 0}
    cash = max(0.0, cash)
    account = {'cash': cash, 'positions': positions, 'corporate_receivables': receivables, **correction_fields}
    if allow_unpriced_rights or corrections or previous.get('performance_complete') is False:
        valuation = account_valuation(account, marks)
        if previous.get('nav') == 0 and not corrections and (valuation.get('nav') or valuation.get('nav_lower_bound', 0)) > 0:
            raise ValueError('paired_nav_unfunded_zero_nav_recovery')
        if corrections or not valuation['valuation_complete'] or previous.get('nav') is None or previous.get('performance_complete') is False:
            # A fixed-cash correction can repair past economic NAV endpoints
            # as of now. Recover the peak only when every original endpoint is
            # actually known; genuinely unpriced history remains unknown.
            endpoints = cash_history.get('nav_endpoints') if cash_history is not None else None
            initial_peak = cash_history.get('initial_peak_nav') if cash_history is not None else None
            if (valuation['valuation_complete'] and previous.get('nav') is not None and opening_nav > 0
                    and endpoints and initial_peak is not None and all(e['nav'] is not None for e in endpoints)):
                all_corrections = [*cash_history.get('cash_corrections', []), *corrections]
                peak = max([number(initial_peak, 'history.initial_peak', minimum=0), valuation['nav'],
                    *[number(e['nav'], 'history.nav', minimum=0) + math.fsum(c['cash_due'] for c in all_corrections
                        if c['ex_date'] <= e['session_date'] < c['recognized_date']) for e in endpoints]])
                return {**account, **valuation, 'performance_complete': True, 'peak_nav': peak,
                    'daily_return': valuation['nav'] / opening_nav - 1.0, 'drawdown': valuation['nav'] / peak - 1.0,
                    'costs': costs, 'turnover': turnover / opening_nav, 'fill_count': len(fills)}
            # Preserve the unknown interval. Expiry restores today's valuation,
            # not yesterday's missing return or a certified lifetime drawdown.
            # Two subsequent known endpoints do restore that day's exact return;
            # a lifetime history gap must not blank every future observation.
            known_open = previous.get('nav') is not None
            known_return = known_open and opening_nav > 0 and valuation['valuation_complete']
            return {**account, **valuation, 'performance_complete': False,
                    **({'return_status': 'undefined_zero_opening_nav'} if previous.get('nav') == 0 else {}),
                    'peak_nav': None,
                    'daily_return': valuation['nav'] / opening_nav - 1.0 if known_return else None,
                    'drawdown': None, 'costs': costs,
                    'turnover': turnover / opening_nav if known_open and opening_nav > 0 else None, 'turnover_notional': turnover,
                    'fill_count': len(fills)}
    nav = account_value(account, marks)
    if previous.get('nav') == 0 and nav > 0:
        raise ValueError('paired_nav_unfunded_zero_nav_recovery')
    peak = max(number(previous.get('peak_nav', opening_nav), 'peak_nav', minimum=opening_nav), nav)
    if opening_nav == 0:
        # Known zero capital is a terminal economic outcome, not missing value.
        # Continue the ledger without inventing the undefined 0/0 daily return.
        return {**account, 'nav': nav, 'peak_nav': peak, 'daily_return': None,
                'return_status': 'undefined_zero_opening_nav',
                'drawdown': nav / peak - 1.0 if peak > 0 else None,
                'costs': costs, 'turnover': None, 'turnover_notional': turnover,
                'fill_count': len(fills)}
    return {'cash': cash, 'positions': positions, 'corporate_receivables': receivables, 'nav': nav, 'peak_nav': peak,
            'daily_return': nav / opening_nav - 1.0, 'drawdown': nav / peak - 1.0,
            'costs': costs, 'turnover': turnover / opening_nav, 'fill_count': len(fills)}


def materialize_pair(*, snapshot_id: str, session_date: str, execution: dict[str, Any],
                     query: Query, writer: Writer, now: datetime | None = None) -> dict[str, Any]:
    """Consume complete paired execution receipts, with immutable hash chaining.

    This is accounting/maturity only, NOT a promotion test or execution-parity
    attestation. An upstream receipt cannot self-assert statistical validity.
    """
    saved = read_snapshot(query, snapshot_id)
    manifest, packet = saved['manifest'], saved['payload']['content']
    if manifest['snapshot_kind'] != 'execution_pair' or manifest['prospective'] != 1:
        raise ValueError('paired_nav_prospective_execution_pair_required')
    if session_date <= manifest['signal_date'] or packet.get('session_date') != session_date:
        raise ValueError('paired_nav_session_mismatch')
    configuration = packet.get('configuration')
    if (not isinstance(configuration, dict) or not configuration.get('trading_config')
            or not configuration.get('risk_config') or not configuration.get('allocator_source_identity')
            or digest(configuration) != packet.get('configuration_checksum')
            or configuration.get('fees') != packet.get('fees')):
        raise ValueError('paired_nav_full_configuration_mismatch')
    session_open = _timestamp(packet['session_open_at'])
    if (_timestamp(manifest['frozen_at']) >= session_open or
            session_open.astimezone(timezone(timedelta(hours=8))).date().isoformat() != session_date):
        raise ValueError('paired_nav_not_frozen_before_execution')
    for key in ('pair_id', 'candidate_checksum', 'baseline_checksum', 'execution_owner_version', 'configuration_checksum'):
        if not packet.get(key) or execution.get(key) != packet[key]:
            raise ValueError(f'paired_nav_identity_mismatch:{key}')
    if execution.get('snapshot_id') != snapshot_id or execution.get('session_date') != session_date:
        raise ValueError('paired_nav_receipt_snapshot_mismatch')
    session_close = _timestamp(packet['session_close_at'])
    observed = _timestamp(execution['observed_at'])
    clock = now or datetime.now(timezone.utc)
    if (clock.tzinfo is None or not session_open < session_close <= observed <= clock
            or session_close.astimezone(timezone(timedelta(hours=8))).date().isoformat() != session_date):
        raise ValueError('paired_nav_close_not_observable')
    if execution.get('session_complete') is not True or execution.get('corporate_actions_complete') is not True:
        raise ValueError('paired_nav_execution_session_incomplete')
    if set(execution.get('arms', {})) != {'baseline', 'candidate'}:
        raise ValueError('paired_nav_both_arms_required')
    previous_rows = query('SELECT session_date,payload_json,payload_checksum FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date<? ORDER BY session_date DESC LIMIT 1', [packet['pair_id'], session_date])
    previous_checksum = None
    if previous_rows:
        previous_row = previous_rows[0]
        previous_packet = json.loads(previous_row['payload_json'])
        if digest(previous_packet) != previous_row['payload_checksum']:
            raise RuntimeError('paired_nav_previous_checksum_mismatch')
        if previous_row['session_date'] != packet.get('previous_session_date'):
            raise ValueError('paired_nav_missing_previous_session')
        if previous_packet['pair_identity'] != {k: packet[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum', 'execution_owner_version', 'configuration_checksum')}:
            raise ValueError('paired_nav_pair_identity_changed')
        previous = previous_packet['arms']
        previous_checksum = previous_row['payload_checksum']
    else:
        if packet.get('previous_session_date') is not None:
            raise ValueError('paired_nav_previous_journal_missing')
        initial = packet['initial_account']
        computed = account_value(initial, initial['marks'])
        if number(initial.get('nav'), 'initial.nav') != computed:
            raise ValueError('paired_nav_initial_nav_mismatch')
        previous = {'baseline': initial, 'candidate': initial}
    from services.paired_nav_chain import cash_accounting_enabled, read_verified_cash_history
    cash_history = read_verified_cash_history(query=query, pair_id=packet['pair_id'],
        before_date=session_date, now=clock) if cash_accounting_enabled(execution) else None
    arms = {}
    for arm in ('baseline', 'candidate'):
        receipt = execution['arms'][arm]
        if receipt.get('complete') is not True:
            raise ValueError(f'paired_nav_arm_incomplete:{arm}')
        if any(not session_open <= _timestamp(fill['executed_at']) <= session_close for fill in receipt['fills']):
            raise ValueError('paired_nav_fill_outside_session')
        arms[arm] = replay_session(previous=previous[arm], fills=receipt['fills'],
            marks=execution['marks'], corporate_actions=execution['corporate_actions'],
            session_date=session_date, fees=packet['fees'], allow_unpriced_rights=True,
            cash_history=cash_history[arm] if cash_history is not None else None)
    result = {'schema_version': SCHEMA, 'pair_id': packet['pair_id'], 'session_date': session_date,
              'pair_identity': {k: packet[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum', 'execution_owner_version', 'configuration_checksum')},
              'snapshot_id': snapshot_id, 'previous_checksum': previous_checksum,
              'execution_checksum': digest(execution), 'arms': arms,
              'net_return_delta': (arms['candidate']['daily_return'] - arms['baseline']['daily_return'])
                  if all(arms[a]['daily_return'] is not None for a in arms) else None,
              'promotion_allowed': False, 'ev_prediction_dates_added': 0}
    # Out-of-order backfill must not rewrite the predecessor of an existing day.
    future = query('SELECT session_date FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date>? LIMIT 1', [packet['pair_id'], session_date])
    existing = query('SELECT payload_json,payload_checksum FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date=?', [packet['pair_id'], session_date])
    from services.paired_nav_comparison import resolve_comparison
    comparison = resolve_comparison(query=query, execution=saved)
    # Enrich newly materialized journals; byte-for-byte retries of old journals
    # retain their original schema. The chain reader resolves old parents too.
    if comparison is not None and (not existing or 'comparison' in json.loads(existing[0]['payload_json'])):
        result['comparison'] = comparison
    result_checksum = digest(result)
    if existing:
        if existing[0]['payload_checksum'] != result_checksum or existing[0]['payload_json'] != encode(result):
            raise RuntimeError('paired_nav_daily_evidence_conflict')
        return result
    if future:
        raise RuntimeError('paired_nav_out_of_order_materialization')
    _write(writer, [('''INSERT OR IGNORE INTO paired_nav_daily_journal_v1
        (pair_id,session_date,snapshot_id,previous_checksum,payload_json,payload_checksum)
        SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date>?
        ) AND COALESCE((SELECT payload_checksum FROM paired_nav_daily_journal_v1
          WHERE pair_id=? AND session_date<? ORDER BY session_date DESC LIMIT 1),'')=?''',
        [packet['pair_id'], session_date, snapshot_id, previous_checksum, encode(result), result_checksum,
         packet['pair_id'], session_date, packet['pair_id'], session_date, previous_checksum or ''])])
    readback = query('SELECT payload_json,payload_checksum FROM paired_nav_daily_journal_v1 WHERE pair_id=? AND session_date=?', [packet['pair_id'], session_date])
    if len(readback) != 1 or readback[0]['payload_json'] != encode(result) or readback[0]['payload_checksum'] != result_checksum:
        raise RuntimeError('paired_nav_daily_readback_failed')
    return result


def stage_execution_receipt(*, execution: dict[str, Any], query: Query, writer: Writer,
                            now: datetime | None = None) -> dict[str, Any]:
    """Durable inbox only; future nightly retries need no manual repost.

    A receipt is not counted until both arms pass actual accounting/readback.
    There is deliberately no broker, paper-order, or serving-pointer writer.
    """
    target = read_snapshot(query, execution['snapshot_id'])
    if target['manifest']['snapshot_kind'] != 'execution_pair':
        raise ValueError('paired_nav_receipt_parent_not_execution_pair')
    if execution.get('session_date') != target['payload']['content'].get('session_date'):
        raise ValueError('paired_nav_receipt_session_mismatch')
    return freeze_snapshot(signal_date=execution['session_date'],
        source_run_id=execution['snapshot_id'], snapshot_kind='execution_receipt', content=execution,
        query=query, writer=writer, now=now)


def materialize_staged_receipts(*, business_date: str, query: Query, writer: Writer,
                               now: datetime | None = None, pair_id: str | None = None) -> int:
    """One accounting owner for nightly reconciliation and pre-session recovery.

    Scoped recovery consumes only receipts already captured for THAT pair. It
    never captures expired frames, repairs absent sources, or asserts coverage.
    Registration still requires the exact previous session and verified state.
    """
    date.fromisoformat(business_date)
    if pair_id is not None and (not isinstance(pair_id, str) or not pair_id.strip()):
        raise ValueError('paired_nav_recovery_pair_invalid')
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError('paired_nav_timezone_required')
    from services.paired_nav_schema import validate_paired_nav_schema
    validate_paired_nav_schema(query)
    scope = ''' AND m.parent_snapshot_id IN (
        SELECT snapshot_id FROM paired_nav_frozen_manifests_v1
        WHERE snapshot_kind='execution_pair' AND source_run_id=?)''' if pair_id is not None else ''
    processed = 0
    while True:
        pending = query('''SELECT m.snapshot_id,m.signal_date,m.parent_snapshot_id
            FROM paired_nav_frozen_manifests_v1 m
            LEFT JOIN paired_nav_daily_journal_v1 j ON j.snapshot_id=m.parent_snapshot_id
            WHERE m.snapshot_kind='execution_receipt' AND m.signal_date<=? AND j.snapshot_id IS NULL'''
            + scope + ' ORDER BY m.signal_date,m.snapshot_id LIMIT 100',
            [business_date] + ([pair_id] if pair_id is not None else []))
        if not pending:
            break
        for row in pending:
            saved = read_snapshot(query, row['snapshot_id'])
            execution = saved['payload']['content']
            if not _timestamp(execution['observed_at']) <= _timestamp(saved['manifest']['frozen_at']) <= clock:
                raise ValueError('paired_nav_raw_execution_not_observable')
            if execution.get('snapshot_id') != row['parent_snapshot_id']:
                raise RuntimeError('paired_nav_receipt_parent_mismatch')
            if pair_id is not None and execution.get('pair_id') != pair_id:
                raise RuntimeError('paired_nav_recovery_pair_mismatch')
            materialize_pair(snapshot_id=row['parent_snapshot_id'], session_date=row['signal_date'],
                execution=execution, query=query, writer=writer, now=clock)
            processed += 1
    return processed


def mature_staged_pairs(*, business_date: str, query: Query, writer: Writer,
                        now: datetime | None = None) -> dict[str, Any]:
    """Nightly consumer: chronological, bounded pages, fail visibly on any gap."""
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError('paired_nav_timezone_required')
    processed = materialize_staged_receipts(business_date=business_date, query=query, writer=writer, now=clock)
    # Receipt absence is not an empty successful queue. A sealed execution pair
    # is an explicit promise to collect that session for BOTH arms. Check those
    # promises, not only receipts which happened to arrive.
    cursor = ''
    outstanding = 0
    while True:
        expected = query('''SELECT m.snapshot_id FROM paired_nav_frozen_manifests_v1 m
            LEFT JOIN paired_nav_daily_journal_v1 j ON j.snapshot_id=m.snapshot_id
            WHERE m.snapshot_kind='execution_pair' AND m.prospective=1
              AND m.signal_date<? AND m.snapshot_id>? AND j.snapshot_id IS NULL
            ORDER BY m.snapshot_id LIMIT 100''', [business_date, cursor])
        if not expected:
            break
        for row in expected:
            snapshot_id = row['snapshot_id']
            packet = read_snapshot(query, snapshot_id)['payload']['content']
            session = date.fromisoformat(packet['session_date']).isoformat()
            if session > business_date:
                continue
            if _timestamp(packet['session_close_at']) <= clock:
                raise RuntimeError(f'paired_nav_due_execution_receipt_missing:{snapshot_id}:{session}')
            outstanding += 1
        cursor = expected[-1]['snapshot_id']
    from services.paired_nav_evidence import read_verified_nav_evidence
    evidence = read_verified_nav_evidence(business_date=business_date, query=query, now=clock)
    coverage = evidence.coverage
    contexts = query('''SELECT COUNT(DISTINCT signal_date) AS dates,MAX(signal_date) AS latest
        FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_context' AND signal_date<=?''', [business_date])[0]
    return {'status': 'awaiting_session_close' if outstanding else 'valuation_incomplete'
            if coverage['accounted_sessions'] > coverage['sessions'] else 'materialized'
            if processed else 'up_to_date' if coverage['sessions'] else 'awaiting_execution_pairs',
            'open_pair_sessions': outstanding,
            'journal_chain_verified': coverage['chain_verified'],
            'journal_chain_checksum': coverage['chain_checksum'],
            'bounded_pair_sessions': coverage['bounded_sessions'],
            'assessment_role': 'accounting_evidence_only',
            'paired_nav_evidence': evidence.summary(),
            'accounted_pair_sessions': coverage['accounted_sessions'],
            'unverified_pair_sessions': coverage['accounted_sessions'] - coverage['sessions'],
            'latest_accounting_session': coverage['latest_accounted'],
            'processed_pair_sessions': processed, 'recorded_pair_sessions': coverage['sessions'],
            'pair_count': coverage['pairs'], 'latest_nav_session': coverage['latest'],
            'allocation_context_dates': contexts['dates'], 'latest_allocation_context_date': contexts['latest'],
            'promotion_allowed': False, 'ev_prediction_dates_added': 0}
