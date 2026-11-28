"""OPB v3 replay: session pieces sum to the five-session label, closed sessions book
incrementally on stored targets, exposure-normalized deltas, KV-gated counterfactual,
warm-start override, and the pre-plan refresh."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import sys

import pytest

from services import l4_opb_arm_replay as replay
from services.l4_opb_selection import (LEDGER_SCHEMA_V2, OPB_SCHEMA_V3, POLICY_SCHEMA, REWARD_EXPOSURE_NORMALIZED,
    MARKET_PROXY_DEFAULT, ROW_COUNTERFACTUAL_INERT, ROW_CUTOVER_WARM_START, ROW_LIVE, context_identity,
    decision_inputs_digest)
from services.paired_nav_collection import allocator_source_identity

SESSIONS = ['2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
OPB = {'schema_version': OPB_SCHEMA_V3, 'enabled': True, 'reward_window_observations': 60,
       'reward_half_life_observations': 20., 'approved_policy_identity': 'x' * 64,
       'reward': REWARD_EXPOSURE_NORMALIZED, 'family_error_rate': .1, 'critical_value_simulations': 4000,
       'hac_lag_sessions': 2, 'min_exposure_ratio': .5,
       'inert_counterfactual': {'enabled': False, 'reference_exposure_cap': None, 'reference_name_cap': None},
       'cutover_warm_start': {'enabled': False, 'max_observations': 0},
       'arms': [{'id': 'base'}, {'id': 'risk_tilt', 'risk_aversion': 8.}]}
LIVE = {'policy_schema': POLICY_SCHEMA, 'scope': 'paper',
        'artifact': {'model_checksum': 'a' * 64, 'l3_identity': {'source': 'fixed'}},
        'constraints': {'risk_aversion': 2., 'return_history_lookback_sessions': 252,
                        'cost_objective': 'entry_round_trip_v1'},
        'opb': OPB}
WEIGHTS = {'base': {'A': .2}, 'risk_tilt': {'A': .05, 'B': .05}}
CLOSES = {'A': [101., 103., 102., 104., 106.], 'B': [99., 98., 100., 101., 100.], '0050': [100.5, 101., 100., 100., 102.]}


def prices():
    out = {}
    for symbol, closes in CLOSES.items():
        for i, day in enumerate(SESSIONS):
            out[(symbol, day)] = (100. if i == 0 else 100. + i, closes[i])
    return out


class Market:
    calendar_stock = '0050'          # the proxy whose finlab.price dates are the calendar

    def query(self, sql, params):
        if sql.startswith('SELECT date'):
            assert "stock_id=?" in sql and params[0] == self.calendar_stock, (sql, params)
            return [{'date': day} for day in SESSIONS if day > params[1]][:params[2]]
        symbols, start, end = params[:-2], params[-2], params[-1]
        return [{'stock_id': s, 'date': d, 'source': 'finlab.price', 'adj_open': o, 'adj_close': c}
                for (s, d), (o, c) in prices().items() if s in symbols and start <= d <= end]


class Learning:
    def __init__(self):
        self.rows, self.verdicts, self.retry = {}, {}, {}

    def query(self, sql, params):
        if 'FROM l4_opb_arm_replay_retry_v1' in sql:
            return [{'signal_date': d, 'last_attempt_at': r['last_attempt_at']}
                    for (c, d), r in self.retry.items() if c == params[0]]
        if 'FROM l4_opb_arm_replay_runs_v1' in sql:
            return [{'n': 0}]
        context, day = params
        if 'FROM l4_opb_arm_replay_verdicts_v1' in sql:
            verdict = self.verdicts.get((context, day))
            return [] if verdict is None else [verdict]
        hits = [r for k, r in self.rows.items() if k[:2] == (context, day)]
        if sql.startswith('SELECT arm_digest,session_offset,weights_json'):
            return [{k: r[k] for k in ('arm_digest', 'session_offset', 'weights_json', 'current_json', 'replay_plan_id',
                                       'effective_digest', 'arm_exposure', 'row_kind', 'status', 'known_date',
                                       'arm_piece', 'market_piece', 'consistency', 'snapshot_id', 'plan_id')}
                    for r in hits]
        return [{'arm_digest': r['arm_digest'], 'session_offset': r['session_offset'],
                 'payload_checksum': r['payload_checksum']} for r in hits]

    def batch_execute(self, statements):
        for sql, values in statements:
            if 'l4_opb_arm_replay_retry_v1' in sql:
                if sql.startswith('DELETE'):
                    self.retry.pop(tuple(values), None)
                else:
                    old = self.retry.get((values[0], values[1]), {'attempts': 0})
                    self.retry[(values[0], values[1])] = {'reason': values[2], 'detail_json': values[3],
                                                          'attempts': old['attempts'] + 1, 'last_attempt_at': values[4]}
                continue
            if 'INTO l4_opb_arm_replay_verdicts_v1' in sql:
                record = dict(zip(replay.VERDICT_COLUMNS, values))
                self.verdicts.setdefault((record['context_identity'], record['signal_date']), record)
                continue
            record = dict(zip(replay.COLUMNS_V2, values))
            key = (record['context_identity'], record['signal_date'], record['arm_digest'], record['session_offset'])
            self.rows.setdefault(key, record)


class Paper:
    def __init__(self, plan):
        self.plan = plan

    def query(self, sql, params):
        return [{'plan_id': 'formal', 'allocation_snapshot_id': 'snap-1', 'created_at': '2026-10-02T00:40:00Z',
                 'payload_json': json.dumps(self.plan)}]


class Runs:
    def __init__(self):
        self.calls = []

    def __call__(self, recommendations, policy, *, return_history, forced_arm):
        self.calls.append((forced_arm, deepcopy(policy['runtime']['account']['risk_limits'])))
        halted = policy['runtime']['account']['risk_limits']['exposure_cap'] == 0
        weights = {} if halted else dict(WEIGHTS[forced_arm])
        return [{'_l4_portfolio_plan': {'plan_id': 'replay-' + forced_arm, 'weights': weights,
            'targets': {s: {'current_weight': 0.} for s in weights},
            'opb': {'arm_id': forced_arm, 'effective_digest': 'e' * 63 + forced_arm[0], 'arm_inert': halted}}}]


@pytest.fixture
def world(monkeypatch):
    limits = {'exposure_cap': .45, 'name_cap': .125, 'buys_halted': False}
    runtime = {'signal_date': '2026-10-01', 'l3_identity': {'source': 'fixed'},
               'account': {'fees': {'buy_cost': .001, 'sell_cost': .004}, 'risk_limits': limits}}
    content = {'allocator_source_identity': allocator_source_identity(),
               'inputs': {'alpha_policy': {'l4Distribution': {**deepcopy(LIVE), 'runtime': runtime}},
                          'return_history': {'lookback': 252}, 'recommendations': [{'symbol': 'A'}, {'symbol': 'B'}]}}
    state = {'content': content}
    monkeypatch.setattr('services.paired_nav_journal.read_snapshot', lambda query, snapshot_id:
        {'manifest': {'frozen_at': '2026-10-02T00:30:00Z'}, 'payload': {'content': deepcopy(state['content'])}})
    stored = {'execution_scope': 'paper', 'l3_identity': {'source': 'fixed'}, 'opb': {'arm_id': 'base'},
              'weights': dict(WEIGHTS['base'])}
    SEALED['state'] = state
    return state, stored


SEALED = {}


def seal(stored):
    """The plan's decision-input digest over the frozen snapshot as it stands (the plan wrote it)."""
    inputs = SEALED['state']['content']['inputs']
    stored['opb']['decision_inputs_digest'] = decision_inputs_digest(
        inputs['recommendations'], inputs['alpha_policy']['l4Distribution'], inputs['return_history'],
        inputs.get('opb_reward_ledger'))
    return stored


def book(stored, learning, runs, business_date, live=None, sealed=True, **kwargs):
    if sealed:
        seal(stored)
    return replay.replay_day_v3(live=deepcopy(live or LIVE), signal_date='2026-10-01', business_date=business_date,
        paper=Paper(stored), learning=learning, market=Market(), run=runs, **kwargs)


def test_session_pieces_sum_to_the_five_session_net_label():
    weights, current = {'A': .2, 'B': .1}, {'B': .15}
    pieces = replay.session_pieces(weights, current, sessions=SESSIONS, prices=prices(), buy_cost=.001, sell_cost=.004)
    label = .2 * (106. / 100. - 1) + .1 * (100. / 100. - 1) - (.001 * .2 + .004 * .05)
    assert sum(pieces) == pytest.approx(label)
    assert pieces[0] == pytest.approx(.2 * .01 + .1 * -.01 - (.001 * .2 + .004 * .05))
    # A suspended session (no row) carries the last close; a bad close or no entry open is missing.
    suspended = {k: v for k, v in prices().items() if k != ('B', SESSIONS[3])}
    carried = replay.session_pieces(weights, current, sessions=SESSIONS, prices=suspended, buy_cost=0., sell_cost=0.)
    plain = replay.session_pieces(weights, current, sessions=SESSIONS, prices=prices(), buy_cost=0., sell_cost=0.)
    assert carried[3] == pytest.approx(plain[3] - .1 * (101. - 100.) / 100.)
    assert sum(carried) == pytest.approx(sum(plain))
    not_loaded = {k: v for k, v in prices().items() if k != ('B', SESSIONS[4])}
    assert replay.session_pieces(weights, current, sessions=SESSIONS, prices=not_loaded, buy_cost=0., sell_cost=0.) is None
    bad = {**prices(), ('B', SESSIONS[3]): (None, None)}
    assert replay.session_pieces(weights, current, sessions=SESSIONS, prices=bad, buy_cost=0., sell_cost=0.) is None
    no_entry = {k: v for k, v in prices().items() if k != ('B', SESSIONS[0])}
    assert replay.session_pieces(weights, current, sessions=SESSIONS, prices=no_entry, buy_cost=0., sell_cost=0.) is None


def test_closed_sessions_book_incrementally_on_stored_targets(world):
    _, stored = world
    learning, runs = Learning(), Runs()
    first = book(stored, learning, runs, '2026-10-06')
    assert first == {'status': 'materialized', 'rows': 4, 'sessions': 2, 'row_kind': ROW_LIVE, 'consistency': 'verified'}
    assert [arm for arm, _ in runs.calls] == ['base', 'risk_tilt']
    later = book(stored, learning, runs, '2026-10-09')
    assert later['rows'] == 6 and later['consistency'] == 'verified', 'later sessions keep the first verdict'
    assert len(runs.calls) == 2, 'later sessions reuse the stored targets'
    assert book(stored, learning, runs, '2026-10-09') == {'status': 'already_materialized'}
    rows = sorted(learning.rows.values(), key=lambda r: (r['arm_id'], r['session_offset']))
    assert {r['schema_version'] for r in rows} == {LEDGER_SCHEMA_V2}
    assert [r['known_date'] for r in rows if r['arm_id'] == 'base'] == SESSIONS
    tilt = [r for r in rows if r['arm_id'] == 'risk_tilt']
    base = [r for r in rows if r['arm_id'] == 'base']
    for t, b in zip(tilt, base):
        # Exposure normalized: the tilt holds .1 against base .2, so its piece is doubled.
        assert t['delta'] == pytest.approx(t['arm_piece'] * .2 / .1 - b['base_piece'])
        assert t['market_piece'] == b['market_piece']
    proxy = replay.session_pieces({'0050': 1.}, {'0050': 1.}, sessions=SESSIONS, prices=prices(), buy_cost=0., sell_cost=0.)
    assert [r['market_piece'] for r in base] == pytest.approx(proxy)


def test_an_arm_added_mid_hold_reuses_the_booked_market_and_base_pieces(world, monkeypatch):
    _, stored = world
    learning, runs = Learning(), Runs()
    book(stored, learning, runs, '2026-10-06')
    for row in learning.rows.values():
        row['market_piece'] += 1e-9                       # as if 0050 had been re-adjusted since
    live = deepcopy(LIVE)
    live['opb']['arms'].append({'id': 'ridge', 'l2_penalty': .02})
    WEIGHTS['ridge'] = {'A': .1, 'B': .1}
    try:
        book(stored, learning, runs, '2026-10-06', live=live)
    finally:
        WEIGHTS.pop('ridge')
    by = {}
    for (_, _, _, offset), row in learning.rows.items():
        by.setdefault(offset, set()).add(row['market_piece'])
    assert all(len(pieces) == 1 for pieces in by.values())


def test_halted_day_books_inert_unless_the_counterfactual_is_admitted(world):
    state, stored = world
    state['content']['inputs']['alpha_policy']['l4Distribution']['runtime']['account']['risk_limits'] = \
        {'exposure_cap': 0, 'name_cap': 0, 'buys_halted': True}
    learning, runs = Learning(), Runs()
    stored['weights'] = {}
    book(stored, learning, runs, '2026-10-09')
    assert {r['status'] for r in learning.rows.values()} == {'inert'}
    assert {r['row_kind'] for r in learning.rows.values()} == {ROW_LIVE}
    live = deepcopy(LIVE)
    live['opb']['inert_counterfactual'] = {'enabled': True, 'reference_exposure_cap': .2, 'reference_name_cap': .0625}
    learning, runs = Learning(), Runs()
    receipt = book(stored, learning, runs, '2026-10-09', live=live)
    assert receipt['row_kind'] == ROW_COUNTERFACTUAL_INERT
    assert receipt['consistency'] == 'verified_inputs'
    assert {(l['exposure_cap'], l['name_cap'], l['buys_halted']) for _, l in runs.calls} == {(.2, .0625, False)}
    assert {r['status'] for r in learning.rows.values()} == {'complete'}


def test_warm_start_override_books_its_own_row_kind(world):
    _, stored = world
    seen = {}

    def override(runtime, recommendations):
        seen['called'] = True
        runtime['l3_identity'] = {'source': 'new'}
        return runtime, recommendations

    live = deepcopy(LIVE)
    live['artifact']['l3_identity'] = {'source': 'new'}
    learning = Learning()
    receipt = book(stored, learning, Runs(), '2026-10-09', live=live, row_kind=ROW_CUTOVER_WARM_START,
                   frozen_override=override, score_source='fold_oof')
    assert seen['called'] and receipt['row_kind'] == ROW_CUTOVER_WARM_START
    assert receipt['consistency'] == 'verified_inputs'
    assert {r['score_source'] for r in learning.rows.values()} == {'fold_oof'}
    # Without the override a changed L3 never borrows the old context's days.
    assert book(stored, Learning(), Runs(), '2026-10-09', live=live) == \
        {'status': 'not_applicable', 'reason': 'l3_identity_changed', 'verdict': 'recorded'}


def test_pre_plan_refresh_books_the_session_that_closed_on_the_signal_date(monkeypatch):
    calls = []
    monkeypatch.setattr(replay, 'attach_daily_replay', lambda config, business_date, *, clients=None, budget=None,
                        dates_limit=None, deadline_seconds=None, solve=True:
                        calls.append((business_date, budget, dates_limit, deadline_seconds, solve)) or {'status': 'ok'})
    assert replay.refresh_before_plan({'l4Distribution': LIVE}, '2026-10-07') == {'status': 'ok'}
    # Premarket never solves (no snapshot read) and stops starting days at its own deadline.
    assert calls == [('2026-10-08', replay.HORIZON_SESSIONS, replay.HORIZON_SESSIONS + 1,
                      replay.PRE_PLAN_DEADLINE_SECONDS, False)]
    off = deepcopy(LIVE)
    off['opb']['enabled'] = False
    v2 = deepcopy(LIVE)
    v2['opb']['schema_version'] = 'l4-opb-relative-arms-v2'
    for config in ({'l4Distribution': off}, {'l4Distribution': v2}, {}):
        assert replay.refresh_before_plan(config, '2026-10-07')['status'] == 'skipped'
    assert len(calls) == 1


def test_consistency_checks_the_frozen_inputs_across_deploys(world, monkeypatch):
    """v1 only ever reached not_applicable (replay runs >=1 session after a deploy); v3 always checks inputs."""
    state, stored = world
    # Same code and policy: inputs and the chosen arm's targets both verified.
    assert book(stored, Learning(), Runs(), '2026-10-06')['consistency'] == 'verified'
    # A deploy since the plan (source identity moved): outputs are not comparable, inputs still are.
    state['content']['allocator_source_identity'] = {'moved': 'x' * 64}
    assert book(stored, Learning(), Runs(), '2026-10-06', sealed=False)['consistency'] == 'verified_inputs'
    # A KV policy change since the plan: same.
    live = deepcopy(LIVE)
    live['constraints'] = {**live['constraints'], 'risk_aversion': 3.}
    assert book(stored, Learning(), Runs(), '2026-10-06', live=live, sealed=False)['consistency'] == 'verified_inputs'
    # The snapshot no longer holds what the plan decided on: fail closed, no rows,
    # a terminal rejection (see test_input_digest_mismatch_is_a_terminal_rejection).
    state['content']['inputs']['recommendations'].append({'symbol': 'C'})
    learning = Learning()
    assert book(stored, learning, Runs(), '2026-10-06', sealed=False) == \
        {'status': 'rejected', 'reason': 'input_digest_mismatch', 'verdict': 'recorded'}
    assert not learning.rows
    # A pre-v3 plan carries no digest.
    stored['opb'].pop('decision_inputs_digest')
    assert book(stored, Learning(), Runs(), '2026-10-06', sealed=False)['consistency'] == 'not_applicable:no_input_digest'


def test_decision_inputs_digest_matches_the_json_round_tripped_snapshot():
    import json
    policy = {**deepcopy(LIVE), 'runtime': {'signal_date': '2026-10-01', 'weights': (0.1, 0.2)},
              '_account_rewards': [{'ignored': True}]}
    recommendations = [{'symbol': 'A', 'score': 0.1 + 0.2, 'tags': ('x', 'y')}]
    history = {'lookback': 252, 'returns': {'A': [0.01, -0.02]}}
    live = decision_inputs_digest(recommendations, policy, history, [{'k': 1}])
    frozen = json.loads(json.dumps({'r': recommendations, 'p': {k: v for k, v in policy.items() if k != '_account_rewards'},
                                    'h': history, 'l': [{'k': 1}]}))
    assert live == decision_inputs_digest(frozen['r'], frozen['p'], frozen['h'], frozen['l'])
    assert live != decision_inputs_digest(frozen['r'], frozen['p'], frozen['h'], [])
    assert decision_inputs_digest(recommendations, policy, None, None) == decision_inputs_digest(
        recommendations, policy, {}, [])
    assert decision_inputs_digest([{'v': float('nan')}], policy, history, []) is None


class Plans:
    """Formal plans for several signal days (one first-before-09:00 plan each)."""

    def __init__(self, days, stored):
        self.days, self.stored = days, stored

    def query(self, sql, params):
        if sql.startswith('SELECT DISTINCT signal_date'):
            return [{'signal_date': d} for d in sorted(self.days, reverse=True) if d < params[0]][:params[1]]
        return [{'plan_id': 'formal', 'allocation_snapshot_id': 'snap-1', 'created_at': '2026-10-02T00:40:00Z',
                 'payload_json': json.dumps(self.stored)}]


def test_missed_nights_are_caught_up_by_the_next_run_and_reruns_agree(world, monkeypatch):
    _, stored = world
    seal(stored)
    learning, runs = Learning(), Runs()
    monkeypatch.setattr('services.l4_distribution_runtime.run', runs)
    clients = {'paper': Plans(['2026-10-01'], stored), 'learning': learning, 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}
    # The job ran on 10-06 (two sessions), then nothing ran for three nights.
    first = replay.attach_daily_replay(config, '2026-10-06', clients=clients)
    assert first['status'] == 'ok' and first['dates']['2026-10-01']['rows'] == 4
    caught = replay.attach_daily_replay(config, '2026-10-09', clients=clients)
    assert caught['dates']['2026-10-01'] == {'status': 'materialized', 'rows': 6, 'sessions': 5,
                                             'row_kind': ROW_LIVE, 'consistency': 'verified'}
    assert sorted({r['known_date'] for r in learning.rows.values()}) == SESSIONS
    # A concurrent or repeated owner (job, pre-plan hook, independent dispatch) changes nothing.
    again = replay.attach_daily_replay(config, '2026-10-09', clients=clients)
    assert again['dates']['2026-10-01'] == {'status': 'already_materialized'} and len(learning.rows) == 10


def test_replay_run_is_bounded_by_budget_and_deadline(monkeypatch):
    seen = []

    def fake(*, live, signal_date, **_):
        seen.append(signal_date)
        return {'status': 'materialized'} if signal_date != '2026-10-05' else {'status': 'already_materialized'}

    monkeypatch.setattr(replay, 'replay_day_v3', fake)
    days = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']
    clients = {'paper': Plans(days, {}), 'learning': Learning(), 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}
    out = replay.attach_daily_replay(config, '2026-10-09', clients=clients, budget=2)
    # Newest first; a booked day does not spend the budget.
    assert seen == ['2026-10-06', '2026-10-05', '2026-10-02']
    assert out['deferred_dates'] == ['2026-10-01'] and out['dates']['2026-10-01'] == {'status': 'deferred_budget'}
    seen.clear()
    out = replay.attach_daily_replay(config, '2026-10-09', clients=clients, deadline_seconds=0)
    assert seen == [] and out['status'] == 'ok' and len(out['deferred_dates']) == 4


def test_independent_replay_job_books_through_the_pipeline_date_and_writes_its_receipt(monkeypatch):
    from services import l4_opb_replay_dispatch as dispatch
    calls = []
    result = {'status': 'ok', 'failed_dates': [], 'deferred_dates': [], 'rejected_dates': ['2026-10-01'], 'dates': {}}
    monkeypatch.setattr(replay, 'attach_daily_replay', lambda config, business_date, *, clients=None:
                        calls.append((config, business_date)) or dict(result))
    learning = Learning()
    receipts = []
    learning.batch_execute = lambda statements: receipts.extend(statements)
    out = dispatch.independent_replay('2026-10-09', execution_id='exec-1', config={'l4Distribution': LIVE},
                                      clients={'learning': learning})
    # Pipeline date S: sessions through S are booked tonight, so premarket only prices them.
    assert calls == [({'l4Distribution': LIVE}, '2026-10-10')]
    assert out['owner'] == 'independent_dispatch' and out['business_date'] == '2026-10-09'
    (sql, values), = receipts
    record = dict(zip(dispatch.RUN_COLUMNS, values))
    assert 'INTO l4_opb_arm_replay_runs_v1' in sql and record['complete'] == 1 and record['status'] == 'ok'
    assert json.loads(record['rejected_dates_json']) == ['2026-10-01'] and record['execution_id'] == 'exec-1'
    assert record['progress'] == 0
    # Progress decides: a run that booked or judged something may be followed tonight;
    # one that did neither would repeat itself, so the night ends.
    assert dispatch.run_complete({'status': 'ok', 'deferred_dates': ['x'], 'progress': 40}) is False
    assert dispatch.run_complete({'status': 'failed', 'failed_dates': ['x'], 'progress': 4}) is False
    assert dispatch.run_complete({'status': 'ok', 'deferred_dates': ['x'], 'progress': 0})
    assert dispatch.run_complete({'status': 'failed', 'failed_dates': ['x']}) and dispatch.run_complete({'status': 'skipped'})
    with pytest.raises(ValueError):
        dispatch.independent_replay('2026-13-40', execution_id='e', config={}, clients={'learning': learning})
    # Scheduling is not allocator economics: this module stays out of the OPB context.
    assert 'l4_opb_replay_dispatch.py' not in allocator_source_identity() and 'l4_opb_arm_replay.py' in allocator_source_identity()


def oof_job_task_timeout():
    """The OOF materialize job's task timeout as deploy_ml_controller.sh sets it (single source)."""
    import re
    from pathlib import Path
    script = (Path(__file__).resolve().parents[2] / 'deploy_ml_controller.sh').read_text()
    seconds, = re.findall(r'^OOF_MATERIALIZE_JOB_TIMEOUT="\$\{OOF_MATERIALIZE_JOB_TIMEOUT:-(\d+)s\}"$', script, re.M)
    assert '--task-timeout="$OOF_MATERIALIZE_JOB_TIMEOUT"' in script
    return int(seconds)


def oof_job_max_retries():
    """--max-retries of the OOF materialize job (create and update) in deploy_ml_controller.sh."""
    import re
    from pathlib import Path
    script = (Path(__file__).resolve().parents[2] / 'deploy_ml_controller.sh').read_text()
    retries = re.findall(r'--task-timeout="\$OOF_MATERIALIZE_JOB_TIMEOUT" \\\n\s*--max-retries=(\d+)', script)
    assert len(retries) == 2 and len(set(retries)) == 1, retries
    return int(retries[0])


def task_template(timeout=None, max_retries='deployed'):
    """The deployed job's task template as GetJob returns it (a real run_v2 message, so field
    presence behaves as in production: an unset max_retries is absent, not 0)."""
    from google.cloud import run_v2
    kw = {'timeout': timedelta(seconds=oof_job_task_timeout() if timeout is None else timeout)}
    if max_retries is not None:
        kw['max_retries'] = oof_job_max_retries() if max_retries == 'deployed' else max_retries
    return run_v2.TaskTemplate(**kw)


@pytest.fixture(autouse=True)
def replay_dispatch_clock(monkeypatch):
    """Dispatch tests run at 02:00 TW (inside the replay window) unless they pass `now`."""
    from services import l4_opb_replay_dispatch as dispatch
    monkeypatch.setattr(dispatch, '_utcnow', lambda: datetime(2026, 11, 19, 18, 0, tzinfo=timezone.utc))


class Rendezvous:
    """Holds each arrival until `n` arrived (or a short timeout): two entries both pass a
    step before either goes on. Never fails a lone entry."""
    def __init__(self, n=2, timeout=0.5):
        import threading
        self.n, self.timeout, self.cond, self.count = n, timeout, threading.Condition(), 0

    def wait(self):
        with self.cond:
            self.count += 1
            self.cond.notify_all()
            self.cond.wait_for(lambda: self.count >= self.n, timeout=self.timeout)


class ReplayBucket:
    """GCS fake with if_generation_match (the daily fence's CAS contract)."""
    def __init__(self):
        import threading
        self.values, self.serial, self.lock, self.rendezvous = {}, 0, threading.Lock(), None

    def blob(self, path):
        from google.api_core.exceptions import NotFound, PreconditionFailed
        bucket = self

        class Blob:
            generation = None

            def reload(self, **kwargs):
                assert kwargs['retry'] is None and 0 < kwargs['timeout'] <= 8
                with bucket.lock:
                    found = bucket.values.get(path)
                if bucket.rendezvous is not None:
                    bucket.rendezvous.wait()        # both entries read the same generation
                if found is None:
                    raise NotFound('fixture missing')
                self.generation = found[0]

            def download_as_bytes(self, *, if_generation_match, **kwargs):
                with bucket.lock:
                    current, value = bucket.values[path]
                if current != if_generation_match:
                    raise PreconditionFailed('fixture generation moved')
                return value

            def upload_from_string(self, raw, *, if_generation_match, **kwargs):
                with bucket.lock:
                    current = bucket.values.get(path, (0, None))[0]
                    if current != if_generation_match:
                        raise PreconditionFailed('fixture CAS collision')
                    bucket.serial += 1
                    bucket.values[path] = (bucket.serial, raw.encode())
        return Blob()

    def state(self, day):
        from services.active8_daily_dispatch_guard import _replay_path
        return json.loads(self.values[_replay_path(day)][1])


class ListPage:
    """One ListExecutions response as the GAPIC pager exposes it: `executions` and
    `next_page_token` are this page only; iterating fetches the rest (as the pager does)."""
    def __init__(self, items, request):
        start = int(getattr(request, 'page_token', '') or 0)
        size = int(getattr(request, 'page_size', 0) or 0) or max(len(items), 1)
        self._rest, self.executions = items[start:], items[start:start + size]
        self.next_page_token = str(start + size) if start + size < len(items) else ''

    def __iter__(self):
        return iter(self._rest)


def replay_provider(executions=(), *, rendezvous=None, busy=False, run_error=None, template=None):
    """The real CloudRunJobsClient against a provider whose list and RunJob are separate,
    non-atomic calls (as in Cloud Run): r10 probe_toctou."""
    import threading
    import time as time_module
    from types import SimpleNamespace as NS
    from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError, JobExecution
    PARENT = 'projects/p/locations/r/jobs/active8-oof-materialize'
    lock = threading.Lock()

    class Provider:
        def __init__(self):
            self.executions, self.run_calls, self.max_running, self.list_calls = list(executions), [], 0, []

        @staticmethod
        def execution(name, env, *, running=False, created=None):
            return NS(name=f'{PARENT}/executions/{name}', conditions=[],
                      completion_time=None if running else datetime.now(timezone.utc),
                      template=NS(containers=[NS(env=[NS(name=k, value=v) for k, v in env.items()])]),
                      create_time=created or datetime.now(timezone.utc))

        def list_executions(self, request=None, **kwargs):
            with lock:
                self.list_calls.append(kwargs.get('timeout'))
                return ListPage(list(self.executions), request)

        def get_execution(self, request=None, **kwargs):
            with lock:
                return next(e for e in self.executions if e.name == request.name)

        def get_job(self, request=None, **kwargs):
            assert request.name == PARENT and kwargs['retry'] is None and 0 < kwargs['timeout'] <= 8
            return NS(template=NS(template=template if template is not None else task_template()))

        def run_job(self, request=None, **kwargs):
            env = {e.name: e.value for e in request.overrides.container_overrides[0].env}
            self.run_calls.append(env)
            if run_error is not None:
                raise run_error
            time_module.sleep(0.05)                 # RPC latency
            with lock:
                item = self.execution(f'opb-{len(self.executions) + 1}', env, running=True)
                self.executions.insert(0, item)
                self.max_running = max(self.max_running, sum(1 for e in self.executions if e.completion_time is None))
            return NS(metadata=NS(name=item.name))

        def finish_all(self):
            with lock:
                for e in self.executions:
                    e.completion_time = e.completion_time or datetime.now(timezone.utc)

        def started(self, day):
            from services import l4_opb_replay_dispatch as dispatch
            return sum(1 for e in self.executions
                       if {v.name: v.value for v in e.template.containers[0].env}.get(dispatch.JOB_DATE_ENV) == day)

    provider = Provider()

    class Client(CloudRunJobsClient):
        def __init__(self):
            super().__init__(project_id='p', region='r', job_name='active8-oof-materialize')
            self._executions_client, self._client = provider, provider

        def get_active_execution(self, *, deadline=None):
            if rendezvous is not None:
                rendezvous.wait()                   # the probe's spot: both past the check
            if busy:
                return JobExecution(f'{PARENT}/executions/oof-1', 'oof-1')
            return super().get_active_execution(deadline=deadline)
    return provider, Client


def test_dispatch_only_starts_a_job_execution_that_the_daily_guard_ignores():
    from services import l4_opb_replay_dispatch as dispatch
    from services import active8_daily_dispatch_guard as guard
    provider, Client = replay_provider()
    v3, bucket = {'l4Distribution': LIVE}, ReplayBucket()
    out = dispatch.dispatch_independent_replay('2026-11-19', jobs=Client(), config=v3, bucket=bucket)
    assert out == {'status': 'spawned', 'business_date': '2026-11-19', 'execution_id': 'opb-1'}
    env, = provider.run_calls
    assert env['OOF_MATERIALIZE_MODE'] == 'opb_arm_replay' and env[dispatch.JOB_DATE_ENV] == '2026-11-19'
    # active8_daily_dispatch_guard matches executions on CADENCE == 'daily' AND END_DATE == day only.
    assert env['OOF_MATERIALIZE_CADENCE'] != 'daily' and 'OOF_MATERIALIZE_END_DATE' not in env
    assert env[guard.REPLAY_CLAIM_ENV] == bucket.state('2026-11-19')['claim_id']
    assert 'OOF_MATERIALIZE_DISPATCH_CLAIM_ID' not in env          # never matched by the daily fence
    assert bucket.state('2026-11-19')['status'] == 'dispatched' and bucket.state('2026-11-19')['started'] == 1
    # Another execution of the job runs (the OOF daily): refused, and the sequence is returned.
    other, OtherClient = replay_provider(busy=True)
    busy_bucket = ReplayBucket()
    assert dispatch.dispatch_independent_replay('2026-11-19', jobs=OtherClient(), config=v3, bucket=busy_bucket) == \
        {'status': 'busy', 'business_date': '2026-11-19', 'active_execution': 'oof-1'}
    assert other.run_calls == [] and busy_bucket.state('2026-11-19')['started'] == 0
    assert guard.REPLAY_CADENCE == dispatch.JOB_CADENCE and guard.REPLAY_DATE_ENV == dispatch.JOB_DATE_ENV
    # The fence lives next to the daily one (same bucket and prefix), as its own object.
    assert guard._replay_path('2026-11-19').startswith('operations/active8-daily-dispatch/v1/2026-11-19/')
    assert guard._replay_path('2026-11-19') != 'operations/active8-daily-dispatch/v1/2026-11-19/state.json'


def test_two_concurrent_entries_never_start_more_than_the_cap_nor_two_at_once():
    """r10 TOCTOU: the provider's list and RunJob are separate; both entries pass the GCS
    read and the active check before either starts. The generation claim lets one start
    and answers the other busy. Eight rounds: at most 4 started, never 2 running."""
    from concurrent.futures import ThreadPoolExecutor
    from services import l4_opb_replay_dispatch as dispatch
    v3, day, bucket = {'l4Distribution': LIVE}, '2026-11-27', ReplayBucket()
    provider, Client = replay_provider()
    statuses = []
    with ThreadPoolExecutor(2) as pool:
        for _ in range(8):
            bucket.rendezvous = Rendezvous()
            statuses.append(sorted(f.result()['status'] for f in [
                pool.submit(dispatch.dispatch_independent_replay, day, jobs=Client(), config=v3, bucket=bucket)
                for _ in range(2)]))
            provider.finish_all()                    # the execution died without a receipt
    assert provider.started(day) == dispatch.MAX_EXECUTIONS_PER_BUSINESS_DATE and provider.max_running == 1
    assert statuses[:4] == [['busy', 'spawned']] * 4 and statuses[4:] == [['capped', 'capped']] * 4, statuses


def test_the_probe_toctou_case_starts_one_not_two():
    """r10 probe_toctou: 3 executions already exist (none running), no fence yet, two
    entries arrive together and both pass get_active_execution before RunJob."""
    from concurrent.futures import ThreadPoolExecutor
    from services import l4_opb_replay_dispatch as dispatch
    day = '2026-11-27'
    replay_env = {'OOF_MATERIALIZE_CADENCE': dispatch.JOB_CADENCE, dispatch.JOB_DATE_ENV: day}
    provider, Client = replay_provider(rendezvous=Rendezvous())
    provider.executions = [provider.execution(f'old{n}', replay_env) for n in range(3)]
    bucket = ReplayBucket()
    bucket.rendezvous = Rendezvous()             # both read the same (missing) fence first
    with ThreadPoolExecutor(2) as pool:
        answers = sorted(f.result()['status'] for f in [pool.submit(
            dispatch.dispatch_independent_replay, day, jobs=Client(), config={'l4Distribution': LIVE}, bucket=bucket)
            for _ in range(2)])
    assert answers == ['busy', 'spawned'] and provider.started(day) == 4 and provider.max_running == 1


def test_the_cap_waits_for_the_last_execution_and_claims_fail_closed(monkeypatch):
    """(3) four started with the last still running: busy, not capped, until it ended.
    Unreadable list, missing bucket, a short deadline: nothing started."""
    from datetime import timedelta
    from services import l4_opb_replay_dispatch as dispatch
    from services import active8_daily_dispatch_guard as guard
    v3, day = {'l4Distribution': LIVE}, '2026-11-19'
    replay_env = lambda d: {'OOF_MATERIALIZE_CADENCE': dispatch.JOB_CADENCE, dispatch.JOB_DATE_ENV: d}
    provider, Client = replay_provider()
    old = datetime(2026, 11, 18, 15, 0, tzinfo=timezone.utc)          # 23:00 TW on 11/18: before the day
    provider.executions = [
        provider.execution('daily-1', {'OOF_MATERIALIZE_CADENCE': 'daily', 'OOF_MATERIALIZE_END_DATE': day}),
        provider.execution('other-night', replay_env('2026-11-20')),
        *[provider.execution(f'done-{n}', replay_env(day)) for n in range(3)],
        provider.execution('too-old', replay_env(day), created=old)]
    bucket = ReplayBucket()
    run = lambda **kw: dispatch.dispatch_independent_replay(day, jobs=Client(), config=v3, bucket=bucket, **kw)
    assert run()['status'] == 'spawned' and bucket.state(day)['started'] == 4
    for _ in range(3):                                               # the 4th still runs
        assert run() == {'status': 'busy', 'business_date': day, 'active_execution': 'opb-7'}
    provider.finish_all()
    assert run() == {'status': 'capped', 'business_date': day, 'executions': dispatch.MAX_EXECUTIONS_PER_BUSINESS_DATE}
    assert len(provider.run_calls) == 1
    # A RunJob error keeps the claim (it may have started one): busy until it expires,
    # then the next sequence number; the lost one stays counted.
    failing, FailingClient = replay_provider(run_error=RuntimeError('rpc reset'))
    fresh = ReplayBucket()
    out = dispatch.dispatch_independent_replay(day, jobs=FailingClient(), config=v3, bucket=fresh)
    assert out == {'status': 'dispatch_failed', 'business_date': day, 'reason': 'execution_dispatch_failed:RuntimeError'}
    assert fresh.state(day)['status'] == 'dispatching' and fresh.state(day)['started'] == 1
    assert dispatch.dispatch_independent_replay(day, jobs=FailingClient(), config=v3, bucket=fresh)['status'] == 'busy'
    later = datetime.now(timezone.utc) + timedelta(seconds=guard.REPLAY_CLAIM_STALE_SECONDS + 1)
    guard_clock = guard._utcnow
    monkeypatch.setattr(guard, '_utcnow', lambda: later)
    dispatch.dispatch_independent_replay(day, jobs=FailingClient(), config=v3, bucket=fresh)
    assert fresh.state(day)['started'] == 2 and len(failing.run_calls) == 2
    monkeypatch.setattr(guard, '_utcnow', guard_clock)        # keeps the replay_dispatch_clock patch
    # Fail closed: nothing claimed, nothing started.
    from services.active8_daily_dispatch_guard import DailyDispatchBlocked

    class Broken:
        def list_executions(self, *a, **k):
            raise RuntimeError('provider down')
    for error_client, expected in ((None, 'DailyDispatchBlocked'), (Broken(), 'RuntimeError')):
        blind, BlindClient = replay_provider()
        client = BlindClient()
        if error_client is not None:
            client._executions_client = error_client
        target = None if error_client is None else ReplayBucket()
        out = dispatch.dispatch_independent_replay(day, jobs=client, config=v3, bucket=target)
        assert out == {'status': 'dispatch_failed', 'business_date': day,
                       'reason': f'execution_dispatch_failed:{expected}'} and blind.run_calls == []
    crowded, CrowdedClient = replay_provider()
    crowded.executions = [crowded.execution(f'x-{n}', replay_env('2026-11-20')) for n in range(301)]
    out = dispatch.dispatch_independent_replay(day, jobs=CrowdedClient(), config=v3, bucket=ReplayBucket())
    assert out['reason'] == 'execution_dispatch_failed:DailyDispatchBlocked' and crowded.run_calls == []
    import time
    short, ShortClient = replay_provider()
    short_bucket = ReplayBucket()
    out = dispatch.dispatch_independent_replay(day, jobs=ShortClient(), config=v3, bucket=short_bucket,
                                               deadline=time.monotonic() + guard.REPLAY_MIN_RUN_JOB_SECONDS - 1)
    assert out['reason'] == 'execution_dispatch_failed:TimeoutError' and short.run_calls == []
    assert short_bucket.state(day)['started'] == 0, 'the deadline is checked before the claim'
    assert DailyDispatchBlocked


def test_one_deadline_from_the_route_covers_config_claim_list_and_run_job(monkeypatch):
    """(2) The route starts one budget; a slow config read ends the dispatch inside it."""
    import time
    from pathlib import Path
    from services import l4_opb_replay_dispatch as dispatch
    assert dispatch.TOTAL_DEADLINE_SECONDS + 5 <= 45                 # Worker OPB_REPLAY_DISPATCH_TIMEOUT_MS
    assert dispatch.CONFIG_DEADLINE_SECONDS < dispatch.TOTAL_DEADLINE_SECONDS
    route = Path(__file__).resolve().parents[1].joinpath('routers', 'l4_distribution.py').read_text()
    handler = route[route.index("'/opb-arm-replay'"):]
    assert 'deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS' in handler and 'deadline=deadline' in handler
    timeouts = []
    monkeypatch.setattr(dispatch, '_load_config', lambda timeout=10.0: timeouts.append(timeout) or time.sleep(2))
    started = time.monotonic()
    out = dispatch.dispatch_independent_replay('2026-11-19', jobs=object(), bucket=object(),
                                               deadline=time.monotonic() + 0.5)
    assert out == {'status': 'dispatch_failed', 'business_date': '2026-11-19', 'reason': 'config_load_failed:TimeoutError'}
    assert time.monotonic() - started < 1.5 and 0 < timeouts[0] <= 0.5
    # The remaining time reaches RunJob (never the fixed 25 s of the old path).
    seen = {}
    provider, Client = replay_provider()

    class Timed(Client):
        def run_job(self, env_overrides=None, *, reject_if_running=True, deadline_seconds=None, **kw):
            seen['deadline'] = deadline_seconds
            return super().run_job(env_overrides, reject_if_running=reject_if_running, deadline_seconds=deadline_seconds)
    dispatch.dispatch_independent_replay('2026-11-19', jobs=Timed(), config={'l4Distribution': LIVE},
                                         bucket=ReplayBucket(), deadline=time.monotonic() + 9)
    assert 5 <= seen['deadline'] < 9


TW = timezone(timedelta(hours=8))


def scheduler_job(job_id):
    from services import l4_opb_replay_dispatch as dispatch
    job, = (j for j in dispatch._scheduler_manifest()['jobs'] if j['id'] == job_id)
    return job


def oof_daily_ticks(day):
    """Every fire time of the active8-oof-daily task in the night ending on TW date `day`."""
    from services import l4_opb_replay_dispatch as dispatch
    manifest = dispatch._scheduler_manifest()
    start = datetime(day.year, day.month, day.day, tzinfo=TW) - timedelta(hours=6)
    end = start + timedelta(hours=24)
    return sorted(t for job in manifest['jobs'] if job.get('task') == dispatch.OOF_DAILY_TASK
                  and job.get('desiredState') != 'PAUSED' for t in dispatch.fire_times(job, manifest, start, end))


def premarket_watchdog_ticks(day):
    """premarket-evidence-watchdog fire times on TW date `day` (the publication callback that
    resumes a parked OOF ticket can come from any of them)."""
    from services import l4_opb_replay_dispatch as dispatch
    start = datetime(day.year, day.month, day.day, tzinfo=TW)
    return dispatch.fire_times(scheduler_job('premarket-evidence-watchdog'), dispatch._scheduler_manifest(),
                               start, start + timedelta(days=1))


def ask_replay(at, day='2026-11-27', **provider_kw):
    from services import l4_opb_replay_dispatch as dispatch
    provider, Client = replay_provider(**provider_kw)
    bucket = ReplayBucket()
    out = dispatch.dispatch_independent_replay(day, jobs=Client(), config={'l4Distribution': LIVE},
                                               bucket=bucket, now=at)
    return out, provider, bucket


def test_no_replay_starts_once_tonights_window_closed_until_the_next_oof_daily_main_tick():
    """Round 13: the window of a night opens at the OOF daily main tick and, once closed, stays
    closed until the next main tick: a 07:55 tick delivered at 07:55:05 and every premarket
    watchdog tick (TW 07:00-08:50, which resumes a parked OOF ticket once, with no retry)
    start nothing."""
    from datetime import date
    from services import l4_opb_replay_dispatch as dispatch
    day = '2026-11-27'
    ticks = oof_daily_ticks(date(2026, 11, 28))
    # Derived from the manifest (not a literal in the controller): 01:55 main, watchdog to 07:55.
    assert ticks[0] == datetime(2026, 11, 28, 1, 55, tzinfo=TW) and ticks[-1] == datetime(2026, 11, 28, 7, 55, tzinfo=TW)
    assert len(ticks) == 13 and dispatch.replay_window(ticks[3]) == (ticks[0], ticks[-1])
    interval = (ticks[-1] - ticks[-2]).total_seconds()
    assert 0 < dispatch.REPLAY_WINDOW_MARGIN_SECONDS < interval
    run = oof_job_task_timeout() * (oof_job_max_retries() + 1)

    # 06:25 (a few seconds of delivery after the tick): started; it ends by 07:25 at the latest.
    out, provider, _ = ask_replay(datetime(2026, 11, 28, 6, 25, 5, tzinfo=TW))
    assert out['status'] == 'spawned' and len(provider.run_calls) == 1
    weekday = date(2026, 11, 27)                                  # a Friday: the premarket watchdog fires
    premarket = premarket_watchdog_ticks(weekday)
    assert premarket[0] == datetime(2026, 11, 27, 7, 0, tzinfo=TW) and premarket[-1] == datetime(2026, 11, 27, 8, 50, tzinfo=TW)
    closed = [datetime(2026, 11, 28, 6, 55, tzinfo=TW), datetime(2026, 11, 28, 6, 56, tzinfo=TW),
              datetime(2026, 11, 28, 7, 25, 5, tzinfo=TW), datetime(2026, 11, 28, 7, 55, tzinfo=TW),
              datetime(2026, 11, 28, 7, 55, 5, tzinfo=TW), datetime(2026, 11, 28, 8, 30, tzinfo=TW),
              datetime(2026, 11, 28, 8, 50, tzinfo=TW), datetime(2026, 11, 28, 15, 0, tzinfo=TW),
              datetime(2026, 11, 29, 1, 54, 59, tzinfo=TW)]
    attempt = int(scheduler_job('premarket-evidence-watchdog')['attemptDeadline'].rstrip('s'))
    closed += [t + timedelta(seconds=s) for t in premarket for s in (0, 5, attempt)]
    for at in closed:
        out, provider, bucket = ask_replay(at)
        assert out == {'status': 'skipped', 'business_date': day, 'reason': 'outside_window',
                       'job_running': False, 'active_execution': None}, at
        assert provider.run_calls == [] and bucket.values == {}
    # The rule is `now + (max_retries + 1) x timeout > last tick - margin` with the job's own values.
    edge = ticks[-1] - timedelta(seconds=dispatch.REPLAY_WINDOW_MARGIN_SECONDS + run)
    assert not dispatch.outside_window(edge, run) and dispatch.outside_window(edge + timedelta(seconds=1), run)
    # The next night's main tick reopens it (one per night, so weekend nights still replay).
    assert ask_replay(datetime(2026, 11, 29, 1, 55, 5, tzinfo=TW))[0]['status'] == 'spawned'
    assert ask_replay(datetime(2026, 11, 30, 1, 55, 5, tzinfo=TW))[0]['status'] == 'spawned'

    # Fail closed: unreadable job, no main schedule, or a naive clock starts nothing.
    provider, Client = replay_provider()

    class NoJob(Client):
        def _get_client(self):
            raise RuntimeError('jobs api down')
    out = dispatch.dispatch_independent_replay(day, jobs=NoJob(), config={'l4Distribution': LIVE},
                                               bucket=ReplayBucket(), now=datetime(2026, 11, 28, 2, 0, tzinfo=TW))
    assert out == {'status': 'dispatch_failed', 'business_date': day, 'reason': 'window_check_failed:RuntimeError'}
    assert provider.run_calls == []
    watchdog_only = {'timeZone': 'UTC', 'jobs': [{'id': 'w', 'task': 'active8-oof-daily', 'schedule': '25,55 18-23 * * *'}]}
    for manifest in (watchdog_only, {'timeZone': 'UTC', 'jobs': []}):
        with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):
            dispatch.replay_window(datetime(2026, 11, 28, 2, 0, tzinfo=TW), manifest)
    with pytest.raises(ValueError, match='replay_window_naive_now'):
        dispatch.replay_window(datetime(2026, 11, 28, 2, 0))


def test_cron_steps_expand_and_a_night_crossing_midnight_orders_by_instant():
    """Round 13 P3-2: `a/n` is a, a+n, ... (not a), and the last tick is the latest instant,
    not the largest hour value."""
    from services import l4_opb_replay_dispatch as dispatch
    assert sorted(dispatch._cron_values('5/15', 0, 59)) == [5, 20, 35, 50]
    assert sorted(dispatch._cron_values('*/10', 0, 59)) == [0, 10, 20, 30, 40, 50]
    assert sorted(dispatch._cron_values('10-30/10', 0, 59)) == [10, 20, 30]
    assert sorted(dispatch._cron_values('18-23', 0, 23)) == [18, 19, 20, 21, 22, 23]
    for bad in ('MON', '5/0', '1-', '60', '*/x', '3-1', '', '?', 'L'):
        with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):
            dispatch._cron_values(bad, 0, 59)
    with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):
        dispatch.fire_times({'schedule': '0 0 * *'}, {'timeZone': 'UTC'}, datetime(2026, 1, 1, tzinfo=timezone.utc),
                            datetime(2026, 1, 2, tzinfo=timezone.utc))
    at = datetime(2026, 11, 28, 2, 0, tzinfo=TW)

    def last(*watchdogs, zone='UTC'):
        jobs = [{'id': 'active8-oof-daily', 'task': 'active8-oof-daily', 'schedule': '55 17 * * *'}]
        jobs += [{'id': f'w{i}', 'task': 'active8-oof-daily', **w} for i, w in enumerate(watchdogs)]
        return dispatch.replay_window(at, {'timeZone': zone, 'jobs': jobs})[1].astimezone(TW)
    # Step: 18:05, 18:20, 18:35, 18:50 UTC -> 02:50 TW (r12 read it as 02:05).
    assert last({'schedule': '5/15 18 * * *'}) == datetime(2026, 11, 28, 2, 50, tzinfo=TW)
    # Crossing UTC midnight: 23:25 and 00:25 UTC -> 08:25 TW is the last (r12 said 07:25).
    assert last({'schedule': '25 23,0 * * *'}) == datetime(2026, 11, 28, 8, 25, tzinfo=TW)
    # Its own zone: 00:10 Asia/Taipei (hour 0) comes before the next 01:55 main tick, so it is
    # this night's last instant, after 04:25 TW (hour 20 UTC).
    assert last({'schedule': '10 0 * * *', 'timeZone': 'Asia/Taipei'}, {'schedule': '25 20 * * *'}) == \
        datetime(2026, 11, 29, 0, 10, tzinfo=TW)
    # Day of week (cron 0/7 = Sunday): 11-27 UTC is a Friday.
    assert last({'schedule': '25 20 * * 5'}) == datetime(2026, 11, 28, 4, 25, tzinfo=TW)
    assert last({'schedule': '25 20 * * 7'}) == datetime(2026, 11, 28, 1, 55, tzinfo=TW)
    assert last({'schedule': '25 20 * * 0-4,6'}) == datetime(2026, 11, 28, 1, 55, tzinfo=TW)
    # Day of month and month (with dow `*`: AND, as in every cron); `*/2` is a restriction too.
    assert last({'schedule': '25 20 27 11 *'}) == datetime(2026, 11, 28, 4, 25, tzinfo=TW)
    assert last({'schedule': '25 20 27 12 *'}) == datetime(2026, 11, 28, 1, 55, tzinfo=TW)
    assert last({'schedule': '25 20 */2 * *'}) == datetime(2026, 11, 28, 4, 25, tzinfo=TW)     # 27 is odd: 1, 3, ...
    assert last({'schedule': '25 20 2-30/2 * *'}) == datetime(2026, 11, 28, 1, 55, tzinfo=TW)
    # Both day fields restricted (Vixie: OR, or AND when one starts with `*`): fail closed, no guess.
    for schedule in ('25 20 1 * 5', '25 20 */2 * 1-5', '25 20 *,1 * 5', '25 20 27 * */1'):
        with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):
            last({'schedule': schedule})
    # dow 7 is Sunday like 0, alone and in a range; 2026-11-29 is a Sunday.
    sunday = datetime(2026, 11, 29, tzinfo=timezone.utc)
    for schedule in ('0 12 * * 7', '0 12 * * 0', '0 12 * * 5-7', '0 12 * * 6,7'):
        fires = dispatch.fire_times({'schedule': schedule}, {'timeZone': 'UTC'}, sunday, sunday + timedelta(days=1))
        assert fires == [sunday.replace(hour=12)], schedule
    assert dispatch.fire_times({'schedule': '0 12 * * 1-6'}, {'timeZone': 'UTC'}, sunday, sunday + timedelta(days=1)) == []
    with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):
        dispatch._cron_values('8', 0, 7)


def test_a_weekday_only_main_opens_no_window_on_the_nights_it_does_not_fire():
    """Round 14 a: the next main tick may be days away (looked up 8 days ahead, not 2), and a
    night without its own main tick has no window: the last tick is within one day of the
    main tick, so a Friday window does not stretch over the weekend."""
    from services import l4_opb_replay_dispatch as dispatch
    # Only the main moves to weekdays (TW Mon-Fri 01:55); the watchdog stays daily (02:25-07:55).
    weekdays = {'timeZone': 'UTC', 'jobs': [
        {'id': 'active8-oof-daily', 'task': 'active8-oof-daily', 'schedule': '55 17 * * 0-4'},
        {'id': 'w', 'task': 'active8-oof-daily', 'schedule': '25,55 18-23 * * *'}]}
    run = oof_job_task_timeout() * (oof_job_max_retries() + 1)

    def window(*at):
        now = datetime(*at, tzinfo=TW)
        opened, last = dispatch.replay_window(now, weekdays)
        return opened.astimezone(TW), last.astimezone(TW), dispatch.outside_window(now, run, weekdays)
    fri = datetime(2026, 11, 27, 1, 55, tzinfo=TW)
    assert window(2026, 11, 27, 2, 0) == (fri, datetime(2026, 11, 27, 7, 55, tzinfo=TW), False)
    for at in ((2026, 11, 28, 2, 0), (2026, 11, 28, 2, 25), (2026, 11, 28, 15, 0), (2026, 11, 29, 2, 0),
               (2026, 11, 29, 5, 25), (2026, 11, 29, 23, 0), (2026, 11, 30, 1, 54, 59)):
        assert window(*at) == (fri, datetime(2026, 11, 27, 7, 55, tzinfo=TW), True), at     # weekend: closed
    assert window(2026, 11, 30, 2, 0) == (datetime(2026, 11, 30, 1, 55, tzinfo=TW),
                                         datetime(2026, 11, 30, 7, 55, tzinfo=TW), False)
    # The same weekend on the real (daily) manifest: every night has its own window.
    for day in (28, 29):
        assert dispatch.replay_window(datetime(2026, 11, day, 2, 0, tzinfo=TW))[1] == datetime(2026, 11, day, 7, 55, tzinfo=TW)
    # A weekly main: the next tick is 7 days away, still found; one beyond 8 days fails closed.
    weekly = {'timeZone': 'UTC', 'jobs': [{'id': 'active8-oof-daily', 'task': 'active8-oof-daily', 'schedule': '55 17 * * 4'}]}
    assert dispatch.replay_window(datetime(2026, 11, 27, 2, 0, tzinfo=TW), weekly)[0] == fri
    yearly = {'timeZone': 'UTC', 'jobs': [{'id': 'active8-oof-daily', 'task': 'active8-oof-daily', 'schedule': '55 17 26 11 *'}]}
    with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):
        dispatch.replay_window(datetime(2026, 11, 27, 2, 0, tzinfo=TW), yearly)
    # The window opens at the main tick itself (`opened <= now`); a second earlier is the previous night.
    main = datetime(2026, 11, 28, 1, 55, tzinfo=TW)
    assert dispatch.replay_window(main)[0] == main and not dispatch.outside_window(main, run)
    assert dispatch.replay_window(main - timedelta(seconds=1))[0] == main - timedelta(days=1)
    assert dispatch.outside_window(main - timedelta(seconds=1), run)


def test_a_closed_window_still_says_whether_the_job_runs():
    """Round 14 d: outside_window answers before the claim, but still reports a running
    execution (read only), so the Worker's busy streak keeps counting a stuck job."""
    from services import l4_opb_replay_dispatch as dispatch
    late = datetime(2026, 11, 28, 7, 0, tzinfo=TW)
    provider, Client = replay_provider()
    # The running execution sits below 150 finished ones: found on the second page.
    provider.executions = ([provider.execution(f'done-{n}', {}) for n in range(150)]
                           + [provider.execution('oof-1', {'OOF_MATERIALIZE_CADENCE': 'daily'}, running=True)])
    bucket = ReplayBucket()
    out = dispatch.dispatch_independent_replay('2026-11-27', jobs=Client(), config={'l4Distribution': LIVE},
                                               bucket=bucket, now=late)
    assert out == {'status': 'skipped', 'business_date': '2026-11-27', 'reason': 'outside_window',
                   'job_running': True, 'active_execution': 'oof-1'}
    assert provider.run_calls == [] and bucket.values == {} and len(provider.list_calls) == 2
    provider, Client = replay_provider()

    class Blind(Client):
        def _get_executions_client(self):
            raise RuntimeError('provider down')
    out = dispatch.dispatch_independent_replay('2026-11-27', jobs=Blind(), config={'l4Distribution': LIVE},
                                               bucket=ReplayBucket(), now=late)
    assert out == {'status': 'skipped', 'business_date': '2026-11-27', 'reason': 'outside_window',
                   'job_running': None, 'active_execution': None} and provider.run_calls == []


def test_the_closed_window_lookup_requests_each_page_with_what_is_left_of_the_deadline(monkeypatch):
    """Round 15: the GAPIC pager would fetch every page with the first call's timeout, so a
    long history could outlast the Worker's 45 s. Each page gets min(8, remaining); a page is
    not requested with less than MIN_PAGE_SECONDS left, and the answer is then job_running None."""
    from services import l4_opb_replay_dispatch as dispatch
    from services import active8_daily_dispatch_guard as guard
    late = datetime(2026, 11, 28, 7, 0, tzinfo=TW)
    clock = [100.0]
    monkeypatch.setattr('time.monotonic', lambda: clock[0])

    def run(step, executions, budget=20.0):
        provider, Client = replay_provider()
        provider.executions = executions(provider)
        listed = provider.list_executions

        def slow(request=None, **kwargs):        # each page takes `step` s (never past its timeout)
            clock[0] += min(step, kwargs['timeout'])
            return listed(request=request, **kwargs)
        provider.list_executions = slow
        clock[0] = 100.0
        deadline = clock[0] + budget              # e.g. what is left after the config read and GetJob
        out = dispatch.dispatch_independent_replay('2026-11-27', jobs=Client(), config={'l4Distribution': LIVE},
                                                   bucket=ReplayBucket(), now=late, deadline=deadline)
        return out, provider, deadline
    finished = lambda provider: [provider.execution(f'done-{n}', {}) for n in range(1000)]
    # Pages that use their whole 8 s: two pages, then 0.5 s left (< MIN_PAGE_SECONDS): no third
    # request, unknown.
    out, provider, deadline = run(8, finished, budget=16.5)
    assert provider.list_calls == [8.0, 8.0] and clock[0] <= deadline
    assert (out['job_running'], out['active_execution']) == (None, None) and provider.run_calls == []
    # Pages of 7 s: the third page only gets what is left (6 s), and the lookup ends by the deadline.
    out, provider, deadline = run(7, finished)
    assert provider.list_calls == [8.0, 8.0, 6.0] and clock[0] <= deadline and out['job_running'] is None
    # Found within the budget: answered without further pages.
    out, provider, _ = run(7, lambda p: finished(p)[:120] + [p.execution('oof-9', {}, running=True)])
    assert provider.list_calls == [8.0, 8.0] and (out['job_running'], out['active_execution']) == (True, 'oof-9')
    # The same per-page budget for the daily guard's scan (its list is the same helper).
    assert guard.MIN_PAGE_SECONDS == 1.0
    provider, Client = replay_provider()
    provider.executions = finished(provider)
    listed = provider.list_executions
    provider.list_executions = lambda request=None, **kw: (clock.__setitem__(0, clock[0] + kw['timeout']),
                                                         listed(request=request, **kw))[1]
    clock[0] = 0.0
    with pytest.raises(TimeoutError):
        list(guard.executions_newest_first(Client(), 16.5, 100))
    assert provider.list_calls == [8.0, 8.0]


def test_the_window_uses_the_deployed_jobs_timeout_and_retries_from_getjob():
    """Round 13 P3-3/P3-5: the longest execution is (max_retries + 1) x task timeout as GetJob
    returns them; an unset or invalid max_retries fails closed. A PAUSED OOF job is not a tick."""
    from services import l4_opb_replay_dispatch as dispatch
    assert oof_job_task_timeout() == 3600 and oof_job_max_retries() == 0

    def status(hm, **template_kw):
        return ask_replay(datetime(2026, 11, 28, *hm, tzinfo=TW), template=task_template(**template_kw))[0]['status']
    # Last tick 07:55 - 25 min margin = 07:30 bound.
    assert status((6, 50), timeout=1800) == 'spawned' and status((6, 50)) == 'skipped'
    assert status((6, 5), timeout=5400) == 'skipped' and status((6, 5)) == 'spawned'
    assert status((6, 0), timeout=5400) == 'spawned'                    # 07:30 is not past the bound
    assert status((5, 40), max_retries=1) == 'skipped' and status((5, 40)) == 'spawned'
    assert status((5, 25), max_retries=1) == 'spawned'
    for bad in (None, -1):                                            # unset -> Cloud Run's default (3)
        out = ask_replay(datetime(2026, 11, 28, 2, 0, tzinfo=TW), template=task_template(max_retries=bad))[0]
        assert out['reason'] == 'window_check_failed:ValueError', bad
    out = ask_replay(datetime(2026, 11, 28, 2, 0, tzinfo=TW), template=task_template(timeout=0))[0]
    assert out['reason'] == 'window_check_failed:ValueError'

    main = {'id': 'active8-oof-daily', 'task': 'active8-oof-daily', 'schedule': '55 17 * * *'}
    late = {'id': 'late', 'task': 'active8-oof-daily', 'schedule': '25 1 * * *'}       # 09:25 TW
    at = datetime(2026, 11, 28, 2, 0, tzinfo=TW)
    assert dispatch.replay_window(at, {'timeZone': 'UTC', 'jobs': [main, late]})[1] == datetime(2026, 11, 28, 9, 25, tzinfo=TW)
    for ignored in ({**late, 'desiredState': 'PAUSED'}, {**late, 'task': 'premarket-evidence-watchdog'}):
        assert dispatch.replay_window(at, {'timeZone': 'UTC', 'jobs': [main, ignored]})[1] == \
            datetime(2026, 11, 28, 1, 55, tzinfo=TW)
    with pytest.raises(ValueError, match='oof_daily_schedule_unsupported'):    # a PAUSED main is no window
        dispatch.replay_window(at, {'timeZone': 'UTC', 'jobs': [{**main, 'desiredState': 'PAUSED'}]})


@pytest.mark.parametrize('premarket', [(6, 30), (7, 0), (7, 20), (7, 50), (8, 40)])
@pytest.mark.parametrize('short_first', [False, True])
def test_a_late_premarket_still_leaves_the_oof_daily_a_free_job(monkeypatch, premarket, short_first):
    """The Worker asks for a replay on every tick until the premarket publication (here also on
    every premarket watchdog tick); every execution may run its full (retries + 1) x timeout.
    Whenever the premarket lands, the job is free at the 07:25 and 07:55 ticks and on every
    premarket watchdog tick, so the OOF daily is dispatched either on a watchdog tick or, after
    07:55, by the publication's continuation (08:40 here) on an empty job."""
    from datetime import date
    from services import l4_opb_replay_dispatch as dispatch
    monkeypatch.setattr(dispatch, 'MAX_EXECUTIONS_PER_BUSINESS_DATE', 50)          # the window, not the cap
    day, latency = '2026-11-27', timedelta(seconds=5)
    run = timedelta(seconds=oof_job_task_timeout() * (oof_job_max_retries() + 1))
    tw_day = date(2026, 11, 30)                                           # Monday: the watchdog fires
    ticks = sorted(oof_daily_ticks(tw_day) + premarket_watchdog_ticks(tw_day))
    published = datetime(2026, 11, 30, *premarket, tzinfo=TW)
    provider, Client = replay_provider()
    bucket, ends, spawned, free = ReplayBucket(), {}, [], {}

    def settle(at):
        for execution in provider.executions:
            if execution.completion_time is None and ends[execution.name] <= at:
                execution.completion_time = ends[execution.name]
    for tick in ticks:
        at = tick + latency
        settle(at)
        if at < published:
            out = dispatch.dispatch_independent_replay(day, jobs=Client(), config={'l4Distribution': LIVE},
                                                       bucket=bucket, now=at)
            if out['status'] == 'spawned':
                name = provider.executions[0].name
                # Optionally the night's earlier runs finish in minutes and only the last one hangs.
                ends[name] = at + (timedelta(minutes=10) if short_first and tick.astimezone(TW).hour < 6 else run)
                spawned.append(tick.astimezone(TW).strftime('%H:%M'))
        free[tick.astimezone(TW).strftime('%H:%M')] = Client().get_active_execution() is None
    assert free['07:25'] and free['07:55'], (spawned, free)
    # From 07:25 on (the watchdog's last two ticks, every premarket tick that may resume a
    # parked ticket) the job is empty; earlier a busy answer is retried by those ticks.
    assert all(free[t.astimezone(TW).strftime('%H:%M')] for t in ticks
               if t >= datetime(2026, 11, 30, 7, 25, tzinfo=TW)), free
    assert all(ends[n] <= datetime(2026, 11, 30, 7, 25, 5, tzinfo=TW) for n in ends), spawned
    assert not any(t in spawned for t in ('06:55', '07:00', '07:25', '07:55', '08:00', '08:30', '08:50')), spawned
    if short_first:
        assert '06:25' in spawned or published <= datetime(2026, 11, 30, 6, 25, 5, tzinfo=TW), spawned
    # The publication's continuation dispatches the OOF daily (same job, reject_if_running) at
    # `published`, past the last watchdog tick when it is 08:40: the job is empty then.
    if published > ticks[-1] - timedelta(hours=1):                        # no watchdog tick left
        settle(published)
        assert Client().get_active_execution() is None, (published, spawned)
    for execution in provider.executions:
        execution.completion_time = execution.completion_time or ends[execution.name]
    oof = Client().run_job({'OOF_MATERIALIZE_CADENCE': 'daily', 'OOF_MATERIALIZE_END_DATE': day})
    assert oof.execution_id


def test_job_mode_runs_the_replay_without_a_worker_callback(monkeypatch):
    import asyncio
    import oof_materialize_job_main as job
    from services import l4_opb_replay_dispatch as dispatch
    seen, callbacks = [], []
    monkeypatch.setenv('OOF_MATERIALIZE_MODE', 'opb_arm_replay')
    monkeypatch.setenv('OOF_MATERIALIZE_CADENCE', 'opb_arm_replay')
    monkeypatch.setenv(dispatch.JOB_DATE_ENV, '2026-11-19')
    monkeypatch.setenv('CLOUD_RUN_EXECUTION', 'opb-1')
    for name in ('OOF_MATERIALIZE_SCHEDULER_TICKET_ID', 'OOF_MATERIALIZE_SCHEDULER_RUN_ID', 'OOF_MATERIALIZE_END_DATE'):
        monkeypatch.delenv(name, raising=False)
    outcome = {'status': 'ok', 'failed_dates': [], 'deferred_dates': [], 'rejected_dates': ['2026-11-12']}
    monkeypatch.setattr(dispatch, 'independent_replay', lambda day, *, execution_id:
                        seen.append((day, execution_id)) or dict(outcome))

    async def callback(payload):
        callbacks.append(payload)
    monkeypatch.setattr(job, '_callback_worker', callback)
    assert asyncio.run(job._run()) == 0
    assert seen == [('2026-11-19', 'opb-1')] and callbacks == []
    assert job._summary('r', outcome, mode='opb_arm_replay').endswith('rejected=1 progress=0 attention=opb_replay_rejected:1')
    outcome['status'] = 'failed'
    assert asyncio.run(job._run()) == 1, 'a failed replay fails the execution (its receipt is still written)'
    # The nightly OOF summary surfaces rejections the same way.
    assert job._opb_attention({'rejected_dates': ['a', 'b']}) == 'attention=opb_replay_rejected:2'
    assert job._opb_attention({'rejected_dates': []}) == '' and job._opb_attention(None) == ''


def test_plan_records_the_digest_the_replay_recomputes_from_the_snapshot():
    import json
    from services.l4_distribution_runtime import distribution_policy_identity, run
    from test_l4_opb_v2 import v2_fixture
    recs, value, history = v2_fixture()
    value['opb'] = deepcopy(OPB)
    value['opb']['approved_policy_identity'] = distribution_policy_identity(value, value['runtime']['l3_identity'])
    plan = run(deepcopy(recs), deepcopy(value), return_history=deepcopy(history))[0]['_l4_portfolio_plan']
    # The allocation snapshot stores the same inputs JSON round-tripped (paired_nav_collection).
    snapshot = json.loads(json.dumps({'recommendations': recs, 'policy': value, 'history': history}))
    assert plan['opb']['decision_inputs_digest'] == decision_inputs_digest(
        snapshot['recommendations'], snapshot['policy'], snapshot['history'], None)
    forced = run(deepcopy(recs), deepcopy(value), return_history=history, forced_arm='risk_tilt')[0]['_l4_portfolio_plan']
    assert 'decision_inputs_digest' not in forced['opb'], 'a counterfactual replay records no decision'


def test_real_capture_snapshot_reproduces_the_plan_digest():
    """End to end through the formal capture: the frozen snapshot the replay reads hashes to the plan's digest."""
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.paired_nav_collection import run_and_capture_allocation
    from services.paired_nav_journal import read_snapshot
    from test_l4_opb_v2 import v2_fixture
    from test_paired_nav_journal import DB
    recs, value, history = v2_fixture()
    value['opb'] = deepcopy(OPB)
    value['opb']['approved_policy_identity'] = distribution_policy_identity(value, value['runtime']['l3_identity'])
    db = DB()
    output, collected = run_and_capture_allocation(recommendations=deepcopy(recs), ranking_config={'enabled': True},
        ensemble_v2_cfg={}, regime_label='bull', regime_surface={}, alpha_policy={'l4Distribution': value},
        return_history=history, opb_reward_ledger=[], trading_config={'l4Distribution': value}, risk_config=None,
        signal_date=value['runtime']['signal_date'], source_run_id='test-opb-v3', query=db.query, writer=db.writer)
    plan = output[0]['_l4_portfolio_plan']
    inputs = read_snapshot(db.query, collected['snapshot_id'])['payload']['content']['inputs']
    assert plan['opb']['decision_inputs_digest'] == decision_inputs_digest(
        inputs['recommendations'], inputs['alpha_policy']['l4Distribution'], inputs['return_history'],
        inputs['opb_reward_ledger'])


def test_controller_route_only_starts_the_independent_replay_job(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import l4_distribution as routes
    from services import l4_opb_replay_dispatch as dispatch_module
    import time
    calls = []
    monkeypatch.setattr('services.l4_opb_replay_dispatch.dispatch_independent_replay',
                        lambda day, *, deadline: calls.append((day, deadline - time.monotonic()))
                        or {'status': 'spawned', 'business_date': day})
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    assert client.post('/l4_distribution/opb-arm-replay', json={'business_date': '2026-11-19'}).json() == \
        {'status': 'spawned', 'business_date': '2026-11-19'}
    assert client.post('/l4_distribution/opb-arm-replay', json={'business_date': '11/19'}).status_code == 422
    (day, left), = calls
    assert day == '2026-11-19' and 0 < left <= dispatch_module.TOTAL_DEADLINE_SECONDS   # one budget from the route


class CountingPaper(Paper):
    def __init__(self, plan, created_at='2026-10-02T00:40:00Z'):
        super().__init__(plan)
        self.created_at, self.reads = created_at, 0

    def query(self, sql, params):
        self.reads += 1
        if self.plan is None:
            return []
        return [{**super().query(sql, params)[0], 'created_at': self.created_at}]


def _snapshot_reads(monkeypatch, state, frozen_at='2026-10-02T00:30:00Z'):
    reads = []

    def read(query, snapshot_id):
        reads.append(snapshot_id)
        return {'manifest': {'frozen_at': frozen_at}, 'payload': {'content': deepcopy(state['content'])}}
    monkeypatch.setattr('services.paired_nav_journal.read_snapshot', read)
    return reads


@pytest.mark.parametrize('reason', ['no_formal_plan', 'l3_identity_changed', 'context_frozen_after_entry',
                                    'risk_lookback_changed', 'empty_pool'])
def test_terminal_not_applicable_day_is_judged_once_then_skipped_on_one_read(world, monkeypatch, reason):
    state, stored = world
    seal(stored)
    frozen_at = '2026-10-02T01:30:00Z' if reason == 'context_frozen_after_entry' else '2026-10-02T00:30:00Z'
    reads = _snapshot_reads(monkeypatch, state, frozen_at)
    if reason == 'l3_identity_changed':
        stored['l3_identity'] = {'source': 'old'}
    if reason == 'risk_lookback_changed':
        state['content']['inputs']['return_history'] = {'lookback': 126}
    if reason == 'empty_pool':
        state['content']['inputs']['recommendations'] = []
    paper, learning, runs = CountingPaper(None if reason == 'no_formal_plan' else stored), Learning(), Runs()
    status = 'no_formal_plan' if reason == 'no_formal_plan' else 'not_applicable'

    def night(business_date):
        return replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date=business_date,
                                    paper=paper, learning=learning, market=Market(), run=runs)
    assert night('2026-10-06') == {'status': status, 'reason': reason, 'verdict': 'recorded'}
    first_reads = len(reads)
    assert first_reads == (1 if reason in ('context_frozen_after_entry', 'risk_lookback_changed', 'empty_pool') else 0)
    verdict = learning.verdicts[next(iter(learning.verdicts))]
    assert verdict['schema_version'] == replay.VERDICT_SCHEMA and verdict['status'] == status
    # Every later night (all three owners) costs one primary-key read: no plan payload, no snapshot.
    for business_date in ('2026-10-07', '2026-10-08', '2026-10-09'):
        assert night(business_date) == {'status': status, 'reason': reason, 'verdict': 'cached'}
    assert len(reads) == first_reads and paper.reads == 1 and not runs.calls and not learning.rows
    # Warm start replays the day under other inputs: a live verdict never binds it (judged afresh, not booked).
    if reason != 'l3_identity_changed':
        warm = replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
                                    paper=paper, learning=learning, market=Market(), run=runs,
                                    row_kind=ROW_CUTOVER_WARM_START, score_source='fold_oof',
                                    frozen_override=lambda runtime, recommendations: (runtime, recommendations))
        assert warm == {'status': status, 'reason': reason} and len(learning.verdicts) == 1


def test_freshly_judged_days_spend_the_budget_and_cached_ones_do_not(world, monkeypatch):
    state, stored = world
    seal(stored)
    state['content']['inputs']['recommendations'] = []          # every day: empty_pool
    reads = []

    class DayPlans(Plans):
        def query(self, sql, params):
            if sql.startswith('SELECT DISTINCT signal_date'):
                return super().query(sql, params)
            return [{'plan_id': 'formal-' + params[0], 'allocation_snapshot_id': 'snap-' + params[0],
                     'created_at': params[0] + 'T00:40:00Z', 'payload_json': json.dumps(self.stored)}]

    def read(query, snapshot_id):
        reads.append(snapshot_id)
        content = deepcopy(state['content'])
        content['inputs']['alpha_policy']['l4Distribution']['runtime']['signal_date'] = snapshot_id[5:]
        return {'manifest': {'frozen_at': '2026-09-01T00:00:00Z'}, 'payload': {'content': content}}
    monkeypatch.setattr('services.paired_nav_journal.read_snapshot', read)
    days = ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
    learning = Learning()
    clients = {'paper': DayPlans(days, stored), 'learning': learning, 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}
    first = replay.attach_daily_replay(config, '2026-10-09', clients=clients, budget=2)
    assert len(reads) == 2 and len(first['deferred_dates']) == 4, 'a night re-reads at most `budget` snapshots'
    second = replay.attach_daily_replay(config, '2026-10-09', clients=clients, budget=2)
    assert len(reads) == 4 and len(second['deferred_dates']) == 2
    replay.attach_daily_replay(config, '2026-10-09', clients=clients, budget=2)
    assert len(reads) == 6 and len(learning.verdicts) == 6
    settled = replay.attach_daily_replay(config, '2026-10-09', clients=clients, budget=2)
    assert len(reads) == 6, 'judged days are never re-read'
    assert settled['status'] == 'ok' and not settled['deferred_dates']
    assert {r['verdict'] for r in settled['dates'].values()} == {'cached'}


def test_input_digest_mismatch_is_a_terminal_rejection(world, monkeypatch):
    state, stored = world
    seal(stored)
    state['content']['inputs']['recommendations'].append({'symbol': 'C'})   # snapshot != what the plan decided on
    reads = _snapshot_reads(monkeypatch, state)
    learning, runs = Learning(), Runs()
    clients = {'paper': Plans(['2026-10-01'], stored), 'learning': learning, 'market': Market()}
    monkeypatch.setattr('services.l4_distribution_runtime.run', runs)
    config = {'l4Distribution': deepcopy(LIVE)}
    out = replay.attach_daily_replay(config, '2026-10-06', clients=clients)
    # Observable (rejected_dates, verdict row with both digests), not a failure the watchdog retries.
    assert out['status'] == 'ok' and out['failed_dates'] == [] and out['rejected_dates'] == ['2026-10-01']
    assert out['dates']['2026-10-01'] == {'status': 'rejected', 'reason': 'input_digest_mismatch', 'verdict': 'recorded'}
    verdict = next(iter(learning.verdicts.values()))
    detail = json.loads(verdict['detail_json'])
    assert verdict['status'] == 'rejected' and detail['recorded'] == stored['opb']['decision_inputs_digest']
    assert detail['recomputed'] != detail['recorded'] and verdict['snapshot_id'] == 'snap-1'
    assert not learning.rows and not runs.calls
    for tick in range(12):
        again = replay.attach_daily_replay(config, '2026-10-06', clients=clients)
        assert again['status'] == 'ok' and again['rejected_dates'] == ['2026-10-01']
    assert len(reads) == 1, 'judged once; ticks and later nights do not re-read the snapshot'
    # The one-off warm start still fails closed on its own day.
    with pytest.raises(ValueError, match='input_digest_mismatch'):
        book(stored, Learning(), Runs(), '2026-10-09', sealed=False, row_kind=ROW_CUTOVER_WARM_START,
             frozen_override=lambda runtime, recommendations: (runtime, recommendations))


def test_each_arm_keeps_its_own_verdict_across_later_sessions(world):
    _, stored = world
    learning, runs = Learning(), Runs()
    assert book(stored, learning, runs, '2026-10-06')['consistency'] == 'verified'
    # An arm added mid-hold: the policy changed since the plan, so only its inputs verify.
    live = deepcopy(LIVE)
    live['opb']['arms'].append({'id': 'ridge', 'l2_penalty': .02})
    WEIGHTS['ridge'] = {'A': .1, 'B': .1}
    try:
        added = book(stored, learning, runs, '2026-10-07', live=live)
        assert added['consistency'] == 'mixed'
        assert {arm: v['consistency'] for arm, v in added['by_arm'].items()} == \
            {'base': 'verified', 'risk_tilt': 'verified', 'ridge': 'verified_inputs'}
        # Every arm stored: the later sessions take each arm's own verdict, not the first row's.
        later = book(stored, learning, runs, '2026-10-09', live=live)
    finally:
        WEIGHTS.pop('ridge')
    assert later['consistency'] == 'mixed' and later['rows'] == 3 * 5 - 2 * 3 - 3
    by_arm = {}
    for row in learning.rows.values():
        by_arm.setdefault(row['arm_id'], set()).add(row['consistency'])
    assert by_arm == {'base': {'verified'}, 'risk_tilt': {'verified'}, 'ridge': {'verified_inputs'}}
    # Stored arms were not re-solved for their later sessions.
    assert [arm for arm, _ in runs.calls] == ['base', 'risk_tilt', 'base', 'risk_tilt', 'ridge']


def test_verdict_sql_runs_on_the_migration_with_primary_key_reads():
    import sqlite3
    from pathlib import Path
    migration = Path(__file__).resolve().parents[2] / 'worker/domain-migrations/learning/0075_l4_opb_arm_replay_v2.sql'
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript(migration.read_text())

    class SqliteLearning:
        def query(self, sql, params):
            plan = ' '.join(r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + sql, params))
            assert 'SCAN' not in plan, plan
            return [dict(r) for r in db.execute(sql, params)]

        def batch_execute(self, statements):
            for sql, values in statements:
                db.execute(sql, values)
    learning = SqliteLearning()
    row = {'allocation_snapshot_id': 'snap-1', 'plan_id': 'formal'}
    first = replay._record_verdict(learning, context='a' * 64, signal_date='2026-10-01', status='rejected',
                                   reason='input_digest_mismatch', row=row, detail={'recorded': 'x', 'recomputed': 'y'})
    again = replay._record_verdict(learning, context='a' * 64, signal_date='2026-10-01', status='rejected',
                                   reason='input_digest_mismatch', row=row, detail={'recorded': 'x', 'recomputed': 'y'})
    assert first == again == {'status': 'rejected', 'reason': 'input_digest_mismatch', 'verdict': 'recorded'}
    assert replay._cached_verdict(learning, 'a' * 64, '2026-10-01')['verdict'] == 'cached'
    with pytest.raises(ValueError, match='verdict_conflict'):
        replay._record_verdict(learning, context='a' * 64, signal_date='2026-10-01', status='not_applicable',
                               reason='empty_pool', row=row)
    with pytest.raises(sqlite3.DatabaseError, match='immutable'):
        db.execute("UPDATE l4_opb_arm_replay_verdicts_v1 SET reason='x'")


def test_a_partially_booked_day_never_rereads_the_plan_or_snapshot(world, monkeypatch):
    """Probe from the second verifier: night 2 of a day with every arm booked costs no snapshot read."""
    state, stored = world
    seal(stored)
    reads = _snapshot_reads(monkeypatch, state)
    paper, learning, runs = CountingPaper(stored), Learning(), Runs()

    def night(business_date, **kwargs):
        return replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date=business_date,
                                    paper=paper, learning=learning, market=Market(), run=runs, **kwargs)
    assert night('2026-10-06')['rows'] == 4 and len(reads) == 1 and paper.reads == 1
    for business_date in ('2026-10-07', '2026-10-08', '2026-10-09'):
        assert night(business_date)['status'] == 'materialized'
    assert len(reads) == 1 and paper.reads == 1 and len(runs.calls) == 2, 'priced from the stored targets only'
    rows = sorted(learning.rows.values(), key=lambda r: (r['arm_id'], r['session_offset']))
    assert {(r['snapshot_id'], r['plan_id']) for r in rows} == {('snap-1', 'formal')}
    # Same pieces as a fresh one-night replay of the whole hold.
    fresh = Learning()
    replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
                         paper=CountingPaper(stored), learning=fresh, market=Market(), run=Runs())
    assert {k: (r['arm_piece'], r['base_piece'], r['market_piece'], r['delta'], r['payload_checksum'])
            for k, r in learning.rows.items()} == \
        {k: (r['arm_piece'], r['base_piece'], r['market_piece'], r['delta'], r['payload_checksum'])
         for k, r in fresh.rows.items()}


def test_premarket_refresh_prices_booked_days_and_never_solves(world, monkeypatch):
    state, stored = world
    seal(stored)
    reads = _snapshot_reads(monkeypatch, state)
    paper, learning, runs = CountingPaper(stored), Learning(), Runs()
    kwargs = dict(live=deepcopy(LIVE), signal_date='2026-10-01', paper=paper, learning=learning, market=Market(), run=runs)
    assert replay.replay_day_v3(business_date='2026-10-06', solve=False, **kwargs) == {'status': 'needs_solve'}
    assert len(reads) == 0 and paper.reads == 0 and not runs.calls and not learning.verdicts
    replay.replay_day_v3(business_date='2026-10-06', **kwargs)          # the nightly owner solves it
    assert replay.replay_day_v3(business_date='2026-10-08', solve=False, **kwargs)['rows'] == 4
    assert len(reads) == 1 and len(runs.calls) == 2
    # needs_solve spends no budget: the premarket bound is pricing work only.
    assert 'needs_solve' in replay.CHEAP_STATUSES


def test_v1_not_applicable_days_spend_the_budget_as_on_main(monkeypatch):
    seen = []

    def fake(*, live, signal_date, **_):
        seen.append(signal_date)
        return {'status': 'not_applicable', 'reason': 'policy_changed'}
    monkeypatch.setattr(replay, 'replay_day', fake)
    v2 = deepcopy(LIVE)
    v2['opb'] = {**v2['opb'], 'schema_version': 'l4-opb-relative-arms-v2'}
    days = ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
    out = replay.attach_daily_replay({'l4Distribution': v2}, '2026-10-09',
                                     clients={'paper': Plans(days, {}), 'learning': Learning(), 'market': Market()}, budget=2)
    assert seen == ['2026-10-01', '2026-09-30'], 'v1 has no verdict table: each not_applicable read is bounded per run'
    assert len(out['deferred_dates']) == 4
    for status in ('immature', 'already_materialized', 'no_formal_plan'):
        assert status in replay.CHEAP_STATUSES


@pytest.mark.parametrize('fault', ['weights_mismatch', 'context_mismatch'])
def test_weight_and_context_mismatches_are_terminal_per_context(world, monkeypatch, fault):
    state, stored = world
    seal(stored)
    if fault == 'weights_mismatch':
        stored['weights'] = {'A': .3}                  # the plan's chosen arm does not replay to its targets
    else:
        state['content']['inputs']['alpha_policy']['l4Distribution']['runtime']['signal_date'] = '2026-09-30'
    reads = _snapshot_reads(monkeypatch, state)
    learning, runs = Learning(), Runs()
    monkeypatch.setattr('services.l4_distribution_runtime.run', runs)
    clients = {'paper': Plans(['2026-10-01'], stored), 'learning': learning, 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}
    first = replay.attach_daily_replay(config, '2026-10-06', clients=clients)
    assert first['status'] == 'ok' and first['rejected_dates'] == ['2026-10-01']
    assert first['dates']['2026-10-01'] == {'status': 'rejected', 'reason': fault, 'verdict': 'recorded'}
    solves = len(runs.calls)
    for tick in range(12):
        assert replay.attach_daily_replay(config, '2026-10-09', clients=clients)['rejected_dates'] == ['2026-10-01']
    assert len(reads) == 1 and len(runs.calls) == solves and not learning.rows
    # A code deploy moves the context, which re-judges the day.
    moved = Learning()
    monkeypatch.setattr(replay, 'context_identity', lambda live, l3: 'f' * 64)
    clients['learning'] = moved
    assert replay.attach_daily_replay(config, '2026-10-09', clients=clients)['dates']['2026-10-01']['verdict'] == 'recorded'
    assert len(reads) == 2


def _receipts_into(learning, receipts):
    """Run receipts go to `receipts` as dicts; every other write reaches the fake ledger."""
    from services import l4_opb_replay_dispatch as dispatch
    inner = learning.batch_execute

    def execute(statements):
        statements = list(statements)
        receipts.extend(dict(zip(dispatch.RUN_COLUMNS, v)) for sql, v in statements if 'l4_opb_arm_replay_runs_v1' in sql)
        inner([(sql, v) for sql, v in statements if 'l4_opb_arm_replay_runs_v1' not in sql])
    return execute


V2_POLICY = deepcopy(LIVE)
V2_POLICY['opb'] = {'schema_version': 'l4-opb-relative-arms-v2', 'enabled': True, 'reward_window_observations': 60,
                    'reward_half_life_observations': 20., 'arms': [{'id': 'base'}]}


def test_v2_policy_keeps_the_replay_with_the_oof_job_as_on_main(monkeypatch):
    """Probe of the third verifier (probe_v1_loop): under v2 the independent path neither
    starts a job nor replays, so v1 not_applicable days are never re-read per tick and
    v2 arm selection never sees rows booked through S+1."""
    from services import l4_opb_replay_dispatch as dispatch

    class Jobs:
        def run_job(self, **kwargs):
            raise AssertionError('no execution under a v2 policy')
    config = {'l4Distribution': V2_POLICY}
    assert dispatch.dispatch_independent_replay('2026-11-26', jobs=Jobs(), config=config) == \
        {'status': 'skipped', 'business_date': '2026-11-26', 'reason': 'policy_not_v3'}
    calls, receipts = [], []
    monkeypatch.setattr(replay, 'replay_day', lambda **kwargs: calls.append(kwargs['signal_date']) or
                        {'status': 'not_applicable', 'reason': 'l3_identity_changed'})
    monkeypatch.setattr(replay, 'attach_daily_replay', lambda *a, **k: calls.append('attach'))
    learning = Learning()
    learning.batch_execute = _receipts_into(learning, receipts)
    for tick in range(3):      # an execution started before the KV went back to v2
        out = dispatch.independent_replay('2026-11-26', execution_id=f'exec-{tick}', config=config,
                                          clients={'learning': learning})
        assert out['status'] == 'skipped'
    assert calls == [] and [r['complete'] for r in receipts] == [1, 1, 1]


def test_a_persistent_failure_ends_the_night_once_nothing_else_progresses(monkeypatch):
    from services import l4_opb_replay_dispatch as dispatch
    days = [f'2026-10-{d:02d}' for d in range(1, 26)]
    booked, solves = set(), []

    def fake(*, signal_date, **_):
        solves.append(signal_date)
        if signal_date == '2026-10-13':
            raise ValueError('l4_opb_arm_replay_calendar_changed')
        if signal_date in booked:
            return {'status': 'already_materialized'}
        booked.add(signal_date)
        return {'status': 'materialized', 'rows': 4}
    monkeypatch.setattr(replay, 'replay_day_v3', fake)
    receipts = []
    learning = Learning()
    learning.batch_execute = _receipts_into(learning, receipts)
    clients = {'paper': Plans(days, {}), 'learning': learning, 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}

    def night(business_date):
        start = len(receipts)
        while True:     # what the Worker does: another execution while the receipt is incomplete
            dispatch.independent_replay(business_date, execution_id=f'e{len(receipts)}', config=config, clients=clients)
            if receipts[-1]['complete'] or len(receipts) - start >= 4:
                return receipts[start:]
    first = night('2026-11-02')
    assert [(r['status'], r['complete'], r['progress']) for r in first] == \
        [('ok', 0, 40), ('failed', 0, 36), ('failed', 0, 20), ('failed', 1, 0)]     # newest first, budget 10
    assert json.loads(first[0]['deferred_dates_json']) and not json.loads(first[2]['deferred_dates_json'])
    assert all(json.loads(r['failed_dates_json']) == ['2026-10-13'] for r in first[1:])
    assert booked == set(days) - {'2026-10-13'}
    # Caught up: the failing day costs one execution a night, never a retry per tick.
    solves.clear()
    later = night('2026-11-03')
    assert [(r['complete'], r['progress']) for r in later] == [(1, 0)] and solves.count('2026-10-13') == 1


def test_a_chosen_arm_missing_from_the_policy_is_terminal_per_context(world, monkeypatch):
    state, stored = world
    seal(stored)
    stored['opb'] = {**stored['opb'], 'arm_id': 'retired_arm'}
    reads = _snapshot_reads(monkeypatch, state)
    learning, runs = Learning(), Runs()
    monkeypatch.setattr('services.l4_distribution_runtime.run', runs)
    clients = {'paper': Plans(['2026-10-01'], stored), 'learning': learning, 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}
    first = replay.attach_daily_replay(config, '2026-10-06', clients=clients)
    assert first['dates']['2026-10-01'] == {'status': 'rejected', 'reason': 'chosen_arm_missing', 'verdict': 'recorded'}
    assert first['status'] == 'ok' and first['progress'] == 1
    again = replay.attach_daily_replay(config, '2026-10-09', clients=clients)
    assert again['dates']['2026-10-01']['verdict'] == 'cached' and again['progress'] == 0
    assert len(reads) == 1 and not learning.rows


class GappedMarket(Market):
    """Market without some (symbol, session) rows (a suspension or a late load)."""

    def __init__(self, gaps):
        self.gaps = set(gaps)

    def query(self, sql, params):
        return [r for r in super().query(sql, params) if (r.get('stock_id'), r.get('date')) not in self.gaps]


def _pieces(learning):
    return {k: (r['arm_piece'], r['base_piece'], r['market_piece'], r['delta'], r['payload_checksum'])
            for k, r in learning.rows.items()}


def test_a_held_name_without_prices_books_the_sessions_that_are_final(world, monkeypatch):
    """P2-1: a name with no row from session 3 on (no later row: not yet bookable) leaves
    sessions 1-2 booked exactly as a night with business_date = session 3 books them."""
    state, stored = world
    seal(stored)
    gaps = {('B', day) for day in SESSIONS[2:]}
    learning, runs = Learning(), Runs()
    out = replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
                               paper=Paper(stored), learning=learning, market=GappedMarket(gaps), run=runs)
    assert out['status'] == 'materialized' and out['sessions'] == 2 and out['missing_price'] == ['B']
    assert out['rows'] == 4
    earlier = Learning()
    replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date=SESSIONS[2],
                         paper=Paper(stored), learning=earlier, market=Market(), run=Runs())
    assert _pieces(learning) == _pieces(earlier)
    # Prices arrive: the rest books from the stored targets and equals a one-shot replay.
    replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
                         paper=Paper(stored), learning=learning, market=Market(), run=runs)
    fresh = Learning()
    replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
                         paper=Paper(stored), learning=fresh, market=Market(), run=Runs())
    assert _pieces(learning) == _pieces(fresh) and len(learning.rows) == 10
    # Missing at entry: nothing is final, nothing is booked.
    none = Learning()
    entry_gap = replay.replay_day_v3(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
                                     paper=Paper(stored), learning=none, market=GappedMarket({('B', SESSIONS[0])}),
                                     run=Runs())
    assert entry_gap == {'status': 'missing_price', 'symbols': ['B']} and not none.rows


def test_unbookable_days_never_starve_older_days_across_nights(monkeypatch):
    """P2-1 (verifier4 probe_progress): the newest 12 days stay missing_price; the 18
    older days are booked from the next night on, and the missing days rotate."""
    days = [f'2026-10-{d:02d}' for d in range(1, 31)]
    booked, tried = set(), []

    def fake(*, signal_date, **_):
        tried.append(signal_date)
        if signal_date >= '2026-10-19':
            return {'status': 'missing_price', 'symbols': ['X']}
        if signal_date in booked:
            return {'status': 'already_materialized'}
        booked.add(signal_date)
        return {'status': 'materialized', 'rows': 4}
    monkeypatch.setattr(replay, 'replay_day_v3', fake)
    learning = Learning()
    clients = {'paper': Plans(days, {}), 'learning': learning, 'market': Market()}
    config = {'l4Distribution': deepcopy(LIVE)}
    first = replay.attach_daily_replay(config, '2026-10-31', clients=clients)
    assert first['progress'] == 0 and len(first['missing_price_dates']) == 10 and not booked
    assert len(learning.retry) == 10 and {r['reason'] for r in learning.retry.values()} == {'missing_price'}
    nights = []
    for _ in range(3):
        tried.clear()
        out = replay.attach_daily_replay(config, '2026-10-31', clients=clients)
        nights.append((out['progress'], len(booked)))
    assert nights[0] == (32, 8) and nights[1] == (40, 18), nights
    # Every missing day has been tried by now (least recently tried first).
    assert set(learning.retry) == {(next(iter(learning.retry))[0], d) for d in days if d >= '2026-10-19'}
    # A day that books leaves the queue; one sliding out of the window is dropped.
    booked_day = '2026-10-19'
    monkeypatch.setattr(replay, 'replay_day_v3', lambda *, signal_date, **_:
                        {'status': 'materialized', 'rows': 4} if signal_date == booked_day else
                        {'status': 'already_materialized'} if signal_date < '2026-10-19' else
                        {'status': 'missing_price', 'symbols': ['X']})
    for _ in range(2):
        replay.attach_daily_replay(config, '2026-10-31', clients=clients)
    assert booked_day not in {d for _, d in learning.retry}


def test_a_transient_failure_gets_one_more_execution_but_a_deterministic_one_does_not(monkeypatch):
    """P2-5: zero progress ends the night, except once for the night's first execution when
    the errors were transient (the D1 client's exhausted HTTP 429/5xx, network, overload)."""
    import json as json_module
    from services import l4_opb_replay_dispatch as dispatch
    from services.d1_client import D1DurableBatchRetryRequired, WorkerD1BatchValidationError
    days = ['2026-10-01', '2026-10-02']
    wrapped = RuntimeError('l4_opb_snapshot_read_failed')
    wrapped.__cause__ = RuntimeError('D1 request failed: network error: reset')

    def durable(cause):          # d1_client raises it `from` the transport error
        error = D1DurableBatchRetryRequired(f'worker=x; raw={cause}')
        error.__cause__ = RuntimeError(cause)
        return error
    cases = ((RuntimeError('D1 request failed: HTTP 503: x'), 2), (wrapped, 2),
             (durable('D1 raw request failed: HTTP 503: x'), 2),
             # Deterministic: a retry reproduces them, so the night ends at once. The durable
             # batch signal counts by its cause: around an HTTP 400 it is deterministic.
             (durable('D1 raw request failed: HTTP 400: SQLITE_CONSTRAINT'), 1),
             (D1DurableBatchRetryRequired('both transports failed'), 1),
             (RuntimeError('paired_nav_manifest_missing'), 1), (RuntimeError('D1 request failed: HTTP 400: SQL error'), 1),
             (WorkerD1BatchValidationError('worker_batch_contract'), 1), (ValueError('l4_opb_arm_replay_conflict'), 1),
             (json_module.JSONDecodeError('bad', 'x', 0), 1), (RuntimeError('d1_read_batch_failed'), 1))
    for error, executions in cases:
        def fake(*, signal_date, **_):
            raise error
        monkeypatch.setattr(replay, 'replay_day_v3', fake)
        receipts, learning = [], Learning()
        learning.batch_execute = _receipts_into(learning, receipts)
        learning_query = learning.query
        learning.query = lambda sql, params: ([{'n': len(receipts)}] if 'l4_opb_arm_replay_runs_v1' in sql
                                              else learning_query(sql, params))
        clients = {'paper': Plans(days, {}), 'learning': learning, 'market': Market()}
        for n in range(4):
            dispatch.independent_replay('2026-10-09', execution_id=f'e{n}', config={'l4Distribution': deepcopy(LIVE)},
                                        clients=clients)
            if receipts[-1]['complete']:
                break
        assert len(receipts) == executions, error
        assert all(r['status'] == 'failed' and r['progress'] == 0 for r in receipts)
        assert replay._transient_error(error) is (executions == 2)
    # A transient setup failure (D1 down before any day) gets the same one retry.
    def setup_fails(*_, **__):
        raise RuntimeError('D1 request failed: HTTP 502: bad gateway')
    monkeypatch.setattr(replay, 'validate_constraints', setup_fails)
    assert replay.attach_daily_replay({'l4Distribution': deepcopy(LIVE)}, '2026-10-09',
                                      clients={'paper': Plans(days, {}), 'learning': Learning(), 'market': Market()}
                                      )['transient_failures'] == 1
    assert dispatch.run_complete({'status': 'failed', 'transient_failures': 1, 'first_execution': True}) is False
    assert dispatch.run_complete({'status': 'failed', 'transient_failures': 1, 'first_execution': False})


def test_job_summary_names_missing_prices_and_run_failures():
    import oof_materialize_job_main as job
    assert job._opb_attention({'status': 'failed', 'reason': 'd1 down'}) == 'attention=opb_replay_run_failed'
    assert job._opb_attention({'status': 'ok', 'missing_price_dates': ['a', 'b'], 'deferred_dates': ['c']}) == \
        'attention=opb_replay_missing_price:2,opb_replay_deferred:1'
    # The nightly OOF summary carries the same token (P3b).
    replay_result = {'status': 'failed', 'failed_dates': ['x'], 'missing_price_dates': ['a'], 'deferred_dates': ['b', 'c'],
                     'rejected_dates': []}
    token = 'attention=opb_replay_failed:1,opb_replay_missing_price:1,opb_replay_deferred:2'
    assert job._opb_attention(replay_result) == token
    nightly = job._summary('run-1', {'status': 'success', 'opb_arm_replay': replay_result}, mode='daily')
    assert nightly == 'run_id=run-1 status=success cohort=none promoted=False reason=none full_fit=none ' + token
    # Classification of this exact string is checked in opbIndependentReplay.test.ts.


def test_retry_queue_and_receipt_sql_run_on_the_migration_without_scans():
    import sqlite3
    from pathlib import Path
    from services import l4_opb_replay_dispatch as dispatch
    migration = Path(__file__).resolve().parents[2] / 'worker/domain-migrations/learning/0075_l4_opb_arm_replay_v2.sql'
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript(migration.read_text())
    plans = []

    class SqliteLearning:
        def query(self, sql, params):
            plan = ' '.join(r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + sql, params))
            assert 'SCAN' not in plan, plan
            plans.append(plan)
            return [dict(r) for r in db.execute(sql, params)]

        def batch_execute(self, statements):
            for sql, values in statements:
                if sql.startswith('DELETE'):
                    plan = ' '.join(r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + sql, values))
                    assert 'SCAN' not in plan and 'USING' in plan, plan
                    plans.append(plan)
                db.execute(sql, values)
    learning = SqliteLearning()
    live = deepcopy(LIVE)
    # A row of an older context (a deploy moved the context): never read again, pruned by age.
    db.execute("INSERT INTO l4_opb_arm_replay_retry_v1 VALUES('old-context','2026-03-02','failed','{}',3,"
               "'2026-03-03T00:00:00+00:00')")
    db.execute("INSERT INTO l4_opb_arm_replay_retry_v1 VALUES('other-context','2026-10-01','failed','{}',1,?)",
               [datetime.now(timezone.utc).isoformat()])
    results = {'2026-10-01': {'status': 'missing_price', 'symbols': ['B']},
               '2026-10-02': {'status': 'failed', 'error_type': 'RuntimeError', 'reason': 'x'},
               '2026-10-05': {'status': 'materialized', 'rows': 4, 'missing_price': ['B']}}
    replay._write_retry_queue(learning, live, results, {})
    replay._write_retry_queue(learning, live, results, {})
    queue = replay._read_retry_queue(learning, live)
    assert sorted(queue) == ['2026-10-01', '2026-10-02', '2026-10-05']
    rows = {(r['context_identity'], r['signal_date']): r for r in db.execute('SELECT * FROM l4_opb_arm_replay_retry_v1')}
    assert ('old-context', '2026-03-02') not in rows and ('other-context', '2026-10-01') in rows
    assert {d: r['attempts'] for (c, d), r in rows.items() if c != 'other-context'} == \
        {'2026-10-01': 2, '2026-10-02': 2, '2026-10-05': 2}
    # detail_json is bounded before encoding: always valid JSON.
    long = {'2026-10-06': {'status': 'failed', 'error_type': 'RuntimeError', 'reason': 'x' * 5000},
            '2026-10-07': {'status': 'missing_price', 'symbols': [f'S{i:04d}' for i in range(1000)]}}
    replay._write_retry_queue(learning, live, long, {})
    details = {r['signal_date']: json.loads(r['detail_json'])
               for r in db.execute("SELECT * FROM l4_opb_arm_replay_retry_v1 WHERE signal_date IN ('2026-10-06','2026-10-07')")}
    assert len(details['2026-10-06']['reason']) == 200
    assert len(details['2026-10-07']['symbols']) == 50 and details['2026-10-07']['symbols_count'] == 1000
    db.execute("DELETE FROM l4_opb_arm_replay_retry_v1 WHERE signal_date IN ('2026-10-06','2026-10-07')")
    replay._write_retry_queue(learning, live, {'2026-10-01': {'status': 'materialized', 'rows': 4},
                                               '2026-10-02': {'status': 'deferred_budget'}}, queue)
    assert sorted(replay._read_retry_queue(learning, live)) == ['2026-10-02']    # resolved and slid-out rows go
    dispatch.write_run_receipt(learning, business_date='2026-10-09', execution_id='e1',
                               result={'status': 'ok', 'missing_price_dates': ['2026-10-01'], 'progress': 4})
    assert dispatch._prior_executions(learning, '2026-10-09') == 1
    assert all('USING' in p for p in plans), plans


def test_market_proxy_is_a_kv_field_whose_default_keeps_every_identity(world):
    """Wei 11/28: opb.market_proxy in trading:config, default 0050, not searched by Optuna.
    Absent and an explicit default are the same policy: the ledger context and the
    approved policy identity stay the strings they were before the field existed."""
    from services.l4_distribution import digest
    from services.l4_distribution_runtime import PLAN_SCHEMA, distribution_policy_identity
    from services.l4_opb_selection import (MARKET_PROXY_DEFAULT, canonical_policy, context_identity, market_proxy,
                                           validate_arms)
    l3 = {'source': 'fixed'}
    absent = deepcopy(LIVE)
    explicit = deepcopy(LIVE)
    explicit['opb']['market_proxy'] = MARKET_PROXY_DEFAULT
    other = deepcopy(LIVE)
    other['opb']['market_proxy'] = '006208'
    assert market_proxy(absent) == market_proxy(explicit) == MARKET_PROXY_DEFAULT and market_proxy(other) == '006208'
    # The formulas as they stood before this field (c565dc56): the default reproduces them byte for byte.
    before_context = digest({'policy_schema': POLICY_SCHEMA, 'model': LIVE['artifact']['model_checksum'], 'l3': l3,
        'constraints': LIVE['constraints'], 'sealed_execution': None,
        'allocator_source_identity': digest(allocator_source_identity()), 'opb_schema': OPB_SCHEMA_V3,
        'reward': OPB['reward'], 'inert_counterfactual': OPB['inert_counterfactual']})
    before_policy = digest({'model': LIVE['artifact']['model_checksum'], 'l3': l3, 'constraints': LIVE['constraints'],
        'opb_policy': {k: v for k, v in OPB.items() if k != 'approved_policy_identity'}, 'schema': PLAN_SCHEMA,
        'policy_schema': POLICY_SCHEMA})
    assert context_identity(absent, l3) == context_identity(explicit, l3) == before_context
    assert distribution_policy_identity(absent, l3) == distribution_policy_identity(explicit, l3) == before_policy
    assert digest(canonical_policy(explicit)) == digest(absent) and canonical_policy(absent) is absent
    # Another proxy is another ledger and another approved policy.
    assert context_identity(other, l3) != before_context
    assert distribution_policy_identity(other, l3) != before_policy
    assert canonical_policy(other) is other
    # A v3-only field: the v2 block (prod today) rejects it, so v2 identities cannot move.
    v2 = deepcopy(V2_POLICY)
    v2['opb']['market_proxy'] = MARKET_PROXY_DEFAULT
    with pytest.raises(ValueError, match='l4_distribution_opb_unknown_field'):
        validate_arms(v2)
    assert context_identity(V2_POLICY, l3) == context_identity(v2, l3)
    # Fail closed: only a TW ETF code (the label calendar stays on 0050).
    validate_arms(explicit)
    validate_arms(other)
    for good in ('0056', '00878', '006208'):
        ok = deepcopy(LIVE)
        ok['opb']['market_proxy'] = good
        validate_arms(ok)
    for bad in ('2330', '1101', '00631L', '005', '0050123', '123', '1234567', 50, None, '', ' 0050', '0050 ',
                '５０５０'):
        broken = deepcopy(LIVE)
        broken['opb']['market_proxy'] = bad
        with pytest.raises(ValueError, match='market_proxy_invalid'):
            validate_arms(broken)
        with pytest.raises(ValueError, match='market_proxy_invalid'):
            context_identity(broken, l3)


def test_the_replay_calendar_and_market_piece_follow_the_configured_proxy(world, monkeypatch):
    _, stored = world
    monkeypatch.setitem(CLOSES, '00999', [100.2, 99., 101., 103., 102.])
    live = deepcopy(LIVE)
    live['opb']['market_proxy'] = '00999'

    class ProxyMarket(Market):
        calendar_stock = '00999'
        loaded = set()

        def query(self, sql, params):
            if not sql.startswith('SELECT date'):
                self.loaded.update(params[:-2])
            return super().query(sql, params)
    monkeypatch.setattr(sys.modules[__name__], 'Market', ProxyMarket)
    learning = Learning()
    out = book(stored, learning, Runs(), '2026-10-09', live=live)
    assert out['status'] == 'materialized' and '00999' in ProxyMarket.loaded and MARKET_PROXY_DEFAULT not in ProxyMarket.loaded
    base = sorted((r for r in learning.rows.values() if r['arm_id'] == 'base'), key=lambda r: r['session_offset'])
    expected = replay.session_pieces({'00999': 1.}, {'00999': 1.}, sessions=SESSIONS, prices=prices(),
                                     buy_cost=0., sell_cost=0.)
    assert [r['market_piece'] for r in base] == pytest.approx(expected)
    assert {r['context_identity'] for r in base} == {context_identity(live, live['artifact']['l3_identity'])}
    assert context_identity(live, live['artifact']['l3_identity']) != context_identity(LIVE, LIVE['artifact']['l3_identity'])
    # The plan's frozen policy (no field) differs from live: replayed, labelled verified_inputs.
    assert out['consistency'] == 'verified_inputs'


def test_no_second_market_proxy_literal_and_no_optuna_search_space_holds_it():
    """(3)(5): the default is declared once (MARKET_PROXY_DEFAULT); the manifest documents
    the field with optuna=false and points at that constant; no Optuna script, contract or
    route can search or push it."""
    import re
    from pathlib import Path
    from services import l4_opb_selection as selection
    root = Path(__file__).resolve().parents[2]
    controller = root / 'ml-controller'
    opb_sources = [controller / 'services' / name for name in (
        'l4_opb_selection.py', 'l4_opb_arm_replay.py', 'l4_opb_cutover_warm_start.py', 'l4_opb_replay_dispatch.py',
        'l4_distribution_runtime.py', 'l4_distribution_context.py')] + sorted((root / 'tools').glob('opb_*.py'))
    assert len(opb_sources) >= 8
    hits = [(p.name, n) for p in opb_sources for n, line in enumerate(p.read_text().splitlines(), 1)
            if re.search(r"""['"]0050['"]""", line)]
    assert hits == [('l4_opb_selection.py', next(n for n, line in enumerate(
        (controller / 'services' / 'l4_opb_selection.py').read_text().splitlines(), 1)
        if line.startswith('MARKET_PROXY_DEFAULT = ')))], hits
    manifest = json.loads((root / 'config' / 'kv' / 'manifest.json').read_text())
    field = manifest['keys']['trading:config']['fields']['l4Distribution.opb.market_proxy']
    assert field['owner'] == 'trading:config' and field['optuna'] is False and field['optional'] is True
    assert field['pattern'] == f'^{selection.MARKET_PROXY_PATTERN}$' and 'default' not in field
    module, constant = field['default_owner'].split(':')
    assert (root / module).is_file() and getattr(selection, constant) == selection.MARKET_PROXY_DEFAULT
    assert re.fullmatch(selection.MARKET_PROXY_PATTERN, selection.MARKET_PROXY_DEFAULT)
    optuna_sources = [*(controller / 'optuna_scripts').glob('*.py'), controller / 'services' / 'optuna_script_contracts.py',
                      controller / 'routers' / 'optuna.py', controller / 'services' / 'alpha_policy_search.py',
                      root / 'worker' / 'src' / 'lib' / 'optunaConfigMerge.ts']
    assert all(p.is_file() for p in optuna_sources)
    assert [p.name for p in optuna_sources if re.search(r'market_?proxy', p.read_text(), re.IGNORECASE)] == []


def test_offline_replay_refuses_prices_cached_for_another_market_proxy(tmp_path, monkeypatch):
    """The prices step records the proxy its calendar and market piece came from;
    replay against a different --market-proxy fails before any solve."""
    import argparse
    import gzip
    import importlib.util
    from pathlib import Path
    for name in ('GCS_BUCKET_NAME', 'OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        monkeypatch.setenv(name, 'restore')    # records the prior state; teardown restores it
        monkeypatch.delenv(name)
    monkeypatch.setattr(sys, 'path', list(sys.path))
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('opb_v3_offline_replay_under_test',
                                                  root / 'tools' / 'opb_v3_offline_replay.py')
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)

    class Rows:
        def __init__(self):
            self.params = []

        def query(self, sql, params=()):
            self.params.append(list(params))
            return [{'date': '2026-10-01'}] if sql.startswith('SELECT date') else []

    def priced(proxy):
        cache = tmp_path / (proxy or 'default')
        cache.mkdir()
        market = Rows()
        tool.prices(argparse.Namespace(start='2026-10-01', end='2026-10-01', market_proxy=proxy), market, cache)
        with gzip.open(cache / 'prices.json.gz', 'rt', encoding='utf-8') as source:
            return cache, json.load(source), market

    cache, raw, market = priced(None)
    assert raw['market_proxy'] == MARKET_PROXY_DEFAULT and raw['calendar'] == ['2026-10-01']
    assert all(MARKET_PROXY_DEFAULT in p for p in market.params)
    assert tool.load_prices(cache, proxy=MARKET_PROXY_DEFAULT)[0] == ['2026-10-01']
    with pytest.raises(RuntimeError, match='market_proxy_mismatch'):
        tool.load_prices(cache, proxy='006208')
    other, raw, _ = priced('006208')
    assert raw['market_proxy'] == '006208'
    tool.load_prices(other, proxy='006208')
    arms = tmp_path / 'arms.json'
    arms.write_text('[]')
    for cached, flag in ((cache, '006208'), (other, None), (other, MARKET_PROXY_DEFAULT)):
        with pytest.raises(RuntimeError, match='market_proxy_mismatch'):
            tool.replay(argparse.Namespace(cache=cached, arms=arms, output=tmp_path / 'out.json', workers=1,
                                           inert_reference_exposure=None, inert_reference_name=.0625,
                                           market_proxy=flag))
    assert not (tmp_path / 'out.json').exists()
    # A cache written before the field existed has no proxy on record: refused, not assumed.
    legacy = tmp_path / 'legacy'
    legacy.mkdir()
    with gzip.open(legacy / 'prices.json.gz', 'wt', encoding='utf-8') as sink:
        json.dump({'calendar': [], 'rows': []}, sink)
    with pytest.raises(RuntimeError, match='market_proxy_mismatch'):
        tool.load_prices(legacy, proxy=MARKET_PROXY_DEFAULT)
