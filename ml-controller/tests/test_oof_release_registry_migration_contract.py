from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_oof_release_registry_migration_preserves_rows_and_constraints():
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        (ROOT / "worker" / "migration_model_artifact_registry.sql").read_text(encoding="utf-8")
    )
    connection.executescript(
        (
            ROOT
            / "worker"
            / "migration_model_artifact_registry_candidate_type_ev_refresh_2026_07_11.sql"
        ).read_text(encoding="utf-8")
    )
    connection.execute(
        """
        INSERT INTO model_artifact_registry (
          artifact_id, model_name, version, candidate_type, state, checksum
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("XGBoost:vOld:weekly_drift", "XGBoost", "vOld", "weekly_drift", "production", "sha256:old"),
    )

    migration = (
        ROOT / "worker" / "migrations" / "0069_model_artifact_registry_oof_release.sql"
    ).read_text(encoding="utf-8")
    connection.executescript(migration)

    assert connection.execute(
        "SELECT artifact_id, candidate_type, state FROM model_artifact_registry"
    ).fetchall() == [("XGBoost:vOld:weekly_drift", "weekly_drift", "production")]
    connection.execute(
        """
        INSERT INTO model_artifact_registry (
          artifact_id, model_name, version, candidate_type, state, checksum
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "XGBoost:vOOF:oof_full_fit_release",
            "XGBoost",
            "vOOF",
            "oof_full_fit_release",
            "offline_strong_pass",
            "sha256:oof",
        ),
    )
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute(
            """
            INSERT INTO model_artifact_registry (
              artifact_id, model_name, version, candidate_type, state
            ) VALUES ('bad', 'XGBoost', 'bad', 'contract_bypass', 'registered')
            """
        )

    indexes = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='model_artifact_registry'"
        )
    }
    assert {
        "idx_model_artifact_registry_model_state",
        "idx_model_artifact_registry_candidate_type",
        "idx_model_artifact_registry_run",
    }.issubset(indexes)


def test_bootstrap_schema_matches_oof_release_candidate_contract():
    schema = (ROOT / "worker" / "schema.sql").read_text(encoding="utf-8")

    assert "'oof_full_fit_release'" in schema
    assert "'l4_alpha_ev_refresh'" in schema
    assert "'allocator_ev_fusion_refresh'" in schema
