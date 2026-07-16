from __future__ import annotations

import sqlite3
from pathlib import Path


def test_production_schema_snapshot_rebuilds_in_memory() -> None:
    worker_dir = Path(__file__).resolve().parents[1]
    sql = (worker_dir / "schema.production.snapshot.sql").read_text(encoding="utf-8")
    connection = sqlite3.connect(":memory:")
    connection.executescript(sql)
    inventory = dict(
        connection.execute(
            "SELECT type, COUNT(*) FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' GROUP BY type"
        ).fetchall()
    )
    assert inventory == {"index": 223, "table": 157, "view": 1}
