import sqlite3
import pytest
from services.native_paper_bootstrap import capture_native_bootstrap
from services.native_paper_sandbox import native_runtime_manifest
from test_native_paper_bootstrap import fixture
from test_native_paper_sandbox import native_runner


def test_full_event_history_exceeds_old_row_ceiling_without_losing_fields_or_ids(native_runner):
    db, query = fixture()
    try:
        db.execute('ALTER TABLE paper_execution_events ADD COLUMN extra_evidence TEXT')
        db.executemany("INSERT INTO paper_execution_events(account_id,trade_date,event_type,status,detail_json,extra_evidence) VALUES(1,'2026-09-06','pending_buy','recorded',?,?)",
                       [('完整證據🐇', None)] * 100005)
        db.execute("INSERT INTO paper_execution_events(id,account_id,trade_date,event_type,status,detail_json) VALUES(-9,1,'2020-01-01','corporate_opening_basis','recorded','old basis')")
        db.execute("INSERT INTO paper_execution_events(account_id,trade_date,event_type,status) VALUES(2,'2026-09-06','other account','recorded')")
        expected=query('SELECT * FROM paper_execution_events WHERE account_id=1 ORDER BY id', [])
        observed=[]
        def tracked(sql,args):
            if sql.startswith('SELECT * FROM paper_execution_events'):
                observed.append((sql,args))
            return query(sql,args)
        owners=native_runtime_manifest(native_runner)['tables']
        before=db.total_changes
        state=capture_native_bootstrap(domain_queries={d:tracked for d in set(owners.values())},
            ownership=owners,account_id=1,signal_date='2026-09-07',frozen_kv={})
        assert db.total_changes==before
        restored=sqlite3.connect(':memory:');restored.row_factory=sqlite3.Row
        try:
            restored.executescript(state['state_sql'])
            assert [dict(r) for r in restored.execute('SELECT * FROM paper_execution_events ORDER BY id')]==expected
        finally:restored.close()
        assert len(expected)==100006
        assert all('OFFSET' not in sql for sql,_ in observed)
        assert sum('id>?' not in sql for sql,_ in observed)==2  # two complete source checks
    finally:db.close()


def test_byte_budget_fails_closed_and_keeps_other_table_row_bound(native_runner):
    db,query=fixture()
    try:
        owners=native_runtime_manifest(native_runner)['tables']
        args=dict(domain_queries={d:query for d in set(owners.values())},ownership=owners,
                  account_id=1,signal_date='2026-09-07',frozen_kv={})
        with pytest.raises(ValueError,match='copy_bytes_exceeded'):
            capture_native_bootstrap(**args,max_copy_bytes=1)
        db.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(2,'0050','ETF','TWSE')")
        with pytest.raises(ValueError,match='copy_bound_exceeded:stocks'):
            capture_native_bootstrap(**args,max_rows=1)
        for value in (0,-1,True):
            with pytest.raises(ValueError,match='copy_budget_invalid'):
                capture_native_bootstrap(**args,max_copy_bytes=value)
    finally:db.close()


def test_event_cursor_regression_is_rejected(native_runner):
    db,query=fixture()
    try:
        owners=native_runtime_manifest(native_runner)['tables']
        def malformed(sql,args):
            if sql.startswith('SELECT * FROM paper_execution_events'):
                return [{'id':2},{'id':1}]
            return query(sql,args)
        with pytest.raises(ValueError,match='event_cursor_invalid'):
            capture_native_bootstrap(domain_queries={d:malformed for d in set(owners.values())},
                ownership=owners,account_id=1,signal_date='2026-09-07',frozen_kv={})
    finally:db.close()
