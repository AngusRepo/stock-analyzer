import json
import logging
from copy import deepcopy
from types import SimpleNamespace
from datetime import date, timedelta

import optuna
import pytest

from optuna_scripts import optuna_screener as search
from services.backtest_engine import EntryAttempt, compute_metrics
from services.screener_search_evidence import assess_metrics, ScreenerSearchBlocked


def metric(filled=10, missed=0, skipped=90, missing=0):
    attempts = [EntryAttempt(str(i), '2026-08-25', '2026-08-26', status, 100,
                             execution_data_missing=data_missing)
                for status, count, data_missing in (
                    ('filled', filled, False), ('no_fill', missed, False),
                    ('skipped_duplicate', skipped, False), ('no_fill', missing, True))
                for i in range(count)]
    result = compute_metrics([], [('2026-08-25', 1e6), ('2026-08-26', 1e6)],
                             attempts, 1e6, '2026-08-25', '2026-08-26')
    # Isolate gate behavior; real compute_metrics funnel remains intact.
    result.total_trades = 40
    result.sharpe = 0.5
    result.sanity_flags = []
    return result


def test_policy_skips_do_not_lower_execution_fill_rate():
    m = metric()
    assert m.fill_rate == m.candidate_conversion_rate == 0.1
    assert m.execution_fill_rate == 1
    assert m.execution_attempts == 10
    assert assess_metrics(m, {})['category'] == 'valid'


def test_real_unfilled_orders_still_fail_unchanged_floor():
    m = metric(filled=2, missed=8, skipped=0)
    assert m.execution_fill_rate == 0.2
    assert assess_metrics(m, {})['category'] == 'fill_rate'


def test_missing_execution_data_is_not_a_pass():
    m = metric(missing=1)
    assert m.execution_fill_rate == 1
    assert assess_metrics(m, {})['category'] == 'data_missing'


def test_no_orders_is_not_one_hundred_percent():
    m = metric(filled=0)
    assert m.execution_fill_rate is None
    assert assess_metrics(m, {})['category'] == 'no_execution'


@pytest.mark.parametrize('field,value,category', [
    ('total_trades', 29, 'n_trades'), ('sharpe', float('nan'), 'invalid_metrics'),
    ('max_drawdown', float('inf'), 'invalid_metrics'),
    ('sanity_flags', ['unrealistically high Sharpe'], 'sanity_flag'),
    ('sanity_flags', ['unknown_vendor_lineage_warning'], 'sanity_flag'),
])
def test_other_guards_remain(field, value, category):
    m = metric()
    setattr(m, field, value)
    assessment = assess_metrics(m, {})
    assert assessment['category'] == category
    json.dumps(assessment, allow_nan=False)


def test_search_samples_only_legal_and_delivered_dimensions():
    baseline = search._default_baseline_params()
    original = deepcopy(baseline)
    study = optuna.create_study(directions=['maximize', 'minimize'],
                               sampler=optuna.samplers.NSGAIISampler(seed=42))
    for _ in range(300):
        trial = study.ask()
        params = search._build_trial_params(trial, baseline)
        assert search._check_constraints(params) is None
        assert params['ranking'] == baseline['ranking']
        assert not any(k.startswith('ranking') for k in trial.params)
        study.tell(trial, (1, 0))
    assert baseline == original


def stub_dataset(monkeypatch, replay):
    days = [(date(2026, 6, 6) + timedelta(days=i)).isoformat() for i in range(91)
            if (date(2026, 6, 6) + timedelta(days=i)).weekday() < 5]
    dataset = SimpleNamespace(trading_days=days)
    monkeypatch.setattr(search, 'select_stratified_subset', lambda **_: ['2330'])
    monkeypatch.setattr(search.BacktestDataset, 'load_for_research',
                        lambda **_: (dataset, {'snapshot': 'fixed-test'}))
    def with_nav(dataset, start, end, params, **kwargs):
        result = replay(dataset, start, end, params, **kwargs)
        result.equity_curve = [(day, 1e6) for day in days if start <= day <= end]
        return result
    monkeypatch.setattr(search, 'replay_period', with_nav)
    return dataset


def test_baseline_same_dataset_and_zero_drawdown_preserved(monkeypatch, caplog):
    seen = []
    def replay(dataset, start, end, params, **kwargs):
        seen.append((dataset, start, end, deepcopy(params)))
        return metric()
    dataset = stub_dataset(monkeypatch, replay)
    baseline = search._default_baseline_params()
    with caplog.at_level(logging.INFO, logger=search.__name__):
        result = search.run_search(n_trials=3, start_date='2026-06-06', end_date='2026-09-04',
                                   baseline_params=baseline)
    assert len(seen) == 6  # baseline + three development trials + two holdout replays
    split = result['diagnostics']['split']
    assert all(r[0] is dataset for r in seen)
    assert all(r[1:3] == (split['development'][0], split['development'][-1]) for r in seen[:4])
    assert all(r[1:3] == (split['validation'][0], split['validation'][-1]) for r in seen[4:])
    assert seen[0][3] == baseline
    assert result['best_max_dd'] == 0
    assert result['baseline_comparison']['delta_candidate_minus_baseline']['sharpe'] == 0
    assert result['baseline_comparison']['promotion_eligible'] is False
    records = [json.loads(r.message.split('] ', 1)[1]) for r in caplog.records
               if r.message.startswith('[optuna_screener:evidence]')]
    assert sum('trial' in r for r in records) == 3
    assert len({r['evidence_id'] for r in records}) == 1
    assert result['diagnostics']['reject_summary']['valid'] == 3


def test_all_rejected_keeps_baseline_and_all_trial_evidence(monkeypatch, caplog):
    stub_dataset(monkeypatch, lambda *a, **kw: metric(filled=2, missed=8))
    with caplog.at_level(logging.INFO, logger=search.__name__), pytest.raises(ScreenerSearchBlocked) as exc:
        search.run_search(n_trials=3, start_date='2026-06-06', end_date='2026-09-04')
    evidence = exc.value.diagnostics
    assert evidence['reject_summary']['fill_rate'] == 3
    assert evidence['baseline']['category'] == 'fill_rate'
    assert sum('"trial":' in r.message for r in caplog.records) == 3
    assert evidence['thresholds']['execution_fill_rate'] == 0.3


def test_replay_exception_retains_cause(monkeypatch):
    def fail(*a, **kw):
        raise ValueError('bad input')
    monkeypatch.setattr(search, 'replay_period', fail)
    result = search.evaluate_params(None, '2026-06-06', '2026-09-04', search._default_baseline_params())
    assert result['category'] == 'replay_error'
    assert result['reject_reason'] == 'ValueError'


def test_broken_baseline_stops_before_search(monkeypatch):
    calls = []
    def replay(*a, **kw):
        calls.append(1)
        return metric(missing=1)
    stub_dataset(monkeypatch, replay)
    with pytest.raises(ScreenerSearchBlocked) as exc:
        search.run_search(n_trials=300, start_date='2026-06-06', end_date='2026-09-04')
    assert len(calls) == 1
    assert exc.value.diagnostics['trial_count'] == 0
    assert exc.value.diagnostics['reason'] == 'baseline_not_evaluable'


@pytest.mark.parametrize('bar,min_value,status,missing', [
    ({'open': 101, 'low': 101}, 2_000_000, 'skipped_min_value', False),
    ({'open': 101, 'low': 101}, 1, 'no_fill', False),
    ({'open': 100, 'low': 99}, 1, 'filled', False),
    (None, 1, 'no_fill', True),
    ({'open': 100, 'low': 0}, 1, 'no_fill', True),
    ({'low': 99}, 1, 'no_fill', True),
    ({'open': float('nan'), 'low': 99}, 1, 'no_fill', True),
    ({'open': True, 'low': 99}, 1, 'no_fill', True),
    ({'open': 100, 'low': 101}, 1, 'no_fill', True),
])
def test_entry_producer_marks_policy_and_data_separately(monkeypatch, bar, min_value, status, missing):
    from services import backtest_engine as engine
    monkeypatch.setattr(engine, '_gap_pct_from_benchmark', lambda *a: 0)
    monkeypatch.setattr(engine, '_get_atr14', lambda *a: 2)
    candidate = engine.Candidate(symbol='2330', date='2026-08-25', close=100,
        industry='semi', base_score=80, chip_score=30, tech_score=30, momentum_score=20,
        combined_score=80, has_buy_signal=1)
    account = engine.AccountState(cash=1_000_000, initial_capital=1_000_000)
    attempts = engine.simulate_entries_for_date(
        SimpleNamespace(get_bar=lambda *a: bar), '2026-08-25', '2026-08-26',
        [candidate], account, engine.PositionSizeParams(min_position_value=min_value),
        engine.SLTPParams(), engine.FeeParams())
    assert len(attempts) == 1
    assert attempts[0].status == status
    assert attempts[0].execution_data_missing == missing
    assert bool(attempts[0].missing_execution_fields) == missing
    assert bool(account.positions) == (status == 'filled')


def test_missing_execution_events_are_logged_individually_without_mutating_metrics(caplog):
    issue = {'symbol': '2330', 'decision_date': '2026-08-25', 'entry_date': '2026-08-26',
             'missing_fields': ['open'], 'source_cause': 'unverified_requires_source_audit'}
    record = {'trial': 7, 'metrics': {'execution_data_issues': [issue, issue], 'execution_data_missing': 2}}
    original = deepcopy(record)
    with caplog.at_level(logging.INFO, logger=search.__name__):
        search.emit_evidence('test-only', record)
    assert record == original
    events = [json.loads(r.message.split('] ', 1)[1]) for r in caplog.records
              if r.message.startswith('[optuna_screener:execution_issue]')]
    assert len(events) == 2
    assert [r['issue_index'] for r in events] == [0, 1]
    assert all(r['trial'] == 7 and r['symbol'] == '2330' for r in events)
