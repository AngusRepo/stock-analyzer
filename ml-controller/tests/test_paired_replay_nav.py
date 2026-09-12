"""Synthetic accounting regression, not genuine strategy returns."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from services.paired_replay_nav import paired_calendar_nav
from services.alpha_evidence_runner import (_trade_returns_and_regimes, _walk_forward_row,
    run_alpha_candidate_evidence, run_parameter_candidate_evidence)


DAYS = [f'2026-01-{i:02d}' for i in range(1, 14)]


def metrics(values=None):
    values = values or [100000.] * len(DAYS)
    return {'start_date': DAYS[0], 'end_date': DAYS[-1], 'initial_capital': 100000.,
            'final_equity': values[-1], 'total_return': values[-1] / 100000 - 1,
            'equity_curve': list(zip(DAYS, values)),
            'partition_returns': [.20] * 6, 'trades': [], 'total_trades': 0}


def paired(a=None, b=None, **kwargs):
    return paired_calendar_nav(a or metrics(), b or metrics(),
        **({'calendar': DAYS, 'start_date': DAYS[0], 'end_date': DAYS[-1],
            'initial_capital': 100000.} | kwargs))


def test_all_dates_and_tail_loss_survive_six_calendar_partitions():
    b = metrics([100000.] * 12 + [80000.])
    out = paired(b=b)
    assert out['sessions'] == sum(p['sessions'] for p in out['partition_dates']) == 13
    assert len(out['candidate']['partition_returns']) == 6
    assert out['candidate']['partition_returns'][-1] == pytest.approx(-.20)
    assert out['total_return_delta'] == pytest.approx(-.20)
    # Old all-positive trade partitions disagree; they cannot override real NAV.
    diag = _walk_forward_row(metrics(), b, nav=out)
    assert diag['candidate_mean_return'] < 0
    assert not diag['passed'] and not diag['diagnostic_stable']
    assert not out['prospective'] and out['nav_maturity_credit'] == 0


def test_raw_daily_delta_includes_first_day_cost_and_preserves_real_zero():
    b = metrics([99980.] * 13)
    out = paired(b=b)
    assert out['daily_net_return_delta'][0] == pytest.approx(-.0002)
    assert out['daily_net_return_delta'][1:] == [0.] * 12
    assert out['candidate']['total_return'] == pytest.approx(-.0002)


@pytest.mark.parametrize('both', [False, True])
def test_missing_same_day_in_both_arms_does_not_create_an_inner_join(both):
    a, b = metrics(), metrics()
    b['equity_curve'].pop(5)
    if both:
        a['equity_curve'].pop(5)
    with pytest.raises(ValueError, match='calendar_incomplete'):
        paired(a, b)


@pytest.mark.parametrize('value', [None, True, float('nan'), float('inf'), -1])
def test_missing_or_invalid_nav_is_not_filled_or_deleted(value):
    b = metrics()
    b['equity_curve'][4] = (DAYS[4], value)
    with pytest.raises(ValueError, match='invalid_number|negative_nav'):
        paired(b=b)


def test_zero_nav_is_economic_bankruptcy_not_a_missing_source_or_invented_zero_return():
    from services.alpha_evidence_runner import _pbo_row, _data_snooping_row
    b = metrics([100000.] * 4 + [0.] * 9)
    out = paired(b=b)
    assert out['status'] == 'terminal_insolvency' and out['insolvent_arms'] == ['candidate']
    assert out['total_return_delta'] == -1.
    assert out['daily_net_return_delta'][4] == -1.
    assert out['daily_net_return_delta'][5:] == [None] * 8
    assert _walk_forward_row(metrics(), b, nav=out)['reason'] == 'terminal_insolvency'
    assert _pbo_row(metrics(), b, nav=out)['go_live_verdict'] == 'FAIL'
    assert _data_snooping_row(metrics(), b, nav=out)['decision'] == 'FAIL'


def test_account_cannot_restart_after_bankruptcy_without_an_external_cashflow_owner():
    b = metrics([0.] + [100000.] * 12)
    with pytest.raises(ValueError, match='unexplained_recapitalization'):
        paired(b=b)


@pytest.mark.parametrize('change', ['date', 'final', 'initial', 'summary', 'scope'])
def test_source_and_summary_must_reconcile(change):
    b = metrics()
    if change == 'date':
        b['equity_curve'][4] = (DAYS[3], 100000.)
    elif change == 'final':
        b['final_equity'] = 1.
    elif change == 'initial':
        b['initial_capital'] = 200000.
    elif change == 'summary':
        b['total_return'] = .5
    else:
        b['start_date'] = '2025-12-31'
    with pytest.raises(ValueError, match='mismatch'):
        paired(b=b)


def test_positive_calendar_diagnostic_is_not_a_purged_training_window():
    b = metrics([100000. + i * 100 for i in range(1, 14)])
    out = paired(b=b)
    row = _walk_forward_row(metrics(), b, nav=out)
    assert row['diagnostic_stable'] and not row['gate_pass']
    assert row['reason'] == 'calendar_partition_is_not_purged_walk_forward'


@pytest.mark.parametrize('runner', [run_alpha_candidate_evidence, run_parameter_candidate_evidence])
def test_actual_runner_checks_identity_before_loading_any_data(runner):
    def unexpected(**kwargs):
        pytest.fail('invalid identity must not load/replay data')
    with pytest.raises(ValueError, match='identity_missing'):
        runner({}, start_date=DAYS[0], end_date=DAYS[-1], dataset_loader=unexpected, replay_fn=unexpected)


@pytest.mark.parametrize('runner', [run_alpha_candidate_evidence, run_parameter_candidate_evidence])
def test_both_actual_runner_consumers_use_nav_not_trade_partition_arrays(runner):
    from test_alpha_evidence_runner import _metrics
    a = _metrics([.01] * 72, [.001] * 6)
    b = _metrics([.02] * 72, [-.001] * 6)
    b.partition_returns = [100.] * 100  # cannot truncate or override NAV
    calls = []
    def replay(**kwargs):
        calls.append(kwargs)
        return a if len(calls) == 1 else b
    output = runner({'id': 'candidate-calendar'}, start_date=a.start_date, end_date=a.end_date,
        dataset_loader=lambda **kwargs: SimpleNamespace(trading_days=[d for d, _ in a.equity_curve]),
        replay_fn=replay, mc_simulations=20)
    assert len(calls) == 2 and calls[0]['dataset'] is calls[1]['dataset']
    assert output['comparison']['paired_nav']['total_return_delta'] < 0
    assert output['walk_forward']['candidate_mean_return'] < 0
    assert output['walk_forward']['windows'] == 6
    assert output['comparison']['paired_nav']['nav_maturity_credit'] == 0


@pytest.mark.parametrize('value', [None, True, 'bad', float('nan'), float('inf')])
def test_trade_diagnostics_cannot_impute_missing_return_zero(value):
    with pytest.raises(ValueError, match='trade_return_missing|trade_return_invalid'):
        _trade_returns_and_regimes({'trades': [{'profit_ratio': value}]})
    assert _trade_returns_and_regimes({'trades': [{'profit_ratio': 0.}]})[0] == [0.]


def test_real_settlement_valuation_and_metric_owner_feed_identical_calendar():
    from services.backtest_engine import AccountState, PendingSettlement, _mark_to_market, compute_metrics
    dates = DAYS[:3]
    account = AccountState(cash=100000., initial_capital=100000.)
    account.pending_settlements.append(PendingSettlement(trade_date=dates[0],
        settlement_date=dates[2], side='sell', amount=200., symbol='2330'))
    curve = []
    for day in dates:
        account.settle_matured(day)
        curve.append((day, _mark_to_market(account, SimpleNamespace(), day)))
    real = compute_metrics([], curve, [], 100000., dates[0], dates[-1], mode='B')
    out = paired_calendar_nav(real, deepcopy(real), calendar=dates,
        start_date=dates[0], end_date=dates[-1], initial_capital=100000.)
    assert out['candidate']['nav'] == [100200.] * 3
    assert out['candidate']['daily_returns'][1:] == [0., 0.]
    assert out['daily_net_return_delta'] == [0.] * 3
