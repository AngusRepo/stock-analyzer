import importlib.util
import sqlite3
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location("repair",Path(__file__).parents[1]/"scripts/repair_training_price_gaps.py")
repair=importlib.util.module_from_spec(spec);spec.loader.exec_module(repair)

def sources():
    return {f:{"2026-04-15":{"2330":v,"6488":v,"UNKNOWN":v}} for f,v in zip(repair.FIELDS,[10,12,9,11,22,1000,11000])}

def test_existing_rows_are_preserved_and_repair_is_idempotent():
    ids=[{"id":1,"symbol":"2330"},{"id":2,"symbol":"6488"}]
    rows=repair.build_missing_rows(ids,[{"stock_id":1,"date":"2026-04-15"}],sources(),["2026-04-15"])
    assert len(rows)==1 and rows[0]['stock_id']==2 and rows[0]['avg_price']==11
    db=sqlite3.connect(':memory:')
    db.execute('CREATE TABLE stock_prices (stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,close REAL,adj_close REAL,volume INTEGER,avg_price REAL,UNIQUE(stock_id,date))')
    db.execute("INSERT INTO stock_prices(stock_id,date,close) VALUES(2,'2026-04-15',999)")
    db.executescript(repair.render_sql(rows));db.executescript(repair.render_sql(rows))
    assert db.execute('SELECT COUNT(*),close FROM stock_prices').fetchone()==(1,999)

@pytest.mark.parametrize('value',[float('nan'),-1])
def test_invalid_source_cannot_generate_sql(value):
    source=sources();source['close']['2026-04-15']['2330']=value
    with pytest.raises(ValueError):repair.build_missing_rows([{'id':1,'symbol':'2330'}],[],source,['2026-04-15'])

def test_incomplete_source_is_never_fabricated():
    source=sources();source['volume']['2026-04-15']['2330']=None
    assert repair.build_missing_rows([{'id':1,'symbol':'2330'}],[],source,['2026-04-15'])==[]
