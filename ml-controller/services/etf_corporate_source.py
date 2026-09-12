"""FinLab ETF catalog + current official TWSE distribution observation.

Company dividend_announcement has no ETF rows. Missing amounts in the ETF
feed are not zero: reconcile against the exact current public distribution
table, keep both raw sources and never assign historical observation credit.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import re
import time

import httpx
import polars as pl

from services.paired_nav_journal import digest

ORIGIN = 'https://www.twse.com.tw'
TW = timezone(timedelta(hours=8))


class DistributionTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.found = False
        self.cell = None
        self.row = []
        self.rows = []
        self.headers = []
        self.header = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'table' and attrs.get('id') == 'myTable':
            if self.found:
                raise ValueError('etf_distribution_ambiguous_table')
            self.active = self.found = True
        if not self.active:
            return
        if tag == 'tr':
            self.row = []
        if tag in ('td', 'th'):
            self.cell, self.header = [], tag == 'th'
        if self.cell is not None and 'data-desc' in attrs:
            self.cell.append(attrs['data-desc'])

    def handle_data(self, text):
        if self.active and self.cell is not None:
            self.cell.append(text)

    def handle_endtag(self, tag):
        if not self.active:
            return
        if tag in ('td', 'th') and self.cell is not None:
            text = ''.join(self.cell).strip()
            if self.header:
                self.headers.append(text)
            else:
                self.row.append(text)
            self.cell = None
        if tag == 'tr' and self.row:
            self.rows.append(self.row)
        if tag == 'table':
            self.active = False


def roc_date(value):
    match = re.fullmatch(r'(\d{3})年(\d{2})月(\d{2})日', value.strip())
    if not match:
        raise ValueError('etf_distribution_date_invalid')
    return date(int(match[1]) + 1911, int(match[2]), int(match[3])).isoformat()


def parse_distribution_table(html, symbol):
    parser = DistributionTable()
    parser.feed(html)
    required = ['證券代號', '證券簡稱', '除息交易日', '收益分配基準日', '收益分配發放日']
    if not parser.found or parser.headers[:5] != required:
        raise ValueError('etf_distribution_layout_changed')
    events = {}
    for row in parser.rows:
        if len(row) != 8 or row[0] != symbol:
            raise ValueError('etf_distribution_universe_or_row_mismatch')
        ex_date, record, pay = map(roc_date, row[2:5])
        amount = None
        if row[5].strip():
            try:
                value = Decimal(row[5].strip())
            except InvalidOperation:
                raise ValueError('etf_distribution_amount_invalid') from None
            if not value.is_finite() or value < 0:
                raise ValueError('etf_distribution_amount_invalid')
            amount = float(value)
        event = {'symbol': symbol, 'ex_date': ex_date, 'record_date': record,
            'payable_date': pay, 'cash_per_share': amount,
            'cash_rounding': 'floor_twd' if re.search(r'元以下(?:全捨|無條件捨去)', row[6]) else None,
            'terms': row[6]}
        if pay < ex_date or record < ex_date or ex_date in events and events[ex_date] != event:
            raise ValueError('etf_distribution_conflicting_terms')
        events[ex_date] = event
    return list(events.values())


def _get(client, endpoint, **kwargs):
    for attempt in range(3):
        try:
            result = client.get(endpoint, **kwargs)
            if result.status_code not in {429, 500, 502, 503, 504}:
                result.raise_for_status()
                return result
        except httpx.RequestError:
            pass
        if attempt < 2:
            time.sleep(.25 * 2 ** attempt)
    raise ValueError('etf_distribution_source_unavailable')


def fetch_etf_corporate_source(*, symbols, session_date, outstanding_action_ids=(),
                             client=None, dataset=None, clock=None, outstanding_scope='complete',
                             historical_cash_dates=None):
    from finlab import data
    from services.corporate_opening_history import normalize_historical_cash_dates
    history = normalize_historical_cash_dates(historical_cash_dates, symbols=symbols, session_date=session_date)
    day = date.fromisoformat(session_date)
    if outstanding_scope not in ('complete', 'union_component'):
        raise ValueError('etf_outstanding_scope_invalid')
    clock = clock or (lambda: datetime.now(timezone.utc))
    if any(not re.fullmatch(r'0[0-9A-Za-z]{3,7}', symbol) for symbol in symbols):
        raise ValueError('etf_distribution_symbol_invalid')
    if dataset is None:
        dataset = pl.from_pandas(data.get('tw_etf_dividend_events', force_download=True, save_to_storage=False))
    required = {'symbol', 'date', '收益分配基準日', '收益分配發放日', '收益分配金額(每1受益權單位)', 'key_date'}
    if dataset.is_empty() or not required <= set(dataset.columns):
        raise ValueError('etf_finlab_schema_or_data_missing')
    if client is None:
        with httpx.Client(timeout=25, follow_redirects=False) as owned:
            return fetch_etf_corporate_source(symbols=symbols, session_date=session_date,
                outstanding_action_ids=outstanding_action_ids, client=owned, dataset=dataset, clock=clock,
                outstanding_scope=outstanding_scope, historical_cash_dates=history)
    registry = _get(client, ORIGIN + '/rwd/api/codeEtf').json()
    if not isinstance(registry, list) or not registry or any(not isinstance(s, str) for s in registry):
        raise ValueError('etf_distribution_registry_invalid')
    if set(symbols) - set(registry):
        raise ValueError('etf_distribution_exchange_coverage_missing')
    actions, raw, blockers = [], {}, {}
    for symbol in symbols:
        first_year = min([day.year - 1, *[date.fromisoformat(d).year for d in history.get(symbol, [])]])
        params = {'stkNo': symbol, 'startDate': str(first_year), 'endDate': str(day.year)}
        result = _get(client, ORIGIN + '/zh/ETFortune/dividendList', params=params)
        events = parse_distribution_table(result.text, symbol)
        raw[symbol] = {'url': ORIGIN + '/zh/ETFortune/dividendList', 'params': params,
            'html': result.text, 'html_checksum': digest(result.text)}
        for event in events:
            action_id = digest({'source': 'twse.etf_income_distribution', 'symbol': symbol, 'ex_date': event['ex_date']})
            if (event['ex_date'] != session_date and action_id not in outstanding_action_ids
                    and event['ex_date'] not in history.get(symbol, [])):
                continue
            if event['cash_per_share'] is None:
                blockers.setdefault(symbol, []).append('etf_distribution_amount_not_announced')
                continue
            if event['cash_per_share'] == 0:
                continue
            actions.append({**event, 'action_id': action_id, 'kind': 'cash', 'stock_per_share': 0.})
    if outstanding_scope == 'complete' and set(outstanding_action_ids) - {a['action_id'] for a in actions}:
        raise ValueError('etf_distribution_outstanding_event_missing')
    observed = clock()
    if observed.tzinfo is None:
        raise ValueError('etf_distribution_observation_clock_missing')
    result = {'schema_version': 'paper-corporate-source-v1', 'session_date': session_date,
        'source': 'finlab.etf_catalog+twse.current_distribution', 'observed_at': observed.isoformat(),
        'covered_symbols': sorted(symbols), 'actions': actions, 'blockers': blockers,
        'tax_basis': 'gross_before_personal_tax', 'raw_source': {'twse': raw, 'registry': registry,
            'finlab_rows_json': dataset.filter(pl.col('symbol').cast(pl.String).is_in(symbols)).write_json()},
        'prospective_backfill_credit': 0}
    result['source_checksum'] = digest(result)
    return result
