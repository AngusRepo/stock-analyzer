from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.oof_hot_archive import (  # noqa: E402
    ARCHIVE_TABLES,
    archive_superseded_oof_cohort,
    load_oof_archive_preflight,
)


class _Blob:
    def __init__(self, store: dict[str, bytes], name: str):
        self.store = store
        self.name = name

    def upload_from_filename(self, path: str, content_type: str):
        self.store[self.name] = Path(path).read_bytes()

    def download_to_filename(self, path: str):
        Path(path).write_bytes(self.store[self.name])

    def upload_from_string(self, payload: bytes, content_type: str):
        self.store[self.name] = bytes(payload)

    def download_as_bytes(self):
        return self.store[self.name]


class _Bucket:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    def blob(self, name: str):
        return _Blob(self.store, name)


def test_archive_preflight_fails_closed_for_hard_reference():
    def query(sql, params, **kwargs):
        return [{
            "cohort_id": params[0],
            "prediction_rows": 10,
            "snapshot_rows": 2,
            "l4_rows": 2,
            "newer_ready_cohorts": 1,
            "hard_reference_count": 1,
        }]

    result = load_oof_archive_preflight("legacy", query_fn=query)
    assert result["eligible"] is False
    assert "active_artifact_hard_reference" in result["blockers"]


def test_verified_archive_precedes_bounded_hot_delete():
    cohort_id = "active8-oof-v3-legacy"
    rows = {
        "active8_oof_predictions": [
            {"rowid": 1, "cohort_id": cohort_id, "prediction_date": "2026-07-01", "symbol": "2330"},
            {"rowid": 2, "cohort_id": cohort_id, "prediction_date": "2026-07-02", "symbol": "2317"},
        ],
        "allocator_ev_oof_snapshots": [
            {"rowid": 3, "cohort_id": cohort_id, "snapshot_date": "2026-07-01", "symbol": "2330"},
        ],
        "l4_oof_predictions": [
            {"rowid": 4, "cohort_id": cohort_id, "prediction_date": "2026-07-01", "symbol": "2330"},
        ],
    }
    ledger_statuses: list[str] = []
    eligibility_batches: list[list] = []

    def query(sql, params, **kwargs):
        if "FROM active8_oof_cohorts c" in sql:
            return [{
                "cohort_id": cohort_id,
                "status": "ready",
                "artifact_manifest_checksum": "a" * 64,
                "created_at": "2026-07-17 00:00:00",
                "prediction_rows": len(rows["active8_oof_predictions"]),
                "snapshot_rows": len(rows["allocator_ev_oof_snapshots"]),
                "l4_rows": len(rows["l4_oof_predictions"]),
                "newer_ready_cohorts": 1,
                "hard_reference_count": 0,
            }]
        if "SELECT prediction_date FROM active8_oof_predictions" in sql:
            return [{"prediction_date": "2026-07-01"}, {"prediction_date": "2026-07-02"}]
        for table in ARCHIVE_TABLES:
            if f"SELECT rowid AS _archive_rowid, * FROM {table}" in sql:
                cursor = int(params[1])
                return [
                    {"_archive_rowid": row["rowid"], **{key: value for key, value in row.items() if key != "rowid"}}
                    for row in rows[table]
                    if row["rowid"] > cursor
                ][: int(params[2])]
            if f"SELECT COUNT(*) row_count FROM {table}" in sql:
                return [{"row_count": len(rows[table])}]
        raise AssertionError(sql)

    def execute(sql, params, **kwargs):
        if "INSERT INTO active8_oof_retention_ledger" in sql:
            ledger_statuses.append(params[1])
            return {"success": True, "meta": {"changes": 1}}
        for table in ARCHIVE_TABLES:
            if f"DELETE FROM {table}" in sql:
                changes = len(rows[table])
                rows[table].clear()
                return {"success": True, "meta": {"changes": changes}}
        raise AssertionError(sql)

    def batch(statements, **kwargs):
        eligibility_batches.append(statements)
        return {"error_count": 0, "success_count": len(statements)}

    bucket = _Bucket()
    result = archive_superseded_oof_cohort(
        cohort_id=cohort_id,
        bucket=bucket,
        delete_hot=True,
        query_fn=query,
        execute_fn=execute,
        batch_fn=batch,
        chunk_size=100,
        delete_chunk_size=100,
    )

    assert result["status"] == "deleted"
    assert result["archive_row_count"] == 4
    assert ledger_statuses == ["verified", "deleted"]
    assert sum(result["deleted_rows"].values()) == 4
    assert len(eligibility_batches[0]) == 6
    assert result["archive_path"] in bucket.store
    assert all(component["remote_verified"] for component in result["components"])
