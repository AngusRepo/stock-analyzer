"""Wider market reads and seekable news/shareholding filters return the rows the former reads did."""
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import polars as pl
import pytest

from services import dataset_snapshot_exporter as exporter
from services.dataset_snapshot_exporter import SENTIMENT_SCORES_SQL, SHAREHOLDING_SQL

MARKET_MIGRATIONS = Path(__file__).resolve().parents[2] / "worker" / "domain-migrations" / "market"

FORMER_SENTIMENT_SQL = """
        SELECT stock_id, date(published_at) as date,
               AVG(CASE sentiment WHEN 'positive' THEN 1 WHEN 'negative' THEN -1 ELSE 0 END) as score
        FROM news
        WHERE date(published_at) >= ? AND date(published_at) <= ?
        GROUP BY stock_id, date(published_at)
        ORDER BY stock_id, date
        """
FORMER_SHAREHOLDING_SQL = """
        SELECT stock_id, CASE WHEN length(date)=8 THEN substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2) ELSE date END AS date, total_shares, holder_count, retail_shares,
               retail_pct, large_holder_shares, large_holder_pct, created_at
        FROM shareholding
        WHERE replace(date, '-', '') >= replace(?, '-', '') AND replace(date, '-', '') <= replace(?, '-', '')
        ORDER BY stock_id, date
        """


def _days(start, end):
    day = date.fromisoformat(start)
    while day <= date.fromisoformat(end):
        yield day.isoformat()
        day += timedelta(days=1)


class OrderedTableClient:
    """Answers `stock_id, date` rows of [start, end] in the SQL's ORDER BY stock_id, date."""

    def __init__(self):
        self.calls = []

    def query(self, sql, params, timeout=None):
        self.calls.append(list(params))
        start, end = params[0], params[1]
        days = [day for day in _days(start, end) if not day.endswith("-05")]  # a day without rows
        return [{"stock_id": stock, "date": day, "close": float(stock) + int(day[-2:])}
                for stock in (1101, 2330, 2454) for day in days]


@pytest.mark.parametrize("workers", ["1", "4"])
def test_wider_reads_concat_to_the_per_chunk_frame(monkeypatch, workers):
    monkeypatch.setenv("DATASET_SNAPSHOT_QUERY_WORKERS", workers)
    per_chunk_client, wide_client = OrderedTableClient(), OrderedTableClient()
    per_chunk, per_chunk_queries = exporter._query_date_range(
        "SELECT stock_id, date, close FROM t WHERE date >= ? AND date <= ? ORDER BY stock_id, date",
        "2026-01-01", "2026-01-23", 1, query_client=per_chunk_client)
    wide, wide_queries = exporter._query_date_range(
        "SELECT stock_id, date, close FROM t WHERE date >= ? AND date <= ? ORDER BY stock_id, date",
        "2026-01-01", "2026-01-23", 1, query_client=wide_client,
        read_chunk_days=exporter.MARKET_READ_CHUNK_DAYS)
    assert (per_chunk_queries, wide_queries) == (23, 5)
    assert wide.equals(per_chunk)
    assert sorted(wide_client.calls)[-1] == ["2026-01-21", "2026-01-23"]


@pytest.mark.parametrize(("chunk_days", "read_days", "expected"), [
    (1, 5, 5), (2, 5, 6), (3, 5, 6), (5, 5, 5), (30, 5, 30), (1, None, 1), (1, 0, 1),
])
def test_read_chunks_hold_whole_export_chunks(chunk_days, read_days, expected):
    assert exporter._read_chunk_days(chunk_days, read_days) == expected


def test_bind_shape_orders_the_chunk_bounds():
    client = OrderedTableClient()
    exporter._query_date_range("SELECT 1 FROM t", "2026-01-01", "2026-01-02", 1, query_client=client,
                               read_chunk_days=5, bind_shape=("start", "end", "start", "end"))
    assert client.calls == [["2026-01-01", "2026-01-02", "2026-01-01", "2026-01-02"]]


def _market_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    for path in sorted(MARKET_MIGRATIONS.glob("*.sql")):
        db.executescript(path.read_text())
    return db


def _rows(db, sql, params):
    return [dict(row) for row in db.execute(sql, params).fetchall()]


def _plan(db, sql, params):
    return [row["detail"] for row in db.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall()]


def test_news_filter_matches_former_rows_and_seeks():
    db = _market_db()
    published = [
        "2026-04-12T23:59:59Z", "2026-04-13T00:00:00Z", "2026-04-13T15:59:59Z", "2026-04-14T01:00:00+08:00",
        "2026-04-14T23:30:00-05:00", "2026-04-15 09:00:00", "2026-04-15", "2026-04-16T00:00:00.000Z",
        "2026-04-17T12:00:00Z", "2026-04-18T00:30:00+09:00", "2026-04-20T00:00:00Z",
    ]
    for index, stamp in enumerate(published):
        for stock in (2330, 1101):
            db.execute("INSERT INTO news (stock_id, title, published_at, sentiment) VALUES (?, ?, ?, ?)",
                       (stock, f"n{index}", stamp, ("positive", "negative", "neutral")[index % 3]))
    for start, end in [("2026-04-13", "2026-04-13"), ("2026-04-13", "2026-04-17"), ("2026-04-14", "2026-04-15"),
                       ("2026-04-18", "2026-04-22"), ("2026-04-01", "2026-04-30")]:
        assert _rows(db, SENTIMENT_SCORES_SQL, [start, end, start, end]) == _rows(db, FORMER_SENTIMENT_SQL, [start, end]), (start, end)
    assert len(_rows(db, SENTIMENT_SCORES_SQL, ["2026-04-01", "2026-04-30"] * 2)) > 8
    plan = _plan(db, SENTIMENT_SCORES_SQL, ["2026-04-13", "2026-04-17"] * 2)
    assert any(detail.startswith("SEARCH news USING ") and "published_at>?" in detail for detail in plan), plan
    assert not any(detail.startswith("SCAN news") for detail in plan), plan


def test_shareholding_filter_matches_former_rows_and_seeks():
    db = _market_db()
    columns = "stock_id, date, total_shares, holder_count, retail_shares, retail_pct, large_holder_shares, large_holder_pct, created_at"
    for stock in (2330, 1101):
        for stamp in ("2026-04-10", "20260410", "2026-04-17", "20260417", "20260424", "2026-05-01", "20260508", "2026-04-3"):
            db.execute(f"INSERT OR IGNORE INTO shareholding ({columns}) VALUES (?, ?, 1, 1, 1, 1, 1, 1, 'now')", (stock, stamp))
    for start, end in [("2026-04-10", "2026-04-10"), ("2026-04-10", "2026-04-17"), ("2026-04-11", "2026-04-30"),
                       ("2026-04-24", "2026-05-08"), ("2026-01-01", "2026-12-31")]:
        params = [start, end] * 3
        assert _rows(db, SHAREHOLDING_SQL, params) == _rows(db, FORMER_SHAREHOLDING_SQL, [start, end]), (start, end)
    plan = _plan(db, SHAREHOLDING_SQL, ["2026-04-10", "2026-04-17"] * 3)
    assert any("idx_shareholding_date" in detail for detail in plan), plan
    assert not any(detail.startswith("SCAN shareholding") for detail in plan), plan


class FirstDateClient(OrderedTableClient):
    """OrderedTableClient whose table holds no row before `first`; answers the MIN query."""

    def __init__(self, first):
        super().__init__()
        self.first = first

    def query(self, sql, params, timeout=None):
        if sql.startswith("SELECT MIN("):
            self.calls.append([])
            return [{"d": self.first}]
        if self.first is None or params[1] < self.first:
            self.calls.append(list(params))
            return []
        return super().query(sql, [max(params[0], self.first), params[1]])


@pytest.mark.parametrize(("chunk_days", "read_days"), [(1, None), (1, 5), (3, 5), (10, None)])
@pytest.mark.parametrize("workers", ["1", "4"])
def test_reads_before_the_first_hot_date_are_skipped(monkeypatch, chunk_days, read_days, workers):
    monkeypatch.setenv("DATASET_SNAPSHOT_QUERY_WORKERS", workers)
    sql = "SELECT stock_id, date, close FROM t WHERE date >= ? AND date <= ? ORDER BY stock_id, date"
    every_client, skip_client = FirstDateClient("2026-02-07"), FirstDateClient("2026-02-07")
    every, every_queries = exporter._query_date_range(sql, "2026-01-01", "2026-03-10", chunk_days,
        query_client=every_client, read_chunk_days=read_days)
    hot, hot_queries = exporter._query_date_range(sql, "2026-01-01", "2026-03-10", chunk_days,
        query_client=skip_client, read_chunk_days=read_days, first_date_sql="SELECT MIN(date) AS d FROM t")
    assert hot.height > 0 and hot.equals(every)
    reads = [call for call in skip_client.calls if call]
    assert all(end >= "2026-02-07" for _, end in reads)
    assert len(reads) < every_queries and hot_queries == len(reads) + 1


def test_an_empty_table_reads_nothing_but_its_first_date():
    client = FirstDateClient(None)
    frame, count = exporter._query_date_range(
        "SELECT stock_id, date FROM t WHERE date >= ? AND date <= ?", "2026-01-01", "2026-01-31", 1,
        query_client=client, read_chunk_days=5, first_date_sql="SELECT MIN(date) AS d FROM t")
    assert frame.is_empty() and count == 1 and client.calls == [[]]


@pytest.mark.parametrize("table", ["stock_prices", "technical_indicators", "chip_data", "margin_data",
                                   "canonical_broker_flow_daily"])
def test_first_market_date_is_one_index_seek(table):
    plan = _plan(_market_db(), exporter._first_date_sql(table, "date"), [])
    assert len(plan) == 1 and plan[0].startswith(f"SEARCH {table} USING COVERING INDEX "), plan
