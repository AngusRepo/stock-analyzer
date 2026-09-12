import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess

import pytest

from services.native_paper_sandbox import PrivatePaperStore, clock_sql, run_native_paper_frames

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope='module')
def native_runner(tmp_path_factory):
    node = shutil.which('node')
    assert node, 'The existing Worker Node runtime is required; do not skip execution parity.'
    runner = tmp_path_factory.mktemp('native-paper-runner') / 'runner.cjs'
    script = "require('esbuild').buildSync(" + json.dumps({
        'entryPoints': ['src/node-runner/nativePaperJobMain.ts'], 'outfile': str(runner),
        'bundle': True, 'platform': 'node', 'format': 'cjs',
    }) + ')'
    subprocess.run([node, '-e', script], cwd=ROOT / 'worker', check=True, capture_output=True, text=True)
    return runner


def base_state():
    db = sqlite3.connect(':memory:')
    db.executescript((ROOT / 'worker/domain-migrations/paper/0001_paper_baseline.sql').read_text(encoding='utf-8'))
    db.executescript((ROOT / 'worker/domain-migrations/paper/0004_corporate_action_accounting.sql').read_text(encoding='utf-8'))
    db.execute('CREATE TABLE _native_private_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_ms REAL,metadata TEXT)')
    for day in ('2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'):
        packet = {'schema_version': 'paper-corporate-source-v1', 'session_date': day,
            'observed_at': day + 'T00:00:00+08:00', 'source_checksum': 'c' * 64,
            'covered_symbols': ['2330', '0050'], 'actions': [], 'blockers': {},
            'tax_basis': 'gross_before_personal_tax'}
        db.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)',
            ('market:corporate_actions:v1:' + day, json.dumps(packet)))
    db.executescript("""
      INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,999999,999999),(2,90000,100000);
      INSERT INTO paper_settlements(account_id,order_id,symbol,side,amount,trade_date,settlement_date)
      VALUES(1,1,'2330','sell',900,'2026-09-02','2026-09-07'),
            (2,2,'2330','buy',1000,'2026-09-02','2026-09-07'),
            (2,3,'2330','sell',3000,'2026-09-02','2026-09-07'),
            (2,4,'2330','sell',7000,'2026-09-04','2026-09-08');
    """)
    raw = '\n'.join(db.iterdump())
    db.close()
    return raw


def checksum(sql):
    return hashlib.sha256(sql.encode()).hexdigest()


def frame(day='2026-09-07', stage='settlement'):
    return {'input_id': day + ':' + stage, 'stage': stage, 'observed_at': day + 'T00:00:00Z'}


def run(runner, raw, frames, inputs=None, variables=None):
    return run_native_paper_frames(state_sql=raw, state_checksum=checksum(raw), account_id=2,
        variables=variables or {}, frames=frames, frame_inputs=inputs or {f['input_id']: f for f in frames}, runner=runner)


def read_state(result):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript(result['state_sql'])
    return db


def test_actual_native_t2_retry_and_next_day_continue_without_touching_other_account(native_runner):
    raw = base_state()
    result = run(native_runner, raw, [frame(), frame()])
    assert result['production_effect'] is False
    assert result['session_complete'] is False
    assert result['nav_maturity_credit'] == 0
    with read_state(result) as db:
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 92000
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 999999
        assert db.execute('SELECT SUM(settled) FROM paper_settlements WHERE account_id=2').fetchone()[0] == 2
        assert db.execute('SELECT SUM(settled) FROM paper_settlements WHERE account_id=1').fetchone()[0] == 0
    continued = run(native_runner, result['state_sql'], [frame('2026-09-08')])
    with read_state(continued) as db:
        row = db.execute('SELECT cash,updated_at FROM paper_accounts WHERE id=2').fetchone()
        assert row['cash'] == 99000
        assert row['updated_at'] == '2026-09-08 00:00:00'


def test_native_t2_batch_failure_cannot_leave_updated_cash(native_runner):
    raw = base_state()
    raw += "\nCREATE TRIGGER reject_settlement BEFORE UPDATE ON paper_settlements BEGIN SELECT RAISE(ABORT,'fixture_fail'); END;"
    with pytest.raises(RuntimeError, match='fixture_fail'):
        run(native_runner, raw, [frame()])
    # Input state is immutable and no result state is exported after failure.
    with sqlite3.connect(':memory:') as db:
        db.executescript(raw)
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 90000


def test_sql_clock_rewrite_preserves_literals_and_dynamic_defaults():
    raw = "CREATE TABLE t(id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,other TEXT);"
    f = frame()
    store = PrivatePaperStore(raw, checksum(raw), {f['input_id']: f})
    try:
        store.dispatch('frame_input', {**f, 'now_ms': 1788739200000})
        store.dispatch('frame_begin', {})
        store.dispatch('sql', {'sql': "INSERT INTO t(id,other) VALUES(1,'CURRENT_TIMESTAMP datetime(''now'')')"})
        row = store.dispatch('sql', {'sql': 'SELECT * FROM t'})['results'][0]
        assert row['created_at'] == '2026-09-07 00:00:00'
        assert row['other'] == "CURRENT_TIMESTAMP datetime('now')"
        assert clock_sql("SELECT strftime('%Y','now'),date('2020-01-01')") == "SELECT strftime('%Y',native_now()),date('2020-01-01')"
    finally:
        store.db.close()


def test_same_store_transaction_rolls_back_sql_kv_and_artifacts():
    raw = 'CREATE TABLE t(id INTEGER);'
    f = frame()
    store = PrivatePaperStore(raw, checksum(raw), {f['input_id']: f})
    try:
        store.dispatch('frame_input', {**f, 'now_ms': 1788739200000})
        store.dispatch('frame_begin', {})
        store.dispatch('sql', {'sql': 'INSERT INTO t VALUES(1)'})
        store.dispatch('kv_put', {'key': 'a', 'value': 'b'})
        store.dispatch('artifact_put', {'key': 'receipt', 'value': '{}'})
        store.dispatch('frame_rollback', {})
        store.dispatch('frame_begin', {})
        assert store.dispatch('sql', {'sql': 'SELECT * FROM t'})['results'] == []
        assert store.dispatch('kv_get', {'key': 'a'}) is None
        assert store.dispatch('artifact_get', {'key': 'receipt'}) is None
        with pytest.raises(sqlite3.DatabaseError):
            store.dispatch('sql', {'sql': "ATTACH DATABASE 'file:foreign' AS foreign_db"})
        with pytest.raises(ValueError, match='transaction_control_forbidden'):
            store.dispatch('sql', {'sql': 'COMMIT'})
        with pytest.raises(ValueError, match='frozen_response_missing'):
            store.dispatch('frozen_fetch', {'url': 'https://example.com', 'method': 'GET', 'body': ''})
    finally:
        store.db.close()


def test_real_credentials_and_unsealed_frame_are_rejected(native_runner):
    with pytest.raises(ValueError, match='credentials_forbidden'):
        run(native_runner, base_state(), [frame()], variables={'ML_CONTROLLER_SECRET': 'synthetic-not-a-real-secret'})
    bad = {frame()['input_id']: {**frame(), 'stage': 'snapshot'}}
    with pytest.raises(RuntimeError, match='frozen_frame_missing'):
        run(native_runner, base_state(), [frame()], inputs=bad)


def test_state_checksum_must_match_before_any_native_execution(native_runner):
    with pytest.raises(ValueError, match='state_checksum_mismatch'):
        run_native_paper_frames(state_sql=base_state(), state_checksum='wrong', frame_inputs={}, frames=[],
            account_id=2, variables={}, runner=native_runner)


def test_changed_native_execution_owner_cannot_continue_old_pair(native_runner):
    raw = base_state()
    with pytest.raises(ValueError, match='execution_owner_changed'):
        run_native_paper_frames(state_sql=raw, state_checksum=checksum(raw), frame_inputs={}, frames=[],
            account_id=2, variables={}, runner=native_runner, expected_execution_owner_version='different-engine')


def snapshot_state():
    with sqlite3.connect(':memory:') as db:
        db.executescript(base_state())
        db.executescript((ROOT / 'worker/domain-migrations/ops/0005_ops_artifact_compute_cost_runtime.sql').read_text(encoding='utf-8'))
        db.executescript("""
          INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date)
          VALUES(2,'2330','TSMC',100,100,100,'2026-09-01');
          CREATE TABLE stocks(id INTEGER PRIMARY KEY,symbol TEXT);
          INSERT INTO stocks VALUES(1,'2330'),(2,'0050');
          CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,close REAL);
          INSERT INTO stock_prices VALUES(1,'2026-09-07',110),(2,'2026-09-07',200);
          CREATE TABLE market_risk(date TEXT,twii_close REAL);
          INSERT INTO market_risk VALUES('2026-09-07',22000);
          CREATE TABLE broker_execution_intents(trade_date TEXT);
          CREATE TABLE broker_execution_events(event_time TEXT,received_at TEXT);
          CREATE TABLE system_logs(level TEXT,cron_name TEXT,message TEXT,meta TEXT,created_at TEXT);
        """)
        return '\n'.join(db.iterdump())


def snapshot_input():
    f = {**frame(stage='snapshot'), 'observed_at': '2026-09-07T06:20:00Z'}
    return {**f, 'responses': [{
        'request': {'url': 'https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?interval=1m&range=1d', 'method': 'GET', 'body': ''},
        'response': {'body': '', 'status': 503, 'headers': {}},
    }]}


def test_real_native_snapshot_after_t2_uses_equity_not_just_settled_cash(native_runner):
    close = snapshot_input()
    result = run(native_runner, snapshot_state(), [frame(), close], inputs={frame()['input_id']: frame(), close['input_id']: close})
    with read_state(result) as db:
        row = db.execute('SELECT * FROM paper_daily_snapshots WHERE account_id=2').fetchone()
        # 92,000 settled + 7,000 still receivable + 100 actual held shares * 110.
        assert row['total_value'] == 110000
        assert row['positions_value'] == 11000
        assert db.execute("SELECT COUNT(*) FROM run_artifacts WHERE status='ready' AND checksum_verified_at IS NOT NULL").fetchone()[0] == 2
        assert db.execute('SELECT COUNT(*) FROM _native_private_artifacts').fetchone()[0] == 2
    # Replaying a snapshot is not a full market session and earns no NAV credit.
    assert result['session_complete'] is False
    assert result['nav_maturity_credit'] == 0


def test_native_snapshot_missing_tape_cannot_export_even_if_helper_catches_failure(native_runner):
    close = {**snapshot_input(), 'responses': []}
    with pytest.raises(RuntimeError, match='scope_incomplete'):
        run(native_runner, snapshot_state(), [frame(), close], inputs={frame()['input_id']: frame(), close['input_id']: close})
