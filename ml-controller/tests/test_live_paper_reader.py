from __future__ import annotations

import math
import sqlite3
from pathlib import Path

import pytest

from services.live_paper_reader import D1PaperReader, PaperDenominatorNotReady

ROOT = Path(__file__).resolve().parents[2]
# paper/0013 (live/l0-seam) owns this table; the reader only selects these two columns.
SIZING = "CREATE TABLE paper_order_sizing_v1 (order_id INTEGER PRIMARY KEY, portfolio_value REAL)"


def _paper():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript((ROOT / "worker/domain-migrations/paper/0001_paper_baseline.sql").read_text())
    conn.execute(SIZING)
    conn.execute("INSERT INTO paper_accounts(id, cash, initial_cash) VALUES (1, 1e6, 1e6), (2, 1e6, 1e6)")
    seen = []

    def query(sql, params, timeout):
        seen.append(sql)
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    return conn, query, seen


def _insert(conn, oid, side, source="auto_ml", account=1, symbol="2330"):
    conn.execute("INSERT INTO paper_orders(id, account_id, symbol, side, shares, price, total_cost, source, created_at) "
                 "VALUES (?, ?, ?, ?, 1000, 100.0, 100000, ?, '2026-12-10 02:00:00')",
                 [oid, account, symbol, side, source])


def test_orders_are_the_paper_accounts_committed_orders_oldest_first():
    conn, query, _ = _paper()
    _insert(conn, 3, "sell", "intraday_exit")
    _insert(conn, 1, "buy")
    _insert(conn, 2, "buy", account=2)
    orders = D1PaperReader(query=query).orders()
    assert [o["id"] for o in orders] == [1, 3]
    assert orders[0] == {"id": 1, "symbol": "2330", "side": "buy", "shares": 1000, "price": 100.0,
                         "source": "auto_ml", "created_at": "2026-12-10 02:00:00"}


def test_an_auto_ml_buy_reads_its_sizing_value():
    conn, query, _ = _paper()
    _insert(conn, 1, "buy")
    conn.execute("INSERT INTO paper_order_sizing_v1 VALUES (1, 987654.5)")
    reader = D1PaperReader(query=query)
    assert reader.portfolio_value(reader.orders()[0]) == 987654.5


def test_a_missing_sizing_row_is_not_ready_not_absent():
    conn, query, _ = _paper()
    _insert(conn, 1, "buy")
    conn.execute("INSERT INTO paper_order_sizing_v1 VALUES (2, 5.0)")  # another order's row
    reader = D1PaperReader(query=query)
    with pytest.raises(PaperDenominatorNotReady, match="missing"):
        reader.portfolio_value(reader.orders()[0])


def test_a_failed_sizing_read_is_not_ready():
    conn, query, _ = _paper()
    _insert(conn, 1, "buy")
    order = D1PaperReader(query=query).orders()[0]

    def broken(sql, params, timeout):
        raise TimeoutError("d1 token=secret")

    with pytest.raises(PaperDenominatorNotReady) as caught:
        D1PaperReader(query=broken).portfolio_value(order)
    assert str(caught.value) == "read_failed:TimeoutError" and caught.value.__cause__ is None


def test_orders_without_a_sizing_writer_never_wait():
    conn, query, seen = _paper()
    _insert(conn, 1, "buy", "manual")
    _insert(conn, 2, "sell", "intraday_exit")
    _insert(conn, 3, "sell", "auto_ml")
    reader = D1PaperReader(query=query)
    orders = reader.orders()
    seen.clear()
    assert [reader.portfolio_value(o) for o in orders] == [None, None, None]
    assert seen == []  # no sizing read for them


@pytest.mark.parametrize("bad", [0, -1.0, math.inf, math.nan, None, "100", True])
def test_an_unusable_sizing_value_is_absent(bad):
    _, _, _ = _paper()
    reader = D1PaperReader(query=lambda sql, params, timeout: [{"portfolio_value": bad}])
    assert reader.portfolio_value({"id": 1, "side": "buy", "source": "auto_ml"}) is None


def test_the_reader_only_reads():
    conn, query, seen = _paper()
    _insert(conn, 1, "buy")
    conn.execute("INSERT INTO paper_order_sizing_v1 VALUES (1, 10.0)")
    reader = D1PaperReader(query=query)
    reader.portfolio_value(reader.orders()[0])
    assert seen and all(sql.lstrip().upper().startswith("SELECT") for sql in seen)
