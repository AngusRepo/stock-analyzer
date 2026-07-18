"""Durable Modal prediction bundle handoff to the pipeline-v2 Cloud Run Job."""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from google.api_core.exceptions import PreconditionFailed
from google.cloud import storage

if TYPE_CHECKING:
    from services.cloud_run_jobs_client import CloudRunJobsClient

_DISPATCH_STALE_SECONDS = 300


def _parse_gcs_uri(uri: str) -> tuple[str, str]:
    if not str(uri or "").startswith("gs://"):
        raise ValueError("pipeline_modal_result_gcs_uri_invalid")
    bucket_name, separator, path = str(uri)[5:].partition("/")
    if not separator or not bucket_name or not path:
        raise ValueError("pipeline_modal_result_gcs_uri_invalid")
    return bucket_name, path


def _safe_run_id(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "")).strip("-")
    if not safe:
        raise ValueError("pipeline_modal_run_id_missing")
    return safe[:160]


def load_verified_modal_prediction_bundle(
    *,
    result_gcs_uri: str,
    expected_checksum: str,
    storage_client: Any | None = None,
) -> dict[str, Any]:
    if len(str(expected_checksum or "")) != 64:
        raise ValueError("pipeline_modal_result_checksum_invalid")
    bucket_name, path = _parse_gcs_uri(result_gcs_uri)
    client = storage_client or storage.Client()
    raw = client.bucket(bucket_name).blob(path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_checksum:
        raise ValueError("pipeline_modal_result_checksum_mismatch")
    bundle = json.loads(raw.decode("utf-8"))
    if bundle.get("schema_version") != "pipeline-modal-prediction-bundle-v1":
        raise ValueError("pipeline_modal_result_schema_invalid")
    return bundle


def dispatch_modal_prediction_continuation(
    payload: dict[str, Any],
    *,
    jobs_client: "CloudRunJobsClient",
    storage_client: Any | None = None,
) -> dict[str, Any]:
    if payload.get("schema_version") != "pipeline-modal-prediction-callback-v2":
        raise ValueError("pipeline_modal_handoff_schema_invalid")
    run_id = str(payload.get("run_id") or "").strip()
    run_date = str(payload.get("run_date") or "")[:10]
    state_gcs_uri = str(payload.get("state_gcs_uri") or "").strip()
    result_gcs_uri = str(payload.get("result_gcs_uri") or "").strip()
    result_checksum = str(payload.get("result_checksum") or "").strip()
    if not run_date or not state_gcs_uri.startswith("gs://"):
        raise ValueError("pipeline_modal_handoff_lineage_missing")
    result_bucket, _ = _parse_gcs_uri(result_gcs_uri)
    if len(result_checksum) != 64:
        raise ValueError("pipeline_modal_result_checksum_invalid")

    client = storage_client or storage.Client()
    bundle = load_verified_modal_prediction_bundle(
        result_gcs_uri=result_gcs_uri,
        expected_checksum=result_checksum,
        storage_client=client,
    )
    expected_lineage = {
        "run_id": run_id,
        "run_date": run_date,
        "state_gcs_uri": state_gcs_uri,
    }
    for key, expected in expected_lineage.items():
        if str(bundle.get(key) or "").strip() != expected:
            raise ValueError(f"pipeline_modal_result_lineage_mismatch:{key}")

    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip() or result_bucket
    bucket = client.bucket(bucket_name)
    receipt_path = (
        f"pipeline-v2/modal-continuations/{run_date}/"
        f"{_safe_run_id(run_id)}-{result_checksum[:16]}.json"
    )
    blob = bucket.blob(receipt_path)
    now = datetime.now(timezone.utc)
    claim = {
        "schema_version": "pipeline-modal-continuation-receipt-v1",
        "status": "dispatching",
        "run_id": run_id,
        "run_date": run_date,
        "state_gcs_uri": state_gcs_uri,
        "result_gcs_uri": result_gcs_uri,
        "result_checksum": result_checksum,
        "attempt": 1,
        "updated_at": now.isoformat(),
    }
    try:
        blob.upload_from_string(
            json.dumps(claim, sort_keys=True),
            content_type="application/json",
            if_generation_match=0,
        )
    except PreconditionFailed:
        blob.reload()
        existing = json.loads(blob.download_as_text())
        status = str(existing.get("status") or "")
        if status == "dispatched":
            return {**existing, "idempotent": True, "receipt_path": receipt_path}
        try:
            updated_at = datetime.fromisoformat(str(existing.get("updated_at") or "").replace("Z", "+00:00"))
            age_seconds = (now - updated_at).total_seconds()
        except ValueError:
            age_seconds = _DISPATCH_STALE_SECONDS + 1
        if status == "dispatching" and age_seconds < _DISPATCH_STALE_SECONDS:
            return {**existing, "idempotent": True, "receipt_path": receipt_path}
        claim["attempt"] = int(existing.get("attempt") or 0) + 1
        claim["takeover_reason"] = f"stale_or_failed:{status or 'unknown'}"
        blob.upload_from_string(
            json.dumps(claim, sort_keys=True),
            content_type="application/json",
            if_generation_match=blob.generation,
        )

    try:
        execution = jobs_client.run_job(
            env_overrides={
                "PIPELINE_MODAL_CONTINUATION_MODE": "1",
                "PIPELINE_RUN_DATE": run_date,
                "PIPELINE_PARENT_RUN_ID": run_id,
                "PIPELINE_STATE_GCS_URI": state_gcs_uri,
                "PIPELINE_MODAL_RESULT_GCS_URI": result_gcs_uri,
                "PIPELINE_MODAL_RESULT_CHECKSUM": result_checksum,
                "PIPELINE_MODAL_ELAPSED_S": str(payload.get("elapsed_s") or ""),
            },
            reject_if_running=False,
        )
    except Exception as exc:
        blob.reload()
        failed = {
            **claim,
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        blob.upload_from_string(
            json.dumps(failed, sort_keys=True),
            content_type="application/json",
            if_generation_match=blob.generation,
        )
        raise

    blob.reload()
    dispatched = {
        **claim,
        "status": "dispatched",
        "execution_id": execution.execution_id,
        "execution_name": execution.execution_name,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    blob.upload_from_string(
        json.dumps(dispatched, sort_keys=True),
        content_type="application/json",
        if_generation_match=blob.generation,
    )
    return {**dispatched, "idempotent": False, "receipt_path": receipt_path}