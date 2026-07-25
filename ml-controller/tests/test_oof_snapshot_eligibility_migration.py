from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
OLD_TABLE_SQL = """
CREATE TABLE active8_oof_date_eligibility (
  cohort_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  evidence_scope TEXT NOT NULL CHECK(evidence_scope IN ('active8_oof','l4','fusion')),
  eligibility_status TEXT NOT NULL CHECK(eligibility_status IN ('legal','illegal','pending')),
  reason_code TEXT NOT NULL,
  evidence_schema_version TEXT NOT NULL,
  source_manifest_checksum TEXT,
  evidence_artifact_path TEXT,
  evidence_artifact_checksum TEXT,
  assessed_knowledge_cutoff TEXT NOT NULL,
  assessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(cohort_id, prediction_date, evidence_scope)
);
CREATE INDEX idx_active8_oof_date_eligibility_status
  ON active8_oof_date_eligibility(evidence_scope, eligibility_status, prediction_date, cohort_id);
"""


def test_snapshot_scope_migration_preserves_rows_and_expands_check_constraint():
    conn = sqlite3.connect(":memory:")
    migration = (ROOT / "worker/migrations/0084_oof_snapshot_eligibility_scope.sql").read_text(encoding="utf-8")
    conn.executescript(OLD_TABLE_SQL)
    conn.execute(
        """
        INSERT INTO active8_oof_date_eligibility (
          cohort_id, prediction_date, evidence_scope, eligibility_status,
          reason_code, evidence_schema_version, assessed_knowledge_cutoff
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("cohort", "2026-07-08", "l4", "legal", "existing", "v2", "2026-07-25"),
    )

    conn.executescript(migration)
    assert conn.execute(
        "SELECT evidence_scope, reason_code FROM active8_oof_date_eligibility"
    ).fetchall() == [("l4", "existing")]
    conn.execute(
        """
        INSERT INTO active8_oof_date_eligibility (
          cohort_id, prediction_date, evidence_scope, eligibility_status,
          reason_code, evidence_schema_version, assessed_knowledge_cutoff
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("cohort", "2026-07-08", "snapshot", "legal", "strict", "v2", "2026-07-25"),
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO active8_oof_date_eligibility (
              cohort_id, prediction_date, evidence_scope, eligibility_status,
              reason_code, evidence_schema_version, assessed_knowledge_cutoff
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("cohort", "2026-07-08", "unknown", "legal", "bad", "v2", "2026-07-25"),
        )


def test_snapshot_scope_is_present_in_main_and_learning_schemas():
    expected = "evidence_scope IN ('active8_oof','snapshot','l4','fusion')"
    for relative in ("worker/schema.sql", "worker/domain-schemas/learning.sql"):
        assert expected in (ROOT / relative).read_text(encoding="utf-8")