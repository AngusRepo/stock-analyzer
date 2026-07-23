"""Fail-closed recovery of a pipeline from a pre-open point-in-time state."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx
from services.state_space_series import long_history_sequence_artifact_evidence


RECOVERY_SCHEMA_VERSION = "pipeline-snapshot-recovery-lineage-v1"
RECOVERY_GENERATION_MODE = "point_in_time_snapshot_recovery"
RECOVERY_SCOPE = "serving_contract_only"
_MUTABLE_RECOVERY_STATE_KEYS = {
    "producer_run_id",
    "pipeline_modal_serving_context",
    "snapshot_recovery_lineage",
    "modal_prediction_state_gcs_uri",
    "modal_prediction_bundle",
}


def _utc_datetime(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _canonical_checksum(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def pit_state_checksum(state: dict[str, Any]) -> str:
    immutable = {
        key: value
        for key, value in state.items()
        if key not in _MUTABLE_RECOVERY_STATE_KEYS
    }
    return _canonical_checksum(immutable)


def _parse_gcs_uri(gcs_uri: str) -> tuple[str, str]:
    if not gcs_uri.startswith("gs://") or "/" not in gcs_uri.removeprefix("gs://"):
        raise ValueError("pipeline_snapshot_recovery_source_uri_invalid")
    return tuple(gcs_uri.removeprefix("gs://").split("/", 1))  # type: ignore[return-value]


def load_pipeline_state_envelope(
    gcs_uri: str,
    *,
    storage_client: Any | None = None,
) -> dict[str, Any]:
    from google.cloud import storage

    bucket_name, blob_name = _parse_gcs_uri(gcs_uri)
    configured_bucket = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not configured_bucket or bucket_name != configured_bucket:
        raise ValueError("pipeline_snapshot_recovery_source_bucket_mismatch")
    client = storage_client or storage.Client()
    blob = client.bucket(bucket_name).blob(blob_name)
    raw = blob.download_as_bytes()
    blob.reload()
    payload = json.loads(raw.lstrip(b"\xef\xbb\xbf"))
    if payload.get("schema_version") != "pipeline-async-state-v1":
        raise ValueError("pipeline_snapshot_recovery_source_schema_invalid")
    state = payload.get("state")
    if not isinstance(state, dict):
        raise ValueError("pipeline_snapshot_recovery_source_state_missing")
    return {
        "payload": payload,
        "state": state,
        "artifact": {
            "gcs_uri": gcs_uri,
            "generation": str(blob.generation or ""),
            "updated_at": _utc_datetime(blob.updated).isoformat(),
            "size": int(blob.size or len(raw)),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "md5_hash": str(blob.md5_hash or ""),
            "crc32c": str(blob.crc32c or ""),
        },
    }


def validate_snapshot_recovery_source(
    envelope: dict[str, Any],
    *,
    source_gcs_uri: str,
    run_date: str,
    next_session_date: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    state = envelope.get("state") if isinstance(envelope.get("state"), dict) else {}
    artifact = envelope.get("artifact") if isinstance(envelope.get("artifact"), dict) else {}
    if str(payload.get("run_date") or "")[:10] != run_date or str(state.get("run_date") or "")[:10] != run_date:
        raise ValueError("pipeline_snapshot_recovery_run_date_mismatch")
    if str(payload.get("producer_run_id") or "") != str(state.get("producer_run_id") or ""):
        raise ValueError("pipeline_snapshot_recovery_producer_lineage_mismatch")
    if str(artifact.get("gcs_uri") or "") != source_gcs_uri:
        raise ValueError("pipeline_snapshot_recovery_artifact_uri_mismatch")
    expected_path = f"/{run_date}/"
    if expected_path not in source_gcs_uri or not source_gcs_uri.endswith("/partial_state.json"):
        raise ValueError("pipeline_snapshot_recovery_source_path_mismatch")

    source_created_at = _utc_datetime(payload.get("created_at"))
    next_session_open = _utc_datetime(f"{next_session_date}T01:00:00Z")
    if next_session_date <= run_date:
        raise ValueError("pipeline_snapshot_recovery_next_session_invalid")
    if source_created_at >= next_session_open:
        raise ValueError("pipeline_snapshot_recovery_source_not_preopen")

    payloads = state.get("payloads") if isinstance(state.get("payloads"), list) else []
    l3_payloads = state.get("l3_payloads") if isinstance(state.get("l3_payloads"), list) else []
    if not payloads or not l3_payloads or len(payloads) != len(l3_payloads):
        raise ValueError("pipeline_snapshot_recovery_payloads_incomplete")
    payload_symbols = [str(row.get("symbol") or "") for row in payloads if isinstance(row, dict)]
    l3_symbols = [str(row.get("symbol") or "") for row in l3_payloads if isinstance(row, dict)]
    if payload_symbols != l3_symbols or any(not symbol for symbol in payload_symbols):
        raise ValueError("pipeline_snapshot_recovery_payload_identity_mismatch")
    if state.get("modal_prediction_bundle") or state.get("modal_prediction_state_gcs_uri"):
        raise ValueError("pipeline_snapshot_recovery_source_already_continued")

    source_context = state.get("pipeline_modal_serving_context")
    if not isinstance(source_context, dict) or source_context.get("schema_version") != "pipeline-modal-serving-context-v1":
        raise ValueError("pipeline_snapshot_recovery_source_serving_context_missing")
    source_versions = {
        str(name): str(version)
        for name, version in (source_context.get("active_versions") or {}).items()
        if str(name) and str(version)
    }
    if not source_versions:
        raise ValueError("pipeline_snapshot_recovery_source_active_versions_missing")

    lineage = {
        "schema_version": RECOVERY_SCHEMA_VERSION,
        "generation_mode": RECOVERY_GENERATION_MODE,
        "recovery_scope": RECOVERY_SCOPE,
        "eligible_for_native_learning": False,
        "source_state_gcs_uri": source_gcs_uri,
        "source_state_created_at": source_created_at.isoformat(),
        "source_state_generation": str(artifact.get("generation") or ""),
        "source_artifact_sha256": str(artifact.get("sha256") or ""),
        "source_pit_state_checksum": pit_state_checksum(state),
        "source_producer_run_id": str(state.get("producer_run_id") or ""),
        "source_active_versions": source_versions,
        "next_session_date": next_session_date,
        "next_session_open_utc": next_session_open.isoformat(),
        "candidate_count": len(payloads),
    }
    return deepcopy(state), lineage


def _active_versions(context: dict[str, Any]) -> dict[str, str]:
    return {
        str(name): str(version)
        for name, version in (context.get("active_versions") or {}).items()
        if str(name) and str(version)
    }


def resolve_next_session_evidence(
    run_date: str,
    *,
    query_fn: Callable[..., list[dict[str, Any]]],
    http_get: Callable[..., Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    rows = query_fn(
        """
        SELECT MIN(date) AS next_session_date
          FROM canonical_market_daily
         WHERE stock_id = '0050'
           AND source = 'finlab.price'
           AND date > ?
        """,
        [run_date],
    )
    d1_date = str((rows or [{}])[0].get("next_session_date") or "")[:10]
    if d1_date:
        return d1_date, {
            "schema_version": "pipeline-next-session-evidence-v1",
            "calendar_owner": "canonical_market_daily:0050:finlab.price",
            "next_session_date": d1_date,
        }

    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    worker_token = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
    if not worker_url or not worker_token:
        raise ValueError("pipeline_snapshot_recovery_worker_calendar_not_configured")
    request = http_get or httpx.get
    response = request(
        f"{worker_url}/api/admin/historical-lineage-boundary",
        params={"task": "pipeline", "date": run_date},
        headers={"Authorization": f"Bearer {worker_token}"},
        timeout=30.0,
    )
    if int(response.status_code) != 200:
        raise ValueError(f"pipeline_snapshot_recovery_worker_calendar_http_{response.status_code}")
    payload = response.json()
    boundary = payload.get("boundary") if isinstance(payload.get("boundary"), dict) else {}
    next_date = str(boundary.get("nextSessionDate") or "")[:10]
    next_open = str(boundary.get("nextSessionOpenUtc") or "")
    if (
        payload.get("schema_version") != "historical-learning-lineage-boundary-v1"
        or payload.get("calendar_owner") != "worker.schedulerPolicy.nextTwTradingDate"
        or str(boundary.get("signalDate") or "")[:10] != run_date
        or not next_date
        or next_date <= run_date
        or next_open != f"{next_date}T01:00:00.000Z"
    ):
        raise ValueError("pipeline_snapshot_recovery_worker_calendar_contract_invalid")
    return next_date, {
        "schema_version": "pipeline-next-session-evidence-v1",
        "calendar_owner": payload["calendar_owner"],
        "next_session_date": next_date,
        "next_session_open_utc": next_open,
        "boundary_reason": str(boundary.get("reason") or ""),
        "boundary_allowed": bool(boundary.get("allowed")),
    }


async def run_pipeline_snapshot_recovery(
    *,
    source_gcs_uri: str,
    run_date: str,
    producer_run_id: str,
    query_fn: Callable[..., list[dict[str, Any]]],
    attach_serving_context: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
    write_state_artifact: Callable[[dict[str, Any]], str],
    build_modal_payload: Callable[..., Awaitable[dict[str, Any]]],
    spawn_prediction_bundle: Callable[[dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    if not source_gcs_uri or not run_date or not producer_run_id:
        raise ValueError("pipeline_snapshot_recovery_required_input_missing")
    next_session_date, next_session_evidence = await asyncio.to_thread(
        resolve_next_session_evidence,
        run_date,
        query_fn=query_fn,
    )

    envelope = await asyncio.to_thread(load_pipeline_state_envelope, source_gcs_uri)
    state, lineage = validate_snapshot_recovery_source(
        envelope,
        source_gcs_uri=source_gcs_uri,
        run_date=run_date,
        next_session_date=next_session_date,
    )
    lineage["next_session_evidence"] = next_session_evidence
    source_pit_checksum = lineage["source_pit_state_checksum"]
    sequence_evidence = await asyncio.to_thread(
        long_history_sequence_artifact_evidence,
        as_of_utc=lineage["source_state_created_at"],
    )
    lineage["sequence_artifact_evidence"] = sequence_evidence
    lineage["recovered_at"] = datetime.now(timezone.utc).isoformat()

    state["producer_run_id"] = producer_run_id
    state.pop("pipeline_modal_serving_context", None)
    state.pop("modal_prediction_bundle", None)
    state.pop("modal_prediction_state_gcs_uri", None)
    state["snapshot_recovery_lineage"] = lineage
    current_context = await attach_serving_context(state)
    if _active_versions(current_context) != lineage["source_active_versions"]:
        raise ValueError("pipeline_snapshot_recovery_active_artifact_changed")
    if pit_state_checksum(state) != source_pit_checksum:
        raise ValueError("pipeline_snapshot_recovery_pit_state_mutated")

    derived_state_gcs_uri = await asyncio.to_thread(write_state_artifact, state)
    modal_payload = await build_modal_payload(state, state_gcs_uri=derived_state_gcs_uri)
    sequence_after = await asyncio.to_thread(
        long_history_sequence_artifact_evidence,
        as_of_utc=lineage["source_state_created_at"],
    )
    if sequence_after["object_fingerprint"] != sequence_evidence["object_fingerprint"]:
        raise ValueError("pipeline_snapshot_recovery_sequence_artifact_changed_during_build")
    spawn_info = await asyncio.to_thread(spawn_prediction_bundle, modal_payload)
    return {
        "status": "deferred",
        "deferred_reason": "modal_prediction_callback",
        "run_date": run_date,
        "metrics": {
            "async_modal_prediction": {
                "status": "triggered",
                "state_gcs_uri": derived_state_gcs_uri,
                "source_state_gcs_uri": source_gcs_uri,
                "function_call_id": spawn_info.get("function_call_id"),
                "function_name": spawn_info.get("function_name"),
                "n_input": spawn_info.get("n_input"),
                "callback_configured": spawn_info.get("callback_configured"),
                "recovery_generation_mode": RECOVERY_GENERATION_MODE,
                "eligible_for_native_learning": False,
            }
        },
        "errors": list(state.get("errors") or []),
    }
