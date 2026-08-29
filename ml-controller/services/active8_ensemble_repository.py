"""Immutable archive and Learning-D1 registry for Active-8 ensembles."""
from __future__ import annotations

import hashlib
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


VALIDATION_ATTEMPT_SCHEMA_VERSION = "active8-oof-ensemble-validation-attempt-v1"


def _validation_observation_identity(
    base_artifacts: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, str]], str]:
    identity: dict[str, dict[str, str]] = {}
    for key in sorted(base_artifacts):
        row = dict(base_artifacts[key])
        model_name = str(row.get("model_name") or key).strip()
        checksum = str(row.get("checksum") or "").strip()
        normalized_checksum = checksum.removeprefix("sha256:")
        item = {
            "artifact_id": str(row.get("artifact_id") or "").strip(),
            "model_name": model_name,
            "version": str(row.get("version") or "").strip(),
            "checksum": checksum,
            "artifact_path": str(row.get("artifact_path") or "").strip(),
            "metadata_path": str(row.get("metadata_path") or "").strip(),
            "candidate_type": str(row.get("candidate_type") or "").strip(),
            "training_run_id": str(row.get("training_run_id") or "").strip(),
        }
        if (
            not model_name
            or not item["artifact_id"]
            or not item["version"]
            or not item["artifact_path"]
            or not item["metadata_path"]
            or item["candidate_type"] != "oof_full_fit_release"
            or len(normalized_checksum) != 64
            or any(char not in "0123456789abcdef" for char in normalized_checksum.lower())
            or model_name in identity
        ):
            raise ValueError(f"active8_ensemble_validation_observation_identity_invalid:{model_name or key}")
        identity[model_name] = item
    if not identity:
        raise ValueError("active8_ensemble_validation_observation_identity_empty")
    checksum = hashlib.sha256(canonical_json(identity).encode("utf-8")).hexdigest()
    return identity, checksum


def persist_active8_ensemble_validation_attempt(
    validation: dict[str, Any],
    *,
    base_artifacts: dict[str, dict[str, Any]],
    cohort_id: str,
    training_run_id: str,
    knowledge_cutoff_date: str,
    source_manifest_checksum: str,
    d1_client: Any = LEARNING_D1_CLIENT,
) -> dict[str, Any]:
    normalized_validation = dict(validation)
    if (
        normalized_validation.get("schema_version") != "active8-oof-ensemble-validation-v1"
        or normalized_validation.get("decision") != "FAIL"
        or not normalized_validation.get("failed_gates")
        or not cohort_id
        or not training_run_id
        or len(knowledge_cutoff_date) != 10
        or len(source_manifest_checksum) != 64
    ):
        raise ValueError("active8_ensemble_validation_attempt_contract_invalid")
    observation_artifacts, observation_checksum = _validation_observation_identity(base_artifacts)
    receipt = {
        "schema_version": VALIDATION_ATTEMPT_SCHEMA_VERSION,
        "cohort_id": cohort_id,
        "training_run_id": training_run_id,
        "knowledge_cutoff_date": knowledge_cutoff_date,
        "source_manifest_checksum": source_manifest_checksum,
        "observation_artifacts": observation_artifacts,
        "observation_artifact_set_checksum": observation_checksum,
        "validation": normalized_validation,
        "production_effect": False,
    }
    receipt_json = canonical_json(receipt)
    receipt_checksum = hashlib.sha256(receipt_json.encode("utf-8")).hexdigest()
    attempt_id = f"active8-ensemble-validation:{cohort_id}:{receipt_checksum[:16]}"
    row = {
        "attempt_id": attempt_id,
        "cohort_id": cohort_id,
        "training_run_id": training_run_id,
        "knowledge_cutoff_date": knowledge_cutoff_date,
        "schema_version": VALIDATION_ATTEMPT_SCHEMA_VERSION,
        "source_manifest_checksum": source_manifest_checksum,
        "observation_artifact_set_checksum": observation_checksum,
        "validation_decision": "FAIL",
        "validation_json": canonical_json(normalized_validation),
        "receipt_json": receipt_json,
        "receipt_checksum": receipt_checksum,
    }
    d1_client.execute(
        """
        INSERT INTO active8_ensemble_validation_attempts_v1 (
          attempt_id, cohort_id, training_run_id, knowledge_cutoff_date,
          schema_version, source_manifest_checksum, observation_artifact_set_checksum,
          validation_decision, validation_json, receipt_json, receipt_checksum,
          production_effect
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(attempt_id) DO NOTHING
        """,
        [
            row["attempt_id"], row["cohort_id"], row["training_run_id"],
            row["knowledge_cutoff_date"], row["schema_version"],
            row["source_manifest_checksum"], row["observation_artifact_set_checksum"],
            row["validation_decision"], row["validation_json"], row["receipt_json"],
            row["receipt_checksum"],
        ],
    )
    rows = d1_client.query(
        "SELECT * FROM active8_ensemble_validation_attempts_v1 WHERE attempt_id = ? LIMIT 2",
        [attempt_id],
    )
    if len(rows) != 1:
        raise RuntimeError("active8_ensemble_validation_attempt_readback_missing")
    actual = rows[0]
    exact_fields = tuple(row)
    mismatches = [field for field in exact_fields if str(actual.get(field) or "") != str(row[field])]
    if mismatches or int(actual.get("production_effect") or 0) != 0:
        raise RuntimeError("active8_ensemble_validation_attempt_immutable_conflict:" + ",".join(mismatches))
    return {
        "status": "persisted",
        "attempt_id": attempt_id,
        "cohort_id": cohort_id,
        "receipt_checksum": receipt_checksum,
        "validation_decision": "FAIL",
        "production_effect": False,
    }


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
