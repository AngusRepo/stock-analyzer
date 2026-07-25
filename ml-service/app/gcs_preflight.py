from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any


def verify_gcs_object_lifecycle(
    bucket: Any,
    *,
    workload: str,
    run_id: str,
    prefix: str = "health/preflight",
) -> dict[str, Any]:
    """Verify create/read/delete permissions before an expensive GCS workload."""

    safe_workload = "".join(ch for ch in str(workload) if ch.isalnum() or ch in {"-", "_"})
    safe_run_id = "".join(ch for ch in str(run_id) if ch.isalnum() or ch in {"-", "_"})
    object_name = (
        f"{prefix.strip('/')}/{safe_workload or 'unknown'}/"
        f"{safe_run_id or 'unknown'}/{uuid.uuid4().hex}.json"
    )
    payload = json.dumps(
        {
            "schema_version": "stockvision-gcs-object-lifecycle-canary-v1",
            "workload": workload,
            "run_id": run_id,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    checksum = hashlib.sha256(payload).hexdigest()
    blob = bucket.blob(object_name)
    uploaded = False
    try:
        blob.upload_from_string(
            payload,
            content_type="application/json",
            if_generation_match=0,
        )
        uploaded = True
        downloaded = blob.download_as_bytes()
        if hashlib.sha256(downloaded).hexdigest() != checksum:
            raise RuntimeError("gcs_preflight_read_checksum_mismatch")
        generation = getattr(blob, "generation", None)
        delete_kwargs = {"if_generation_match": generation} if generation is not None else {}
        blob.delete(**delete_kwargs)
        uploaded = False
        if blob.exists():
            raise RuntimeError("gcs_preflight_delete_verification_failed")
        return {
            "status": "pass",
            "schema_version": "stockvision-gcs-object-lifecycle-canary-v1",
            "bucket": str(getattr(bucket, "name", "")),
            "object_name": object_name,
            "checksum": checksum,
            "operations": ["create", "read", "delete"],
        }
    finally:
        if uploaded:
            try:
                blob.delete()
            except Exception:
                pass
