from __future__ import annotations

import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_oof_retention_migration_is_valid_and_fail_closed():
    retention_schema = (
        ROOT / "worker" / "migrations" / "0076_retention_policy_and_capacity.sql"
    ).read_text(encoding="utf-8")
    migration = (
        ROOT / "worker" / "migrations" / "0082_oof_evidence_eligibility_retention.sql"
    ).read_text(encoding="utf-8")
    db = sqlite3.connect(":memory:")
    db.executescript(retention_schema)
    db.executescript(migration)
    tables = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    }
    assert "active8_oof_date_eligibility" in tables
    assert "active8_oof_retention_ledger" in tables
    assert "immutable checksum archive" in migration
    assert "hard references" in migration
    columns = {
        row[1]
        for row in db.execute(
            "PRAGMA table_info(active8_oof_date_eligibility)"
        ).fetchall()
    }
    assert "evidence_scope" in columns
    assert "PRIMARY KEY(cohort_id, prediction_date, evidence_scope)" in migration
    assert "'active8_oof','l4','fusion'" in migration
