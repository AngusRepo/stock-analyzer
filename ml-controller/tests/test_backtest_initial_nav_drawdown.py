"""Actual metric owner regressions; synthetic balances, not strategy returns."""
from dataclasses import asdict

import pytest

from services.backtest_engine import compute_metrics, _compute_max_drawdown


def test_first_session_loss_is_measured_against_opening_nav_and_date_is_serialized():
    curve = [('2026-09-07', 80000.), ('2026-09-08', 90000.)]
    row = compute_metrics([], curve, [], 100000., curve[0][0], curve[-1][0], mode='B')
    assert row.max_drawdown == pytest.approx(.20)
    assert row.max_drawdown_date == '2026-09-07'
    assert asdict(row)['max_drawdown_date'] == '2026-09-07'
    assert not hasattr(row, 'max_dd_date')


def test_new_high_water_mark_and_later_loss_use_the_same_nav_owner():
    assert _compute_max_drawdown([('2026-09-07', 120000.), ('2026-09-08', 90000.)],
        initial_equity=100000.) == (.25, '2026-09-08')


def test_fees_on_first_day_are_not_forgiven():
    value, day = _compute_max_drawdown([('2026-09-07', 99980.)], initial_equity=100000.)
    assert value == pytest.approx(.0002) and day == '2026-09-07'


def test_bankruptcy_is_a_full_loss_not_zero_or_missing_drawdown():
    assert _compute_max_drawdown([('2026-09-07', 0.)], initial_equity=100000.) == (1., '2026-09-07')


def test_monotonically_growing_nav_has_no_invented_trough_date():
    assert _compute_max_drawdown([('2026-09-07', 110000.)], initial_equity=100000.) == (0., '')


@pytest.mark.parametrize('initial', [0., -1., True, float('nan'), float('inf')])
def test_bad_initial_value_cannot_hide_loss(initial):
    with pytest.raises(ValueError, match='invalid_initial_equity'):
        _compute_max_drawdown([], initial_equity=initial)
