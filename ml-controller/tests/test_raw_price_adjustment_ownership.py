"""Execute actual worker upserts against SQLite to verify price ownership."""
import re,sqlite3
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[2]
@pytest.mark.parametrize("source",["worker/src/lib/twseApi.ts","worker/src/routes/stocks.ts"])
def test_raw_quote_upsert_preserves_canonical_adjustment(source):
 text=(ROOT/source).read_text(encoding="utf-8")
 statements=re.findall(r"`(INSERT INTO stock_prices .*?)`",text,re.S)
 assert len(statements)==1
 sql=statements[0]
 db=sqlite3.connect(":memory:")
 db.execute("CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,close REAL,adj_close REAL,volume INTEGER,avg_price REAL,PRIMARY KEY(stock_id,date))")
 db.execute("INSERT INTO stock_prices(stock_id,date,close,adj_close) VALUES(1,'2026-08-24',100,387.9)")
 values=[1,"2026-08-24",101,103,99,102,1000]
 if sql.count("?")==8:values.append(101.5)
 db.execute(sql,values)
 assert db.execute("SELECT close,adj_close FROM stock_prices").fetchone()==(102,387.9)
 values[1]="2026-08-25";db.execute(sql,values)
 assert db.execute("SELECT adj_close FROM stock_prices WHERE date='2026-08-25'").fetchone()==(None,)


def test_canonical_mirror_missing_adjustment_does_not_invent_or_erase_price():
 text=(ROOT/"worker/src/lib/updateOrchestrator.ts").read_text(encoding="utf-8")
 sql=re.search(r"`\s*(INSERT INTO stock_prices .*?)`",text,re.S).group(1)
 assert "row.adj_close ?? row.close" not in text
 db=sqlite3.connect(":memory:")
 db.execute("CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,close REAL,adj_close REAL,volume INTEGER,avg_price REAL,PRIMARY KEY(stock_id,date))")
 values=[1,"2026-08-24",100,102,99,101,390.,1000,100.5]
 db.execute(sql,values)
 values[6]=None;db.execute(sql,values)
 assert db.execute("SELECT adj_close FROM stock_prices").fetchone()==(390.,)
 values[1]="2026-08-25";db.execute(sql,values)
 assert db.execute("SELECT adj_close FROM stock_prices WHERE date='2026-08-25'").fetchone()==(None,)
 values[6]=395.;db.execute(sql,values)
 assert db.execute("SELECT adj_close FROM stock_prices WHERE date='2026-08-25'").fetchone()==(395.,)
