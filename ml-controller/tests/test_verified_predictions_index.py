"""load_verified_predictions seeks learning 0074's partial covering index and returns the same rows."""
from __future__ import annotations

import random
import re
import sqlite3
from pathlib import Path
from types import SimpleNamespace

from services import backtest_state, retention_history

ROOT = Path(__file__).resolve().parents[2] / "worker"
SCHEMA = (ROOT / "domain-schemas/learning.sql").read_text(encoding="utf-8")
MIGRATION = (ROOT / "domain-migrations/learning/0074_predictions_verified_generated_index.sql").read_text(encoding="utf-8")
INDEX = "idx_pred_verified_generated"


def _statement(sql: str) -> str:
    found = re.search(rf"CREATE INDEX IF NOT EXISTS {INDEX}[^;]*;", sql)
    assert found, INDEX
    return " ".join(found[0].split())


def _database(with_index: bool) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(re.search(r"CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);", SCHEMA)[0])
    for index in re.findall(r"CREATE INDEX IF NOT EXISTS \w+\s+ON predictions\([^;]*\);", SCHEMA):
        if with_index or INDEX not in index:
            conn.execute(index)
    rng = random.Random(74)
    for i in range(3000):
        day = f"2026-{1 + i % 11:02d}-{1 + i % 28:02d}"
        resolved = rng.choice([0, 1, None, None, 2, "1"])
        conn.execute(
            "INSERT INTO predictions (stock_id, model_name, generated_at, prediction_date, forecast_data,"
            " direction_correct, verified_at, verification_label_known_date) VALUES (?,?,?,?,?,?,?,?)",
            (2300 + i % 50, rng.choice(["ensemble", "TabM"]), f"{day} {i % 24:02d}:00:00", day,
             "x" * rng.choice([10, 9000]), resolved,
             None if resolved is None or i % 13 == 0 else f"{day} 18:00:00", None if i % 4 == 0 else day))
    conn.execute("ANALYZE")
    return conn


class _Client:
    def __init__(self, conn):
        self.conn, self.calls = conn, []

    def query(self, sql, params=None, timeout=None):
        self.calls.append((sql, list(params or [])))
        return [dict(row) for row in self.conn.execute(sql, list(params or []))]


def _load(monkeypatch, conn, start="2026-02-01", end="2026-10-15"):
    client = _Client(conn)
    monkeypatch.setattr(backtest_state, "LEARNING_D1_CLIENT", client)
    monkeypatch.setattr(retention_history, "archived_predictions", lambda *a, **k: iter(()))
    return backtest_state.load_verified_predictions(start, end), client.calls[0]


def test_schema_index_is_the_migration_index():
    assert _statement(SCHEMA) == _statement(MIGRATION)


def test_verified_read_seeks_the_covering_index_in_order(monkeypatch):
    conn = _database(with_index=True)
    _, (sql, params) = _load(monkeypatch, conn)
    plan = [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params)]
    assert plan == [f"SEARCH predictions USING COVERING INDEX {INDEX} (generated_at>? AND generated_at<?)"], plan


def test_index_returns_the_rows_of_the_table_scan(monkeypatch):
    for start, end in [("2026-02-01", "2026-10-15"), ("2026-01-01", "2026-12-31"), ("2026-03-05", "2026-03-05 23:59:59")]:
        scanned, _ = _load(monkeypatch, _database(with_index=False), start, end)
        seeked, _ = _load(monkeypatch, _database(with_index=True), start, end)
        assert seeked == scanned and len(seeked) > 0, (start, end)
