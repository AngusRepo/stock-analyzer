"""Ensemble signal chunks: the date-index read returns the same rows as the original model-index read."""
from __future__ import annotations

import re
import sqlite3
import threading
from pathlib import Path

from services import dataset_snapshot_exporter as exporter

_ORIGINAL_SQL = """
            SELECT id, stock_id, generated_at, prediction_date, trade_signal,
                   direction_accuracy, entry_price, stop_loss, target1, target2,
                   forecast_data
            FROM predictions
            WHERE model_name = 'ensemble'
              AND prediction_date >= ?
              AND prediction_date <= ?
            ORDER BY stock_id, generated_at
            """
_SCHEMA = (Path(__file__).parents[2] / "worker/domain-schemas/learning.sql").read_text(encoding="utf-8")


class _SqliteClient:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.lock = threading.Lock()
        self.calls: list[tuple[str, list]] = []

    def query(self, sql, params=None, timeout=None):
        with self.lock:
            self.calls.append((sql, list(params or [])))
            cur = self.conn.execute(sql, list(params or []))
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


def _database() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)  # _query_date_range reads chunks on a pool
    conn.execute(re.search(r"CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);", _SCHEMA)[0])
    for index in re.findall(r"CREATE INDEX IF NOT EXISTS \w+\s+ON predictions\([^;]*\);", _SCHEMA):
        conn.execute(index)
    insert = ("INSERT INTO predictions (stock_id, model_name, generated_at, prediction_date, trade_signal,"
              " direction_accuracy, entry_price, stop_loss, target1, target2, forecast_data, verified_at)"
              " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    i = 0
    for day in range(1, 29):
        date = f"2026-02-{day:02d}"
        for model in ("ensemble", "LightGBM", "TabM", "ensemble_v2"):
            for stock in range(5):
                i += 1
                # Mixed shapes the original range predicate already treats as text: a time
                # suffix sorts after the chunk's last day, so both reads drop it there.
                prediction_date = f"{date}T08:00:00" if stock == 4 else date
                generated = f"{date} 0{stock % 2}:00:00"  # ties on (stock_id, generated_at)
                conn.execute(insert, (2300 + stock, model, generated, prediction_date,
                                      ("buy", "sell", "hold")[i % 3], 0.5 + stock / 10, 10.0 + i, 9.0, 11.0, 12.0,
                                      None if i % 7 == 0 else f'{{"i": {i}}}',
                                      None if i % 3 == 0 else f"{date} 12:00:00"))
    # Re-generated rows for the same stock/date, rows without a date and rows outside the range.
    conn.execute(insert, (2300, "ensemble", "2026-02-10 00:00:00", "2026-02-11", "buy", 0.6, 1, 1, 1, 1, "{}", None))
    conn.execute(insert, (2301, "ensemble", "2026-02-10 09:00:00", None, "buy", 0.6, 1, 1, 1, 1, "{}", None))
    conn.execute(insert, (2302, "ensemble", "2025-12-31 09:00:00", "2025-12-31", "buy", 0.6, 1, 1, 1, 1, "{}", None))
    conn.execute(insert, (2303, "ensemble", "2026-03-31 09:00:00", "2026-03-31", "buy", 0.6, 1, 1, 1, 1, "{}", None))
    conn.execute(insert, (2304, "Ensemble", "2026-02-12 09:00:00", "2026-02-12", "buy", 0.6, 1, 1, 1, 1, "{}", None))
    return conn


def _key(row: dict) -> tuple:
    return (row["stock_id"], row["generated_at"], row["id"])


def test_every_chunk_returns_the_original_rows():
    conn = _database()
    client = _SqliteClient(conn)
    total = 0
    for chunk_days in (1, 3, 10, 30):
        for start, end in exporter._date_chunks("2026-01-25", "2026-03-05", chunk_days):
            old = client.query(_ORIGINAL_SQL, [start, end])
            new = client.query(exporter.ENSEMBLE_SIGNALS_SQL, [start, end])
            assert sorted(old, key=_key) == sorted(new, key=_key), (start, end)
            # The SQL order (stock_id, generated_at) holds; the exporter breaks ties by id afterwards.
            assert [r[:2] for r in map(_key, new)] == sorted(r[:2] for r in map(_key, new))
            total += len(new)
    assert total > 0


def test_export_frame_matches_the_original_read():
    conn = _database()
    old, old_queries = exporter._query_date_range(_ORIGINAL_SQL, "2026-01-25", "2026-03-05", 10,
                                                  query_client=_SqliteClient(conn))
    new, new_queries = exporter._query_date_range(exporter.ENSEMBLE_SIGNALS_SQL, "2026-01-25", "2026-03-05", 10,
                                                  query_client=_SqliteClient(conn))
    assert old_queries == new_queries == 4
    assert old.height == new.height > 0
    assert old.sort(["stock_id", "generated_at", "id"]).equals(new.sort(["stock_id", "generated_at", "id"]))


def test_chunk_read_seeks_the_date_index():
    conn = _database()
    plan = [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + exporter.ENSEMBLE_SIGNALS_SQL,
                                           ["2026-02-01", "2026-02-10"])]
    assert any(d.startswith("SEARCH predictions USING INDEX idx_pred_date_model_stock (prediction_date>? AND prediction_date<?)")
               for d in plan), plan
    assert not any(d.startswith("SCAN ") for d in plan), plan
    assert not any("idx_pred_model_verified_date" in d for d in plan), plan
