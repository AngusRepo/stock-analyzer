from datetime import datetime, timezone

import polars as pl
import pytest

from services.finlab_corporate_actions import normalize_dividend_announcements, CASH, STOCK


def row(**changes):
    return {'stock_id': '2330', '公告日期': '2026-09-01', '公告時間': '12:00:00',
        'key_date': '2026-09-01 12:01:00', '股利所屬期間': '115年第2季',
        '除息交易日': '2026-09-07', '除權交易日': '2026-09-07', '現金股利發放日': '2026-10-08',
        '普通股每股面額': '新台幣5.0000元', '現金增資認股比率(%)': 0.,
        CASH[0]: 2., CASH[1]: 1., STOCK[0]: .5, STOCK[1]: 0., **changes}


def normalize(rows):
    return normalize_dividend_announcements(pl.DataFrame(rows), symbols=['2330', '1101'],
        session_date='2026-09-07', observed_at=datetime(2026, 9, 6, 22, tzinfo=timezone.utc))


def test_cash_pay_date_and_actual_par_value_are_not_guessed():
    result = normalize([row()])
    cash, stock = result['actions']
    assert cash['cash_per_share'] == 3 and cash['payable_date'] == '2026-10-08'
    assert stock['stock_per_share'] == .1 and stock['payable_date'] is None
    assert result['covered_symbols'] == ['1101', '2330'] and result['blockers'] == {}
    assert result['stock_delivery_source_complete'] is False


def test_future_revision_cannot_overwrite_frozen_evidence():
    future = row(**{'key_date': '2026-09-08 12:01:00', CASH[0]: 8.})
    result = normalize([row(), future])
    assert result['actions'][0]['cash_per_share'] == 3


def test_only_future_revision_is_a_pit_gap_not_a_complete_zero_action_day():
    result = normalize([row(**{'key_date': '2026-09-08 12:01:00'})])
    assert result['actions'] == []
    assert result['blockers']['2330'] == ['corporate_event_has_no_observable_revision']


def test_missing_amount_and_unknown_par_value_remain_visible():
    result = normalize([row(**{CASH[0]: None})])
    assert result['blockers']['2330'] and not result['actions']
    result = normalize([row(**{'普通股每股面額': '無面額'})])
    assert 'stock_dividend_par_value_missing' in result['blockers']['2330']


def test_conflicting_revision_and_subscription_rights_are_not_discarded():
    result = normalize([row(), row(**{CASH[0]: 8.})])
    assert 'announcement_identity_or_time_invalid' in result['blockers']['2330']
    result = normalize([row(**{'現金增資認股比率(%)': 5.})])
    assert result['blockers']['2330'] == ['corporate_amount_missing']


@pytest.mark.parametrize('order', [(0, 1, 2), (2, 0, 1), (1, 2, 0)])
def test_superseded_archive_conflict_does_not_poison_current_revision(order):
    # Real preserved feed has historical rows bulk-ingested on the same clock.
    # A newer observable complete revision is not ambiguous because those old
    # rows differ. Do not make the result depend on source row order.
    versions = [
        row(**{'公告日期': '2019-08-07', 'key_date': '2023-12-01 10:12:23',
               '股利所屬期間': '不適用', '除息交易日': '2019-08-20',
               '除權交易日': None, CASH[0]: 1.}),
        row(**{'公告日期': '2022-12-05', 'key_date': '2023-12-01 10:12:23',
               '股利所屬期間': '不適用', '除息交易日': '2022-12-18',
               '除權交易日': None, CASH[0]: 4.}),
        row(**{'股利所屬期間': '不適用'}),
    ]
    result = normalize([versions[i] for i in order])
    assert result['blockers'] == {}
    assert result['actions'][0]['cash_per_share'] == 3


def test_latest_ambiguous_revision_is_not_resolved_by_an_older_good_row():
    current = row()
    older = row(**{'公告日期': '2026-08-20', 'key_date': '2026-08-20 12:01:00'})
    result = normalize([current, {**current, CASH[0]: 9.}, older])
    assert result['blockers']['2330'] == ['announcement_identity_or_time_invalid']
    assert result['actions'] == []


def test_future_revision_cannot_clear_a_present_ambiguity():
    current = row()
    future = row(**{'key_date': '2026-09-08 12:01:00', CASH[0]: 7.})
    result = normalize([current, {**current, CASH[0]: 9.}, future])
    assert result['blockers']['2330'] == ['announcement_identity_or_time_invalid']
    assert result['actions'] == []


def subscription_row(**changes):
    return row(**{'股利所屬期間': '不適用', '權利分派基準日': '2026-09-15',
        CASH[0]: 0., CASH[1]: 0., STOCK[0]: 0., STOCK[1]: 0.,
        '現金增資認股比率(%)': 2., '現金增資認購價(元/股)': 0.,
        '現金增資總股數(股)': 2000., '參加分派總股數': 100000., **changes})


@pytest.mark.parametrize('reverse', [False, True])
def test_same_subscription_event_period_relabel_uses_observable_latest_terms(reverse):
    old = subscription_row()
    new = subscription_row(**{'股利所屬期間': '114年', '公告日期': '2026-09-02',
        'key_date': '2026-09-02 12:01:00', '現金增資認購價(元/股)': 828., CASH[0]: 8.})
    versions = [old, new]
    result = normalize(versions[::-1] if reverse else versions)
    assert result['blockers'] == {}
    rights = [a for a in result['actions'] if a['kind'] == 'subscription']
    assert len(rights) == 1 and rights[0]['rights']['subscription_price'] == 828.
    assert len([a for a in result['actions'] if a['kind'] == 'cash']) == 1


def test_subscription_period_relabel_preserves_original_outstanding_action_id():
    old = subscription_row(**{'現金增資認購價(元/股)': 800.})
    original = normalize([old])['actions'][0]
    new = subscription_row(**{'股利所屬期間': '114年', '公告日期': '2026-09-08',
        '公告時間': '06:00:00', 'key_date': '2026-09-08 06:00:00', '現金增資認購價(元/股)': 828.})
    result = normalize_dividend_announcements(pl.DataFrame([old, new]), symbols=['2330'],
        session_date='2026-09-08', observed_at=datetime(2026, 9, 8, tzinfo=timezone.utc),
        outstanding_action_ids=(original['action_id'],))
    assert result['blockers'] == {}
    assert len(result['actions']) == 1
    assert result['actions'][0]['action_id'] == original['action_id']
    assert result['actions'][0]['fiscal_period'] == original['fiscal_period']
    assert result['actions'][0]['rights']['subscription_price'] == 828.


def test_subscription_relabel_does_not_use_future_price_or_merge_distinct_terms():
    old = subscription_row()
    future = subscription_row(**{'股利所屬期間': '114年', '公告日期': '2026-09-08',
        'key_date': '2026-09-08 06:00:00', '現金增資認購價(元/股)': 828.})
    assert 'subscription_price_or_share_capital_missing' in normalize([old, future])['blockers']['2330']
    different = subscription_row(**{'股利所屬期間': '114年', '現金增資認購價(元/股)': 828.,
        '權利分派基準日': '2026-09-16'})
    assert 'subscription_price_or_share_capital_missing' in normalize([old, different])['blockers']['2330']


def test_subscription_cross_period_conflicting_latest_terms_are_not_arbitrarily_chosen():
    left = subscription_row(**{'現金增資認購價(元/股)': 800.})
    right = subscription_row(**{'股利所屬期間': '114年', '現金增資認購價(元/股)': 828.})
    for versions in ([left, right], [right, left]):
        result = normalize(versions)
        assert result['blockers']['2330'] == ['subscription_revision_ambiguous']
        assert result['actions'] == []


def test_subscription_equivalent_labels_emit_once_but_duplicate_booked_rights_require_repair():
    left = subscription_row(**{'現金增資認購價(元/股)': 800.})
    right = {**left, '股利所屬期間': '114年'}
    original_ids = tuple(normalize([r])['actions'][0]['action_id'] for r in (left, right))
    result = normalize([left, right])
    assert result['blockers'] == {} and len(result['actions']) == 1
    assert normalize([right, left])['actions'] == result['actions']
    with pytest.raises(ValueError, match='duplicate_outstanding_identity'):
        normalize_dividend_announcements(pl.DataFrame([left, right]), symbols=['2330'],
            session_date='2026-09-08', observed_at=datetime(2026, 9, 8, tzinfo=timezone.utc),
            outstanding_action_ids=original_ids)


def test_wrong_source_schema_fails_before_claiming_universe_coverage():
    with pytest.raises(ValueError, match='schema'):
        normalize_dividend_announcements(pl.DataFrame({'stock_id': ['2330']}), symbols=['2330'],
            session_date='2026-09-07', observed_at=datetime.now(timezone.utc))


def test_irrelevant_old_bad_par_value_is_not_todays_gap_but_outstanding_rights_are_carried():
    old = row(**{'股利所屬期間': '110年', '普通股每股面額': None,
        '除息交易日': '2021-09-07', '除權交易日': '2021-09-07', '現金股利發放日': '2021-10-01'})
    current = normalize([old, row()])
    assert current['blockers'] == {}
    next_day = normalize_dividend_announcements(pl.DataFrame([row()]), symbols=['2330'],
        session_date='2026-09-08', observed_at=datetime(2026, 9, 8, tzinfo=timezone.utc),
        outstanding_action_ids=tuple(a['action_id'] for a in current['actions']))
    assert next_day['actions'] == current['actions']
