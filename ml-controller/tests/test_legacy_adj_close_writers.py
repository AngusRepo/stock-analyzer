"""MEM-M1 / NEW-67#1: raw-quote backfill scripts never write legacy stock_prices.adj_close."""
import re
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("source", ["scripts/backfill_prices.py", "scripts/backfill.ts"])
def test_raw_quote_backfill_scripts_do_not_write_adj_close(source):
    text = (ROOT / source).read_text(encoding="utf-8")
    statements = re.findall(r"INSERT (?:OR IGNORE )?INTO stock_prices\s*\(([^)]*)\)", text)
    assert statements, source
    assert all("adj_close" not in columns for columns in statements)


def test_backfill_ts_statement_leaves_adj_close_null_and_binds_every_column():
    text = (ROOT / "scripts/backfill.ts").read_text(encoding="utf-8")
    sql = re.search(r"sql: `(INSERT INTO stock_prices.*?)`", text, re.S).group(1)
    params = re.search(r"params: \[([^\]]*)\]", text[text.index(sql):]).group(1).split(",")
    assert sql.count("?") == len(params)
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE stock_prices(id INTEGER PRIMARY KEY AUTOINCREMENT,stock_id INTEGER NOT NULL,"
               "date TEXT NOT NULL,open REAL,high REAL,low REAL,close REAL,adj_close REAL,volume INTEGER,"
               "avg_price REAL,UNIQUE(stock_id,date))")
    db.execute(sql, [1, "2026-08-24", 10.0, 11.0, 9.0, 10.5, 1000])
    assert db.execute("SELECT close, adj_close FROM stock_prices").fetchone() == (10.5, None)


def _legacy_price_db():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE stocks(id INTEGER PRIMARY KEY, symbol TEXT)")
    db.execute("INSERT INTO stocks VALUES (7, '0050')")
    db.execute("CREATE TABLE stock_prices(id INTEGER PRIMARY KEY AUTOINCREMENT,stock_id INTEGER NOT NULL,"
               "date TEXT NOT NULL,open REAL,high REAL,low REAL,close REAL,adj_close REAL,volume INTEGER,"
               "avg_price REAL,UNIQUE(stock_id,date))")
    return db


_BENCHMARK_ROW = {"symbol": "0050", "date": "2026-08-24", "open": 190.0, "high": 192.0, "low": 189.0,
                  "close": 191.0, "volume": 1000.0, "value": 191000.0}


def _benchmark_tool():
    pytest.importorskip("pandas")
    import importlib.util
    spec = importlib.util.spec_from_file_location("finlab_paper_benchmark_backfill",
                                                  ROOT / "tools/finlab_paper_benchmark_backfill.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_paper_benchmark_sql_file_never_copies_raw_close_into_adj_close(tmp_path):
    tool = _benchmark_tool()
    path = tmp_path / "bench.sql"
    tool.write_sql_file([_BENCHMARK_ROW], path)
    statements = [line for line in path.read_text(encoding="utf-8").splitlines()
                  if line.startswith("INSERT INTO stock_prices")]
    db = _legacy_price_db()
    for statement in statements:
        db.execute(statement)
    assert db.execute("SELECT stock_id, close, adj_close, avg_price FROM stock_prices").fetchall() == [(7, 191.0, None, 191.0)]


def test_paper_benchmark_upsert_never_copies_raw_close_into_adj_close(monkeypatch):
    tool = _benchmark_tool()
    calls = []
    monkeypatch.setattr(tool, "ensure_stock", lambda symbol: 7)
    monkeypatch.setattr(tool, "d1_exec", lambda sql, params=None: calls.append((sql, params)))
    tool.upsert_prices([_BENCHMARK_ROW])
    sql, params = next(call for call in calls if call[0].startswith("INSERT INTO stock_prices"))
    db = _legacy_price_db()
    db.execute(sql, params)
    assert db.execute("SELECT stock_id, close, adj_close, avg_price FROM stock_prices").fetchall() == [(7, 191.0, None, 191.0)]


# Counterexample (independent review 11/24): INSERT OR REPLACE deletes the conflicting row, so a
# raw-quote rerun over a date the FinLab canonical sync already filled NULLed its adj_close and
# avg_price. The writers now upsert like the live writer (worker/src/lib/twseApi.ts) and never
# touch adj_close.
def _canonical_row_db():
    db = _legacy_price_db()
    db.execute("INSERT INTO stock_prices(stock_id,date,open,high,low,close,adj_close,volume,avg_price) "
               "VALUES (7,'2026-08-24',190,192,189,190.5,176.4,900,190.2)")
    return db


@pytest.mark.parametrize("source", ["scripts/backfill.ts", "tools/finlab_paper_benchmark_backfill.py"])
def test_raw_quote_writers_never_replace_stock_prices_rows(source):
    assert "INSERT OR REPLACE INTO stock_prices" not in (ROOT / source).read_text(encoding="utf-8")


def test_backfill_ts_rerun_keeps_canonical_adj_close_and_avg_price():
    text = (ROOT / "scripts/backfill.ts").read_text(encoding="utf-8")
    sql = re.search(r"sql: `(INSERT INTO stock_prices.*?)`", text, re.S).group(1)
    db = _canonical_row_db()
    db.execute(sql, [7, "2026-08-24", 190.0, 192.0, 189.0, 191.0, 1000])
    assert db.execute("SELECT close, volume, adj_close, avg_price FROM stock_prices").fetchall() == [(191.0, 1000, 176.4, 190.2)]


def test_paper_benchmark_sql_file_rerun_keeps_canonical_adj_close(tmp_path):
    tool = _benchmark_tool()
    path = tmp_path / "bench.sql"
    tool.write_sql_file([_BENCHMARK_ROW], path)
    db = _canonical_row_db()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("INSERT INTO stock_prices"):
            db.execute(line)
    assert db.execute("SELECT close, volume, adj_close, avg_price FROM stock_prices").fetchall() == [(191.0, 1000, 176.4, 191.0)]


def test_paper_benchmark_upsert_rerun_keeps_canonical_adj_close(monkeypatch):
    tool = _benchmark_tool()
    calls = []
    monkeypatch.setattr(tool, "ensure_stock", lambda symbol: 7)
    monkeypatch.setattr(tool, "d1_exec", lambda sql, params=None: calls.append((sql, params)))
    tool.upsert_prices([_BENCHMARK_ROW])
    sql, params = next(call for call in calls if call[0].startswith("INSERT INTO stock_prices"))
    db = _canonical_row_db()
    db.execute(sql, params)
    assert db.execute("SELECT close, volume, adj_close, avg_price FROM stock_prices").fetchall() == [(191.0, 1000, 176.4, 191.0)]
