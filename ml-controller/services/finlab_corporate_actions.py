"""PIT corporate-action source adapter. No order/account writes or silent gaps.

Column mapping verified against dividend_announcement, FinLab 2.0.13, on
2026-09-08. The dataset has cash payment dates but NOT stock delivery dates.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import re

import polars as pl

from services.paired_nav_journal import digest

TW = timezone(timedelta(hours=8))
CASH = ('盈餘分配之股東現金股利(元/股)', '法定盈餘公積、資本公積發放之現金(元/股)')
STOCK = ('盈餘轉增資配股(元/股)', '法定盈餘公積、資本公積轉增資配股(元/股)')
REQUIRED = {'stock_id', '公告日期', '公告時間', 'key_date', '股利所屬期間', '除息交易日',
            '除權交易日', '現金股利發放日', '普通股每股面額', '現金增資認股比率(%)', *CASH, *STOCK}


def _date(value):
    if value is None or str(value).strip() in ('', 'NaT', 'nan', 'None'):
        return None
    return date.fromisoformat(str(value)[:10]).isoformat()


def _amount(value):
    # Null is not a zero dividend; the source can explicitly supply zero.
    if value is None or isinstance(value, bool):
        raise ValueError('corporate_amount_missing')
    try:
        number = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError('corporate_amount_invalid') from exc
    if not number.is_finite() or number < 0:
        raise ValueError('corporate_amount_invalid')
    return number


def _subscription_event_key(row):
    """Match a relabelled offering only with complete unchanged event terms.

    Fiscal period is dividend metadata, not a cash-capital-increase identity.
    A missing/different event basis is never guessed to be the same offering.
    Invalid terms still reach the normal strict row validation below.
    """
    try:
        ex_date, record_date = _date(row['除權交易日']), _date(row.get('權利分派基準日'))
        basis = tuple(_amount(row.get(c)) for c in
            ('現金增資認股比率(%)', '現金增資總股數(股)', '參加分派總股數'))
        return (str(row['stock_id']), ex_date, record_date, *basis) if ex_date and record_date and all(basis) else None
    except (ValueError, TypeError):
        return None


def normalize_dividend_announcements(rows: pl.DataFrame, *, symbols: list[str], session_date: str,
                                    observed_at: datetime, outstanding_action_ids: tuple[str, ...] = (),
                                    outstanding_scope: str = 'complete', historical_cash_dates=None) -> dict:
    """Select last actually observable revision of each fiscal-period event.

    Never infer payment or delivery dates from ex-date/T+2. Every requested stock
    is covered only if the complete source fetch succeeded; row-level unknowns
    remain explicit blockers, not dropped records.
    """
    date.fromisoformat(session_date)
    if observed_at.tzinfo is None or not REQUIRED <= set(rows.columns):
        raise ValueError('corporate_source_schema_or_clock_invalid')
    symbols = sorted(set(symbols))
    from services.corporate_opening_history import normalize_historical_cash_dates
    historical_cash_dates = normalize_historical_cash_dates(historical_cash_dates, symbols=symbols, session_date=session_date)
    if outstanding_scope not in ('complete', 'union_component'):
        raise ValueError('corporate_outstanding_scope_invalid')
    if any(symbol.startswith('0') for symbol in symbols):
        raise ValueError('corporate_company_feed_does_not_cover_etfs')
    if not symbols or any(not re.fullmatch(r'[0-9A-Za-z]{4,8}', symbol) for symbol in symbols):
        raise ValueError('corporate_source_universe_invalid')
    selected, blockers = {}, {}
    ambiguous = set()
    relevant = rows.filter(pl.col('stock_id').cast(pl.String).is_in(symbols)).to_dicts()
    def action_id(symbol, period, kind, ex_date):
        return digest({'source': 'finlab.dividend_announcement', 'symbol': symbol,
                       'period': period, 'kind': kind, 'ex_date': ex_date})
    # Old completed fiscal periods are not today's missing data. Retain all
    # revisions of a relevant period so a newer postponement cancels the old
    # date, while outstanding rights explicitly carry across sessions.
    relevant_periods = set()
    for row in relevant:
        symbol, period = str(row['stock_id']), str(row['股利所屬期間'])
        for kind, field in [('cash', '除息交易日'), ('stock', '除權交易日'), ('subscription', '除權交易日')]:
            ex_date = _date(row[field])
            if (ex_date == session_date or action_id(symbol, period, kind, ex_date) in outstanding_action_ids
                    or kind == 'cash' and ex_date in historical_cash_dates.get(symbol, [])):
                relevant_periods.add((symbol, period))
    # An outstanding action can retain its original period-based ID while the
    # issuer corrects that label. Include the matching offering's other labels.
    subscription_keys = {_subscription_event_key(row) for row in relevant
        if (str(row['stock_id']), str(row['股利所屬期間'])) in relevant_periods}
    subscription_keys.discard(None)
    for row in relevant:
        if _subscription_event_key(row) in subscription_keys:
            relevant_periods.add((str(row['stock_id']), str(row['股利所屬期間'])))
    for row in relevant:
        symbol = str(row['stock_id'])
        if (symbol, str(row['股利所屬期間'])) not in relevant_periods:
            continue
        try:
            publication = datetime.combine(date.fromisoformat(_date(row['公告日期'])),
                time.fromisoformat(str(row['公告時間'])), TW)
            seen = datetime.fromisoformat(str(row['key_date']))
            seen = seen.replace(tzinfo=TW) if seen.tzinfo is None else seen
            # Availability is max(publication, ingestion), not an old date on
            # a later revised row. This never manufactures historical PIT.
            available = max(publication, seen)
            if available > observed_at:
                continue
            key = (symbol, str(row['股利所屬期間']))
            if not key[1] or key[1] == 'None':
                raise ValueError('corporate_fiscal_period_missing')
            old = selected.get(key)
            if old and available == old[0] and row != old[1]:
                ambiguous.add(key)
            if old is None or available > old[0]:
                selected[key] = (available, row)
                # An older conflicting batch is superseded by a later complete
                # observable revision. Defer ambiguity until the winner is known
                # so input row order cannot turn valid evidence into a blocker.
                ambiguous.discard(key)
        except (ValueError, TypeError):
            blockers.setdefault(symbol, []).append('announcement_identity_or_time_invalid')
    for symbol, period in ambiguous:
        blockers.setdefault(symbol, []).append('announcement_identity_or_time_invalid')
    # An event exists in the fetched catalog, but no revision was observable
    # at the requested cutoff. That is a PIT gap, not a certified no-action day.
    for symbol, period in relevant_periods - set(selected):
        blockers.setdefault(symbol, []).append('corporate_event_has_no_observable_revision')
    subscription_groups = {}
    for key, (available, row) in selected.items():
        event = _subscription_event_key(row)
        if event and key not in ambiguous:
            subscription_groups.setdefault(event, []).append((key, available, row))
    subscription_owners, subscription_periods = {}, {}
    for event, versions in subscription_groups.items():
        latest_time = max(v[1] for v in versions)
        latest = [v for v in versions if v[1] == latest_time]
        if len({str(v[2].get('現金增資認購價(元/股)')) for v in latest}) != 1:
            blockers.setdefault(event[0], []).append('subscription_revision_ambiguous')
            subscription_owners.update({v[0]: None for v in versions})
            continue
        owner = min(latest, key=lambda v: v[0])[0]
        outstanding = [v[0][1] for v in versions
            if action_id(v[0][0], v[0][1], 'subscription', event[1]) in outstanding_action_ids]
        if len(outstanding) > 1:
            raise ValueError('corporate_subscription_duplicate_outstanding_identity')
        subscription_owners.update({v[0]: owner for v in versions})
        subscription_periods[owner] = outstanding[0] if outstanding else owner[1]
    actions = []
    for (symbol, period), (available, row) in sorted(selected.items()):
        if (symbol, period) in ambiguous:
            continue  # Never emit arbitrarily chosen terms from a true conflict.
        try:
            cash, stock = sum((_amount(row[c]) for c in CASH)), sum((_amount(row[c]) for c in STOCK))
            cash_ex, stock_ex = _date(row['除息交易日']), _date(row['除權交易日'])
            subscription = _amount(row['現金增資認股比率(%)'])
            subscription_period = subscription_periods.get((symbol, period), period)
            if (subscription and stock_ex and subscription_owners.get((symbol, period), (symbol, period)) == (symbol, period)
                    and (stock_ex == session_date or action_id(symbol, subscription_period, 'subscription', stock_ex) in outstanding_action_ids)):
                price = _amount(row.get('現金增資認購價(元/股)'))
                issued = _amount(row.get('現金增資總股數(股)'))
                previous = _amount(row.get('參加分派總股數'))
                if not price or not issued or not previous:
                    raise ValueError('subscription_price_or_share_capital_missing')
                actions.append({'action_id': action_id(symbol, subscription_period, 'subscription', stock_ex),
                    'symbol': symbol, 'kind': 'subscription', 'ex_date': stock_ex, 'payable_date': None,
                    'cash_per_share': 0, 'stock_per_share': 0,
                    'fiscal_period': subscription_period, 'record_date': _date(row.get('權利分派基準日')),
                    'rights': {'ratio': float(subscription / 100), 'subscription_price': float(price),
                        'issued_ratio': float(issued / previous), 'policy': 'do_not_subscribe'}})
            for kind, amount, ex_date in [('cash', cash, cash_ex), ('stock', stock, stock_ex)]:
                if amount == 0:
                    continue
                if not ex_date:
                    # Future proposal without declared ex-date is not an
                    # entitlement. It is retained in the raw source checksum.
                    continue
                if (ex_date != session_date and action_id(symbol, period, kind, ex_date) not in outstanding_action_ids
                        and not (kind == 'cash' and ex_date in historical_cash_dates.get(symbol, []))):
                    continue
                ratio = Decimal(0)
                if kind == 'stock':
                    match = re.fullmatch(r'新台幣([0-9]+(?:\.[0-9]+)?)元', str(row['普通股每股面額']).strip())
                    if not match or Decimal(match[1]) <= 0:
                        raise ValueError('stock_dividend_par_value_missing')
                    ratio = amount / Decimal(match[1])
                payable = _date(row['現金股利發放日']) if kind == 'cash' else None
                if payable and payable < ex_date:
                    raise ValueError('corporate_payment_before_entitlement')
                actions.append({'action_id': action_id(symbol, period, kind, ex_date),
                    'symbol': symbol, 'kind': kind, 'ex_date': ex_date, 'payable_date': payable,
                    'fiscal_period': period, 'record_date': _date(row.get('權利分派基準日')),
                    'cash_per_share': float(amount) if kind == 'cash' else 0,
                    'stock_per_share': float(ratio) if kind == 'stock' else 0})
        except (ValueError, TypeError) as exc:
            blockers.setdefault(symbol, []).append(str(exc))
    if outstanding_scope == 'complete' and set(outstanding_action_ids) - {a['action_id'] for a in actions}:
        raise ValueError('corporate_outstanding_source_identity_missing')
    # Hash the complete fetched schema/data, not only selected happy-path rows.
    source_identity = {'source': 'finlab.dividend_announcement', 'columns': rows.columns,
        'data': rows.write_json(), 'observed_at': observed_at.isoformat()}
    return {'schema_version': 'paper-corporate-source-v1', 'session_date': session_date,
        'observed_at': observed_at.isoformat(), 'source_checksum': digest(source_identity),
        'covered_symbols': symbols, 'actions': actions,
        'blockers': {s: sorted(set(reasons)) for s, reasons in blockers.items()},
        'tax_basis': 'gross_before_personal_tax',
        'raw_source': {'columns': rows.columns,
            'rows_json': rows.filter(pl.col('stock_id').cast(pl.String).is_in(symbols)).write_json()},
        'source': 'finlab.dividend_announcement', 'stock_delivery_source_complete': False}


def fetch_finlab_corporate_source(*, symbols: list[str], session_date: str,
                                outstanding_action_ids: tuple[str, ...] = (), clock=None,
                                outstanding_scope: str = 'complete', historical_cash_dates=None) -> dict:
    from finlab import data
    from finlab.auth import get_session
    from services.finlab_auth import finlab_session_auth_available
    if not finlab_session_auth_available() and get_session() is None:
        raise ValueError('corporate_finlab_headless_auth_missing')
    clock = clock or (lambda: datetime.now(timezone.utc))
    # Do not silently re-use a local stale cache. Explicit fresh, no cache writes.
    raw = data.get('dividend_announcement', force_download=True, save_to_storage=False)
    rows = pl.from_pandas(raw)
    if rows.is_empty():
        raise ValueError('corporate_finlab_source_empty')
    result = normalize_dividend_announcements(rows, symbols=symbols, session_date=session_date,
        outstanding_action_ids=outstanding_action_ids, observed_at=clock(), outstanding_scope=outstanding_scope,
        historical_cash_dates=historical_cash_dates)
    result['raw_source_rows'] = rows.height
    return result


def _fetch_dividend_sources(*, symbols: list[str], session_date: str,
                                outstanding_action_ids: tuple[str, ...] = (),
                                dividend_reader=None, delivery_reader=None, etf_reader=None, historical_cash_dates=None) -> dict:
    """One source composition owner for settlement and private paired execution.

    The caller must persist this result before consumption. A retry must reuse
    the persisted receipt, not fetch revised terms for an already-booked day.
    """
    from services.mops_corporate_terms import fetch_mops_delivery_announcements, enrich_stock_delivery_source
    from services.subscription_rights import enrich_subscription_source
    dividend_reader = dividend_reader or fetch_finlab_corporate_source
    delivery_reader = delivery_reader or fetch_mops_delivery_announcements
    etfs = sorted(s for s in symbols if s.startswith('0'))
    companies = sorted(set(symbols) - set(etfs))
    def history(universe):
        values = {s: dates for s, dates in (historical_cash_dates or {}).items() if s in universe}
        return {'historical_cash_dates': values} if values else {}
    if etfs:
        from services.etf_corporate_source import fetch_etf_corporate_source
        parts = [(etf_reader or fetch_etf_corporate_source)(symbols=etfs, session_date=session_date,
            outstanding_action_ids=outstanding_action_ids, outstanding_scope='union_component', **history(etfs))]
        if companies:
            company = dividend_reader(symbols=companies, session_date=session_date,
                outstanding_action_ids=outstanding_action_ids, outstanding_scope='union_component', **history(companies))
            evidence = {s: delivery_reader(symbol=s) for s in sorted({a['symbol'] for a in company['actions']})}
            parts.append(enrich_subscription_source(enrich_stock_delivery_source(company, evidence), evidence))
        actions = [action for part in parts for action in part['actions']]
        if sorted(s for part in parts for s in part['covered_symbols']) != sorted(set(symbols)):
            raise ValueError('corporate_source_union_coverage_missing')
        result = {'schema_version': 'paper-corporate-source-v1', 'session_date': session_date,
            'source': 'paper-corporate-union-v1', 'covered_symbols': sorted(set(symbols)),
            'observed_at': max(datetime.fromisoformat(part['observed_at']) for part in parts).isoformat(),
            'actions': actions, 'blockers': {s: reasons for part in parts for s, reasons in part.get('blockers', {}).items()},
            'tax_basis': 'gross_before_personal_tax', 'source_components': parts}
        result['source_checksum'] = digest(result)
        return result
    snapshot = dividend_reader(symbols=symbols, session_date=session_date,
        outstanding_action_ids=outstanding_action_ids, outstanding_scope='union_component', **history(companies))
    action_symbols = sorted({a['symbol'] for a in snapshot['actions']})
    evidence = {symbol: delivery_reader(symbol=symbol) for symbol in action_symbols}
    return enrich_subscription_source(enrich_stock_delivery_source(snapshot, evidence), evidence)


def fetch_paper_corporate_source(*, symbols: list[str], session_date: str,
                                outstanding_action_ids: tuple[str, ...] = (),
                                dividend_reader=None, delivery_reader=None, etf_reader=None,
                                capital_reader=None, historical_cash_dates=None) -> dict:
    from services.capital_corporate_source import fetch_capital_corporate_source
    from services.corporate_opening_history import normalize_historical_cash_dates
    historical_cash_dates = normalize_historical_cash_dates(historical_cash_dates, symbols=symbols, session_date=session_date)
    dividends = _fetch_dividend_sources(symbols=symbols, session_date=session_date,
        outstanding_action_ids=outstanding_action_ids, dividend_reader=dividend_reader,
        delivery_reader=delivery_reader, etf_reader=etf_reader, historical_cash_dates=historical_cash_dates)
    capital = (capital_reader or fetch_capital_corporate_source)(symbols=symbols, session_date=session_date,
        outstanding_action_ids=outstanding_action_ids)
    parts = [dividends, capital]
    if any(sorted(p['covered_symbols']) != sorted(set(symbols)) for p in parts):
        raise ValueError('corporate_source_union_coverage_missing')
    actions = [a for p in parts for a in p['actions']]
    ids = [a['action_id'] for a in actions]
    if len(ids) != len(set(ids)):
        raise ValueError('corporate_source_union_duplicate_action')
    if set(outstanding_action_ids) - set(ids):
        raise ValueError('corporate_outstanding_source_identity_missing')
    blockers = {}
    for part in parts:
        for symbol, reasons in part.get('blockers', {}).items():
            blockers.setdefault(symbol, []).extend(reasons)
    result = {'schema_version': 'paper-corporate-source-v1', 'session_date': session_date,
              'source': 'paper-corporate-union-v1', 'covered_symbols': sorted(set(symbols)),
              'observed_at': max(datetime.fromisoformat(p['observed_at']) for p in parts).isoformat(),
              'actions': actions, 'blockers': blockers, 'tax_basis': 'gross_before_personal_tax',
              'stock_delivery_source_complete': dividends.get('stock_delivery_source_complete', False),
              'source_components': parts}
    result['source_checksum'] = digest(result)
    return result
