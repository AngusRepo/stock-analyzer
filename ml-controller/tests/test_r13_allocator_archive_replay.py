import importlib.util
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

from services import l4_portfolio

REPO = Path(__file__).resolve().parents[2]


def _tool():
    spec = importlib.util.spec_from_file_location('r13_replay', REPO / 'tools/r13_allocator_archive_replay.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _kwargs(**changes):
    base = dict(symbols=['A', 'B', 'C'], expected_gross=[.02, .01, 0.], covariance=[[.01, 0, 0], [0, .01, 0], [0, 0, .01]],
                current_weights=[0., .01, .3], exposure_cap=.9, name_cap=.4, min_weight=.05, max_positions=2,
                buy_cost=.001, sell_cost=.004, locked_symbols=('C',))
    return {**base, **changes}


def test_preconditions_flag_aud1_and_aud17():
    tool = _tool()
    pre = tool.preconditions(_kwargs())
    assert pre['candidates'] == 3 and pre['held'] == 2 and pre['locked_weight'] == .3
    assert pre['aud17_below_min_weight'] == ['B']
    assert not pre['aud1_locked_over_cap']
    assert not pre['aud1_zero_cap_with_locked'] and not pre['aud1_zero_cap_full_liquidation']
    assert not tool.preconditions(_kwargs(exposure_cap=.3))['aud1_locked_over_cap']
    assert tool.preconditions(_kwargs(exposure_cap=.2))['aud1_locked_over_cap']
    assert tool.preconditions(_kwargs(exposure_cap=0.))['aud1_zero_cap_with_locked']
    liquidation = tool.preconditions(_kwargs(exposure_cap=0., locked_symbols=()))
    assert liquidation['aud1_zero_cap_full_liquidation'] and not liquidation['aud1_zero_cap_with_locked']
    assert not tool.preconditions(_kwargs(exposure_cap=0., locked_symbols=(), current_weights=[0., 0., 0.]))[
        'aud1_zero_cap_full_liquidation']
    # A locked name below min_weight is not an AUD-17 forced sale; pool membership is counted.
    assert tool.preconditions(_kwargs(locked_symbols=('B', 'C')))['aud17_below_min_weight'] == []
    assert tool.preconditions(_kwargs(), pool={'A', 'B'})['locked_outside_pool'] == 1
    # Production's weight support, not a finer one.
    assert tool.preconditions(_kwargs(current_weights=[5e-8, .01, .3]))['held'] == 2


def _runtime():
    return types.SimpleNamespace(allocate=l4_portfolio.allocate)


def test_measured_times_each_solve_at_the_budget_and_restores_the_runtime():
    tool, runtime = _tool(), _runtime()
    budgets = []
    real = l4_portfolio.allocate

    def spy(**kwargs):
        budgets.append(kwargs['time_limit'])
        return real(**kwargs)

    module = types.SimpleNamespace(allocate=spy)
    replay, calls = tool.measured(lambda: runtime.allocate(**_kwargs()), module, runtime, 7.)
    replay()
    assert budgets == [7.] and runtime.allocate is real
    assert calls[0]['status'] == 'plan' and calls[0]['seconds'] >= 0 and calls[0]['rounds'] >= 1
    assert calls[0]['aud17_sold_to_zero'] == ['B']  # below min_weight and not worth raising

    replay, calls = tool.measured(lambda: runtime.allocate(**_kwargs(exposure_cap=.2)), module, runtime, 7.)
    with pytest.raises(ValueError):
        replay()
    assert calls[0]['status'] == 'error' and calls[0]['aud1_locked_over_cap']
    assert runtime.allocate is real


class _Db:
    def __init__(self, rows):
        self.rows, self.queries = rows, []

    def query(self, sql, params=None):
        self.queries.append((sql, params))
        return self.rows


def _snapshot(policy, recommendations=({'symbol': 'A'},), history=None, frozen_at='2026-10-02T00:30:00Z'):
    return {'manifest': {'frozen_at': frozen_at},
            'payload': {'content': {'inputs': {'recommendations': list(recommendations),
                                               'return_history': {'h': 1} if history is None else history,
                                               'alpha_policy': {'l4Distribution': policy}}}}}


RUNTIME = {'signal_date': '2026-10-01', 'l3_identity': 'l3'}


def test_replay_date_forces_the_stored_arm_and_compares_weights():
    tool, runtime = _tool(), _runtime()
    stored_weights = l4_portfolio.allocate(**_kwargs())['weights']
    seen = {}

    def run(recommendations, policy, *, return_history, forced_arm=None):
        seen.update(forced_arm=forced_arm, policy=policy, history=return_history)
        return [{'_l4_portfolio_plan': {'weights': runtime.allocate(**_kwargs())['weights']}}]

    snapshot = _snapshot({'version': 2, 'opb': {'enabled': True}, 'runtime': RUNTIME})
    entries, market = [], _Db([{'entry': '2026-10-02'}])

    def first(paper, day, entry):
        entries.append((day, entry))
        return ({'plan_id': 'p', 'allocation_snapshot_id': 's'},
                {'weights': stored_weights, 'opb': {'arm_id': 'tight'}, 'l3_identity': 'l3'})

    report = tool.replay_date(
        '2026-10-01', paper=_Db([]), learning=_Db([]), market=market, time_limits=[30., 120.],
        run=run, read_snapshot=lambda query, sid: snapshot, first_formal_plan=first,
        allocate_module=l4_portfolio, runtime_module=runtime, is_v2=lambda policy: policy.get('version') == 2)
    assert entries == [('2026-10-01', '2026-10-02')]
    sql, params = market.queries[0]
    assert "stock_id='0050'" in sql and 'date>?' in sql and params == ['2026-10-01']
    assert seen['forced_arm'] == 'tight' and seen['history'] == {'h': 1}
    assert [b['time_limit'] for b in report['budgets']] == [30., 120.]
    assert all(b['matches_stored'] for b in report['budgets'])
    summary = tool.summarize([report])
    assert summary['budget_30s']['solve_plans'] == 1 and summary['budget_120s']['matches_stored'] == 1
    assert summary['budget_30s']['aud17_names_sold_to_zero'] == 1


def test_replay_date_reports_a_refusal_without_repairing_it():
    tool, runtime = _tool(), _runtime()

    def run(recommendations, policy, *, return_history, forced_arm=None):
        runtime.allocate(**_kwargs(exposure_cap=0.))
        return []

    snapshot = _snapshot({'runtime': RUNTIME, 'opb': {'enabled': True}}, recommendations=())
    report = tool.replay_date(
        '2026-10-01', paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2026-10-02'}]), time_limits=[30.],
        run=run, read_snapshot=lambda query, sid: snapshot,
        first_formal_plan=lambda paper, day, entry: ({'plan_id': 'p', 'allocation_snapshot_id': 's'},
                                                     {'weights': {}, 'l3_identity': 'l3', 'opb': {'arm_id': 'tight'}}),
        allocate_module=l4_portfolio, runtime_module=runtime, is_v2=lambda policy: False)
    budget = report['budgets'][0]
    assert budget['run_error'].startswith('ValueError') and budget['solves'][0]['aud1_zero_cap_with_locked']
    assert report['consistency'] == 'not_applicable:v1_context' and budget['matches_stored'] is None
    assert report['forced_arm'] is None, 'a v1 day is never forced, even with OPB enabled'
    summary = tool.summarize([report])['budget_30s']
    assert summary['aud1_zero_cap_with_locked_days'] == 1 and summary['days_refused'] == 1
    assert summary['not_comparable'] == 1 and sum(summary['allocate_errors'].values()) == 1


def test_a_refusal_outside_allocate_is_counted():
    tool, runtime = _tool(), _runtime()

    def run(recommendations, policy, *, return_history, forced_arm=None):
        raise ValueError('l4_distribution_risk_history_missing:A')

    report = tool.replay_date(
        '2026-10-01', paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2026-10-02'}]), time_limits=[30.],
        run=run, read_snapshot=lambda query, sid: _snapshot({'version': 2, 'runtime': RUNTIME}),
        first_formal_plan=lambda *a: ({'plan_id': 'p', 'allocation_snapshot_id': 's'}, {'weights': {}, 'l3_identity': 'l3'}),
        allocate_module=l4_portfolio, runtime_module=runtime, is_v2=lambda policy: True)
    summary = tool.summarize([report])['budget_30s']
    assert summary['days_refused'] == 1 and summary['days_with_plan'] == 0 and summary['solves'] == 0
    assert summary['run_errors'] == {'ValueError: l4_distribution_risk_history_missing:A': 1}
    assert report['forced_arm'] is None, 'OPB disabled: no arm gate is added'


@pytest.mark.parametrize('change, reason', [({'frozen_at': '2026-10-02T01:00:00Z'}, 'context_frozen_after_entry'),
                                            ({'runtime': {**RUNTIME, 'l3_identity': 'other'}}, 'context_mismatch'),
                                            ({'runtime': {**RUNTIME, 'signal_date': '2026-09-30'}}, 'context_mismatch')])
def test_replay_date_keeps_the_opb_replay_guards(change, reason):
    tool = _tool()
    snapshot = _snapshot({'runtime': change.get('runtime', RUNTIME)}, frozen_at=change.get('frozen_at', '2026-10-02T00:30:00Z'))
    report = tool.replay_date(
        '2026-10-01', paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2026-10-02'}]), time_limits=[30.],
        run=None, read_snapshot=lambda query, sid: snapshot,
        first_formal_plan=lambda *a: ({'plan_id': 'p', 'allocation_snapshot_id': 's'}, {'weights': {}, 'l3_identity': 'l3'}),
        allocate_module=l4_portfolio, runtime_module=_runtime(), is_v2=lambda policy: True)
    assert (report['status'], report['reason']) == ('not_applicable', reason)
    assert tool.summarize([report])['not_replayed'] == {reason: 1}


def test_the_real_runtime_replays_a_v2_day_to_the_stored_plan():
    from copy import deepcopy
    from services import l4_distribution_runtime as runtime
    from services.l4_opb_selection import is_v2
    from test_l4_opb_v2 import v2_fixture
    tool = _tool()
    recommendations, policy, history = v2_fixture()
    for label, value in (('enabled', policy), ('disabled', {**policy, 'opb': {**policy['opb'], 'enabled': False,
                                                                                  'approved_policy_identity': 'e' * 64}})):
        stored = runtime.run(deepcopy(recommendations), deepcopy(value), return_history=deepcopy(history))[0]['_l4_portfolio_plan']
        signal_date = value['runtime']['signal_date']
        snapshot = {'manifest': {'frozen_at': '2000-01-01T00:00:00Z'},
                    'payload': {'content': {'inputs': {'recommendations': recommendations, 'return_history': history,
                                                       'alpha_policy': {'l4Distribution': value}}}}}
        report = tool.replay_date(
            signal_date, paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2099-01-02'}]), time_limits=[30.],
            run=runtime.run, read_snapshot=lambda query, sid: snapshot,
            first_formal_plan=lambda *a: ({'plan_id': stored['plan_id'], 'allocation_snapshot_id': 's'}, stored),
            allocate_module=l4_portfolio, runtime_module=runtime, is_v2=is_v2)
        assert report['budgets'][0]['matches_stored'] is True, label
        assert runtime.allocate is l4_portfolio.allocate


def test_replay_date_without_a_formal_plan_or_session():
    tool = _tool()
    common = dict(paper=_Db([]), learning=_Db([]), time_limits=[30.], run=None, read_snapshot=None,
                  allocate_module=l4_portfolio, runtime_module=_runtime(), is_v2=lambda p: False)
    assert tool.replay_date('2026-10-01', market=_Db([{'entry': None}]),
                            first_formal_plan=None, **common)['status'] == 'no_next_session'
    assert tool.replay_date('2026-10-01', market=_Db([{'entry': '2026-10-02'}]),
                            first_formal_plan=lambda *a: (None, None), **common)['status'] == 'no_formal_plan'


@pytest.mark.parametrize('clock, blocked', [('12:59', False), ('13:00', True), ('16:29', True), ('16:30', False),
                                            ('17:00', True), ('22:59', True), ('23:00', False)])
def test_main_refuses_inside_the_learning_db_avoid_windows(clock, blocked):
    tool = _tool()
    now = datetime.fromisoformat(f'2026-10-30T{clock}:00+00:00')
    assert tool.in_avoid_window(now) is blocked
    if blocked:
        with pytest.raises(SystemExit, match='avoid window'):
            tool.main(['--since', '2026-09-21', '--until', '2026-10-29'], clock=lambda: now, clients={})


def test_main_reads_dates_and_never_writes():
    tool = _tool()

    class Paper(_Db):
        def execute(self, *a, **k):
            raise AssertionError('read-only tool')

    paper = Paper([])
    result = tool.main(['--since', '2026-09-21', '--until', '2026-10-29'],
                       clock=lambda: datetime(2026, 10, 30, 2, tzinfo=timezone.utc),
                       clients={'paper': paper, 'learning': _Db([]), 'market': _Db([])})
    assert result['summary']['dates'] == 0 and result['aborted'] is None
    sql, params = paper.queries[0]
    assert 'l4_portfolio_plans_v1' in sql and 'activated=1' in sql and 'account_id=1' in sql
    assert params == ['2026-09-21', '2026-10-29']
    assert not hasattr(tool.QueryOnly(paper), 'execute')


def test_main_stops_before_a_date_that_reaches_an_avoid_window():
    tool = _tool()
    times = iter([datetime(2026, 10, 30, 12, 59, tzinfo=timezone.utc), datetime(2026, 10, 30, 13, 0, tzinfo=timezone.utc)])
    result = tool.main(['--since', '2026-09-21', '--until', '2026-10-29'], clock=lambda: next(times),
                       clients={'paper': _Db([{'signal_date': '2026-10-01'}]), 'learning': _Db([]), 'market': _Db([])})
    assert result['aborted'] == {'reason': 'aborted_avoid_window', 'next_date': '2026-10-01'}
    assert result['dates'] == []


def test_aud2_flag_needs_the_budget_to_be_spent():
    tool, runtime = _tool(), _runtime()
    clock = iter([0., 0.001, 10., 50.])
    tool.time.perf_counter = lambda: next(clock)

    def refuse(**kwargs):
        raise ValueError(tool.NOT_CERTIFIED)

    module = types.SimpleNamespace(allocate=refuse)
    for expected in (False, True):
        replay, calls = tool.measured(lambda: runtime.allocate(**_kwargs()), module, runtime, 30.)
        with pytest.raises(ValueError):
            replay()
        assert calls[0]['aud2_budget_exhausted'] is expected


def test_a_different_plan_is_counted_and_an_empty_output_is_not_a_plan():
    tool, runtime = _tool(), _runtime()
    outputs = iter([[{'_l4_portfolio_plan': {'weights': {'A': .1}}}], [], [{'_l4_portfolio_plan': {'weights': {'A': .1}}}]])

    def run(recommendations, policy, *, return_history, forced_arm=None):
        return next(outputs)

    first = lambda *a: ({'plan_id': 'p', 'allocation_snapshot_id': 's'}, {'weights': {'A': .2}, 'l3_identity': 'l3'})
    reports = [tool.replay_date('2026-10-01', paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2026-10-02'}]),
                                time_limits=[30.], run=run, read_snapshot=lambda q, s: _snapshot({'version': 2, 'runtime': RUNTIME}),
                                first_formal_plan=first, allocate_module=l4_portfolio, runtime_module=runtime,
                                is_v2=lambda policy, v2=v2: v2) for v2 in (True, True, False)]
    summary = tool.summarize(reports)['budget_30s']
    assert summary['differs_from_stored'] == 2 and summary['not_comparable'] == 1
    assert summary['days_with_plan'] == 2


def test_main_hands_the_replay_query_only_clients(monkeypatch):
    tool = _tool()
    seen = []
    monkeypatch.setattr(tool, 'replay_date', lambda day, **kw: seen.append(kw) or {'signal_date': day, 'status': 'no_formal_plan'})

    class Writable(_Db):
        def execute(self, *a, **k):
            raise AssertionError('read-only tool')

    tool.main(['--since', '2026-09-21', '--until', '2026-10-29'], clock=lambda: datetime(2026, 10, 30, 2, tzinfo=timezone.utc),
              clients={'paper': Writable([{'signal_date': '2026-10-01'}]), 'learning': Writable([]), 'market': Writable([])})
    assert all(isinstance(seen[0][name], tool.QueryOnly) for name in ('paper', 'learning', 'market'))
