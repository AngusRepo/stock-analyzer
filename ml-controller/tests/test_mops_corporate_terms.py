from datetime import datetime, timezone
import json

import httpx
import pytest

from services.mops_corporate_terms import parse_stock_terms, fetch_mops_stock_evidence, fetch_mops_delivery_announcements, ORIGIN, QUERY
from services.mops_corporate_terms import enrich_stock_delivery_source
from services.finlab_corporate_actions import fetch_paper_corporate_source
from services.paired_nav_journal import digest


def test_cash_record_dates_cannot_become_stock_delivery():
    text = '除權（息）交易日:115/08/28 普通股現金股利發放日期:115/09/18 除權（息）基準日:115/09/05'
    assert parse_stock_terms(text, ex_date='2026-08-28')['payable_date'] is None
    text += ' 擬訂115/10/16為股票股利發放日'
    assert parse_stock_terms(text, ex_date='2026-08-28')['payable_date'] == '2026-10-16'
    assert parse_stock_terms(text, ex_date='2026-08-27')['status'] == 'unlinked'


def test_conflicting_delivery_dates_and_cash_in_lieu_are_not_guessed():
    base = '除權（息）交易日:115/08/28 '
    with pytest.raises(ValueError, match='ambiguous'):
        parse_stock_terms(base + '股票股利發放日期:115/10/16 增資股票發放日:115/10/17', ex_date='2026-08-28')
    assert parse_stock_terms(base + '畸零股按面額折付現金', ex_date='2026-08-28')['fractional_treatment'] is None
    fee = '凡參加帳簿劃撥配發股票之股東，其未滿一股之畸零股款，將做為處理帳簿劃撥之費用。'
    assert parse_stock_terms(base + fee, ex_date='2026-08-28')['fractional_treatment'] == 'book_entry_fee'


def test_public_source_capture_binds_announcement_identity_and_keeps_revision_evidence():
    url = ORIGIN + '/mops/web/ajax_t05sr01_1?COMPANY_ID=8932&SPOKE_DATE=20260813&SPOKE_TIME=162413&SEQ_NO=2'
    row = {'COMPANY_ID': '8932', 'AN_CODE': 'M14', 'SUBJECT': '本公司股利發放',
        'CDATE': '115/08/13', 'CTIME': '16:24:13', 'HYPERLINK': url}
    calls = []
    def transport(request):
        calls.append(str(request.url))
        if str(request.url) == QUERY:
            return httpx.Response(200, text='\ufeff' + json.dumps({'status': 'success', 'data': [row]}))
        assert str(request.url) == url
        return httpx.Response(200, text='<div>8932 發言日期 說明</div><p>除權（息）交易日:115/08/28 股票股利發放日:115/10/16</p>')
    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        result = fetch_mops_stock_evidence(symbol='8932', ex_date='2026-08-28',
            observed_at=datetime(2026, 9, 7, tzinfo=timezone.utc), client=client)
        assert result['documents'][0]['terms']['payable_date'] == '2026-10-16'
        assert result['automatic_settlement_attested'] is False
        row['HYPERLINK'] = 'https://untrusted.invalid/'
        with pytest.raises(ValueError, match='identity_or_url'):
            fetch_mops_stock_evidence(symbol='8932', ex_date='2026-08-28',
                observed_at=datetime(2026, 9, 7, tzinfo=timezone.utc), client=client)
        assert len(calls) == 3  # Untrusted URL was never fetched.


def test_separate_delivery_feed_uses_observed_forms_without_executing_remote_script():
    calls = []
    first = '''<form name="fm_show"><input type="hidden" name="step" value="2">
      <input type="hidden" name="co_id_1" value="8932"><input type="hidden" name="noticeKind" value="11">
      <input type="hidden" name="scope" value="1"><input type="hidden" name="SDATE" value="20250908">
      <input type="hidden" name="EDATE" value="20260908"></form>'''
    second = '''<form name="fm_t59sb09"><input type="hidden" name="step" value="2"><input type="hidden" name="ST" value="1">
      <table><tr class="even"><td>8932</td><td>fixture</td><td>115/08/13</td><td>stock dividend</td>
      <td><input type="button" value="詳細資料" onclick='document.fm_t59sb09.co_id.value="8932";document.fm_t59sb09.DATE1.value="20260813";document.fm_t59sb09.SKEY.value="1";untrustedFunction();'></td>
      </tr></table></form>'''
    def transport(request):
        calls.append((str(request.url), request.content))
        if len(calls) == 1:
            return httpx.Response(200, text=first)
        if len(calls) == 2:
            return httpx.Response(200, text=second)
        assert str(request.url) == ORIGIN + '/mops/web/ajax_t59sb09'
        return httpx.Response(200, text='<p>公司代號</p><p>8932</p><p>公告內容</p><p>fixture content</p>')
    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        result = fetch_mops_delivery_announcements(symbol='8932', client=client,
            clock=lambda: datetime(2026, 9, 8, tzinfo=timezone.utc))
    assert len(calls) == 3 and len(result['documents']) == 1
    assert result['documents'][0]['request']['DATE1'] == '20260813'
    assert result['query_start'] == '2025-09-08' and result['query_end'] == '2026-09-08'


def test_delivery_error_page_cannot_masquerade_as_no_corporate_events():
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, text='查詢過於頻繁'))) as client:
        with pytest.raises(ValueError, match='form_changed'):
            fetch_mops_delivery_announcements(symbol='8932', client=client)


def test_composed_source_joins_exact_record_date_and_ratio_without_cross_year_contamination():
    action = {'action_id': 'stock', 'symbol': '8932', 'kind': 'stock', 'ex_date': '2026-08-28',
        'record_date': '2026-09-05', 'payable_date': None, 'stock_per_share': .19216, 'cash_per_share': 0}
    snapshot = {'source_checksum': 'f' * 64, 'observed_at': '2026-09-07T23:00:00+00:00', 'actions': [action], 'covered_symbols': ['8932']}
    text = '增資配股及配息基準日為115年9月5日 每仟股無償配發192.16股 擬訂115年10月16日為股票股利發放日'
    document = {'published_date': '2026-08-13', 'body': text, 'body_checksum': digest(text)}
    evidence = {'symbol': '8932', 'query_start': '2025-09-08', 'query_end': '2026-09-08',
        'observed_at': '2026-09-07T23:01:00+00:00', 'documents': [document]}
    result = fetch_paper_corporate_source(symbols=['8932'], session_date='2026-09-08',
        dividend_reader=lambda **kwargs: snapshot, delivery_reader=lambda **kwargs: evidence,
        capital_reader=lambda **_: {'covered_symbols': ['8932'], 'observed_at': snapshot['observed_at'], 'actions': []})
    assert result['actions'][0]['payable_date'] == '2026-10-16'
    assert result['stock_delivery_source_complete'] is True
    assert result['observed_at'] == evidence['observed_at']
    assert snapshot['actions'][0]['payable_date'] is None
    old = {**document, 'body': text.replace('115年9月5日', '114年9月5日')}
    old['body_checksum'] = digest(old['body'])
    wrong = enrich_stock_delivery_source(snapshot, {'8932': {**evidence, 'documents': [old]}})
    assert wrong['actions'][0]['stock_terms_status'] == 'unresolved_event_link'
    assert wrong['actions'][0]['payable_date'] is None
    assert wrong['stock_delivery_source_complete'] is False


def test_cash_floor_is_explicit_and_newer_unlinked_revision_cannot_use_old_terms():
    action = {'action_id': 'cash', 'symbol': '8932', 'kind': 'cash', 'ex_date': '2026-08-28',
        'record_date': '2026-09-05', 'payable_date': '2026-09-18', 'cash_per_share': .7207, 'stock_per_share': 0}
    text = '增資配股及配息基準日為115年9月5日 每股配發新台幣0.7207元 現金股利按分配比例計算至元為止，元以下全捨'
    document = {'published_date': '2026-08-13', 'body': text, 'body_checksum': digest(text)}
    evidence = {'symbol': '8932', 'query_start': '2025-09-08', 'query_end': '2026-09-08',
        'observed_at': '2026-09-07T23:01:00+00:00', 'documents': [document]}
    snapshot = {'source_checksum': 'f' * 64, 'observed_at': '2026-09-07T23:00:00+00:00', 'actions': [action]}
    result = enrich_stock_delivery_source(snapshot, {'8932': evidence})
    assert result['actions'][0]['cash_rounding'] == 'floor_twd'
    newer = text.replace('0.7207', '0.81')
    evidence['documents'].append({'published_date': '2026-08-14', 'body': newer, 'body_checksum': digest(newer)})
    result = enrich_stock_delivery_source(snapshot, {'8932': evidence})
    assert result['blockers']['8932'] == ['issuer_latest_revision_not_linked']
    assert 'cash_rounding' not in result['actions'][0]
