"""FinLab event catalog + exact TWSE/TPEx delivered share conversion terms.

Observed public forms on 2026-09-08. Price-adjustment ratios are NEVER used as
share conversion ratios. Payment/election terms absent from the official price
table stay unknown, not fabricated cash. All downloads are read-only.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser
import re

import httpx
import polars as pl

from services.etf_corporate_source import _get
from services.paired_nav_journal import digest

CATALOGS = {'twse': 'capital_reduction_tse:恢復買賣日期',
            'tpex': 'capital_reduction_otc:恢復買賣日期', 'etf': 'etf_split:恢復買賣日期'}
TWSE = 'https://www.twse.com.tw/rwd/zh/reducation/'
TPEX = 'https://www.tpex.org.tw/www/zh-tw/bulletin/revivt'


def action_date(raw):
    text = str(raw).strip()[:10]
    if re.fullmatch(r'\d{7}', text):
        return date(int(text[:3]) + 1911, int(text[3:5]), int(text[5:])).isoformat()
    if re.fullmatch(r'\d{3}/\d{2}/\d{2}', text):
        return date(int(text[:3]) + 1911, int(text[4:6]), int(text[7:])).isoformat()
    return date.fromisoformat(text).isoformat()


def amount(raw, unit):
    # Require the announced quantity's unit; price/ratio confusion is fatal.
    match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)\s*' + re.escape(unit), str(raw).strip())
    if not match:
        raise ValueError('capital_issuer_amount_or_unit_invalid')
    return Decimal(match[1])


def event_id(exchange, symbol, resume, leg):
    return digest({'source': 'finlab.capital_catalog+official_terms', 'exchange': exchange,
                   'symbol': symbol, 'resume_date': resume, 'leg': leg})


def catalog_events(catalogs, symbols, session_date, outstanding_action_ids):
    """Wide SDK input is converted once to Polars; zero events is not a failed fetch."""
    selected, raw = [], {}
    for exchange, dataset in CATALOGS.items():
        frame = catalogs[dataset]
        if not isinstance(frame, pl.DataFrame) or frame.is_empty() or 'date' not in frame.columns:
            raise ValueError('capital_catalog_schema_or_fetch_missing')
        columns = [s for s in symbols if s in frame.columns]
        portion = frame.select(['date', *columns])
        raw[dataset] = portion.write_json()
        for row in portion.iter_rows(named=True):
            for symbol in columns:
                value = row[symbol]
                if value is None or str(value) in ('NaT', 'nan', 'None'):
                    continue
                resume = action_date(value)
                if resume == session_date or any(event_id(exchange, symbol, resume, leg) in outstanding_action_ids
                                                  for leg in ('exchange', 'refund', 'fraction')):
                    selected.append({'exchange': exchange, 'symbol': symbol, 'resume_date': resume,
                                     'catalog_date': action_date(row['date'])})
    keys = [(e['exchange'], e['symbol'], e['resume_date']) for e in selected]
    if len(keys) != len(set(keys)):
        raise ValueError('capital_catalog_duplicate_event')
    return selected, raw


def parse_twse_detail(packet, symbol):
    expected = ['股票代號：', '股票名稱：', '停止買賣日期：', '每壹仟股換發新股票：',
                '每股退還股款：', '原股每股配發現金股利：', '減資並(有償)現金增資：',
                '每股認購金額：', 'a. 公開承銷：', 'b. 員工認購：', 'c. 原股東認購：', '按股東持股比例每千股認購：']
    if packet.get('stat') != 'OK' or packet.get('fields') != expected or len(packet.get('data', [])) != 1:
        raise ValueError('capital_twse_detail_layout_changed')
    row = packet['data'][0]
    if len(row) != len(expected) or str(row[0]).strip() != symbol:
        raise ValueError('capital_twse_detail_identity_mismatch')
    ratio = amount(row[3], '股') / 1000
    cash = amount(row[4], '元/股')
    if amount(row[5], '元/股') or any(amount(row[i], '股') for i in (6, 8, 9, 10, 11)):
        raise ValueError('capital_combined_subscription_or_dividend_requires_terms')
    if amount(row[7], '元/股') or ratio <= 0:
        raise ValueError('capital_conversion_terms_invalid')
    return {'stop_date': action_date(row[2]), 'share_ratio': float(ratio), 'cash_return': float(cash)}


class DetailTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cell = None
        self.cells = []

    def handle_starttag(self, tag, attrs):
        if tag in ('th', 'td'):
            if self.cell is not None:
                raise ValueError('capital_tpex_nested_cell')
            self.cell = []

    def handle_data(self, text):
        if self.cell is not None:
            self.cell.append(text)

    def handle_endtag(self, tag):
        if tag in ('th', 'td') and self.cell is not None:
            self.cells.append(''.join(self.cell).strip())
            self.cell = None


def parse_tpex_detail(html, symbol, resume):
    table = DetailTable()
    table.feed(html)
    expected = ['股票代號/股票名稱:', '停止買賣日期:', '恢復買賣日期:', '每壹仟股換發新股票:',
                '每股退還股款:', '現金增資總股數:', '現金增資認購價:', '現金增資配股率:']
    if len(table.cells) != 16 or table.cells[::2] != expected:
        raise ValueError('capital_tpex_detail_layout_changed')
    row = table.cells[1::2]
    if row[0].split('/')[0].strip() != symbol or action_date(row[2]) != resume:
        raise ValueError('capital_tpex_detail_identity_mismatch')
    if any(v != 'NA' for v in row[5:]):
        raise ValueError('capital_combined_subscription_requires_terms')
    ratio = amount(row[3], '股') / 1000
    if ratio <= 0:
        raise ValueError('capital_conversion_terms_invalid')
    return {'stop_date': action_date(row[1]), 'share_ratio': float(ratio),
            'cash_return': float(amount(row[4], '元/股'))}


def par_ratio(ratio, before, after):
    values = [amount(v, '') for v in (ratio, before, after)]
    if any(v <= 0 for v in values) or values[0] * values[2] != values[1]:
        raise ValueError('capital_par_share_ratio_conflict')
    return float(values[0])


def current_par_events(public, symbols, session_date):
    """Daily official census, including changes absent from reduction catalogs.

    Explicit share ratios only: a rounded reference-price quotient is NOT a
    quantity source. Historical rights remain tied to their sealed opening event.
    """
    raw, events = {}, []
    raw['twse_par'] = public('https://www.twse.com.tw/rwd/zh/change/TWTB8U', {
        'startDate': session_date.replace('-', ''), 'endDate': session_date.replace('-', ''), 'response': 'json'})
    raw['tpex_par'] = public('https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt', {
        'startDate': session_date.replace('-', '/'), 'endDate': session_date.replace('-', '/'), 'response': 'json'})
    for exchange, packet in raw.items():
        if exchange == 'twse_par':
            if packet.get('stat') != 'OK' or packet.get('fields') != [
                '恢復買賣日期', '股票代號', '名稱', '停止買賣前收盤價格', '恢復買賣參考價',
                '漲停價格', '跌停價格', '開盤競價基準', '詳細資料']:
                raise ValueError('capital_par_twse_census_invalid')
            rows = packet.get('data')
        else:
            tables = packet.get('tables', [])
            if packet.get('stat') != 'ok' or len(tables) != 1 or tables[0].get('fields') != [
                '恢復買賣日期', '證券代號', '證券名稱', '最後交易日之收盤價格', '恢復買賣開始參考價',
                '漲停價格', '跌停價格', '開始交易基準價', '詳細資料']:
                raise ValueError('capital_par_tpex_census_invalid')
            rows = tables[0].get('data')
            if not isinstance(rows, list) or tables[0].get('totalCount') != len(rows):
                raise ValueError('capital_par_tpex_census_incomplete')
        if not isinstance(rows, list):
            raise ValueError('capital_par_census_rows_missing')
        for row in rows:
            if not isinstance(row, list) or len(row) != 9 or action_date(row[0]) != session_date:
                raise ValueError('capital_par_census_row_invalid')
            symbol = str(row[1]).strip()
            if symbol not in symbols:
                continue
            documents = [packet]
            if exchange == 'twse_par':
                pointer = [v.strip() for v in row[8].split(',')]
                if len(pointer) != 3 or pointer[0] != symbol or not all(re.fullmatch(r'\d{8}', v) for v in pointer[1:]):
                    raise ValueError('capital_par_twse_pointer_invalid')
                if datetime.strptime(pointer[2], '%Y%m%d').date().isoformat() != session_date:
                    raise ValueError('capital_par_twse_pointer_date_conflict')
                preview = public('https://www.twse.com.tw/rwd/zh/change/TWTB7U', {'response': 'json'})
                if preview.get('stat') != 'OK' or preview.get('fields') != ['停止買賣日期', '股票代號', '名稱',
                    '恢復買賣日期', '變更股票面額換股率', '變更前面額', '變更後面額', '詳細資料', '恢復買賣參考價', '參考價試算']:
                    raise ValueError('capital_par_twse_preview_invalid')
                matches = [r for r in preview.get('data', []) if len(r) == 10 and str(r[1]).strip() == symbol
                           and action_date(r[3]) == session_date]
                if len(matches) != 1:
                    raise ValueError('capital_par_twse_exact_share_terms_missing')
                detail = matches[0]
                stop = action_date(detail[0])
                if stop != datetime.strptime(pointer[1], '%Y%m%d').date().isoformat():
                    raise ValueError('capital_par_twse_stop_date_conflict')
                ratio = par_ratio(*detail[4:7])
                documents.append(preview)
            else:
                table = DetailTable()
                table.feed(row[8])
                if len(table.cells) != 12 or table.cells[::2] != ['證券代號/證券名稱:', '停止買賣日期:',
                    '恢復買賣日期:', '變更股票面額換股率:', '變更前股票面額:', '變更後股票面額:']:
                    raise ValueError('capital_par_tpex_detail_invalid')
                values = table.cells[1::2]
                if values[0].split('/')[0].strip() != symbol or action_date(values[2]) != session_date:
                    raise ValueError('capital_par_tpex_detail_identity_conflict')
                stop, ratio = action_date(values[1]), par_ratio(*values[3:6])
            if any(e['symbol'] == symbol for e in events):
                raise ValueError('capital_par_duplicate_event')
            events.append({'exchange': exchange, 'symbol': symbol, 'resume_date': session_date,
                'catalog_date': None, 'discovered_by': 'official_current_census',
                'terms': {'stop_date': stop, 'share_ratio': ratio, 'cash_return': 0.,
                          'last_close': float(amount(row[3].replace(',', ''), ''))},
                'documents': documents})
    return events, raw


def issuer_capital_terms(evidence, symbol, resume, terms):
    from services.mops_corporate_terms import DATE, _date
    if evidence.get('symbol') != symbol or not evidence['query_start'] <= resume <= evidence['query_end']:
        raise ValueError('capital_issuer_event_range_missing')
    linked = []
    for document in evidence['documents']:
        if digest(document['body']) != document['body_checksum'] or document['published_date'] > evidence['query_end']:
            raise ValueError('capital_issuer_document_invalid')
        text = re.sub(r'\s+', '', document['body'])
        dates = {_date(m) for m in re.finditer(r'(?:換發新股票上市買賣日(?:暨舊股票終止上市日)?|恢復買賣日期|新股票?(?:上市|上櫃)買賣日(?:期)?(?:暨舊股票終止(?:上市|上櫃)買賣日(?:期)?)?)[:：](?:民國)?' + DATE, text)}
        if resume not in dates:
            continue
        ratios = {Decimal(m) / 1000 for m in re.findall(r'每[仟千]股換發(?:約)?([0-9]+(?:\.[0-9]+)?)股', text)}
        book_fee = bool(re.search(r'劃撥股東之畸零股款.{0,12}(?:作|做)為無實體股票劃撥之費用', text))
        if dates != {resume} or len(ratios) != 1 or (ratios != {Decimal(str(terms['share_ratio']))} and not book_fee):
            linked.append((document['published_date'], None))
            continue
        payable = {_date(m) for m in re.finditer(r'(?:現金減資)?退還股款發放日(?:期)?[:：](?:民國)?' + DATE, text)}
        fraction_payable = {_date(m) for m in re.finditer(r'畸零股款發放日(?:期)?[:：](?:民國)?' + DATE, text)}
        if len(payable) > 1 or len(fraction_payable) > 1 or any(d < resume for d in payable | fraction_payable):
            raise ValueError('capital_issuer_payment_ambiguous')
        rounding = bool(re.search(r'每股退還.{0,70}元以下(?:捨去|全捨|無條件捨去)', text))
        fraction = bool(re.search(r'拼湊後仍不足一股之(?:普通股)?畸零股.{0,160}最後交易日之收盤價.{0,80}元以下(?:捨去|全捨|無條件捨去)', text))
        linked.append((document['published_date'], {'refund_date': next(iter(payable), None),
            'cash_rounding': 'floor_twd' if rounding else None, 'fraction_at_last_close': fraction,
            'fraction_payment_date': next(iter(fraction_payable), None),
            'issuer_share_ratio': float(next(iter(ratios))), 'book_entry_fee': book_fee}))
    if not linked:
        return {'refund_date': None, 'cash_rounding': None, 'fraction_at_last_close': False,
                'fraction_payment_date': None}
    latest = max(d for d, _ in linked)
    instructions = [t for d, t in linked if d == latest]
    if None in instructions or len({digest(t) for t in instructions}) != 1:
        raise ValueError('capital_issuer_latest_terms_unresolved')
    return instructions[0]


def fetch_capital_corporate_source(*, symbols, session_date, outstanding_action_ids=(),
                                  catalogs=None, client=None, clock=None, issuer_reader=None):
    clock = clock or (lambda: datetime.now(timezone.utc))
    date.fromisoformat(session_date)
    if client is None:
        with httpx.Client(timeout=30, follow_redirects=False) as owned:
            return fetch_capital_corporate_source(symbols=symbols, session_date=session_date,
                outstanding_action_ids=outstanding_action_ids, catalogs=catalogs, client=owned, clock=clock,
                issuer_reader=issuer_reader)
    if catalogs is None:
        from finlab import data
        catalogs = {key: pl.from_pandas(data.get(key, force_download=True, save_to_storage=False).reset_index())
                    for key in CATALOGS.values()}
    events, raw = catalog_events(catalogs, symbols, session_date, outstanding_action_ids)
    cache = {}
    def public(endpoint, params):
        key = (endpoint, tuple(sorted(params.items())))
        if key not in cache:
            cache[key] = _get(client, endpoint, params=params).json()
        return cache[key]
    # A lagging FinLab catalog must not certify a false no-action day. Check
    # both exchanges' CURRENT official census independently, then take the union.
    census = {}
    census['twse'] = public(TWSE + 'TWTAUU', {'startDate': session_date.replace('-', ''),
        'endDate': session_date.replace('-', ''), 'response': 'json'})
    census['tpex'] = public(TPEX, {'startDate': session_date.replace('-', '/'),
        'endDate': session_date.replace('-', '/'), 'response': 'json'})
    split_url = 'https://www.twse.com.tw/rwd/zh/split/TWTC9U'
    census['etf'] = public(split_url, {'response': 'json'})
    for exchange, packet in census.items():
        if exchange == 'twse' and packet.get('stat') == '很抱歉，沒有符合條件的資料!':
            rows = []
        elif exchange == 'tpex':
            tables = packet.get('tables', [])
            if packet.get('stat') != 'ok' or len(tables) != 1 or tables[0].get('fields', [])[:2] != ['恢復買賣日期', '股票代號']:
                raise ValueError('capital_current_tpex_census_invalid')
            rows = tables[0].get('data')
            if not isinstance(rows, list) or tables[0].get('totalCount') != len(rows):
                raise ValueError('capital_current_tpex_census_incomplete')
        else:
            first_fields = ['停止買賣日期', 'ETF代號'] if exchange == 'etf' else ['恢復買賣日期', '股票代號']
            if packet.get('stat') != 'OK' or packet.get('fields', [])[:2] != first_fields or not isinstance(packet.get('data'), list):
                raise ValueError('capital_current_official_census_invalid')
            rows = packet['data']
        for row in rows:
            if not isinstance(row, list) or len(row) != (8 if exchange == 'etf' else 11):
                raise ValueError('capital_current_official_row_invalid')
            symbol, resume = str(row[1]).strip(), action_date(row[4 if exchange == 'etf' else 0])
            if symbol not in symbols or resume != session_date:
                continue
            if not any(e['exchange'] == exchange and e['symbol'] == symbol and e['resume_date'] == resume for e in events):
                events.append({'exchange': exchange, 'symbol': symbol, 'resume_date': resume,
                               'catalog_date': None, 'discovered_by': 'official_current_census'})
    par_events, par_census = current_par_events(public, symbols, session_date)
    events.extend(par_events)
    census.update(par_census)
    actions, evidence, blockers = [], [], {}
    for event in events:
        symbol, resume, exchange = event['symbol'], event['resume_date'], event['exchange']
        if exchange in ('twse_par', 'tpex_par'):
            terms, documents = dict(event['terms']), list(event['documents'])
        elif exchange == 'etf':
            # This is a documented unit ratio, never capital_divide_ratio.
            # The current official table must still include the exact old event.
            packet = public(split_url, {'response': 'json'})
            fields = ['停止買賣日期', 'ETF代號', '名稱', '分割(反分割)', '恢復買賣日期', '分割(反分割)比率', '參考價試算', '恢復買賣參考價']
            if packet.get('stat') != 'OK' or packet.get('fields') != fields:
                raise ValueError('capital_etf_split_layout_changed')
            matching = [r for r in packet['data'] if len(r) == 8 and r[1] == symbol and action_date(r[4]) == resume]
            if len(matching) != 1:
                raise ValueError('capital_etf_split_event_missing')
            ratio = amount(matching[0][5], '')
            terms = {'stop_date': action_date(matching[0][0]), 'share_ratio': float(ratio), 'cash_return': 0.}
            documents = [packet]
        elif exchange == 'twse':
            params = {'startDate': resume.replace('-', ''), 'endDate': resume.replace('-', ''), 'response': 'json'}
            packet = public(TWSE + 'TWTAUU', params)
            if packet.get('stat') != 'OK' or packet.get('fields', [])[:2] != ['恢復買賣日期', '股票代號']:
                raise ValueError('capital_twse_listing_changed')
            rows = [r for r in packet['data'] if len(r) == 11 and r[1] == symbol and action_date(r[0]) == resume]
            if len(rows) != 1:
                raise ValueError('capital_twse_event_missing')
            link = [v.strip() for v in rows[0][10].split(',')]
            if len(link) != 2 or link[0] != symbol or not re.fullmatch(r'\d{8}', link[1]):
                raise ValueError('capital_twse_detail_pointer_invalid')
            detail = public(TWSE + 'TWTAVUDetail', {'STK_NO': symbol, 'FILE_DATE': link[1], 'response': 'json'})
            terms = parse_twse_detail(detail, symbol)
            terms['last_close'] = float(amount(rows[0][3].replace(',', ''), ''))
            documents = [packet, detail]
        else:
            params = {'startDate': resume.replace('-', '/'), 'endDate': resume.replace('-', '/'), 'response': 'json'}
            packet = public(TPEX, params)
            tables = packet.get('tables', [])
            if packet.get('stat') != 'ok' or len(tables) != 1 or tables[0].get('fields', [])[:2] != ['恢復買賣日期', '股票代號']:
                raise ValueError('capital_tpex_listing_changed')
            table = tables[0]
            if table.get('totalCount') != len(table.get('data', [])):
                raise ValueError('capital_tpex_listing_truncated')
            rows = [r for r in table['data'] if len(r) == 11 and r[1] == symbol and action_date(r[0]) == resume]
            if len(rows) != 1:
                raise ValueError('capital_tpex_event_missing')
            terms = parse_tpex_detail(rows[0][10], symbol, resume)
            terms['last_close'] = float(amount(rows[0][3].replace(',', ''), ''))
            documents = [packet]
        if terms['stop_date'] >= resume or terms['share_ratio'] <= 0:
            raise ValueError('capital_halt_or_conversion_terms_invalid')
        payment = {'refund_date': None, 'cash_rounding': None, 'fraction_at_last_close': False,
                   'fraction_payment_date': None}
        if exchange != 'etf' and not (exchange.endswith('_par') and terms['share_ratio'].is_integer()):
            from services.mops_corporate_terms import fetch_mops_delivery_announcements
            issuer = (issuer_reader or fetch_mops_delivery_announcements)(symbol=symbol)
            payment = issuer_capital_terms(issuer, symbol, resume, terms)
            documents.append(issuer)
        exchange_ratio = terms['share_ratio']
        if payment.get('issuer_share_ratio') is not None:
            terms['share_ratio'] = payment['issuer_share_ratio']
        evidence.append({'event': event, 'terms': terms, 'documents': documents})
        conversion = {'action_id': event_id(exchange, symbol, resume, 'exchange'), 'symbol': symbol,
                        'kind': 'exchange', 'ex_date': resume, 'payable_date': resume, 'cash_per_share': 0.,
                        'stock_per_share': terms['share_ratio'], 'capital_return_per_share': terms['cash_return'],
                        'stop_date': terms['stop_date']}
        if payment.get('book_entry_fee'):
            conversion['fractional_treatment'] = 'book_entry_fee'
            if exchange_ratio != terms['share_ratio']:
                # No guessed floating tolerance: the native ledger must prove
                # BOTH disclosed ratios give exactly the same tradable integer
                # quantity for this opening holding. Fractions are issuer fees.
                conversion['official_share_ratio'] = exchange_ratio
        actions.append(conversion)
        if terms['cash_return']:
            actions.append({'action_id': event_id(exchange, symbol, resume, 'refund'), 'symbol': symbol,
                            'kind': 'cash', 'ex_date': resume, 'payable_date': payment['refund_date'],
                            'cash_per_share': terms['cash_return'], 'stock_per_share': 0.,
                            'cash_terms_status': 'confirmed' if payment['refund_date'] else 'awaiting_issuer_refund_schedule',
                            'cash_rounding': payment['cash_rounding']})
        if payment['fraction_at_last_close']:
            actions.append({'action_id': event_id(exchange, symbol, resume, 'fraction'), 'symbol': symbol,
                            'kind': 'cash', 'ex_date': resume, 'payable_date': payment['fraction_payment_date'],
                            'cash_per_share': terms['last_close'], 'stock_per_share': 0., 'cash_rounding': 'floor_twd',
                            'cash_quantity_basis': 'exchange_fraction', 'share_conversion_ratio': terms['share_ratio'],
                            'related_exchange_action_id': event_id(exchange, symbol, resume, 'exchange')})
    result = {'source': 'finlab.capital_catalog+twse_tpex.official_terms', 'session_date': session_date,
              'observed_at': clock().isoformat(), 'covered_symbols': sorted(set(symbols)),
              'actions': actions, 'blockers': blockers,
              'raw_source': {'catalogs': raw, 'official': evidence, 'current_official_census': census}}
    result['source_checksum'] = digest(result)
    return result
