import sqlite3

import pytest

from services.native_paper_bootstrap import capture_native_bootstrap
from services.native_paper_sandbox import native_runtime_manifest, PrivatePaperStore
from test_native_paper_sandbox import native_runner, ROOT, frame


def fixture():
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    for path in ('core/0001_core_baseline.sql', 'paper/0001_paper_baseline.sql',
                 'paper/0004_corporate_action_accounting.sql', 'market/0001_market_baseline.sql'):
        db.executescript((ROOT / 'worker/domain-migrations' / path).read_text(encoding='utf-8'))
    db.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','TSMC','TWSE')")
    db.execute('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,100000,100000),(2,777,777)')
    db.execute("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-09-08',999)")
    db.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES('2026-09-07',1,'2330','TSMC',1,50,'seed')")
    def query(sql, args):
        return [dict(row) for row in db.execute(sql, args)]
    return db, query


def test_bootstrap_uses_native_owner_keeps_constraints_and_does_not_copy_future_market_rows(native_runner):
    db, query = fixture()
    try:
        manifest = native_runtime_manifest(native_runner)
        before = db.total_changes
        state = capture_native_bootstrap(domain_queries={domain: query for domain in set(manifest['tables'].values())},
            ownership=manifest['tables'], account_id=1, signal_date='2026-09-07', frozen_kv={})
        assert db.total_changes == before
        store = PrivatePaperStore(state['state_sql'], state['state_checksum'], {frame()['input_id']: frame()})
        try:
            assert store.db.execute('SELECT COUNT(*) FROM paper_accounts').fetchone()[0] == 1
            assert store.db.execute('SELECT COUNT(*) FROM stock_prices').fetchone()[0] == 0
            assert state['source_tables']['stock_prices'] == 'market'
            assert len(state['seed_rows']) == 1
            assert store.db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_rec_date'").fetchone()[0] == 1
            store.dispatch('frame_input', {**frame(), 'now_ms': 1788739200000})
            store.dispatch('frame_begin', {})
            with pytest.raises(sqlite3.IntegrityError):
                store.db.execute("INSERT INTO paper_positions(account_id,symbol,shares,avg_cost) VALUES(999,'2330',1,100)")
        finally:
            store.db.close()
    finally:
        db.close()


def test_bootstrap_changed_sources_cannot_publish(native_runner):
    db, query = fixture()
    calls = [0]
    def changing(sql, args):
        if sql.startswith('SELECT * FROM paper_accounts'):
            calls[0] += 1
            if calls[0] == 2:
                db.execute('UPDATE paper_accounts SET cash=cash+1 WHERE id=1')
        return query(sql, args)
    try:
        owners = native_runtime_manifest(native_runner)['tables']
        with pytest.raises(ValueError, match='source_changed_during_capture'):
            capture_native_bootstrap(domain_queries={domain: changing for domain in set(owners.values())},
                ownership=owners, account_id=1, signal_date='2026-09-07', frozen_kv={})
    finally:
        db.close()
