"""Rolling IC rows: per-day compact reads must give the same IC as the original full-row query."""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from routers import model_pool
from services.model_ic_tracker import (
    IC_TARGET_SEMANTIC_VERSION,
    PRODUCTION_IC_SEGMENTS,
    compute_weekly_ic_from_rows,
)

TRACKED = ("LightGBM", "TabM", "ResidualMLP::challenger")
SEGMENT = sorted(PRODUCTION_IC_SEGMENTS)[0]

_ORIGINAL_RUN_DATE_SQL = """
    SELECT id, stock_id, model_name, direction_accuracy, forecast_data,
           actual_return_pct, verified_at, prediction_date, generated_at,
           verification_label_schema_version, verification_label_entry_price,
           verification_label_end_date, verification_label_known_date
    FROM predictions
    WHERE model_name IN ({placeholders})
      AND date(prediction_date) <= date(?)
      AND date(verification_label_known_date) <= date(?)
      AND date(prediction_date) >= date(?, ?)
"""
_ORIGINAL_NOW_SQL = """
    SELECT id, stock_id, model_name, direction_accuracy, forecast_data,
           actual_return_pct, verified_at, prediction_date, generated_at,
           verification_label_schema_version, verification_label_entry_price,
           verification_label_end_date, verification_label_known_date
    FROM predictions
    WHERE model_name IN ({placeholders})
      AND date(verification_label_known_date) <= date('now')
      AND date(prediction_date) >= date('now', ?)
"""


class _SqliteClient:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.calls: list[tuple[str, list]] = []

    def query(self, sql, params=None):
        self.calls.append((sql, list(params or [])))
        cur = self.conn.execute(sql, list(params or []))
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _forecast(i: int, model: str):
    variant = i % 9
    signal = {"artifact_version": f"{model}-v1", "target_semantic_version": IC_TARGET_SEMANTIC_VERSION,
              "artifact_id": f"{model}-art", "artifact_checksum": "ABCDEF"}
    full = {"rank_score": ((i * 37) % 101) / 101.0 - 0.5, "model_signal": signal,
            "stock_meta": {"market_segment": SEGMENT.lower(), "name": "x" * 200},
            "padding": {"big": list(range(50))}}
    if variant == 1:
        return "{not json"
    if variant == 2:
        return None
    if variant == 3:
        return json.dumps([1, 2, 3])
    if variant == 4:
        return json.dumps({**full, "model_signal": "string-signal"})
    if variant == 5:
        return json.dumps({**full, "rank_score": str(full["rank_score"])})
    if variant == 6:
        return json.dumps({**full, "stock_meta": {"market_segment": "EMERGING"}})
    if variant == 7:
        return json.dumps({**full, "model_signal": {**signal, "artifact_version": f"{model}-old"}})
    return json.dumps(full)


def _database(anchor: date) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("""CREATE TABLE predictions (id INTEGER PRIMARY KEY, stock_id TEXT, model_name TEXT,
        direction_accuracy REAL, forecast_data TEXT, actual_return_pct REAL, verified_at TEXT,
        prediction_date TEXT, generated_at TEXT, verification_label_schema_version TEXT,
        verification_label_entry_price REAL, verification_label_end_date TEXT, verification_label_known_date TEXT)""")
    conn.execute("CREATE INDEX idx_pred_date_model_stock ON predictions(prediction_date, model_name, stock_id)")
    conn.execute("CREATE INDEX idx_pred_model_verified_date ON predictions(model_name, verified_at, prediction_date)")
    i = 0
    for offset in range(-45, 4):
        day = anchor + timedelta(days=offset)
        for model in (*TRACKED, "ensemble"):
            for stock in range(6):
                i += 1
                prediction_date = day.isoformat() if stock != 5 else f"{day.isoformat()}T08:00:00"
                known = day + timedelta(days=2 if stock != 4 else -3)
                conn.execute("INSERT INTO predictions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                    i, f"{2300 + stock}", model, 0.5, _forecast(i, model), ((i * 13) % 17) / 10.0 - 0.8,
                    None if i % 11 == 0 else f"{known.isoformat()} 10:00:00", prediction_date,
                    f"{day.isoformat()} 0{stock % 3}:00:00", IC_TARGET_SEMANTIC_VERSION, 100.0,
                    (day + timedelta(days=1)).isoformat(), known.isoformat()))
    return conn


def _ic(rows):
    expected = {name: f"{name}-v1" for name in TRACKED}
    identities = {name: {"artifact_id": f"{name}-art", "checksum": "abcdef"} for name in TRACKED}
    return compute_weekly_ic_from_rows(rows, min_samples=2, min_dates=1, all_tracked=TRACKED,
                                       expected_artifact_versions=expected,
                                       expected_artifact_identities=identities)


def _assert_same(old_rows, new_rows):
    assert sorted(r["id"] for r in old_rows) == sorted(r["id"] for r in new_rows)
    old_ic, new_ic = _ic(old_rows), _ic(new_rows)
    assert json.dumps(old_ic, sort_keys=True, default=str) == json.dumps(new_ic, sort_keys=True, default=str)
    assert any(info.get("status") == "computed" for info in new_ic.values())


def test_run_date_rows_match_original_query(monkeypatch):
    anchor = date(2026, 11, 10)
    conn = _database(anchor)
    client = _SqliteClient(conn)
    monkeypatch.setattr(model_pool, "LEARNING_D1_CLIENT", client)
    placeholders = ",".join("?" * len(TRACKED))
    old = _SqliteClient(conn).query(_ORIGINAL_RUN_DATE_SQL.format(placeholders=placeholders),
                                    [*TRACKED, "2026-11-10", "2026-11-10", "2026-11-10", "-35 days"])

    new = model_pool._load_weekly_ic_rows(TRACKED, "2026-11-10", 35)

    _assert_same(old, new)
    assert len(client.calls) == 36
    for sql, params in client.calls:
        assert "+model_name IN" in sql
        assert "direction_accuracy, forecast_data" not in sql
        assert sql.count("?") == len(params)
        plan = " ".join(r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql, params))
        assert "idx_pred_date_model_stock" in plan


def test_now_rows_match_original_query_including_future_dates(monkeypatch):
    anchor = datetime.now(timezone.utc).date()
    conn = _database(anchor)
    client = _SqliteClient(conn)
    monkeypatch.setattr(model_pool, "LEARNING_D1_CLIENT", client)
    placeholders = ",".join("?" * len(TRACKED))
    old = _SqliteClient(conn).query(_ORIGINAL_NOW_SQL.format(placeholders=placeholders), [*TRACKED, "-35 days"])

    new = model_pool._load_weekly_ic_rows(TRACKED, None, 35)

    _assert_same(old, new)
    assert any(r["prediction_date"] > anchor.isoformat() for r in new)
    assert len(client.calls) == 37
    assert all(sql.count("?") == len(params) for sql, params in client.calls)


@pytest.mark.parametrize("run_date", ["2026-13-40", "2026-11-10T00:30:00+08:00", "now", "20261110"])
def test_non_calendar_run_date_is_rejected(monkeypatch, run_date):
    monkeypatch.setattr(model_pool, "LEARNING_D1_CLIENT", _SqliteClient(sqlite3.connect(":memory:")))
    with pytest.raises(HTTPException) as exc:
        model_pool._load_weekly_ic_rows(TRACKED, run_date, 35)
    assert exc.value.status_code == 400


@pytest.mark.parametrize("lookback_days", [0, -1, 121, 3650])
def test_lookback_days_is_bounded(lookback_days):
    with pytest.raises(ValidationError):
        model_pool.ComputeWeeklyICRequest(lookback_days=lookback_days)
