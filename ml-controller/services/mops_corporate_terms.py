"""Read-only official issuer announcement evidence; never guess delivery dates.

The public query form and exact hyperlink schema were inspected on 2026-09-08.
This is not a promise of a stable public API. Unknown layouts are explicit gaps.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
import json
import re
import time
from decimal import Decimal
from urllib.parse import urlparse, parse_qs

import httpx

from services.paired_nav_journal import digest

ORIGIN = 'https://mopsov.twse.com.tw'
QUERY = ORIGIN + '/mops/web/ezsearch_query'
TW = timezone(timedelta(hours=8))
DATE = r'(?P<y>\d{3,4})[年/](?P<m>\d{1,2})[月/](?P<d>\d{1,2})日?'


def _public_post(client, endpoint, *, data):
    for attempt in range(3):
        try:
            response = client.post(endpoint, data=data)
        except httpx.RequestError:
            if attempt == 2:
                raise RuntimeError('mops_source_transport_unavailable') from None
        else:
            if response.status_code not in {429, 500, 502, 503, 504}:
                response.raise_for_status()
                return response
            if attempt == 2:
                raise RuntimeError('mops_source_temporarily_unavailable')
        time.sleep(0.25 * 2 ** attempt)
    raise RuntimeError('mops_source_retry_exhausted')


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.ignored = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignored += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.ignored -= 1

    def handle_data(self, value):
        if not self.ignored and value.strip():
            self.parts.append(value.strip())


def _date(match) -> str:
    year = int(match['y'])
    return date(year + 1911 if year < 1911 else year, int(match['m']), int(match['d'])).isoformat()


def _roc(day: date) -> str:
    return f'{day.year - 1911:03d}{day.month:02d}{day.day:02d}'


class _PublicForm(HTMLParser):
    def __init__(self, name):
        super().__init__()
        self.name, self.active, self.values, self.rows, self.row = name, False, {}, [], None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'form':
            self.active = attrs.get('name') == self.name
        if not self.active:
            return
        if tag == 'input' and attrs.get('type') == 'hidden' and attrs.get('name'):
            self.values[attrs['name']] = attrs.get('value', '')
        if tag == 'tr' and attrs.get('class') in ('odd', 'even'):
            self.row = {'parts': [], 'onclick': None}
        if tag == 'input' and self.row is not None and attrs.get('value') == '詳細資料':
            self.row['onclick'] = attrs.get('onclick')

    def handle_endtag(self, tag):
        if tag == 'form':
            self.active = False
        if tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, value):
        if self.active and self.row is not None and value.strip():
            self.row['parts'].append(value.strip())


def fetch_mops_delivery_announcements(*, symbol: str, client: httpx.Client | None = None, clock=None) -> dict:
    """Read the separate company-law delivery feed, including exact raw pointers.

    The official form supplies a trailing-one-year range. Old unresolved events
    outside that range must not be marked covered. Never execute returned JS.
    """
    if not re.fullmatch(r'[0-9A-Za-z]{4,8}', symbol):
        raise ValueError('mops_source_identity_invalid')
    clock = clock or (lambda: datetime.now(timezone.utc))
    if client is None:
        with httpx.Client(timeout=30, follow_redirects=False) as owned:
            return fetch_mops_delivery_announcements(symbol=symbol, client=owned, clock=clock)
    endpoint = ORIGIN + '/mops/web/ajax_t146sb10'
    request = {'step': '1', 'firstin': '1', 'off': '1', 'queryName': 'co_id_1',
        'inpuType': 'co_id', 'scope': '1', 'co_id_1': symbol, 'typek': 'all',
        'selecttype': '0', 'noticeDate': '2', 'date': '7', 'noticeKind': '11', 'sort': '2'}
    first = _public_post(client, endpoint, data=request)
    first.raise_for_status()
    form = _PublicForm('fm_show')
    form.feed(first.text)
    params = form.values
    if (params.get('step') != '2' or params.get('co_id_1') != symbol
            or params.get('noticeKind') != '11' or params.get('scope') != '1'):
        raise ValueError('mops_delivery_form_changed')
    start, end = (datetime.strptime(params[key], '%Y%m%d').date() for key in ('SDATE', 'EDATE'))
    if not 0 < (end - start).days <= 366:
        raise ValueError('mops_delivery_range_invalid')
    second = _public_post(client, endpoint, data={**params, 'rpt': 'bool_t59sb09'})
    second.raise_for_status()
    listing = _PublicForm('fm_t59sb09')
    listing.feed(second.text)
    if listing.values.get('step') != '2' or listing.values.get('ST') != '1':
        raise ValueError('mops_delivery_listing_changed')
    if len(listing.rows) >= 1000:
        raise ValueError('mops_delivery_listing_truncated')
    documents = []
    for row in listing.rows:
        body = row['onclick'] or ''
        # Extract the three observed literal assignments only; never eval JS or
        # follow an arbitrary action/URL embedded in a remote document.
        identifiers = {}
        for field in ('co_id', 'DATE1', 'SKEY'):
            found = re.findall(r'document\.fm_t59sb09\.' + field + r'\.value="([0-9A-Za-z]+)";', body)
            if len(found) != 1:
                raise ValueError('mops_delivery_row_identity_changed')
            identifiers[field] = found[0]
        if identifiers['co_id'] != symbol or not row['parts'] or row['parts'][0] != symbol:
            raise ValueError('mops_delivery_company_mismatch')
        published = datetime.strptime(identifiers['DATE1'], '%Y%m%d').date()
        if not start <= published <= end:
            raise ValueError('mops_delivery_publication_outside_range')
        detail_request = {**listing.values, **identifiers}
        detail = _public_post(client, ORIGIN + '/mops/web/ajax_t59sb09', data=detail_request)
        detail.raise_for_status()
        reader = _Text()
        reader.feed(detail.text)
        text = '\n'.join(reader.parts)
        if '公司代號\n' + symbol not in text or '公告內容' not in text:
            raise ValueError('mops_delivery_document_changed')
        documents.append({'endpoint': ORIGIN + '/mops/web/ajax_t59sb09', 'request': detail_request,
            'published_date': published.isoformat(), 'body': text, 'body_checksum': digest(text)})
    observed = clock()
    if observed.tzinfo is None or observed.astimezone(TW).date() != end:
        raise ValueError('mops_delivery_capture_date_mismatch')
    result = {'source': 'mops.t146sb10.t59sb09', 'symbol': symbol,
        'query_start': start.isoformat(), 'query_end': end.isoformat(),
        'observed_at': observed.isoformat(), 'listing_checksum': digest(second.text), 'documents': documents}
    return {**result, 'source_checksum': digest(result)}


def parse_stock_terms(text: str, *, ex_date: str) -> dict:
    """Recognize only explicit issuer labels, never cash-payment or record dates.

    Facts from an unlinked announcement are not joined by company name alone.
    Fractional terms describe the announced book-entry/no-pooling election.
    A source receipt, not this parser alone, owns availability and completeness.
    """
    compact = re.sub(r'\s+', '', text)
    ex_dates = {_date(m) for m in re.finditer(r'除權[（(]息[）)]交易日[:：]' + DATE, compact)}
    if ex_dates != {ex_date}:
        return {'status': 'unlinked', 'payable_date': None, 'fractional_treatment': None}
    return _parse_stock_payment_terms(compact, ex_date=ex_date)


def _parse_stock_payment_terms(compact: str, *, ex_date: str) -> dict:
    patterns = [r'(?:股票股利發放日(?:期)?|增資股票發放日(?:期)?)[:：]' + DATE,
                DATE + r'為股票股利發放日']
    delivery = {_date(m) for pattern in patterns for m in re.finditer(pattern, compact)}
    if len(delivery) > 1 or any(d < ex_date for d in delivery):
        raise ValueError('mops_stock_delivery_date_ambiguous')
    fee = re.search(r'凡參加帳簿劃撥配發股票之股東.{0,20}未滿一股之畸零股款.{0,20}(?:做|作)為處理帳簿劃撥之費用', compact)
    # Par-value cash can have a different payment date and expense deduction.
    # Do not treat the general cash clause as overriding a book-entry fee clause.
    fractional = 'book_entry_fee' if fee else None
    return {'status': 'linked', 'payable_date': next(iter(delivery), None),
            'fractional_treatment': fractional}


def enrich_stock_delivery_source(snapshot: dict, evidence_by_symbol: dict) -> dict:
    """Join exact record date AND dividend ratio, not merely industry/symbol/year.

    Both original FinLab and official issuer documents remain in the receipt.
    Unlinked/superseding text cannot silently turn into a settlement instruction.
    """
    from copy import deepcopy
    result = deepcopy(snapshot)
    originals = {a['action_id']: deepcopy(a) for a in snapshot['actions']}
    for action in result['actions']:
        evidence = evidence_by_symbol.get(action['symbol'])
        if evidence is None or evidence.get('symbol') != action['symbol']:
            raise ValueError('corporate_delivery_evidence_missing')
        if not evidence['query_start'] <= action['ex_date'] <= evidence['query_end']:
            raise ValueError('corporate_delivery_evidence_range_missing')
        if action['kind'] == 'subscription':
            continue  # Same preserved documents, distinct original-holder terms parser.
        linked = []
        for document in evidence['documents']:
            if digest(document['body']) != document['body_checksum']:
                raise ValueError('corporate_delivery_document_checksum_mismatch')
            if document['published_date'] > evidence['query_end']:
                raise ValueError('corporate_delivery_future_document')
            text = re.sub(r'\s+', '', document['body'])
            record_dates = {_date(m) for m in re.finditer(r'基準日(?:為|[:：])' + DATE, text)}
            if not action.get('record_date') or action['record_date'] not in record_dates:
                continue
            if action['kind'] == 'cash':
                ratios = {Decimal(m) for m in re.findall(r'每股配發(?:現金股利)?新[臺台]幣([0-9]+(?:\.[0-9]+)?)元', text)}
                expected = Decimal(str(action['cash_per_share']))
                terms = {'cash_rounding': 'floor_twd' if re.search(r'現金股利.{0,45}元以下(?:全捨|無條件捨去)', text) else None}
            else:
                ratios = {Decimal(m) / 1000 for m in re.findall(r'每[仟千]股(?:無償)?配發(?:股票股利)?([0-9]+(?:\.[0-9]+)?)股', text)}
                expected = Decimal(str(action['stock_per_share']))
                terms = _parse_stock_payment_terms(text, ex_date=action['ex_date'])
            if len(ratios) != 1 or abs(next(iter(ratios)) - expected) > Decimal('0.000000000001'):
                # A later same-record-date revision must not silently expose an
                # older matching instruction. Preserve it as unresolved.
                linked.append((document['published_date'], document['body_checksum'], None))
                continue
            # The record-date+ratio join was independently established above;
            # reuse only the narrowly labelled delivery/fraction parser.
            linked.append((document['published_date'], document['body_checksum'], terms))
        linked.sort()
        if linked:
            latest_day = linked[-1][0]
            latest = [entry for entry in linked if entry[0] == latest_day]
            if len({digest(entry[2]) for entry in latest}) != 1:
                raise ValueError('corporate_delivery_same_day_terms_ambiguous')
            terms = latest[0][2]
            if terms is None:
                result.setdefault('blockers', {}).setdefault(action['symbol'], []).append('issuer_latest_revision_not_linked')
                action['stock_terms_status' if action['kind'] == 'stock' else 'cash_terms_status'] = 'unresolved_event_link'
                continue
            if action['kind'] == 'cash':
                action['cash_rounding'] = terms['cash_rounding']
                action['cash_terms_status'] = 'confirmed' if action['cash_rounding'] else 'awaiting_rounding_terms'
                action['cash_evidence_checksums'] = [entry[1] for entry in latest]
                continue
            action['payable_date'] = terms['payable_date']
            action['fractional_treatment'] = terms['fractional_treatment']
            action['delivery_evidence_checksums'] = [entry[1] for entry in latest]
            action['stock_terms_status'] = 'confirmed_schedule' if action['payable_date'] else 'awaiting_issuer_schedule'
        else:
            action['stock_terms_status' if action['kind'] == 'stock' else 'cash_terms_status'] = 'unresolved_event_link'
    stock_actions = [a for a in result['actions'] if a['kind'] == 'stock']
    result['stock_delivery_source_complete'] = all(a.get('stock_terms_status') == 'confirmed_schedule' for a in stock_actions)
    result['source_components'] = {'finlab_checksum': snapshot['source_checksum'],
        'issuer_evidence': deepcopy(evidence_by_symbol), 'original_actions': originals}
    times = [datetime.fromisoformat(snapshot['observed_at'])] + [datetime.fromisoformat(e['observed_at']) for e in evidence_by_symbol.values()]
    if any(t.tzinfo is None for t in times):
        raise ValueError('corporate_delivery_evidence_clock_missing')
    result['observed_at'] = max(times).isoformat()
    result['source_checksum'] = digest({k: v for k, v in result.items() if k != 'source_checksum'})
    return result


def fetch_mops_stock_evidence(*, symbol: str, ex_date: str, observed_at: datetime,
                             client: httpx.Client | None = None) -> dict:
    if not re.fullmatch(r'[0-9A-Za-z]{4,8}', symbol) or observed_at.tzinfo is None:
        raise ValueError('mops_source_identity_invalid')
    ex = date.fromisoformat(ex_date)
    end = observed_at.astimezone(TW).date()
    start = ex - timedelta(days=180)
    if end < start or (end - start).days > 730:
        raise ValueError('mops_source_query_window_invalid')
    if client is None:
        with httpx.Client(timeout=30, follow_redirects=False) as owned:
            return fetch_mops_stock_evidence(symbol=symbol, ex_date=ex_date,
                observed_at=observed_at, client=owned)
    response = client.post(QUERY, data={'step': '00', 'RADIO_CM': '2', 'TYPEK': '',
        'CO_MARKET': '', 'CO_ID': symbol, 'PRO_ITEM': '', 'SUBJECT': '',
        'SDATE': _roc(start), 'EDATE': _roc(end), 'lang': 'TW', 'AN': ''})
    response.raise_for_status()
    packet = json.loads(response.text.lstrip('\ufeff\r\n '))
    rows = packet.get('data')
    if packet.get('status') != 'success' or not isinstance(rows, list) or len(rows) >= 1000:
        raise ValueError('mops_query_incomplete_or_schema_changed')
    documents = []
    for row in rows:
        if row.get('COMPANY_ID') != symbol:
            raise ValueError('mops_query_company_mismatch')
        if row.get('AN_CODE') not in ('M11', 'M14', 'M99'):
            continue
        title = row['SUBJECT']
        if '代子公司' in title or not any(k in title for k in ('股利', '除權', '增資', '發行新股')):
            continue
        match = re.fullmatch(DATE, row['CDATE'])
        if match is None:
            raise ValueError('mops_publication_date_invalid')
        published = datetime.fromisoformat(_date(match) + 'T' + row['CTIME']).replace(tzinfo=TW)
        if published > observed_at:
            continue
        url = row['HYPERLINK']
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        if (parsed.scheme != 'https' or parsed.netloc != 'mopsov.twse.com.tw'
                or parsed.path != '/mops/web/ajax_t05sr01_1' or parsed.fragment
                or params.get('COMPANY_ID') != [symbol]
                or params.get('SPOKE_DATE') != [published.strftime('%Y%m%d')]
                or params.get('SPOKE_TIME') != [published.strftime('%H%M%S')]):
            raise ValueError('mops_announcement_identity_or_url_invalid')
        detail = client.get(url)
        detail.raise_for_status()
        reader = _Text()
        reader.feed(detail.text)
        body = '\n'.join(reader.parts)
        if '說明' not in body or '發言日期' not in body or symbol not in body:
            raise ValueError('mops_announcement_layout_changed')
        documents.append({'url': url, 'published_at': published.isoformat(), 'title': title,
            'body': body, 'body_checksum': digest(body), 'terms': parse_stock_terms(body, ex_date=ex_date)})
    documents.sort(key=lambda d: (d['published_at'], d['url']))
    # Latest terms are diagnostic evidence. Unlinked revisions stay visible;
    # absence of a parsed date is not evidence that delivery never happened.
    result = {'source': 'mops.ezsearch', 'symbol': symbol, 'ex_date': ex_date,
        'observed_at': observed_at.isoformat(), 'query': {'start': start.isoformat(), 'end': end.isoformat()},
        'query_checksum': digest(packet), 'documents': documents,
        'automatic_settlement_attested': False}
    return {**result, 'source_checksum': digest(result)}
