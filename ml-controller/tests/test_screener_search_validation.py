from copy import deepcopy
from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from optuna_scripts import optuna_screener as search
from services.screener_search_validation import (
    chronological_split, portfolio_metrics, paired_holdout, freeze_selection, OBJECTIVE,
)
from services.screener_search_evidence import assess_metrics


def days():
    return [(date(2026, 6, 1) + timedelta(days=i)).isoformat() for i in range(90)
            if (date(2026, 6, 1) + timedelta(days=i)).weekday() < 5]


def metrics(dates, drift=.001, trade_sharpe=5):
    equity = 1e6
    curve = []
    for i, day in enumerate(dates):
        equity *= 1 + drift + (.002 if i % 2 else -.002)
        curve.append((day, equity))
    return SimpleNamespace(initial_capital=1e6, final_equity=equity, equity_curve=curve,
        sharpe=trade_sharpe, total_return=equity/1e6-1, max_drawdown=.1,
        total_trades=40, win_rate=.6, profit_factor=1.1,
        entry_attempts=50, entries_filled=40, fill_rate=.8,
        candidate_conversion_rate=.8, execution_attempts=50, execution_fill_rate=.8,
        execution_data_missing=0, skip_reasons={}, sanity_flags=[])


def test_nav_sharpe_is_not_trade_sharpe_and_first_day_loss_counts():
    observed = portfolio_metrics(metrics(days(), drift=-.001, trade_sharpe=9))
    assert observed['portfolio_sharpe'] < 0
    assert observed['trade_sharpe_diagnostic'] == 9
    assert observed['portfolio_total_return'] < 0
    sample = metrics(days()[:2])
    sample.equity_curve = [(days()[0], 900000), (days()[1], 950000)]
    sample.final_equity = 950000
    assert portfolio_metrics(sample)['portfolio_max_drawdown'] == pytest.approx(.1)


def test_low_drawdown_and_high_trade_sharpe_are_not_self_defeating_objective_gates():
    sample = metrics(days(), trade_sharpe=4)
    sample.sanity_flags = ['sharpe=4.00 > 3.0 — likely overfit, reject for Optuna',
                          'max_dd=0.010 < 2% — unrealistically low, check data']
    result = assess_metrics(sample, {}, portfolio=portfolio_metrics(sample))
    assert result['category'] == 'valid'
    assert result['metrics']['diagnostic_only_flags'] == sample.sanity_flags
    sample.execution_data_missing = 1
    assert assess_metrics(sample, {}, portfolio=portfolio_metrics(sample))['category'] == 'data_missing'


def test_undefined_trade_sharpe_does_not_replace_valid_nav_objective():
    sample = metrics(days(), trade_sharpe=float('nan'))
    result = assess_metrics(sample, {}, portfolio=portfolio_metrics(sample))
    assert result['category'] == 'valid'
    assert result['metrics']['sharpe'] is None
    assert result['metrics']['portfolio_sharpe'] > 0
    import json
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize('fault', ['duplicate', 'nonfinite', 'final_mismatch', 'missing'])
def test_nav_errors_fail_closed(fault):
    sample = metrics(days())
    if fault == 'duplicate': sample.equity_curve[1] = sample.equity_curve[0]
    if fault == 'nonfinite': sample.equity_curve[1] = (days()[1], float('nan'))
    if fault == 'final_mismatch': sample.final_equity += 100
    if fault == 'missing': sample.equity_curve = []
    with pytest.raises(ValueError): portfolio_metrics(sample)


def test_split_is_chronological_disjoint_and_does_not_shrink_evidence_floor():
    split = chronological_split(days(), '2026-06-01', '2026-08-29')
    assert len(split['gap']) == 5
    assert len(split['development']) >= 20 and len(split['validation']) >= 10
    assert split['development'][-1] < split['gap'][0] < split['validation'][0]
    assert split['historical_holdout_is_prospective'] is False
    with pytest.raises(ValueError): chronological_split(days()[:20], days()[0], days()[19])


def test_holdout_requires_exact_date_pairs_not_intersection():
    left = {'category': 'valid', 'metrics': portfolio_metrics(metrics(days()))}
    right = deepcopy(left)
    right['metrics']['daily_nav_returns'].pop()
    assert paired_holdout(left, right, days())['status'] == 'invalid'
    same = paired_holdout(left, left, days())
    assert same['status'] == 'inconclusive_zero_variance'
    assert same['promotion_eligible'] is False
    assert same['prospective_credit'] is False


def test_selection_lock_changes_with_candidate_or_split():
    split = chronological_split(days(), days()[0], days()[-1])
    def lock(candidate, baseline):
        return freeze_selection(candidate, split, {}, ['1'], baseline_params=baseline)
    assert lock({'a': 1}, {'a': 0}) == lock({'a': 1}, {'a': 0})
    assert lock({'a': 2}, {'a': 0}) != lock({'a': 1}, {'a': 0})
    assert lock({'a': 1}, {'a': 2}) != lock({'a': 1}, {'a': 0})
    with pytest.raises(ValueError, match='selection_baseline_required'):
        lock({'a': 1}, {})


def test_holdout_cannot_change_selection_and_universe_is_prior_to_search(monkeypatch):
    dataset = SimpleNamespace(trading_days=days())
    universe_dates = []
    monkeypatch.setattr(search, 'select_stratified_subset',
                        lambda **kwargs: universe_dates.append(kwargs['end_date']) or ['2330'])
    monkeypatch.setattr(search.BacktestDataset, 'load_for_research', lambda **_: (dataset, {'snapshot':'fixed'}))
    outcomes = []
    for holdout_drift in (-.02, .02):
        calls, emitted = [], []
        def replay(ds, start, end, params, **kwargs):
            calls.append((start, end))
            n = len(calls)
            drift = 0 if n == 1 else -.001 if n == 2 else .001 if n == 3 else 0 if n == 4 else holdout_drift
            return metrics([day for day in days() if start <= day <= end], drift, 9 if n == 2 else -9)
        monkeypatch.setattr(search, 'replay_period', replay)
        monkeypatch.setattr(search, 'emit_evidence', lambda _, record: emitted.append(deepcopy(record)))
        result = search.run_search(n_trials=2, start_date=days()[0], end_date=days()[-1])
        assert len(calls) == 5
        assert calls[0] == calls[1] == calls[2]
        assert calls[3] == calls[4] and calls[2][1] < calls[3][0]
        assert result['diagnostics']['selected_trial'] == 1  # negative trade score, positive NAV
        assert result['best_sharpe'] > 0 and result['best_trade_sharpe_diagnostic'] == -9
        assert result['best_sharpe_definition'] == OBJECTIVE
        assert next(i for i,r in enumerate(emitted) if r.get('kind') == 'selection') < next(i for i,r in enumerate(emitted) if r.get('kind') == 'holdout')
        assert result['holdout']['promotion_eligible'] is False
        outcomes.append(result)
    assert outcomes[0]['selection_lock'] == outcomes[1]['selection_lock']
    assert outcomes[0]['best_params'] == outcomes[1]['best_params']
    assert outcomes[0]['holdout']['mean_daily_nav_delta'] < 0 < outcomes[1]['holdout']['mean_daily_nav_delta']
    assert universe_dates == ['2026-05-31', '2026-05-31']


def test_holdout_data_failure_is_not_hidden_or_reselected(monkeypatch):
    dataset = SimpleNamespace(trading_days=days())
    monkeypatch.setattr(search, 'select_stratified_subset', lambda **_: ['2330'])
    monkeypatch.setattr(search.BacktestDataset, 'load_for_research', lambda **_: (dataset, {}))
    calls = []
    def replay(ds, start, end, params, **kwargs):
        calls.append(1)
        value = metrics([day for day in days() if start <= day <= end])
        if len(calls) > 3: value.execution_data_missing = 1
        return value
    monkeypatch.setattr(search, 'replay_period', replay)
    with pytest.raises(search.ScreenerSearchBlocked) as exc:
        search.run_search(n_trials=2, start_date=days()[0], end_date=days()[-1])
    assert len(calls) == 5
    assert exc.value.diagnostics['reason'] == 'holdout_not_evaluable'
    assert exc.value.diagnostics['selection_lock']['locked_before_validation'] is True
