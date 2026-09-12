import asyncio
import json
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from routers import config_pool
from services.backtest_engine import BacktestDataset
from services.config_pool_policy import ConfigPoolPolicy


DAYS = [(date(2026, 6, 1) + timedelta(days=i)).isoformat() for i in range(60)]


def replay(candidate=False):
    nav, curve = 1e6, []
    for i, day in enumerate(DAYS):
        nav *= 1 + .001 + (.002 if i % 2 else -.002) + ( .001 + i % 3 * .0001 if candidate else 0)
        curve.append((day, nav))
    return SimpleNamespace(initial_capital=1e6, final_equity=nav, equity_curve=curve,
        sharpe=-1 if candidate else 3, total_return=nav / 1e6 - 1, max_drawdown=.1,
        total_trades=40, win_rate=.30 if candidate else .80, profit_factor=1.1,
        entry_attempts=50, entries_filled=40, fill_rate=.8,
        candidate_conversion_rate=.8, execution_attempts=50, execution_fill_rate=.8,
        execution_data_missing=0, skip_reasons={}, sanity_flags=[])


def test_low_win_rate_better_nav_is_positive_not_rejected_by_legacy_proxy():
    policy = ConfigPoolPolicy.from_config({'configPool': {'winRateFloor': .99}})
    result = policy.evaluate(replay(), replay(True), DAYS)
    assert result['status'] == 'positive_increment'
    assert result['mean_daily_nav_delta'] > .001
    assert result['action'] == 'hold'  # Historical diagnosis cannot promote.
    assert result['promotion_eligible'] is False
    assert result['prospective_credit'] is False


@pytest.mark.parametrize('fault', ['missing_date', 'nan', 'execution', 'unknown_sanity'])
def test_bad_evidence_not_masked(fault):
    candidate = replay(True)
    if fault == 'missing_date':
        candidate.equity_curve.pop(10)
    elif fault == 'nan':
        candidate.equity_curve[10] = (DAYS[10], float('nan'))
    elif fault == 'execution':
        candidate.execution_data_missing = 1
    else:
        candidate.sanity_flags = ['future_column_or_unknown_problem']
    assert ConfigPoolPolicy().evaluate(replay(), candidate, DAYS)['status'] == 'invalid'


def configure_route(monkeypatch, broken=False):
    calls = []
    async def worker(path, **kwargs):
        calls.append((path, kwargs))
        if path == '/api/admin/config':
            return {'test': 'champion'}
        if path == '/api/admin/config/challenger?full=1':
            return {'challenger': {'config': {'test': 'candidate'}, 'hash': 'candidate',
                                  'shadow_since': '2026-01-01T00:00:00Z'}}
        if path == '/api/admin/config/challenger/state':
            return {'success': True, 'state': {'challenger_hash': 'candidate',
                    'consecutive_wins': 10, 'consecutive_losses': 0}}
        if path == '/api/admin/config/challenger/eval_commit':
            return {'success': True}
        raise AssertionError(path)
    monkeypatch.setattr(config_pool, 'fetch_worker_admin', worker)
    monkeypatch.setattr(BacktestDataset, 'load_for_research',
                        lambda **_: (SimpleNamespace(trading_days=DAYS), {'snapshot': 'synthetic'}))
    def run(**kwargs):
        result = replay(kwargs['params']['test'] == 'candidate')
        if broken:
            result.execution_data_missing = 1
        return result
    monkeypatch.setattr('services.backtest_engine.replay_period', run)
    return calls


def test_route_persists_nav_not_new_votes_and_does_not_retire_old_challenger(monkeypatch):
    calls = configure_route(monkeypatch)
    request = config_pool.WeeklyEvalRequest(apply=True, confirm=True, end_date=DAYS[-1])
    results = [asyncio.run(config_pool.weekly_eval(request, None, None)) for _ in range(2)]
    assert all(r['action'] == 'hold' and r['consecutive_wins'] == 10 for r in results)
    writes = [kwargs['json_body'] for path, kwargs in calls if path.endswith('eval_commit')]
    assert len(writes) == 2
    assert all(w['state']['paired_nav_evidence']['status'] == 'positive_increment' for w in writes)
    assert not any(kwargs.get('method') == 'DELETE' or path.endswith('promote_to_prod') for path, kwargs in calls)


def test_route_quality_failure_returns_error_without_state_write(monkeypatch):
    calls = configure_route(monkeypatch, broken=True)
    request = config_pool.WeeklyEvalRequest(apply=True, confirm=True, end_date=DAYS[-1])
    with pytest.raises(HTTPException) as caught:
        asyncio.run(config_pool.weekly_eval(request, None, None))
    assert caught.value.status_code == 422
    assert not any(path.endswith('eval_commit') for path, _ in calls)


def test_undefined_trade_ratio_diagnostics_remain_json_safe():
    metrics = replay(True)
    metrics.sharpe, metrics.profit_factor = float('nan'), float('inf')
    summary = config_pool._perf_summary(metrics)
    assert summary['sharpe'] is None and summary['profit_factor'] is None
    json.dumps(summary, allow_nan=False)
