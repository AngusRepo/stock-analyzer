from datetime import datetime, timezone

import httpx
import polars as pl
import pytest

from services.capital_corporate_source import CATALOGS, catalog_events, event_id, fetch_capital_corporate_source
from services.capital_corporate_source import parse_twse_detail, parse_tpex_detail, issuer_capital_terms, current_par_events
from services.paired_nav_journal import digest


def twse_detail():
    return {'stat': 'OK', 'fields': ['股票代號：', '股票名稱：', '停止買賣日期：', '每壹仟股換發新股票：',
        '每股退還股款：', '原股每股配發現金股利：', '減資並(有償)現金增資：', '每股認購金額：',
        'a. 公開承銷：', 'b. 員工認購：', 'c. 原股東認購：', '按股東持股比例每千股認購：'],
        'data': [['6176  ', 'fixture', '115/08/13', '750.00000000 股', '2.500000 元/股',
                  '0 元/股', '0 股', '0 元/股', '0 股', '0 股', '0 股', '0 股']]}


def issuer():
    body = ('每仟股換發750股。换股事項。換發新股票上市買賣日暨舊股票終止上市日：民國115年08月24日。'
            '每股退還2.5元計算至元為止(元以下捨去)。現金減資退還股款發放日期：民國115年08月31日。'
            '拼湊後仍不足一股之畸零股，依減資換股基準日前最後交易日之收盤價按比例給付現金，元以下捨去。')
    return {'symbol': '6176', 'query_start': '2025-09-08', 'query_end': '2026-09-08',
            'documents': [{'published_date': '2026-07-24', 'body': body, 'body_checksum': digest(body)}]}


def catalogs():
    return {dataset: pl.DataFrame({'date': ['2026-08-24'], '6176': ['2026-08-24'] if exchange == 'twse' else [None]})
            for exchange, dataset in CATALOGS.items()}


def empty_par_packet(path):
    if path.endswith('TWTB8U'):
        return {'stat': 'OK', 'fields': ['恢復買賣日期', '股票代號', '名稱', '停止買賣前收盤價格',
            '恢復買賣參考價', '漲停價格', '跌停價格', '開盤競價基準', '詳細資料'], 'data': []}
    if path.endswith('pvChgRslt'):
        return {'stat': 'ok', 'tables': [{'fields': ['恢復買賣日期', '證券代號', '證券名稱',
            '最後交易日之收盤價格', '恢復買賣開始參考價', '漲停價格', '跌停價格', '開始交易基準價',
            '詳細資料'], 'data': [], 'totalCount': 0}]}
    return None


def test_conversion_ratio_is_announced_units_not_price_adjustment():
    parsed = parse_twse_detail(twse_detail(), '6176')
    assert parsed == {'stop_date': '2026-08-13', 'share_ratio': .75, 'cash_return': 2.5}
    bad = twse_detail()
    bad['data'][0][3] = '.7742857143'
    with pytest.raises(ValueError, match='unit_invalid'):
        parse_twse_detail(bad, '6176')
    bad = twse_detail()
    bad['data'][0][6] = '100 股'
    with pytest.raises(ValueError, match='combined_subscription'):
        parse_twse_detail(bad, '6176')


def test_tpex_embedded_official_detail_is_identity_checked():
    labels = ['股票代號/股票名稱:', '停止買賣日期:', '恢復買賣日期:', '每壹仟股換發新股票:',
              '每股退還股款:', '現金增資總股數:', '現金增資認購價:', '現金增資配股率:']
    values = ['6241&nbsp;/&nbsp;fixture', '115/08/18', '115/08/25', '729.64415000&nbsp;股', '0.00000000&nbsp;元/股', 'NA', 'NA', 'NA']
    html = '<table>' + ''.join(f'<tr><th>{k}</th><td>{v}</td></tr>' for k, v in zip(labels, values)) + '</table>'
    assert parse_tpex_detail(html, '6241', '2026-08-25')['share_ratio'] == .72964415
    with pytest.raises(ValueError, match='identity_mismatch'):
        parse_tpex_detail(html, '6176', '2026-08-25')


def test_catalog_only_selects_current_events_or_actual_outstanding_rights():
    events, _ = catalog_events(catalogs(), ['6176'], '2026-09-08', ())
    assert events == []
    right = event_id('twse', '6176', '2026-08-24', 'refund')
    events, _ = catalog_events(catalogs(), ['6176'], '2026-09-08', (right,))
    assert len(events) == 1 and events[0]['resume_date'] == '2026-08-24'


def test_real_source_composition_preserves_refund_schedule_fraction_rights_and_capture_time():
    packet = {'stat': 'OK', 'fields': ['恢復買賣日期', '股票代號'],
              'data': [['115/08/24', '6176', 'fixture', '81.30', '105.06', '', '', '', '', '退還股款', '6176  ,20260812']]}
    def request(req):
        if (par := empty_par_packet(req.url.path)) is not None:
            return httpx.Response(200, json=par)
        if req.url.path.endswith('revivt'):
            return httpx.Response(200, json={'stat': 'ok', 'tables': [{'fields': ['恢復買賣日期', '股票代號'],
                'data': [], 'totalCount': 0}]})
        if req.url.path.endswith('TWTC9U'):
            return httpx.Response(200, json={'stat': 'OK', 'fields': ['停止買賣日期', 'ETF代號'], 'data': []})
        if req.url.path.endswith('TWTAVUDetail'):
            assert req.url.params['STK_NO'] == '6176' and req.url.params['FILE_DATE'] == '20260812'
            return httpx.Response(200, json=twse_detail())
        assert req.url.path.endswith('TWTAUU')
        return httpx.Response(200, json=packet)
    observed = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    with httpx.Client(transport=httpx.MockTransport(request)) as client:
        result = fetch_capital_corporate_source(symbols=['6176'], session_date='2026-09-08',
            outstanding_action_ids=(event_id('twse', '6176', '2026-08-24', 'refund'),), catalogs=catalogs(),
            client=client, issuer_reader=lambda **_: issuer(), clock=lambda: observed)
    exchange, refund, fraction = result['actions']
    assert exchange['stock_per_share'] == .75
    assert refund['payable_date'] == '2026-08-31' and refund['cash_rounding'] == 'floor_twd'
    assert fraction['cash_per_share'] == 81.3 and fraction['cash_quantity_basis'] == 'exchange_fraction'
    assert fraction['payable_date'] is None  # Not the separately named capital refund payment.
    assert result['observed_at'] == observed.isoformat()  # Never backdate current capture to 8/24.


def test_later_same_event_unlinked_revision_cannot_restore_old_payment():
    evidence = issuer()
    old = evidence['documents'][0]
    new = old['body'].replace('750股', '749股')
    evidence['documents'].append({'published_date': '2026-07-25', 'body': new, 'body_checksum': digest(new)})
    with pytest.raises(ValueError, match='latest_terms_unresolved'):
        issuer_capital_terms(evidence, '6176', '2026-08-24', {'share_ratio': .75})


def test_current_official_event_is_not_lost_when_finlab_catalog_lags():
    data = catalogs()
    data[CATALOGS['twse']] = pl.DataFrame({'date': ['2026-08-24'], '6176': [None]})
    def request(req):
        if (par := empty_par_packet(req.url.path)) is not None:
            return httpx.Response(200, json=par)
        if req.url.path.endswith('revivt'):
            return httpx.Response(200, json={'stat': 'ok', 'tables': [{'fields': ['恢復買賣日期', '股票代號'],
                'data': [], 'totalCount': 0}]})
        if req.url.path.endswith('TWTC9U'):
            return httpx.Response(200, json={'stat': 'OK', 'fields': ['停止買賣日期', 'ETF代號'], 'data': []})
        if req.url.path.endswith('TWTAVUDetail'):
            return httpx.Response(200, json=twse_detail())
        return httpx.Response(200, json={'stat': 'OK', 'fields': ['恢復買賣日期', '股票代號'],
            'data': [['115/08/24', '6176', 'fixture', '81.30', '105.06', '', '', '', '', '退還股款', '6176,20260812']]})
    with httpx.Client(transport=httpx.MockTransport(request)) as client:
        result = fetch_capital_corporate_source(symbols=['6176'], session_date='2026-08-24', catalogs=data,
                                               client=client, issuer_reader=lambda **_: issuer())
    assert result['actions'][0]['stock_per_share'] == .75
    assert result['raw_source']['official'][0]['event']['discovered_by'] == 'official_current_census'


def test_error_page_cannot_be_a_complete_zero_event_census():
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'stat': '參數錯誤'}))) as client:
        with pytest.raises(ValueError, match='census_invalid'):
            fetch_capital_corporate_source(symbols=['2330'], session_date='2026-09-08', catalogs=catalogs(), client=client)


def test_tpex_precision_is_preserved_only_with_explicit_book_entry_fee_terms():
    evidence = issuer()
    evidence['symbol'] = '6241'
    body = ('每仟股換發729.6441479股。新股票上櫃買賣日期暨舊股票終止上櫃買賣日期：115年8月25日。'
            '劃撥股東之畸零股款作為無實體股票劃撥之費用。')
    evidence['documents'] = [{'published_date': '2026-08-18', 'body': body, 'body_checksum': digest(body)}]
    parsed = issuer_capital_terms(evidence, '6241', '2026-08-25', {'share_ratio': .72964415})
    assert parsed['issuer_share_ratio'] == .7296441479 and parsed['book_entry_fee'] is True
    body = body.split('劃撥股東')[0]
    evidence['documents'] = [{'published_date': '2026-08-18', 'body': body, 'body_checksum': digest(body)}]
    with pytest.raises(ValueError, match='latest_terms_unresolved'):
        issuer_capital_terms(evidence, '6241', '2026-08-25', {'share_ratio': .72964415})


def test_tpex_par_value_change_uses_share_ratio_not_rounded_price_quotient():
    def public(url, params):
        packet = empty_par_packet(url)
        if url.endswith('pvChgRslt'):
            labels = ['證券代號/證券名稱:', '停止買賣日期:', '恢復買賣日期:',
                      '變更股票面額換股率:', '變更前股票面額:', '變更後股票面額:']
            values = ['4747&nbsp/&nbsp強生*', '115/08/20', '115/08/31', '2.00000000', '10.00', '5.00']
            detail = '<table>' + ''.join(f'<tr><th>{k}</th><td>{v}</td></tr>' for k, v in zip(labels, values)) + '</table>'
            table = packet['tables'][0]
            table['data'] = [['1150831', '4747', '強生*', '56.50', '28.25', '31.05', '25.45', '28.25', detail]]
            table['totalCount'] = 1
        return packet
    events, raw = current_par_events(public, ['4747'], '2026-08-31')
    assert events[0]['terms'] == {'stop_date': '2026-08-20', 'share_ratio': 2., 'cash_return': 0., 'last_close': 56.5}
    assert len(raw['tpex_par']['tables'][0]['data']) == 1


@pytest.mark.parametrize('bad_ratio', [False, True])
def test_twse_par_change_requires_exact_preview_identity_and_parity(bad_ratio):
    def public(url, params):
        if url.endswith('TWTB7U'):
            return {'stat': 'OK', 'fields': ['停止買賣日期', '股票代號', '名稱', '恢復買賣日期',
                '變更股票面額換股率', '變更前面額', '變更後面額', '詳細資料', '恢復買賣參考價', '參考價試算'],
                'data': [['115/08/27', '6949', 'fixture', '115/09/07', '19' if bad_ratio else '20',
                          '10.00', '0.50', '6949,20260826', '6949,20260827,20260907', ',10.00,0.50']]}
        packet = empty_par_packet(url)
        if url.endswith('TWTB8U'):
            packet['data'] = [['115/09/07', '6949', 'fixture', '1,490.00', '74.50', '81.90', '67.10', '74.50',
                               '6949,20260827,20260907']]
        return packet
    if bad_ratio:
        with pytest.raises(ValueError, match='par_share_ratio_conflict'):
            current_par_events(public, ['6949'], '2026-09-07')
    else:
        events, _ = current_par_events(public, ['6949'], '2026-09-07')
        assert events[0]['terms']['share_ratio'] == 20.
        assert events[0]['terms']['last_close'] == 1490.
