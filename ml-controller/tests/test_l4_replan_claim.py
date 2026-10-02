"""Real SQLite atomic claims, concurrent callers, expiry and fencing."""
import sqlite3
from threading import RLock, Event, Thread
from services.l4_replan_lease import replan_claim, GROUP


class LeaseDB:
    def __init__(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = RLock()
        self.db.execute('''CREATE TABLE maintenance_task_leases (
            lease_group TEXT PRIMARY KEY, task_name TEXT, owner_id TEXT,
            lease_expires_at TEXT, acquired_at TEXT, heartbeat_at TEXT)''')

    def query(self, sql, args):
        with self.lock:
            result = [dict(row) for row in self.db.execute(sql, args).fetchall()]
            self.db.commit()
            return result


def test_claim_excludes_overlap_and_recovers_after_completion():
    db = LeaseDB()
    entered, release = Event(), Event()
    def first():
        with replan_claim(db) as fence:
            assert fence
            entered.set()
            assert release.wait(5)
            fence()
    thread = Thread(target=first)
    thread.start()
    assert entered.wait(5)
    try:
        with replan_claim(db) as fence:
            assert fence is None
    finally:
        release.set()
        thread.join(5)
    with replan_claim(db) as fence:
        assert fence
        fence()


def test_expired_claim_recovered_and_old_owner_fenced():
    import pytest
    db = LeaseDB()
    with replan_claim(db) as first:
        db.query("UPDATE maintenance_task_leases SET lease_expires_at='2000-01-01' WHERE lease_group=?", [GROUP])
        with replan_claim(db) as second:
            assert second
            with pytest.raises(RuntimeError, match='lease_lost'):
                first()
            second()


def test_overlap_returns_before_account_or_snapshot_read(monkeypatch):
    from services.l4_replan import replan
    from types import SimpleNamespace
    db = LeaseDB()
    with replan_claim(db):
        result = replan(plan_id='a'*64, veto_symbols=[], weight_caps={'A': .1}, reason='debate_risk_cap',
            paper=SimpleNamespace(query=lambda *_: []), learning=None,
            account_reader=lambda _: (_ for _ in ()).throw(AssertionError('must not read account')),
            publisher=None, leases=db)
    assert result['status'] == 'in_progress'


def test_risk_caps_change_allocation_without_changing_model_inputs(monkeypatch):
    from copy import deepcopy
    from services import l4_distribution_runtime as runtime
    from test_l4_distribution_runtime import fixture
    rows, policy, history = fixture()
    calls = []
    original = runtime.predict
    def observe(features, model):
        result = original(features, model)
        calls.append(deepcopy((features, model, result)))
        return result
    monkeypatch.setattr(runtime, 'predict', observe)
    first = runtime.run(rows, policy, return_history=history)[0]['_l4_portfolio_plan']
    selected = max(first['weights'], key=first['weights'].get)
    changed = deepcopy(policy)
    changed['runtime']['account']['name_caps'] = {selected: first['weights'][selected] / 2}
    second = runtime.run(rows, changed, return_history=history)[0]['_l4_portfolio_plan']
    assert calls[0] == calls[1], 'L3 features, model and forecasts stay identical'
    assert first['weights'] != second['weights'], 'portfolio changes solely through constraints'
