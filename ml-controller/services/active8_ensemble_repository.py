"""Immutable archive and Learning-D1 registry for Active-8 ensembles."""
from __future__ import annotations

import json
from typing import Any

from services.active8_ensemble_artifact import (
    ARTIFACT_SCHEMA_VERSION,
    canonical_json,
    payload_checksum,
)
from services.d1_domain_client import D1DataDomain, client_for_domain

LEARNING_D1_CLIENT = client_for_domain(D1DataDomain.LEARNING)


def _exact_artifact_row(payload: dict[str, Any], *, training_run_id: str, archive_uri: str) -> dict[str, Any]:
    checksum = str(payload.get("payload_checksum") or "")
    cohort_id = str(payload.get("cohort_id") or "")
    validation = payload.get("validation") if isinstance(payload.get("validation"), dict) else {}
    if (
        payload.get("schema_version") != ARTIFACT_SCHEMA_VERSION
        or checksum != payload_checksum({key: value for key, value in payload.items() if key != "payload_checksum"})
        or validation.get("decision") != "PASS"
        or not cohort_id
        or not training_run_id
        or not archive_uri
    ):
        raise ValueError("active8_ensemble_candidate_contract_invalid")
    return {
        "artifact_id": f"active8-ensemble:{cohort_id}:{checksum[:16]}",
        "cohort_id": cohort_id,
        "training_run_id": training_run_id,
        "knowledge_cutoff_date": str(payload.get("knowledge_cutoff_date") or ""),
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "payload_json": canonical_json(payload),
        "payload_checksum": checksum,
        "base_artifact_set_checksum": str(payload.get("base_artifact_set_checksum") or ""),
        "validation_decision": "PASS",
        "validation_json": canonical_json(validation),
        "archive_uri": archive_uri,
        "state": "candidate",
        "production_effect": 0,
    }


def archive_active8_ensemble_payload(payload: dict[str, Any], *, bucket: Any) -> str:
    raw = canonical_json(payload)
    checksum = str(payload.get("payload_checksum") or "")
    cohort_id = str(payload.get("cohort_id") or "")
    if not checksum or not cohort_id:
        raise ValueError("active8_ensemble_archive_identity_missing")
    path = f"active8/ensemble/{cohort_id}/{checksum}.json"
    blob = bucket.blob(path)
    if blob.exists():
        if blob.download_as_text() != raw:
            raise RuntimeError("active8_ensemble_archive_immutable_conflict")
    else:
        blob.upload_from_string(raw, content_type="application/json")
    bucket_name = str(getattr(bucket, "name", "") or "").strip()
    if not bucket_name:
        raise RuntimeError("active8_ensemble_archive_bucket_identity_missing")
    return f"gs://{bucket_name}/{path}"


def persist_active8_ensemble_candidate(
    payload: dict[str, Any],
    *,
    training_run_id: str,
    bucket: Any,
    d1_client: Any = LEARNING_D1_CLIENT,
) -> dict[str, Any]:
    archive_uri = archive_active8_ensemble_payload(payload, bucket=bucket)
    row = _exact_artifact_row(payload, training_run_id=training_run_id, archive_uri=archive_uri)
    d1_client.execute(
        """
        INSERT INTO active8_ensemble_artifacts_v1 (
          artifact_id, cohort_id, training_run_id, knowledge_cutoff_date,
          schema_version, payload_json, payload_checksum,
          base_artifact_set_checksum, validation_decision, validation_json,
          archive_uri, state, production_effect
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 0)
        ON CONFLICT(artifact_id) DO NOTHING
        """,
        [
            row["artifact_id"], row["cohort_id"], row["training_run_id"],
            row["knowledge_cutoff_date"], row["schema_version"], row["payload_json"],
            row["payload_checksum"], row["base_artifact_set_checksum"],
            row["validation_decision"], row["validation_json"], row["archive_uri"],
        ],
    )
    rows = d1_client.query(
        "SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id = ? LIMIT 2",
        [row["artifact_id"]],
    )
    if len(rows) != 1:
        raise RuntimeError("active8_ensemble_candidate_readback_missing")
    actual = rows[0]
    exact_fields = (
        "artifact_id", "cohort_id", "training_run_id", "knowledge_cutoff_date",
        "schema_version", "payload_json", "payload_checksum",
        "base_artifact_set_checksum", "validation_decision", "validation_json",
        "archive_uri",
    )
    mismatches = [field for field in exact_fields if str(actual.get(field) or "") != str(row[field])]
    if mismatches or str(actual.get("state") or "") not in {"candidate", "production", "archived"}:
        raise RuntimeError("active8_ensemble_candidate_immutable_conflict:" + ",".join(mismatches))
    return {
        "status": "persisted",
        "artifact_id": row["artifact_id"],
        "cohort_id": row["cohort_id"],
        "payload_checksum": row["payload_checksum"],
        "archive_uri": row["archive_uri"],
        "state": actual.get("state"),
        "production_effect": bool(actual.get("production_effect")),
    }
