from copy import deepcopy
from datetime import datetime, timezone
import json

import polars as pl
import pytest

from services.subscription_rights import parse_subscription_terms, enrich_subscription_source, validate_rights
from services.paired_nav_journal import _corporate_receivables, account_value, digest
from services.finlab_corporate_actions import normalize_dividend_announcements
from services.paper_corporate_source import validate_source_schema
from services.backtest_corporate_accounting import apply_corporate_session
from test_backtest_corporate_accounting import account, source, nav
from test_finlab_corporate_actions import row


def rights():
    return {'ratio': .06075416207, 'issued_ratio': 20000000 / 246896665, 'subscription_price': 83.,
        'policy': 'do_not_subscribe', 'payment_start': '2026-09-07', 'payment_deadline': '2026-09-09',
        'expiry_policy': 'unexercised_original_holder_rights_expire', 'fractional_policy': 'retain_no_automatic_pooling',
        'fair_value_per_right': None, 'valuation_status': 'unobservable', 'promotion_eligible': False,
        'evidence_checksums': ['a' * 64]}


def action():
    return {'action_id': 'subscription', 'symbol': '2330', 'kind': 'subscription', 'ex_date': '2026-09-07',
        'payable_date': None, 'cash_per_share': 0., 'stock_per_share': 0., 'rights': rights()}


# Narrow parser fixture projected from MOPS 9958 DATE1=20260817 SKEY=1.
# Full raw source: audits/outbox/2026-09-08-nav-release/subscription_source_9958.json
# Original body SHA256: 7ae406dd7e476e78535a21a61ccb20616ab8be889a054012cb72429fc7ae296e
# Tests must not depend on that untracked audit file or fetch the network.
ISSUER_TERMS = '''115年8月30日為現金增資認股基準日。每仟股得認購60.75416207股。
本次現金增資認購價格：每股發行價格新台幣83元整。
原股東、員工放棄認購或認購不足之股份，授權董事長洽特定人按發行價格認購之。
(1)原股東及員工股款繳納期間：115年9月1日起至115年9月7日止
(2)特定人認股繳款期間：115年9月8日起至115年9月10日止'''


def test_official_original_holder_deadline_not_placement_deadline():
    terms = parse_subscription_terms(ISSUER_TERMS, record_date='2026-08-30', ratio=.06075416207, price=83.)
    assert terms['payment_start'] == '2026-09-01'
    assert terms['payment_deadline'] == '2026-09-07'
    assert terms['fair_value_per_right'] is None and terms['promotion_eligible'] is False
    with pytest.raises(ValueError, match='ratio_or_price'):
        parse_subscription_terms(ISSUER_TERMS, record_date='2026-08-30', ratio=.08, price=83.)
    assert parse_subscription_terms(ISSUER_TERMS, record_date='2026-09-30', ratio=.06075416207, price=83.) is None


# Wording verified against MOPS 4541, published2026-09-03; original body SHA256
# c5d124307009fa579712514cac213d3a18232e8fefb390ba946d044f49cad66e.
# Dates/amounts remain facts; this is a compact fixture, not a capture attestation.
ISSUER_4541 = '''115年9月18日為現金增資認股基準日。每仟股得認購59.130427股。
發行價格：每股新台幣50元。
原股東放棄認購之股份及不足一股之畸零股，由董事長洽特定人認購。
(1)原股東及員工繳款期間自115年9月22日至115年9月30日。
(2)特定人繳款期間自115年10月1日至115年10月5日。'''


def test_4541_original_holder_wording_source_variant():
    terms = parse_subscription_terms(ISSUER_4541, record_date='2026-09-18', ratio=.059130427, price=50.)
    assert terms['payment_start'] == '2026-09-22'
    assert terms['payment_deadline'] == '2026-09-30'
    assert terms['fair_value_per_right'] is None
    assert terms['policy'] == 'do_not_subscribe'


@pytest.mark.parametrize('extra', [
    '每股發行價格新台幣51元。',
    '(3)原股東及員工股款繳納期間：115年9月22日至115年10月1日。',
])
def test_mixed_wording_conflicting_terms_cannot_pick_convenient_match(extra):
    with pytest.raises(ValueError):
        parse_subscription_terms(ISSUER_4541 + extra, record_date='2026-09-18', ratio=.059130427, price=50.)


@pytest.mark.parametrize('revision', ['valid', 'new_mismatch', 'same_day_conflict'])
def test_latest_issuer_revision_cannot_fall_back_to_old_matching_terms(revision):
    a = {**action(), 'record_date': '2026-08-30', 'ex_date': '2026-08-24'}
    evidence = {'query_end': '2026-09-08', 'documents': [
        {'body': ISSUER_TERMS, 'body_checksum': digest(ISSUER_TERMS), 'published_date': '2026-08-17'}]}
    if revision != 'valid':
        changed = ISSUER_TERMS.replace('83元', '84元')
        evidence['documents'].append({'body': changed, 'body_checksum': digest(changed),
            'published_date': '2026-08-18' if revision == 'new_mismatch' else '2026-08-17'})
    result = enrich_subscription_source({'actions': [a], 'blockers': {}}, {'2330': evidence})
    if revision == 'valid':
        validate_rights(result['actions'][0]['rights'], '2026-08-24')
        assert result['actions'][0]['rights']['payment_deadline'] == '2026-09-07'
    else:
        assert result['blockers']['2330'] == ['subscription_latest_issuer_terms_unresolved']


def test_mode_a_and_independent_journal_retain_rights_until_actual_expiry():
    book, a = account(), action()
    previous = {'cash': book.cash, 'positions': {'2330': 100}}
    for day in ('2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'):
        apply_corporate_session(book, source(day, [a]), day, {'2330': 100.})
        unchanged = deepcopy(book)
        apply_corporate_session(book, source(day, [a]), day, {'2330': 100.})
        assert book == unchanged
        cash, pending = _corporate_receivables(previous, [a], previous['positions'], day)
        assert cash == 0 and book.cash == 99000.
        if day <= '2026-09-09':
            assert len(pending) == len(book.corporate_receivables) == 1
            assert json.loads(pending[0]['rights_json']) == json.loads(book.corporate_receivables[a['action_id']]['rights_json'])
            assert json.loads(pending[0]['rights_json'])['quantity'] == pytest.approx(6.075416207)
            with pytest.raises(ValueError, match='unobservable'):
                account_value({**previous, 'corporate_receivables': pending}, {'2330': 99.})
            with pytest.raises(ValueError, match='unobservable'):
                nav(book, 99.)
        else:
            assert not pending and not book.corporate_receivables
        previous['corporate_receivables'] = pending
        # Selling the parent does not sell or surrender its outstanding right.
        previous['positions'] = {}
        book.positions.clear()


@pytest.mark.parametrize('field,value', [('policy', 'subscribe'), ('fair_value_per_right', 0.),
    ('promotion_eligible', True), ('payment_deadline', '2026-09-01'), ('ratio', True), ('evidence_checksums', [])])
def test_no_unknown_to_zero_or_automatic_subscription(field, value):
    r = rights()
    r[field] = value
    with pytest.raises(ValueError):
        validate_rights(r, '2026-09-07')


def test_finlab_source_carries_distinct_entitlement_and_issuance_ratios():
    data = row(**{'現金增資認股比率(%)': 6.075416207, '現金增資認購價(元/股)': 83.,
        '現金增資總股數(股)': 20000000., '參加分派總股數': 246896665.})
    first = normalize_dividend_announcements(pl.DataFrame([data]), symbols=['2330'], session_date='2026-09-07',
        observed_at=datetime(2026, 9, 7, tzinfo=timezone.utc))
    a = next(a for a in first['actions'] if a['kind'] == 'subscription')
    assert a['rights']['ratio'] == pytest.approx(.06075416207)
    assert a['rights']['issued_ratio'] == pytest.approx(20000000 / 246896665)
    with pytest.raises((ValueError, KeyError)):
        validate_source_schema(first)  # FinLab alone has no issuer deadline.
    following = normalize_dividend_announcements(pl.DataFrame([data]), symbols=['2330'], session_date='2026-09-08',
        observed_at=datetime(2026, 9, 8, tzinfo=timezone.utc), outstanding_action_ids=(a['action_id'],))
    assert following['actions'] == [a]
