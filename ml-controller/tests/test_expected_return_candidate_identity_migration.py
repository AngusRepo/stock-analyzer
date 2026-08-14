from __future__ import annotations

import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LEGACY_MIGRATION = ROOT / "worker/migrations/0106_expected_return_candidate_identity_v2.sql"
LEARNING_MIGRATION = ROOT / "worker/domain-migrations/learning/0005_expected_return_candidate_identity_v2.sql"
TRAINING_RUN_ID = "active8_oof:active8-oof-v7-immutable-fold-evidence-2026-01-29-2026-07-22-tr60-te10"
CHECKSUMS = {
    "l4_alpha_ev": "57924157cb6dbdf6a2bf3dd50f761b900b7530884dbfbcf9595364fbfc506acf",
    "allocator_ev_fusion": "359b98684868acaf2ba7bc4bf27575538f99a7f57f110d8a53e67a52dcbe5d15",
}


def _envelope(model_name: str, decision: str = "FAIL") -> dict[str, object]:
    if model_name == "l4_alpha_ev":
        contract = "l4-alpha-ev-contract-v5"
        feature = "l4-directional-score-sector-components-v3-lineage-bound"
        validation_schema = "l4-alpha-ev-validation-packet-v1"
    else:
        contract = "allocator-ev-fusion-contract-v14"
        feature = "allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound"
        validation_schema = "allocator-ev-fusion-validation-packet-v14"
    return {
        "artifact_contract_version": contract,
        "feature_semantic_version": feature,
        "label_schema_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "validation_packet": {
            "schema_version": validation_schema,
            "decision": decision,
            "sample_audit": {"oof_max_date": "2026-07-22"},
        },
    }


def _connection() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute(
        """
        CREATE TABLE model_artifact_registry (
          artifact_id TEXT PRIMARY KEY,
          model_name TEXT NOT NULL,
          version TEXT NOT NULL,
          candidate_type TEXT NOT NULL,
          training_run_id TEXT,
          checksum TEXT,
          source_run_date TEXT,
          offline_gate_decision TEXT,
          offline_evidence_json TEXT NOT NULL
        )
        """
    )
    return connection


def _insert_candidate(
    connection: sqlite3.Connection,
    *,
    model_name: str,
    version: str,
    candidate_type: str,
    envelope: dict[str, object],
    training_run_id: str = TRAINING_RUN_ID,
) -> None:
    connection.execute(
        """
        INSERT INTO model_artifact_registry (
          artifact_id, model_name, version, candidate_type, training_run_id,
          checksum, source_run_date, offline_gate_decision, offline_evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-09', 'FAIL', ?)
        """,
        (
            f"{model_name}:{version}",
            model_name,
            version,
            candidate_type,
            training_run_id,
            CHECKSUMS[model_name],
            json.dumps(envelope, sort_keys=True),
        ),
    )


def test_legacy_and_learning_identity_migrations_are_identical() -> None:
    assert LEGACY_MIGRATION.read_text(encoding="utf-8") == LEARNING_MIGRATION.read_text(encoding="utf-8")


def test_identity_repair_is_exact_targeted_and_idempotent() -> None:
    connection = _connection()
    _insert_candidate(
        connection,
        model_name="l4_alpha_ev",
        version="l4-alpha-ev-ridge-v5-sector-20260809",
        candidate_type="l4_alpha_ev_refresh",
        envelope=_envelope("l4_alpha_ev"),
    )
    fusion_envelope = _envelope("allocator_ev_fusion")
    fusion_envelope["cadence"] = "manual"
    _insert_candidate(
        connection,
        model_name="allocator_ev_fusion",
        version="allocator-ev-fusion-residual-v14-20260809",
        candidate_type="allocator_ev_fusion_refresh",
        envelope=fusion_envelope,
    )
    wrong_contract = _envelope("allocator_ev_fusion")
    wrong_contract["artifact_contract_version"] = "allocator-ev-fusion-contract-v13"
    _insert_candidate(
        connection,
        model_name="allocator_ev_fusion",
        version="allocator-ev-fusion-residual-v14-invalid",
        candidate_type="allocator_ev_fusion_refresh",
        envelope=wrong_contract,
        training_run_id="allocator_ev_fusion_refresh:weekly:2026-08-09",
    )
    _insert_candidate(
        connection,
        model_name="l4_alpha_ev",
        version="l4-alpha-ev-ridge-v5-sector-unverified",
        candidate_type="l4_alpha_ev_refresh",
        envelope=_envelope("l4_alpha_ev"),
        training_run_id="active8_oof:unverified",
    )

    migration = LEGACY_MIGRATION.read_text(encoding="utf-8")
    connection.executescript(migration)
    first = dict(connection.execute(
        "SELECT artifact_id, offline_evidence_json FROM model_artifact_registry"
    ).fetchall())
    connection.executescript(migration)
    second = dict(connection.execute(
        "SELECT artifact_id, offline_evidence_json FROM model_artifact_registry"
    ).fetchall())
    assert first == second

    for model_name, version in (
        ("l4_alpha_ev", "l4-alpha-ev-ridge-v5-sector-20260809"),
        ("allocator_ev_fusion", "allocator-ev-fusion-residual-v14-20260809"),
    ):
        payload = json.loads(first[f"{model_name}:{version}"])
        assert payload["identity_schema_version"] == "expected-return-candidate-identity-v2"
        assert payload["expected_return_owner"] == model_name
        assert payload["model_version"] == version
        assert payload["artifact_checksum"] == CHECKSUMS[model_name]
        assert payload["cadence"] == ("manual" if model_name == "allocator_ev_fusion" else "weekly")
        assert payload["validation_packet"]["sample_audit"]["oof_max_date"] == "2026-07-22"

    invalid = json.loads(first["allocator_ev_fusion:allocator-ev-fusion-residual-v14-invalid"])
    assert "identity_schema_version" not in invalid
    unverified = json.loads(first["l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-unverified"])
    assert "identity_schema_version" not in unverified
    assert "cadence" not in unverified
