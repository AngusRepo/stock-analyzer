"""Research rules from sealed MOPS notices; wording fixtures are trimmed from real 11/22 probe notices."""
import hashlib
import json
import sys
from pathlib import Path

import polars as pl
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import extract_reviewed_corporate_rules as extractor
from services.paired_nav_journal import digest

STOCK_1225 = ('依配股（增資）基準日股東名簿所記載之股東持有股份比例分派，盈餘配發每仟股55股。每股配發新台幣0.14元，'
              '計算至元為止。(一)本公司訂於114年9月30日為除息及除權配股(增資)基準日，依公司法第165條規定停止過戶。')
STOCK_1449 = ('原股東按發行新股增資基準日股東名簿所載股東持有股數股票股利每仟股無償配發32.66337059股。'
              '本公司訂114年10月19日為發行新股增資基準日。')
STOCK_1436 = '每仟股無償配發301.43032003股。(一)、除權、除息基準日：民國114年7月27日'
SUB_1449 = ('每股發行價格新台幣10.8元。原股東每仟股可認購155.19830415股。原股東及員工認購不足或逾期未拼湊者，'
            '則授權董事長洽特定人按發行價格認購之。(2)發行價格：每股新台幣10.8元。三、茲訂114年8月4日為認股基準日。'
            '民國114年8月7日至114年8月13日為原股東及員工之股款繳納期間；')
SUB_1256 = ('其餘90%，計1,737仟股由原股東按增資認股基準日之股東名簿所載持股比例認購。原股東放棄認購之股份，'
            '授權董事長洽特定人按實際發行價格認足。3.現金增資認購價格：每股新台幣145元整。4.認股基準日：114年10月13日'
            '6.原股東認股繳款期間：114年10月16日至114年10月27日')


def doc(published, body):
    text = '公司代號\n' + body
    return {'published_date': published, 'body': text, 'body_checksum': digest(text)}


def stock(symbol, ex, record, ratio):
    return {'symbol': symbol, 'kind': 'stock', 'ex_date': ex, 'record_date': record, 'stock_per_share': ratio}


SOURCE = {'sha256': 'e' * 64}


def test_real_dividend_wording_links_exact_record_date_and_ratio():
    rules, queue, _ = extractor.stock_candidates(stock('1225', '2025-09-24', '2025-09-30', .055),
                                                 [doc('2025-09-09', STOCK_1225)], SOURCE)
    assert queue == [] and rules[0]['review_semantic'] == 'auto_exact_match'
    assert rules[0]['stock_per_share'] == .055 and rules[0]['payable_date'] is None
    rules, _, _ = extractor.stock_candidates(stock('1449', '2025-10-13', '2025-10-19', .03266337059),
                                             [doc('2025-09-23', STOCK_1449)], SOURCE)
    assert rules and extractor.Decimal(rules[0]['issuer_ratio_delta_per_thousand']) == 0


def test_last_digit_difference_is_queued_with_finlab_value_never_auto():
    rules, queue, _ = extractor.stock_candidates(stock('1436', '2025-07-21', '2025-07-27', .30143032002),
                                                 [doc('2025-07-03', STOCK_1436)], SOURCE)
    assert rules == [] and queue[0]['reasons'] == ['ratio_last_digit_difference']
    rule = queue[0]['rule']
    assert rule['stock_per_share'] == .30143032002 and rule['issuer_stock_per_thousand'] == '301.43032003'


def test_wrong_record_date_or_ratio_never_links():
    for action in (stock('1225', '2025-09-24', '2025-09-29', .055), stock('1225', '2025-09-24', '2025-09-30', .056)):
        rules, queue, _ = extractor.stock_candidates(action, [doc('2025-09-09', STOCK_1225)], SOURCE)
        assert rules == [] and queue == []


def test_pricing_record_date_is_not_a_dividend_record_date():
    assert extractor.stock_record_dates(extractor.compact('1.訂價基準日：114年09月26日')) == {}


def test_later_unlinked_revision_sends_the_event_to_review():
    revised = STOCK_1225.replace('每仟股55股', '每仟股60股')
    _, queue, _ = extractor.stock_candidates(stock('1225', '2025-09-24', '2025-09-30', .055),
        [doc('2025-09-09', STOCK_1225), doc('2025-09-12', revised)], SOURCE)
    assert queue[0]['reasons'] == ['later_unlinked_revision']


def subscription(symbol, ex, record, ratio, price):
    return {'symbol': symbol, 'kind': 'subscription', 'ex_date': ex, 'record_date': record,
            'rights': {'ratio': ratio, 'subscription_price': price, 'issued_ratio': ratio, 'policy': 'do_not_subscribe'}}


def test_real_offering_wording_with_reversed_payment_period_is_exact():
    rules, queue, _ = extractor.subscription_candidates(subscription('1449', '2025-07-29', '2025-08-04', .15519830415, 10.8),
                                                        [doc('2025-07-22', SUB_1449)], SOURCE, None)
    assert queue == [] and rules[0]['review_semantic'] == 'auto_exact_match'
    assert (rules[0]['payment_start'], rules[0]['payment_deadline']) == ('2025-08-07', '2025-08-13')


def test_share_count_ratio_is_derived_and_queued_for_review():
    action = subscription('1256', '2025-10-07', '2025-10-13', .05132651107, 145.)
    rules, queue, _ = extractor.subscription_candidates(action, [doc('2025-09-25', SUB_1256)], SOURCE,
                                                        extractor.Decimal(33842160))
    assert rules == [] and queue[0]['reasons'] == ['ratio_derived_from_share_counts']
    assert queue[0]['rule']['ratio'] == .05132651107 and queue[0]['rule']['payment_deadline'] == '2025-10-27'
    # Without the FinLab share base nothing is derived, and without a ratio nothing links.
    assert extractor.subscription_candidates(action, [doc('2025-09-25', SUB_1256)], SOURCE, None)[:2] == ([], [])


def test_unpriced_or_mispriced_offering_never_links():
    action = subscription('1449', '2025-07-29', '2025-08-04', .15519830415, 11.)
    rules, queue, diagnostic = extractor.subscription_candidates(action, [doc('2025-07-22', SUB_1449)], SOURCE, None)
    assert rules == [] and queue == [] and 'price' in diagnostic['missing']
    unpriced = SUB_1449.replace('每股發行價格新台幣10.8元', '本次發行價格尚未訂價')
    assert extractor.subscription_terms(extractor.compact(unpriced), previous_shares=None)['prices'] == {}


def test_extract_writes_a_spec_that_compiles_and_clears_the_blocker(tmp_path):
    from test_compile_corporate_history import spec_fixture, CAPTURED
    from test_finlab_corporate_actions import subscription_row
    from compile_corporate_history import compile_history
    base = tmp_path / 'base'
    base.mkdir()
    spec = spec_fixture(base)
    pl.DataFrame([subscription_row(**{'現金增資認購價(元/股)': 50., '除權交易日': '2026-09-07'})]).write_parquet(
        base / 'div.parquet')
    (base / 'spec.json').write_text(json.dumps(spec, ensure_ascii=False))
    body = ('每股發行價格新台幣50元。原股東每仟股可認購20股。原股東放棄認購部分，授權董事長洽特定人認購。'
            '茲訂115年9月15日為認股基準日。原股東繳款期間：115年9月20日至115年9月25日')
    evidence = {'symbol': '2330', 'query_start': '2024-06-01', 'query_end': '2026-10-02',
                'observed_at': '2026-10-02T23:00:00+00:00', 'documents': [doc('2026-09-01', body)]}
    issuer = tmp_path / 'fetch' / 'issuer'
    issuer.mkdir(parents=True)
    raw = json.dumps(evidence, ensure_ascii=False).encode()
    (issuer / '2330.json').write_bytes(raw)
    (issuer / 'fetch_report_x.json').write_text(json.dumps({'symbols': {'2330': {
        'status': 'sealed', 'dataset': 'mops.t146sb10.t59sb09:2330', 'path': 'issuer/2330.json',
        'fetched_at': '2026-10-02T22:00:00+00:00', 'sha256': hashlib.sha256(raw).hexdigest()}}}))
    result = extractor.extract(base / 'spec.json', issuer, ['2330'], start='2026-09-01', end='2026-09-30')
    report = extractor.write_outputs(result, tmp_path / 'out', issuer_dir=issuer, clock=lambda: CAPTURED)
    assert report['subscription_rules'] == 1 and report['rules_by_semantic']['auto_exact_match'] == 1
    out_spec = json.loads((tmp_path / 'out' / 'spec.json').read_text())
    [bundle_ref] = out_spec['extra_sources']
    bundle_raw = (tmp_path / 'out' / 'issuer_bundle.json').read_bytes()
    assert bundle_ref['sha256'] == hashlib.sha256(bundle_raw).hexdigest()
    assert json.loads(bundle_raw)['evidence']['2330'] == evidence
    [rule] = out_spec['reviewed_subscription_rules']
    assert rule['source_sha256s'] == [bundle_ref['sha256']]
    assert rule['issuer_source_sha256s'] == [hashlib.sha256(raw).hexdigest()]
    frame, *_ = compile_history(out_spec, base=tmp_path / 'out')
    from services.research_corporate_history import load_history_tape
    day = load_history_tape(frame)['2026-09-07']
    assert '2330' not in day['blockers']
    assert [a['kind'] for a in day['actions'] if a['symbol'] == '2330'] == ['subscription']
    (issuer / '2330.json').write_bytes(raw + b' ')
    with pytest.raises(ValueError, match='changed_since_fetch'):
        extractor.extract(base / 'spec.json', issuer, ['2330'], start='2026-09-01', end='2026-09-30')


def test_list_numbers_and_issuer_typos_never_become_dates():
    # 6225 / 5548 / 3037 real wording: a line break before the next list number, and an impossible month.
    text = extractor.compact('1.原股東及員工之股款繳款期間:115/9/3~115/9/1\n2.特定人認股繳款期間:115/9/10~115/9/16')
    periods = extractor.subscription_terms(text, previous_shares=None)['periods']
    assert list(periods) == [('2026-09-03', '2026-09-01')]  # 9/1, never 9/12
    assert extractor.stock_record_dates(extractor.compact('核准，115年79月3日為除權基準日')) == {}


def test_record_date_moved_after_ex_date_is_never_auto():
    # 4764 real case: the 8/1 offering was re-run with an 8/28 record date announced after the ex-date.
    action = subscription('1449', '2025-07-29', '2025-08-04', .15519830415, 10.8)
    moved = doc('2025-08-06', SUB_1449.replace('114年8月4日為認股基準日', '114年8月29日為認股基準日'))
    rules, queue, _ = extractor.subscription_candidates(action, [doc('2025-07-22', SUB_1449)], SOURCE, None, [moved])
    assert rules == [] and queue[0]['reasons'] == ['record_date_moved_after_ex_date']
    # The ex-date's own repeat of the same terms is not a move.
    rules, _, _ = extractor.subscription_candidates(action, [doc('2025-07-22', SUB_1449)], SOURCE, None,
                                                    [doc('2025-07-29', SUB_1449)])
    assert rules


def test_real_ratio_wording_variants_and_numbers_broken_over_lines():
    # 1229 / 2515 / 6294 / 3128 / 1295 / 3313 real wording.
    for body, value in (('(即每壹仟股無償配發50股)', 50), ('每仟股無償配發新股50.3股', '50.3'), ('每仟股無償配60股', 60),
                        ('每仟股無償配發97.408\n26976股', '97.40826976')):
        assert list(extractor.stock_ratios(extractor.compact(body))) == [extractor.Decimal(value)]
    assert extractor.stock_ratios(extractor.compact('每仟股配發現金股利1,000元')) == {}
    for body, value in (('每仟股認購新股67.984\n4408股', '67.9844408'), ('每壹仟股認購246.48817163股', '246.48817163')):
        assert list(extractor.subscription_terms(extractor.compact(body), previous_shares=None)['ratios']) == [
            extractor.Decimal(value)]


def test_approximate_issuer_ratio_is_queued_even_when_digits_match():
    rules, queue, _ = extractor.stock_candidates(stock('1225', '2025-09-24', '2025-09-30', .055),
        [doc('2025-09-09', STOCK_1225.replace('每仟股55股', '每仟股約55股'))], SOURCE)
    assert rules == [] and queue[0]['reasons'] == ['issuer_ratio_approximate']
    rules, queue, _ = extractor.subscription_candidates(subscription('1449', '2025-07-29', '2025-08-04', .15519830415, 10.8),
        [doc('2025-07-22', SUB_1449.replace('每仟股可認購', '每仟股約可認購'))], SOURCE, None)
    assert rules == [] and queue[0]['reasons'] == ['issuer_ratio_approximate']
