"""The OPB arm replay ledger: verified replay, paired net deltas, no rows on missing prices, idempotent."""
from copy import deepcopy
import json

import pytest

from services import l4_opb_arm_replay as replay
from services.l4_opb_selection import LEDGER_SCHEMA, OPB_SCHEMA, POLICY_SCHEMA
from services.paired_nav_collection import allocator_source_identity

SESSIONS = ['2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
LIVE = {'policy_schema': POLICY_SCHEMA, 'scope': 'paper',
    'artifact': {'model_checksum': 'a' * 64, 'l3_identity': {'source': 'fixed'}},
    'constraints': {'risk_aversion': 2., 'return_history_lookback_sessions': 252, 'cost_objective': 'entry_round_trip_v1'},
    'opb': {'schema_version': OPB_SCHEMA, 'enabled': True, 'reward_window_observations': 60,
            'reward_half_life_observations': 20., 'approved_policy_identity': 'x' * 64,
            'arms': [{'id': 'base'}, {'id': 'tight', 'exposure_fraction': .5, 'name_fraction': .5}]}}
WEIGHTS = {'base': {'A': .2, 'B': 0.}, 'tight': {'A': .1, 'B': .1}}


class Market:
    def __init__(self, prices):
        self.prices = prices

    def query(self, sql, params):
        if "stock_id='0050'" in sql:
            return [{'date': day} for day in SESSIONS if day > params[0]][:params[1]]
        return [{'stock_id': s, 'date': d, 'source': 'finlab.price', 'adj_open': o, 'adj_close': c}
                for (s, d), (o, c) in self.prices.items() if s in params and d in params]


class Learning:
    def __init__(self):
        self.rows = {}

    def query(self, sql, params):
        if sql.startswith('SELECT arm_digest'):
            return [{'arm_digest': k[2]} for k in self.rows if k[:2] == tuple(params)]
        row = self.rows.get(tuple(params))
        return [] if row is None else [{'payload_checksum': row['payload_checksum']}]

    def batch_execute(self, statements):
        for _, values in statements:
            record = dict(zip(replay.COLUMNS, values))
            self.rows.setdefault((record['context_identity'], record['signal_date'], record['arm_digest']), record)


class Paper:
    def __init__(self, plan):
        self.plan = plan

    def query(self, sql, params):
        return [{'plan_id': 'formal', 'allocation_snapshot_id': 'snap-1', 'created_at': '2026-10-02T00:40:00Z',
                 'payload_json': json.dumps(self.plan)}]


def fake_run(recommendations, policy, *, return_history, forced_arm):
    return [{'_l4_portfolio_plan': {'plan_id': 'replay-' + forced_arm, 'weights': dict(WEIGHTS[forced_arm]),
        'targets': {s: {'current_weight': 0.} for s in WEIGHTS[forced_arm]},
        'opb': {'arm_id': forced_arm, 'effective_digest': 'e-' + forced_arm, 'arm_inert': False}}}]


@pytest.fixture
def world(monkeypatch):
    runtime = {'signal_date': '2026-10-01', 'l3_identity': {'source': 'fixed'},
               'account': {'fees': {'buy_cost': .001, 'sell_cost': .004}}}
    content = {'allocator_source_identity': allocator_source_identity(),
               'inputs': {'alpha_policy': {'l4Distribution': {**deepcopy(LIVE), 'runtime': runtime}},
                          'return_history': {'lookback': 252}, 'recommendations': [{'symbol': 'A'}, {'symbol': 'B'}]}}
    monkeypatch.setattr('services.paired_nav_journal.read_snapshot', lambda query, snapshot_id:
        {'manifest': {'frozen_at': '2026-10-02T00:30:00Z'}, 'payload': {'content': deepcopy(content)}})
    stored = {'execution_scope': 'paper', 'l3_identity': {'source': 'fixed'}, 'opb': {'arm_id': 'base'},
              'weights': dict(WEIGHTS['base'])}
    prices = {('A', '2026-10-02'): (100., None), ('A', '2026-10-08'): (None, 110.),
              ('B', '2026-10-02'): (100., None), ('B', '2026-10-08'): (None, 95.)}
    return stored, prices


def materialize(stored, prices, learning):
    return replay.replay_day(live=deepcopy(LIVE), signal_date='2026-10-01', business_date='2026-10-09',
        paper=Paper(stored), learning=learning, market=Market(prices), run=fake_run)


def test_replay_writes_paired_net_deltas_once_and_verifies_the_chosen_arm(world):
    stored, prices = world
    learning = Learning()
    receipt = materialize(stored, prices, learning)
    assert receipt == {'status': 'materialized', 'arms': 2, 'consistency': 'verified', 'known_date': '2026-10-08'}
    rows = {r['arm_id']: r for r in learning.rows.values()}
    assert rows['base']['arm_return'] == pytest.approx(.2 * .1 - .001 * .2)
    assert rows['tight']['delta'] == pytest.approx((.1 * .1 - .1 * .05 - .001 * .2) - (.2 * .1 - .001 * .2))
    assert {r['schema_version'] for r in rows.values()} == {LEDGER_SCHEMA}
    assert {r['known_date'] for r in rows.values()} == {'2026-10-08'}
    assert materialize(stored, prices, learning) == {'status': 'already_materialized'}


def test_replay_rejects_a_chosen_arm_that_does_not_reproduce_the_stored_plan(world):
    stored, prices = world
    stored['weights'] = {'A': .19, 'B': 0.}
    with pytest.raises(ValueError, match='arm_replay_mismatch'):
        materialize(stored, prices, Learning())


def test_missing_price_writes_no_row_for_any_arm(world):
    stored, prices = world
    del prices[('B', '2026-10-08')]
    learning = Learning()
    assert materialize(stored, prices, learning) == {'status': 'missing_price', 'symbols': ['B']}
    assert learning.rows == {}


def test_rerun_with_different_payload_is_a_conflict(world):
    stored, prices = world
    learning = Learning()
    materialize(stored, prices, learning)
    record = next(iter(learning.rows.values()))
    with pytest.raises(ValueError, match='arm_replay_conflict'):
        replay._insert(learning, [{**record, 'payload_checksum': 'f' * 64}])


def test_nightly_hook_skips_v1_and_never_raises():
    assert replay.attach_daily_replay({'l4Distribution': {'scope': 'paper'}}, '2026-10-09') == \
        {'status': 'skipped', 'reason': 'policy_not_v2'}
    broken = replay.attach_daily_replay({'l4Distribution': {**LIVE, 'constraints': {}}}, '2026-10-09')
    assert broken['status'] == 'failed'
