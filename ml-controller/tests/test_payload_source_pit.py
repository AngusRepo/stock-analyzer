"""Execute the original misc loader against isolated SQLite, including failures."""
import sqlite3

import pytest

from services import payload_builder as builder


@pytest.fixture
def source_db(monkeypatch):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE margin_data(stock_id INTEGER,date TEXT,margin_balance REAL,short_ratio REAL);
        CREATE TABLE shareholding(stock_id INTEGER,date TEXT,retail_pct REAL);
        CREATE TABLE canonical_revenue_monthly(stock_id TEXT,revenue_month TEXT,as_of_date TEXT,
            yoy REAL,mom REAL,revenue REAL);
        CREATE TABLE canonical_fundamental_features(stock_id TEXT,available_date TEXT,as_of_date TEXT,
            period TEXT,source TEXT,eps REAL,roe REAL,pe REAL,pb REAL,dividend_yield REAL);
        INSERT INTO margin_data VALUES(1,'2026-09-05',100,.1),(1,'2026-09-07',900,.9);
        INSERT INTO shareholding VALUES(1,'2026-09-05',.2),(1,'2026-09-07',.8);
        INSERT INTO canonical_revenue_monthly VALUES('1000','2026-08','2026-09-04',5,6,1000);
        INSERT INTO canonical_fundamental_features VALUES
          ('1000','2026-09-04','2026-09-04','2026Q2','finlab.fundamental_factor_diversity',3,10,15,2,4),
          ('1000','2026-09-07','2026-09-07','2026Q3','finlab.fundamental_factor_diversity',30,20,25,3,5);
    """)
    def query(sql, params, **kwargs):
        return [dict(row) for row in db.execute(sql, params)]
    monkeypatch.setattr(builder.MARKET_D1_CLIENT, 'query', query)
    try:
        yield db, query
    finally:
        db.close()


def test_misc_loader_uses_decision_day_not_newest_margin_or_shareholding(source_db):
    db, _ = source_db
    # Prior unbounded query chooses data after the requested decision day.
    assert db.execute('SELECT margin_balance FROM margin_data ORDER BY date DESC LIMIT 1').fetchone()[0] == 900
    assert db.execute('SELECT retail_pct FROM shareholding ORDER BY date DESC LIMIT 1').fetchone()[0] == .8
    actual = builder._bulk_load_per_stock_misc([1], {1: '1000'}, decision_date='2026-09-06')[1]
    assert actual['margin_balance'] == 100
    assert actual['short_ratio'] == .1
    assert actual['retail_pct'] == .2
    assert actual['eps'] == 3
    assert actual['revenue'] == 1000
    # A later decision can legitimately consume those later observations.
    later = builder._bulk_load_per_stock_misc([1], {1: '1000'}, decision_date='2026-09-07')[1]
    assert later['margin_balance'] == 900 and later['retail_pct'] == .8 and later['eps'] == 30
    assert builder._bulk_load_per_stock_misc([1], {1: '1000'}, decision_date='2026-09-01') == {1: {}}


@pytest.mark.parametrize('fail_after_first_chunk', [False, True])
def test_fundamental_query_failure_is_not_an_empty_success(source_db, monkeypatch, fail_after_first_chunk):
    _, query = source_db
    fundamental_reads = []
    def interrupted(sql, params, **kwargs):
        if 'FROM canonical_fundamental_features' in sql:
            fundamental_reads.append(params)
            if not fail_after_first_chunk or len(fundamental_reads) == 2:
                raise RuntimeError('isolated raw source failure')
        return query(sql, params, **kwargs)
    monkeypatch.setattr(builder.MARKET_D1_CLIENT, 'query', interrupted)
    ids = list(range(1, 82)) if fail_after_first_chunk else [1]
    with pytest.raises(RuntimeError, match='isolated raw source failure'):
        builder._bulk_load_per_stock_misc(ids, {sid: str(999 + sid) for sid in ids}, decision_date='2026-09-06')
    assert len(fundamental_reads) == (2 if fail_after_first_chunk else 1)


def test_successful_empty_fundamental_table_remains_distinct_from_failure(source_db):
    db, _ = source_db
    db.execute('DELETE FROM canonical_fundamental_features')
    result = builder._bulk_load_per_stock_misc([1], {1: '1000'}, decision_date='2026-09-06')[1]
    assert result['margin_balance'] == 100
    assert 'eps' not in result
