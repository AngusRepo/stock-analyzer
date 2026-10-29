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
    assert tool.preconditions(_kwargs(exposure_cap=.2))['aud1_locked_over_cap']
    assert tool.preconditions(_kwargs(exposure_cap=0.))['aud1_zero_cap_with_locked']
    liquidation = tool.preconditions(_kwargs(exposure_cap=0., locked_symbols=()))
    assert liquidation['aud1_zero_cap_full_liquidation'] and not liquidation['aud1_zero_cap_with_locked']


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
        self.queries.append(sql)
        return self.rows


def test_replay_date_forces_the_stored_arm_and_compares_weights():
    tool, runtime = _tool(), _runtime()
    stored_weights = l4_portfolio.allocate(**_kwargs())['weights']
    seen = {}

    def run(recommendations, policy, *, return_history, forced_arm=None):
        seen.update(forced_arm=forced_arm, policy=policy, history=return_history)
        return [{'_l4_portfolio_plan': {'weights': runtime.allocate(**_kwargs())['weights']}}]

    snapshot = {'payload': {'content': {'inputs': {'recommendations': [{'symbol': 'A'}], 'return_history': {'h': 1},
                                                   'alpha_policy': {'l4Distribution': {'version': 2}}}}}}
    report = tool.replay_date(
        '2026-10-01', paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2026-10-02'}]), time_limits=[30., 120.],
        run=run, read_snapshot=lambda query, sid: snapshot,
        first_formal_plan=lambda paper, day, entry: ({'plan_id': 'p', 'allocation_snapshot_id': 's'},
                                                     {'weights': stored_weights, 'opb': {'arm_id': 'tight'}}),
        allocate_module=l4_portfolio, runtime_module=runtime, is_v2=lambda policy: policy.get('version') == 2)
    assert seen['forced_arm'] == 'tight' and seen['history'] == {'h': 1}
    assert [b['time_limit'] for b in report['budgets']] == [30., 120.]
    assert all(b['matches_stored'] for b in report['budgets'])
    summary = tool.summarize([report])
    assert summary['budget_30s']['plans'] == 1 and summary['budget_120s']['matches_stored'] == 1
    assert summary['budget_30s']['aud17_names_sold_to_zero'] == 1


def test_replay_date_reports_a_refusal_without_repairing_it():
    tool, runtime = _tool(), _runtime()

    def run(recommendations, policy, *, return_history, forced_arm=None):
        runtime.allocate(**_kwargs(exposure_cap=0.))
        return []

    snapshot = {'payload': {'content': {'inputs': {'recommendations': [], 'return_history': {},
                                                   'alpha_policy': {'l4Distribution': {}}}}}}
    report = tool.replay_date(
        '2026-10-01', paper=_Db([]), learning=_Db([]), market=_Db([{'entry': '2026-10-02'}]), time_limits=[30.],
        run=run, read_snapshot=lambda query, sid: snapshot,
        first_formal_plan=lambda paper, day, entry: ({'plan_id': 'p', 'allocation_snapshot_id': 's'}, {'weights': {}}),
        allocate_module=l4_portfolio, runtime_module=runtime, is_v2=lambda policy: False)
    budget = report['budgets'][0]
    assert budget['error'].startswith('ValueError') and budget['solves'][0]['aud1_zero_cap_with_locked']
    assert tool.summarize([report])['budget_30s']['aud1_zero_cap_with_locked_days'] == 1


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
            tool.main(['--since', '2026-09-21', '--until', '2026-10-29'], now=now, clients={})


def test_main_reads_dates_and_never_writes():
    tool = _tool()

    class Paper(_Db):
        def execute(self, *a, **k):
            raise AssertionError('read-only tool')

    paper = Paper([])
    result = tool.main(['--since', '2026-09-21', '--until', '2026-10-29'],
                       now=datetime(2026, 10, 30, 2, tzinfo=timezone.utc),
                       clients={'paper': paper, 'learning': _Db([]), 'market': _Db([])})
    assert result['summary'] == {'dates': 0, 'replayed': 0}
    assert 'l4_portfolio_plans_v1' in paper.queries[0]
