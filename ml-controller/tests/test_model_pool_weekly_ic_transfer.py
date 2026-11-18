"""Rolling IC transfer: batched /raw reads, the label-semantic flag encoding, and one registry snapshot."""
from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import date


from routers import model_pool
from services.model_ic_tracker import IC_TARGET_SEMANTIC_VERSION, tracked_model_names
from tests.test_model_pool_weekly_ic_rows import (
    TRACKED,
    _ORIGINAL_RUN_DATE_SQL,
    _SqliteClient,
    _assert_same,
    _database,
)


class _BatchSqliteClient(_SqliteClient):
    database_id = "learning-db"

    def __init__(self, conn: sqlite3.Connection, monkeypatch) -> None:
        super().__init__(conn)
        self.batches: list[int] = []

        def read_raw_batch(requests, *, database_id, timeout=60.0):
            assert database_id == "learning-db"
            self.batches.append(len(requests))
            return [self.query(r["sql"], r["params"]) for r in requests]

        monkeypatch.setattr(model_pool, "read_raw_batch", read_raw_batch)


def _vary_label_semantics(conn: sqlite3.Connection) -> None:
    # Values the flag encoding must hand back unchanged: other text, NULL,
    # numbers, near-misses of the target string, and a JSON-typed target.
    variants = [None, "legacy-v3", IC_TARGET_SEMANTIC_VERSION + " ", IC_TARGET_SEMANTIC_VERSION.upper(), 7, 1, ""]
    ids = [r[0] for r in conn.execute("SELECT id FROM predictions ORDER BY id")]
    for n, row_id in enumerate(ids[::5]):
        conn.execute("UPDATE predictions SET verification_label_schema_version=? WHERE id=?",
                     (variants[n % len(variants)], row_id))
    for n, row_id in enumerate(ids[2::7]):
        value = variants[n % len(variants)]
        conn.execute("UPDATE predictions SET forecast_data=json_set(forecast_data, "
                     "'$.model_signal.target_semantic_version', json(?)) WHERE id=? AND json_valid(forecast_data) "
                     "AND json_type(forecast_data, '$.model_signal')='object'", (json.dumps(value), row_id))


def test_batched_rows_match_original_query_with_varied_label_semantics(monkeypatch):
    anchor = date(2026, 11, 10)
    conn = _database(anchor)
    _vary_label_semantics(conn)
    client = _BatchSqliteClient(conn, monkeypatch)
    monkeypatch.setattr(model_pool, "LEARNING_D1_CLIENT", client)
    placeholders = ",".join("?" * len(TRACKED))
    old = _SqliteClient(conn).query(_ORIGINAL_RUN_DATE_SQL.format(placeholders=placeholders),
                                    [*TRACKED, "2026-11-10", "2026-11-10", "2026-11-10", "-35 days"])

    new = model_pool._load_weekly_ic_rows(TRACKED, "2026-11-10", 35)

    _assert_same(old, new)
    old_by_id = {r["id"]: r for r in old}
    for row in new:
        original = old_by_id[row["id"]]
        assert row["verification_label_schema_version"] == original["verification_label_schema_version"]
        assert type(row["verification_label_schema_version"]) is type(original["verification_label_schema_version"])
        expected = conn.execute("SELECT CASE WHEN json_valid(forecast_data) THEN json_extract(forecast_data, "
                                "'$.model_signal.target_semantic_version') END FROM predictions WHERE id=?",
                                (row["id"],)).fetchone()[0]
        actual = row["forecast_data"]["model_signal"]["target_semantic_version"]
        assert actual == expected and type(actual) is type(expected)
        assert not any(key.endswith("__is_target") for key in row)
    labels = [r["verification_label_schema_version"] for r in new]
    assert IC_TARGET_SEMANTIC_VERSION in labels and None in labels and "1" in labels and "legacy-v3" in labels
    signals = [r["forecast_data"]["model_signal"]["target_semantic_version"] for r in new]
    assert IC_TARGET_SEMANTIC_VERSION in signals and 7 in signals and IC_TARGET_SEMANTIC_VERSION + " " in signals
    assert client.batches == [6] * 6
    assert len(client.calls) == 36
    for sql, params in client.calls:
        assert sql.count("?") == len(params)
        plan = " ".join(r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql, params))
        assert "idx_pred_date_model_stock" in plan and "SCAN" not in plan


def test_now_window_batches_the_open_ended_range(monkeypatch):
    conn = _database(date.today())
    client = _BatchSqliteClient(conn, monkeypatch)
    monkeypatch.setattr(model_pool, "LEARNING_D1_CLIENT", client)
    model_pool._load_weekly_ic_rows(TRACKED, None, 35)
    assert client.batches == [6] * 6 + [1]


def test_compute_weekly_ic_reads_one_lifecycle_snapshot_after_predictions(monkeypatch):
    order: list[str] = []
    registry_rows = [{"artifact_id": "a"}]
    pointers = [{"model_name": "XGBoost"}]
    passed = {}

    def load_rows(all_tracked, run_date, lookback_days):
        order.append("predictions")
        return []

    def list_registry(limit=100):
        order.append("registry")
        return registry_rows

    def list_pointers(model_name=None):
        order.append("pointers")
        return pointers

    def update(per_model_ic, *, min_samples, registry_rows=None, champion_pointers=None):
        passed.update(rows=registry_rows, pointers=champion_pointers)
        return {"status": "ok", "selected": 0, "updated": 0, "updates": [], "errors": []}

    monkeypatch.setattr(model_pool, "_load_weekly_ic_rows", load_rows)
    monkeypatch.setattr(model_pool, "load_d1_champion_pool", lambda: order.append("pool") or {"models": {}})
    monkeypatch.setattr(model_pool, "list_artifact_registry", list_registry)
    monkeypatch.setattr(model_pool, "list_champion_pointers", list_pointers)
    monkeypatch.setattr("services.model_artifact_registry.update_live_gate_from_ic", update)

    out = asyncio.run(model_pool.compute_weekly_ic(model_pool.ComputeWeeklyICRequest(run_date="2026-11-16")))

    assert order == ["predictions", "pool", "registry", "pointers"]
    assert passed["rows"] is registry_rows and passed["pointers"] is pointers
    assert set(out["stage_s"]) == {"prediction_read", "lifecycle_read", "registry_write"}
    assert set(out["per_model_ic"]) == set(tracked_model_names())
