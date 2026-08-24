from __future__ import annotations

import gzip
import hashlib
import json
import os
from typing import Any


REQUEST_SCHEMA = "pipeline-modal-prediction-request-v1"
REQUEST_REF_SCHEMA = "pipeline-modal-prediction-request-ref-v1"
DEFAULT_MAX_SYMBOLS = 2_000
DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_COMPRESSED_BYTES = 96 * 1024 * 1024


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(1, value)


def _safe_run_id(value: str) -> str:
    return "".join(character if character.isalnum() or character in {"-", "_", "."} else "_" for character in value)


def prepare_pipeline_modal_request(payload: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    if payload.get("schema_version") != REQUEST_SCHEMA:
        raise ValueError("pipeline_modal_request_schema_invalid")
    run_date = str(payload.get("run_date") or "")[:10]
    run_id = str(payload.get("run_id") or "").strip()
    state_gcs_uri = str(payload.get("state_gcs_uri") or "").strip()
    expected_source_sha = str(payload.get("expected_source_sha") or "").strip().lower()
    callback_url = str(payload.get("callback_url") or "").strip()
    callback_token = str(payload.get("callback_token") or "").strip()
    rows = payload.get("payloads") if isinstance(payload.get("payloads"), list) else []
    symbols = [
        str(row.get("symbol") or row.get("stock_id") or "").strip()
        for row in rows
        if isinstance(row, dict)
    ]
    if (
        len(run_date) != 10
        or not run_id
        or not state_gcs_uri.startswith("gs://")
        or len(expected_source_sha) != 40
        or any(character not in "0123456789abcdef" for character in expected_source_sha)
        or not callback_url
        or not callback_token
        or not rows
        or len(symbols) != len(rows)
        or any(not symbol for symbol in symbols)
        or len(set(symbols)) != len(symbols)
    ):
        raise ValueError("pipeline_modal_request_identity_invalid")

    max_symbols = min(
        DEFAULT_MAX_SYMBOLS,
        _positive_int_env("PIPELINE_MODAL_REQUEST_MAX_SYMBOLS", DEFAULT_MAX_SYMBOLS),
    )
    if len(rows) > max_symbols:
        raise ValueError(f"pipeline_modal_request_symbol_capacity_exceeded:{len(rows)}:{max_symbols}")

    durable_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"callback_url", "callback_token"}
    }
    raw = json.dumps(
        durable_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    max_raw = min(
        DEFAULT_MAX_UNCOMPRESSED_BYTES,
        _positive_int_env(
            "PIPELINE_MODAL_REQUEST_MAX_UNCOMPRESSED_BYTES",
            DEFAULT_MAX_UNCOMPRESSED_BYTES,
        ),
    )
    if len(raw) > max_raw:
        raise ValueError(f"pipeline_modal_request_bytes_exceeded:{len(raw)}:{max_raw}")
    compressed = gzip.compress(raw, compresslevel=6, mtime=0)
    max_compressed = min(
        DEFAULT_MAX_COMPRESSED_BYTES,
        _positive_int_env(
            "PIPELINE_MODAL_REQUEST_MAX_COMPRESSED_BYTES",
            DEFAULT_MAX_COMPRESSED_BYTES,
        ),
    )
    if len(compressed) > max_compressed:
        raise ValueError(
            f"pipeline_modal_request_compressed_bytes_exceeded:{len(compressed)}:{max_compressed}"
        )

    raw_sha = hashlib.sha256(raw).hexdigest()
    compressed_sha = hashlib.sha256(compressed).hexdigest()
    envelope = {
        "schema_version": REQUEST_REF_SCHEMA,
        "run_date": run_date,
        "run_id": run_id,
        "state_gcs_uri": state_gcs_uri,
        "expected_source_sha": expected_source_sha,
        "request_sha256": raw_sha,
        "request_compressed_sha256": compressed_sha,
        "request_uncompressed_bytes": len(raw),
        "request_compressed_bytes": len(compressed),
        "n_input": len(rows),
        "max_symbols": max_symbols,
        "callback_url": callback_url,
        "callback_token": callback_token,
    }
    return compressed, envelope


def write_pipeline_modal_request_artifact(
    payload: dict[str, Any],
    *,
    storage_client: Any | None = None,
) -> dict[str, Any]:
    from google.api_core.exceptions import PreconditionFailed
    from google.cloud import storage

    compressed, envelope = prepare_pipeline_modal_request(payload)
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME is required for pipeline Modal request artifact")
    prefix = os.environ.get(
        "PIPELINE_MODAL_REQUEST_GCS_PREFIX",
        "pipeline-v2/async-modal-prediction",
    ).strip().strip("/")
    blob_name = (
        f"{prefix}/{envelope['run_date']}/{_safe_run_id(str(envelope['run_id']))}/"
        f"modal_request/{envelope['request_sha256']}.json.gz"
    )
    client = storage_client or storage.Client()
    blob = client.bucket(bucket_name).blob(blob_name)
    blob.metadata = {
        "schema_version": REQUEST_REF_SCHEMA,
        "request_sha256": str(envelope["request_sha256"]),
        "request_compressed_sha256": str(envelope["request_compressed_sha256"]),
        "run_id": str(envelope["run_id"]),
        "run_date": str(envelope["run_date"]),
        "n_input": str(envelope["n_input"]),
    }
    try:
        blob.upload_from_string(
            compressed,
            content_type="application/gzip",
            if_generation_match=0,
        )
    except PreconditionFailed:
        # The object name is content-addressed. A concurrent/retried producer
        # may reuse it only after exact metadata and size readback below.
        pass
    blob.reload()
    metadata = dict(blob.metadata or {})
    if (
        int(blob.size or -1) != len(compressed)
        or metadata.get("request_sha256") != envelope["request_sha256"]
        or metadata.get("request_compressed_sha256") != envelope["request_compressed_sha256"]
        or metadata.get("run_id") != envelope["run_id"]
        or metadata.get("run_date") != envelope["run_date"]
        or metadata.get("n_input") != str(envelope["n_input"])
    ):
        raise RuntimeError("pipeline_modal_request_artifact_readback_mismatch")
    return {
        **envelope,
        "request_gcs_uri": f"gs://{bucket_name}/{blob_name}",
        "request_generation": str(blob.generation or ""),
    }
