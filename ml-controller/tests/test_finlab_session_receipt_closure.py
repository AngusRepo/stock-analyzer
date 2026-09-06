import json
import sqlite3
from pathlib import Path

import polars as pl
import pytest

from services.finlab_canonical_materializer import materialize_finlab_canonical_outputs, build_d1_upsert_statements, build_market_domain_insert_statements

ROOT = Path(__file__).resolve().parents[2]


def test_source_calendar_is_independent_of_requested_projection_dates(tmp_path):
    lane = tmp_path / "raw/daily_price"
    lane.mkdir(parents=True)
    pl.DataFrame({"date": ["2026-08-20", "2026-08-21"], **{str(i): [10., 11.] for i in range(100)}}).write_parquet(lane / "close.parquet")
    result = materialize_finlab_canonical_outputs(tmp_path, run_id="same", start_date="2026-08-21",
                                                  end_date="2026-08-21", datasets=["canonical_market_daily"])
    assert {r["date"] for r in result.canonical_market_daily} == {"2026-08-21"}
    assert [r["session_date"] for r in result.source_sessions] == ["2026-08-20", "2026-08-21"]
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "worker/domain-migrations/market/0007_finlab_source_sessions.sql").read_text())
    for _ in range(2):
        for sql, params in build_market_domain_insert_statements(result):
            if "INTO finlab_source_sessions_v1" in sql:
                db.execute(sql, params)
    assert db.execute("SELECT COUNT(*) FROM finlab_source_sessions_v1").fetchone()[0] == 2


def test_dataset_lanes_and_retries_do_not_erase_each_others_receipts(tmp_path):
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "worker/domain-migrations/ops/0013_finlab_materialization_receipts.sql").read_text())
    db.execute("""CREATE TABLE finlab_materialization_manifest (
        run_id TEXT PRIMARY KEY, generated_at TEXT, source_run_id TEXT, artifact_root TEXT,
        row_counts_json TEXT, freshness_json TEXT, checksum TEXT, status TEXT)""")
    for dataset in ["canonical_market_daily", "canonical_chip_daily", "canonical_chip_daily"]:
        output = materialize_finlab_canonical_outputs(tmp_path, run_id="shared", datasets=[dataset],
                                                      generated_at="2026-09-05T00:00:00+00:00")
        for sql, params in build_d1_upsert_statements(output):
            if "INTO finlab_materialization_" in sql:
                db.execute(sql, params)
    counts = json.loads(db.execute("SELECT row_counts_json FROM finlab_materialization_manifest").fetchone()[0])
    assert counts == {"canonical_market_daily": 0, "canonical_chip_daily": 0}
    assert db.execute("SELECT COUNT(*) FROM finlab_materialization_receipts_v1").fetchone()[0] == 2


@pytest.mark.parametrize("reported", [
    {"total": 1, "success_count": 0, "error_count": 1},
    {"total": 0, "success_count": 0, "error_count": 0},
    {"total": 0, "error_count": 0},
])
def test_failed_market_write_cannot_publish_ready_ops_receipts(monkeypatch, tmp_path, reported):
    import importlib.util
    spec = importlib.util.spec_from_file_location("finlab_receipt_tool", ROOT / "tools/finlab_v4_remote_backfill.py")
    tool = importlib.util.module_from_spec(spec)
    import sys
    monkeypatch.setitem(sys.modules, spec.name, tool)
    spec.loader.exec_module(tool)
    import services.finlab_canonical_materializer as materializer
    monkeypatch.setattr(materializer, "build_market_domain_insert_statements", lambda output: [("INSERT INTO finlab_source_sessions_v1 VALUES (?)", [1])])
    monkeypatch.setattr(tool, "market_domain_active", lambda: True)
    receipts = []
    monkeypatch.setattr(tool, "ops_d1_batch_execute", lambda *a, **k: receipts.append(a))
    monkeypatch.setattr(tool, "d1_batch_execute", lambda *a, **k: reported)
    with pytest.raises(RuntimeError, match="incomplete_before_receipt"):
        tool.materialize_canonical_to_d1({"run_id": "x", "artifact_root": str(tmp_path),
                                        "generated_at": "2026-09-05T00:00:00Z"},
                                       start_date=None, end_date=None, datasets=["canonical_market_daily"])
    assert receipts == []
