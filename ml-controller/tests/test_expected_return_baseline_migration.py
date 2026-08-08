from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "worker"
    / "migrations"
    / "0104_expected_return_v5_v14_baseline_pointer_closure.sql"
)

SCHEMA = """
CREATE TABLE model_artifact_registry (
  artifact_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  version TEXT NOT NULL,
  candidate_type TEXT NOT NULL,
  state TEXT NOT NULL,
  artifact_path TEXT,
  metadata_path TEXT,
  training_run_id TEXT,
  trained_from_snapshot TEXT,
  feature_policy_version TEXT,
  checksum TEXT,
  source_run_date TEXT,
  offline_gate_status TEXT,
  offline_gate_decision TEXT,
  offline_gate_failed_gates TEXT,
  offline_evidence_json TEXT,
  live_gate_status TEXT,
  live_evidence_json TEXT,
  promotion_decision TEXT,
  approval_state TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE expected_return_artifact_payloads (
  artifact_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  serving_mode TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  source_artifact_path TEXT,
  source_artifact_checksum TEXT,
  source_cohort_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE model_champion_pointers (
  model_name TEXT PRIMARY KEY,
  champion_version TEXT NOT NULL,
  champion_artifact_id TEXT,
  rollback_version TEXT,
  rollback_artifact_id TEXT,
  promoted_at TEXT,
  promotion_reason TEXT,
  promotion_evidence_json TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE model_champion_history (
  event_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_id TEXT,
  effective_at TEXT NOT NULL,
  retired_at TEXT,
  source TEXT,
  evidence_grade TEXT,
  evidence_json TEXT
);
"""


def database() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA)
    return connection


def apply_migration(connection: sqlite3.Connection) -> None:
    connection.executescript(MIGRATION.read_text(encoding="utf-8"))


def test_contract_migration_rotates_only_known_abstention_baselines():
    connection = database()
    connection.executemany(
        """
        INSERT INTO model_champion_pointers (
          model_name, champion_version, champion_artifact_id
        ) VALUES (?, ?, ?)
        """,
        [
            (
                "l4_alpha_ev",
                "l4-alpha-ev-abstention-baseline-v1",
                "l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1",
            ),
            (
                "allocator_ev_fusion",
                "allocator-ev-fusion-abstention-baseline-v13",
                "allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13",
            ),
        ],
    )
    abstention_json = json.dumps({
        "promotion_state": "safe_abstention",
        "validation_packet": {"alpha_quality_passed": False},
    })
    connection.executemany(
        """
        INSERT INTO expected_return_artifact_payloads (
          artifact_id, model_name, model_version, serving_mode,
          artifact_json, payload_checksum
        ) VALUES (?, ?, ?, 'abstention_baseline', ?, ?)
        """,
        [
            (
                "l4_alpha_ev:l4-alpha-ev-abstention-baseline-v1",
                "l4_alpha_ev", "l4-alpha-ev-abstention-baseline-v1",
                abstention_json, "old-l4",
            ),
            (
                "allocator_ev_fusion:allocator-ev-fusion-abstention-baseline-v13",
                "allocator_ev_fusion",
                "allocator-ev-fusion-abstention-baseline-v13",
                abstention_json, "old-fusion",
            ),
        ],
    )


    apply_migration(connection)

    pointers = dict(
        connection.execute(
            "SELECT model_name, champion_artifact_id FROM model_champion_pointers"
        ).fetchall()
    )
    assert pointers == {
        "l4_alpha_ev": (
            "l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1"
        ),
        "allocator_ev_fusion": (
            "allocator_ev_fusion:"
            "allocator-ev-fusion-residual-v14-abstention-baseline-v1"
        ),
    }

    payloads = connection.execute(
        """
        SELECT model_name, artifact_json, payload_checksum
          FROM expected_return_artifact_payloads
         WHERE artifact_id IN (
           'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-abstention-baseline-v1',
           'allocator_ev_fusion:allocator-ev-fusion-residual-v14-abstention-baseline-v1'
         )
         ORDER BY model_name
        """
    ).fetchall()
    assert len(payloads) == 2
    for owner, artifact_json, checksum in payloads:
        assert hashlib.sha256(artifact_json.encode("utf-8")).hexdigest() == checksum
        artifact = json.loads(artifact_json)
        assert artifact["expected_return_owner"] == owner
        assert artifact["serving_mode"] == "abstention_baseline"
        if owner == "l4_alpha_ev":
            assert artifact["artifact_contract_version"] == "l4-alpha-ev-contract-v5"
        else:
            assert (
                artifact["artifact_contract_version"]
                == "allocator-ev-fusion-contract-v14"
            )


def test_contract_migration_never_overwrites_learned_alpha_champions():
    connection = database()
    connection.executemany(
        """
        INSERT INTO model_champion_pointers (
          model_name, champion_version, champion_artifact_id
        ) VALUES (?, ?, ?)
        """,
        [
            ("l4_alpha_ev", "learned-l4", "l4_alpha_ev:learned-l4"),
            (
                "allocator_ev_fusion",
                "learned-fusion",
                "allocator_ev_fusion:learned-fusion",
            ),
        ],
    )
    learned_json = json.dumps({
        "promotion_state": "production_primary",
        "validation_packet": {"alpha_quality_passed": True},
    })
    connection.executemany(
        """
        INSERT INTO expected_return_artifact_payloads (
          artifact_id, model_name, model_version, serving_mode,
          artifact_json, payload_checksum
        ) VALUES (?, ?, ?, 'alpha', ?, ?)
        """,
        [
            (
                "l4_alpha_ev:learned-l4", "l4_alpha_ev", "learned-l4",
                learned_json, "learned-l4-checksum",
            ),
            (
                "allocator_ev_fusion:learned-fusion", "allocator_ev_fusion",
                "learned-fusion", learned_json, "learned-fusion-checksum",
            ),
        ],
    )


    apply_migration(connection)

    pointers = dict(
        connection.execute(
            "SELECT model_name, champion_artifact_id FROM model_champion_pointers"
        ).fetchall()
    )
    assert pointers == {
        "l4_alpha_ev": "l4_alpha_ev:learned-l4",
        "allocator_ev_fusion": "allocator_ev_fusion:learned-fusion",
    }
