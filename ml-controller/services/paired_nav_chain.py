"""Read-only verification of the entire immutable, chronological NAV journal.

This checks persisted accounting continuity, not statistical validity or native
execution parity. Missing valuations remain missing; no date can be reset or
silently dropped to make an inference sample look complete.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from services.paired_nav_journal import Query, SCHEMA, account_value, digest, number, read_snapshot, replay_session, _timestamp


def _nav_interval(account: dict[str, Any]) -> tuple[float, float]:
    """Economic bounds are not a point fair value and never become cash."""
    if account.get('nav') is not None:
        nav = number(account['nav'], 'interval.nav', minimum=0)
        return nav, nav
    if account.get('valuation_complete') is not False:
        raise RuntimeError('paired_nav_chain_missing_valuation_status')
    lower = number(account.get('nav_lower_bound'), 'interval.lower', minimum=0)
    upper = number(account.get('nav_upper_bound'), 'interval.upper', minimum=lower)
    if not upper > lower:
        raise RuntimeError('paired_nav_unknown_valuation_requires_interval')
    return lower, upper


def paired_return_interval(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Certified pathwise return enclosure, NOT a statistical confidence bound.

    Current lower / previous upper is the smallest possible gross return;
    current upper / previous lower is the largest. Taking candidate lower minus
    baseline upper preserves even outcome-dependent missing valuations without
    inventing zero or deleting dates. No distributional assumption is made here.
    """
    arms = {}
    bounds = {name: (_nav_interval(previous[name]), _nav_interval(current[name]))
              for name in ('baseline', 'candidate')}
    bounds = {name: ((old[0] + cash_correction_amount(current[name]), old[1] + cash_correction_amount(current[name])), new)
              for name, (old, new) in bounds.items()}
    if any(old[0] == 0 for old, _ in bounds.values()):
        known = all(low == high for values in bounds.values() for low, high in values)
        return {'lower': None, 'upper': None, 'exact': False,
                'kind': 'undefined_return_zero_opening_nav' if known
                        else 'unbounded_return_zero_opening_nav_lower_bound'}
    for name in ('baseline', 'candidate'):
        (old_low, old_high), (new_low, new_high) = bounds[name]
        arms[name] = (new_low / old_high - 1.0, new_high / old_low - 1.0)
    low = arms['candidate'][0] - arms['baseline'][1]
    high = arms['candidate'][1] - arms['baseline'][0]
    if not math.isfinite(low) or not math.isfinite(high) or low > high:
        raise RuntimeError('paired_nav_return_interval_invalid')
    return {'lower': low, 'upper': high, 'exact': low == high,
            'kind': 'pathwise_accounting_enclosure_not_confidence_interval'}


def _same_number(actual: Any, expected: float | None, field: str) -> None:
    if expected is None:
        if actual is not None:
            raise RuntimeError('paired_nav_chain_unknown_return:' + field)
        return
    if (type(actual) not in (int, float) or not math.isfinite(actual)
            or not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12)):
        raise RuntimeError('paired_nav_chain_arithmetic_mismatch:' + field)


def verify_journal_chain(*, business_date: str, query: Query, page_size: int = 50,
                         observe_prefix: Callable[[dict[str, Any]], None] | None = None,
                         now: datetime | None = None, pair_id: str | None = None,
                         include_cash_history: bool = False) -> dict[str, Any]:
    """Stream bounded pages and return counts only after every row verifies.

    The first opening account is authenticated against its immutable pre-market
    execution snapshot. Subsequent returns use the preceding journal NAV. This
    deliberately does not compress missing days into a multi-day daily return.
    """
    date.fromisoformat(business_date)
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError('paired_nav_timezone_required')
    if type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError('paired_nav_chain_invalid_page_size')
    cursor_pair, cursor_date = '', ''
    current_pair = None
    previous: dict[str, Any] | None = None
    previous_checksum = None
    previous_date = None
    identity = None
    pair_count = exact_pair_count = 0
    coverage = {'accounted_sessions': 0, 'sessions': 0, 'pairs': 0, 'bounded_sessions': 0,
                'latest': None, 'latest_accounted': None}
    # Hash the ordered, verified prefix. Consumers may identify exactly which
    # evidence was checked without retaining every account object in memory.
    chain_checksum = digest(['paired-nav-chain-audit-v1', business_date])
    history = empty_cash_history()
    if include_cash_history and not pair_id:
        raise ValueError('paired_nav_cash_history_pair_required')
    while True:
        rows = query('''SELECT j.*,m.snapshot_kind,m.prospective,
                m.signal_date AS manifest_signal_date
            FROM paired_nav_daily_journal_v1 j
            LEFT JOIN paired_nav_frozen_manifests_v1 m ON m.snapshot_id=j.snapshot_id
            WHERE j.session_date<=? AND (j.pair_id>? OR (j.pair_id=? AND j.session_date>?))
            ''' + (' AND j.pair_id=? ' if pair_id else '') + '''
            ORDER BY j.pair_id,j.session_date LIMIT ?''',
            [business_date, cursor_pair, cursor_pair, cursor_date, *([pair_id] if pair_id else []), page_size])
        if not rows:
            break
        for row in rows:
            try:
                payload = json.loads(row['payload_json'])
                valid_hash = digest(payload) == row['payload_checksum']
            except (TypeError, ValueError) as exc:
                raise RuntimeError('paired_nav_chain_invalid_payload') from exc
            if not valid_hash:
                raise RuntimeError('paired_nav_chain_checksum_mismatch')
            if (payload.get('schema_version') != SCHEMA
                    or any(payload.get(k) != row[k] for k in ('pair_id', 'session_date', 'snapshot_id', 'previous_checksum'))
                    or row['snapshot_kind'] != 'execution_pair' or row['prospective'] != 1
                    or not row['manifest_signal_date'] or row['manifest_signal_date'] >= row['session_date']):
                raise RuntimeError('paired_nav_chain_identity_mismatch')
            if date.fromisoformat(row['session_date']).isoformat() != row['session_date']:
                raise RuntimeError('paired_nav_chain_invalid_date')
            # Every session must bind its own sealed execution identity, not
            # merely the first session's manifest and subsequent row hashes.
            execution_snapshot = read_snapshot(query, row['snapshot_id'])
            frozen = execution_snapshot['payload']['content']
            frozen_at = _timestamp(execution_snapshot['manifest']['frozen_at'])
            if frozen_at > clock:
                raise ValueError('paired_nav_execution_snapshot_not_available')
            from services.paired_nav_comparison import resolve_comparison
            comparison = resolve_comparison(query=query, execution=execution_snapshot)
            if 'comparison' in payload and payload['comparison'] != comparison:
                raise RuntimeError('paired_nav_chain_comparison_mismatch')
            if row['pair_id'] != current_pair:
                initial = frozen['initial_account']
                opening = account_value(initial, initial['marks'])
                _same_number(initial.get('nav'), opening, 'initial.nav')
                if frozen.get('previous_session_date') is not None:
                    raise RuntimeError('paired_nav_chain_missing_origin')
                identity = {k: frozen[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum',
                    'execution_owner_version', 'configuration_checksum')}
                previous = {'baseline': initial, 'candidate': initial}
                history = empty_cash_history()
                for name in history:
                    history[name]['recognized_cash_ids'] = sorted(r['action_id'] for r in initial.get('corporate_receivables', [])
                        if r.get('kind') == 'cash')
                previous_checksum = None
                previous_date = None
                current_pair = row['pair_id']
                pair_count = exact_pair_count = 0
                coverage['pairs'] += 1
            if payload.get('pair_identity') != identity or identity['pair_id'] != current_pair:
                raise RuntimeError('paired_nav_chain_pair_identity_changed')
            if row['previous_checksum'] != previous_checksum:
                raise RuntimeError('paired_nav_chain_predecessor_mismatch')
            if (any(frozen.get(k) != v for k, v in identity.items())
                    or frozen.get('session_date') != row['session_date']
                    or frozen.get('previous_session_date') != previous_date):
                raise RuntimeError('paired_nav_chain_session_manifest_mismatch')
            arms = payload.get('arms')
            if not isinstance(arms, dict) or set(arms) != {'baseline', 'candidate'}:
                raise RuntimeError('paired_nav_chain_both_arms_required')
            for name, arm in arms.items():
                nav, opening = arm.get('nav'), previous[name].get('nav')
                if nav is not None:
                    number(nav, name + '.nav', minimum=0)
                elif arm.get('valuation_complete') is not False:
                    raise RuntimeError('paired_nav_chain_missing_valuation_status')
                if opening is not None:
                    opening += cash_correction_amount(arm)
                expected_return = None if nav is None or opening is None or opening == 0 else nav / opening - 1.0
                _same_number(arm.get('daily_return'), expected_return, name + '.daily_return')
            returns = [arms[a].get('daily_return') for a in ('candidate', 'baseline')]
            delta = None if None in returns else returns[0] - returns[1]
            _same_number(payload.get('net_return_delta'), delta, 'net_return_delta')
            receipts = query('''SELECT snapshot_id FROM paired_nav_frozen_manifests_v1
                WHERE snapshot_kind='execution_receipt' AND parent_snapshot_id=?''', [row['snapshot_id']])
            if len(receipts) != 1:
                raise RuntimeError('paired_nav_chain_execution_receipt_missing_or_ambiguous')
            receipt_snapshot = read_snapshot(query, receipts[0]['snapshot_id'])
            execution = receipt_snapshot['payload']['content']
            if (digest(execution) != payload.get('execution_checksum')
                    or execution.get('snapshot_id') != row['snapshot_id']
                    or execution.get('session_date') != row['session_date']
                    or any(execution.get(k) != v for k, v in identity.items())):
                raise RuntimeError('paired_nav_chain_execution_receipt_mismatch')
            # A late receipt supports a later decision, never an earlier one.
            # Recheck raw availability even for an already materialized ledger.
            opened = _timestamp(frozen['session_open_at'])
            closed = _timestamp(frozen['session_close_at'])
            observed = _timestamp(execution['observed_at'])
            received = _timestamp(receipt_snapshot['manifest']['frozen_at'])
            taipei = timezone(timedelta(hours=8))
            if (not frozen_at < opened < closed <= observed <= received <= clock
                    or any(value.astimezone(taipei).date().isoformat() != row['session_date']
                           for value in (opened, closed))):
                raise ValueError('paired_nav_raw_execution_not_observable')
            for name, arm in arms.items():
                if any(not opened <= _timestamp(fill['executed_at']) <= closed
                       for fill in execution['arms'][name]['fills']):
                    raise ValueError('paired_nav_raw_fill_outside_session')
                # Reconcile the ledger against the sealed raw receipt. This is
                # accounting replay only: no new fill, prices, or native orders.
                reconciled = replay_session(previous=previous[name],
                    fills=execution['arms'][name]['fills'], marks=execution['marks'],
                    corporate_actions=execution['corporate_actions'],
                    session_date=row['session_date'], fees=frozen['fees'], allow_unpriced_rights=True,
                    cash_history=history[name] if cash_accounting_enabled(execution) else None)
                if digest(arm) != digest(reconciled):
                    raise RuntimeError('paired_nav_chain_execution_accounting_mismatch:' + name)
            interval = paired_return_interval(previous, arms)
            advance_cash_history(history, previous, arms, execution['corporate_actions'], row['session_date'])
            if delta is not None and not interval['lower'] <= delta <= interval['upper']:
                raise RuntimeError('paired_nav_point_outside_return_interval')
            coverage['bounded_sessions'] += int(interval['lower'] is not None and interval['upper'] is not None)
            coverage['accounted_sessions'] += 1
            pair_count += 1
            coverage['latest_accounted'] = max(coverage['latest_accounted'] or '', row['session_date'])
            if delta is not None:
                exact_pair_count += 1
                coverage['sessions'] += 1
                coverage['latest'] = max(coverage['latest'] or '', row['session_date'])
            chain_checksum = digest([chain_checksum, current_pair, row['session_date'], row['payload_checksum'], interval])
            if observe_prefix is not None:
                observe_prefix({'pair_id': current_pair, 'pair_identity': dict(identity),
                    'session_date': row['session_date'], 'accounted_sessions': pair_count,
                    'exact_nav_sessions': exact_pair_count, 'journal_checksum': row['payload_checksum'],
                    'previous_journal_checksum': previous_checksum, 'snapshot_id': row['snapshot_id'],
                    'candidate_daily_return': returns[0], 'baseline_daily_return': returns[1],
                    'net_return_delta': delta, 'return_enclosure': dict(interval), 'comparison': comparison,
                    'cash_restatement': {'previous_session_date': previous_date,
                        'opening_bounds': {a: _nav_interval(previous[a]) for a in arms},
                        'closing_bounds': {a: _nav_interval(arms[a]) for a in arms},
                        'corrections': {a: arms[a].get('cash_corrections', []) for a in arms},
                        'available_at': received.isoformat()}})
            previous, previous_checksum, previous_date = arms, row['payload_checksum'], row['session_date']
        cursor_pair, cursor_date = rows[-1]['pair_id'], rows[-1]['session_date']
    # Rows are immutable, but a concurrent publisher may add an earlier pair
    # while keyset pagination advances. Do not issue a complete-prefix receipt
    # if that publisher was missed; the existing nightly retry will re-audit.
    count = query('SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1 WHERE session_date<=?'
        + (' AND pair_id=?' if pair_id else ''), [business_date, *([pair_id] if pair_id else [])])
    if len(count) != 1 or count[0]['n'] != coverage['accounted_sessions']:
        raise RuntimeError('paired_nav_chain_concurrent_publication_retry')
    return {**coverage, 'chain_checksum': chain_checksum, 'chain_verified': True,
        **({'cash_history': history} if include_cash_history else {})}


def cash_accounting_enabled(execution):
    version = execution.get('cash_accounting_version')
    if version is not None and (type(version) is not int or version != 1):
        raise ValueError('paired_nav_cash_accounting_version_invalid')
    return version == 1


def cash_correction_amount(account):
    return math.fsum(number(c['cash_due'], 'cash_correction.amount', minimum=0)
                     for c in account.get('cash_corrections', []))


def empty_cash_history():
    return {arm: {'openings': {}, 'recognized_cash_ids': [], 'nav_endpoints': [], 'cash_corrections': []}
            for arm in ('baseline', 'candidate')}


def advance_cash_history(history, previous, current, actions, session_date):
    """Called only after reconciliation; never infer ownership from a later lot."""
    for arm, context in history.items():
        if not context['nav_endpoints']:
            context['initial_peak_nav'] = previous[arm].get('peak_nav', previous[arm].get('nav'))
        context['openings'][session_date] = dict(previous[arm]['positions'])
        context['nav_endpoints'].append({'session_date': session_date, 'nav': current[arm].get('nav')})
        context['cash_corrections'].extend(dict(c) for c in current[arm].get('cash_corrections', []))
        recognized = set(context['recognized_cash_ids'])
        recognized.update(r['action_id'] for r in current[arm].get('corporate_receivables', []) if r.get('kind') == 'cash')
        recognized.update(c['action_id'] for c in current[arm].get('cash_corrections', []))
        recognized.update(a['action_id'] for a in actions if a.get('kind') == 'cash'
            and a.get('ex_date') == session_date and previous[arm]['positions'].get(a['symbol'], 0) > 0)
        context['recognized_cash_ids'] = sorted(recognized)


def read_verified_cash_history(*, query, pair_id, before_date, now=None):
    # Reuse the actual chain owner and its complete receipt replay, scoped to
    # this pair. No extra ledger, quantities from current native output or SQL
    # shortcut around history verification.
    cutoff = (date.fromisoformat(before_date) - timedelta(days=1)).isoformat()
    return verify_journal_chain(business_date=cutoff, query=query, pair_id=pair_id,
        include_cash_history=True, now=now)['cash_history']
