from datetime import datetime, timezone

import httpx
import polars as pl
import pytest

from services.etf_corporate_source import parse_distribution_table, fetch_etf_corporate_source
from services.finlab_corporate_actions import fetch_paper_corporate_source, normalize_dividend_announcements
from services.paired_nav_journal import digest


def html(symbol='00878', amount='1.01'):
    headers = ['證券代號', '證券簡稱', '除息交易日', '收益分配基準日', '收益分配發放日', '收益分配金額', '標準', '年度']
    values = [symbol, 'fixture', '115年08月18日', '115年08月24日', '115年09月11日', amount, 'fixture terms', '115']
    return '<table id="myTable"><thead><tr>' + ''.join('<th>'+s+'</th>' for s in headers) + '</tr></thead><tbody><tr>' + ''.join('<td>'+s+'</td>' for s in values) + '</tr></tbody></table>'


def dataset():
    return pl.DataFrame({'symbol': ['00878'], 'date': ['2026-08-18'], '收益分配基準日': ['2026-08-24'],
        '收益分配發放日': ['2026-09-11'], '收益分配金額(每1受益權單位)': [None], 'key_date': ['2026-08-01']})


def client(body=None, registry=None):
    def handle(request):
        if request.url.path == '/rwd/api/codeEtf':
            return httpx.Response(200, json=['00878'] if registry is None else registry)
        assert request.url.path == '/zh/ETFortune/dividendList'
        assert request.url.params['stkNo'] == '00878'
        assert request.url.params['startDate'] == '2025' and request.url.params['endDate'] == '2026'
        return httpx.Response(200, text=html() if body is None else body)
    return httpx.Client(transport=httpx.MockTransport(handle))


def test_missing_finlab_etf_amount_uses_observed_official_terms_not_zero_or_backdated_receipt():
    now = datetime(2026, 8, 17, 23, tzinfo=timezone.utc)
    with client() as public:
        result = fetch_etf_corporate_source(symbols=['00878'], session_date='2026-08-18',
            client=public, dataset=dataset(), clock=lambda: now)
    assert result['actions'][0]['cash_per_share'] == 1.01
    assert result['actions'][0]['payable_date'] == '2026-09-11'
    assert result['actions'][0]['cash_rounding'] is None
    assert result['observed_at'] == now.isoformat() and result['prospective_backfill_credit'] == 0
    assert 'null' in result['raw_source']['finlab_rows_json']


def test_official_unannounced_amount_and_uncovered_exchange_cannot_be_no_action_success():
    with client(body=html(amount='')) as public:
        result = fetch_etf_corporate_source(symbols=['00878'], session_date='2026-08-18', client=public, dataset=dataset())
    assert result['actions'] == [] and result['blockers']['00878'] == ['etf_distribution_amount_not_announced']
    with client(registry=['0050']) as public, pytest.raises(ValueError, match='exchange_coverage_missing'):
        fetch_etf_corporate_source(symbols=['00878'], session_date='2026-08-18', client=public, dataset=dataset())
    with pytest.raises(ValueError, match='layout_changed'):
        parse_distribution_table('<html>upstream unavailable</html>', '00878')
    with pytest.raises(ValueError, match='row_mismatch'):
        parse_distribution_table(html(symbol='0050'), '00878')


def test_mixed_account_union_checks_every_outstanding_id_across_both_sources():
    now = '2026-09-07T23:00:00+00:00'
    stock = {'source_checksum': 'a'*64, 'observed_at': now, 'covered_symbols': ['2330'], 'actions': [{'action_id':'stock-right','symbol':'2330','kind':'cash'}]}
    etf = {'source_checksum': 'b'*64, 'observed_at': now, 'covered_symbols': ['00878'], 'actions': [{'action_id':'etf-right','symbol':'00878','kind':'cash'}]}
    # Isolate the union test from issuer matching; use no stock actions first,
    # then demonstrate that a missing stock right is still a hard failure.
    stock['actions'] = []
    args = dict(symbols=['2330','00878'], session_date='2026-09-08', dividend_reader=lambda **_: stock,
        etf_reader=lambda **_: etf, delivery_reader=lambda **_: (_ for _ in ()).throw(AssertionError('unexpected issuer read')),
        capital_reader=lambda **_: {'covered_symbols': ['2330','00878'], 'observed_at': now, 'actions': []})
    result = fetch_paper_corporate_source(**args, outstanding_action_ids=('etf-right',))
    assert result['covered_symbols'] == ['00878','2330']
    with pytest.raises(ValueError, match='outstanding_source_identity_missing'):
        fetch_paper_corporate_source(**args, outstanding_action_ids=('etf-right','stock-right'))


def test_company_feed_explicitly_rejects_etf_coverage():
    from test_finlab_corporate_actions import row
    with pytest.raises(ValueError, match='does_not_cover_etfs'):
        normalize_dividend_announcements(pl.DataFrame([row()]), symbols=['00878'],
            session_date='2026-09-07', observed_at=datetime.now(timezone.utc))


def test_historical_cash_discovery_keeps_actual_capture_time_and_does_not_include_other_dates():
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    with client() as public:
        absent = fetch_etf_corporate_source(symbols=['00878'], session_date='2026-09-08',
            client=public, dataset=dataset(), clock=lambda: now)
        observed = fetch_etf_corporate_source(symbols=['00878'], session_date='2026-09-08',
            client=public, dataset=dataset(), clock=lambda: now,
            historical_cash_dates={'00878': ['2026-08-18']})
    assert absent['actions'] == []
    assert len(observed['actions']) == 1 and observed['actions'][0]['ex_date'] == '2026-08-18'
    assert observed['observed_at'] == now.isoformat() and observed['prospective_backfill_credit'] == 0


def test_mixed_source_routes_only_each_company_or_etf_history_and_never_to_capital_owner():
    calls = {}
    def reader(name):
        def read(**request):
            calls[name] = request
            return {'covered_symbols': request['symbols'], 'actions': [], 'blockers': {},
                'observed_at': '2026-09-07T23:00:00+00:00', 'source_checksum': digest(request)}
        return read
    result = fetch_paper_corporate_source(symbols=['2330', '00878'], session_date='2026-09-08',
        historical_cash_dates={'2330': ['2026-09-07'], '00878': ['2026-08-18']},
        dividend_reader=reader('company'), etf_reader=reader('etf'), capital_reader=reader('capital'),
        delivery_reader=lambda **_: (_ for _ in ()).throw(AssertionError('unexpected issuer read')))
    assert calls['company']['historical_cash_dates'] == {'2330': ['2026-09-07']}
    assert calls['etf']['historical_cash_dates'] == {'00878': ['2026-08-18']}
    assert 'historical_cash_dates' not in calls['capital']
    assert result['covered_symbols'] == ['00878', '2330']
