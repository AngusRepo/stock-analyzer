"""Formal NeuralForecast iTransformer artifact training and model_pool registration."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .neuralforecast_sequence_runtime import train_neuralforecast_sequence_artifact
from .model_store import _get_bucket

MODEL_NAME = "iTransformer"
STALE_PROMOTION_FIELDS = (
    "artifact_backfill",
    "ic_4w_avg",
    "last_ic_by_segment",
    "model_cpcv",
    "rolling_ic",
    "weekly_ic",
)


def _update_model_pool_active(bucket, *, version: str, artifact_path: str, metadata: dict, reason: str) -> dict:
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        raise RuntimeError("universal/model_pool.json not found")
    pool = json.loads(pool_blob.download_as_text().lstrip("\ufeff"))
    entry = (pool.setdefault("models", {})).setdefault(MODEL_NAME, {})
    old_version = entry.get("version")
    promoted_at = datetime.now(timezone.utc).isoformat()
    if old_version and str(old_version) != str(version):
        entry.setdefault("retired_versions", []).append({
            "version": old_version,
            "gcs_path": entry.get("gcs_path"),
            "retired_at": promoted_at,
            "reason": reason,
            "weekly_ic_at_retire": list(entry.get("weekly_ic") or []),
            "ic_4w_avg_at_retire": entry.get("ic_4w_avg"),
        })
    entry.update({
        "status": "active",
        "version": version,
        "gcs_path": artifact_path,
        "model_type": "time_series_transformer_neuralforecast_itransformer",
        "artifact_schema": metadata.get("artifact_schema"),
        "runtime_package": metadata.get("runtime_package", "neuralforecast"),
        "seq_len": metadata.get("seq_len"),
        "pred_len": metadata.get("pred_len"),
        "metadata_path": metadata.get("metadata_path"),
        "balance_family": "time_series",
        "promoted_at": promoted_at,
        "last_ic_status": "awaiting_live_ic",
        "last_ic_root_cause": "new_neuralforecast_itransformer_artifact_awaiting_verified_predictions",
        "last_ic_sample_count": 0,
        "last_artifact_evidence": {
            "oos_ic": metadata.get("oos_ic"),
            "direction_accuracy": metadata.get("direction_accuracy"),
            "oos_samples": (metadata.get("metrics") or {}).get("oos_samples"),
            "pbo": (metadata.get("metrics") or {}).get("pbo"),
            "artifact_schema": metadata.get("artifact_schema"),
            "prep_lineage": metadata.get("prep_lineage"),
        },
        "promotion_controller": {
            "source": "neuralforecast_itransformer_formal_retrain",
            "reason": reason,
            "promoted_at": promoted_at,
            "artifact_path": artifact_path,
        },
    })
    for field in STALE_PROMOTION_FIELDS:
        entry.pop(field, None)
    entry.pop("challenger", None)
    entry.pop("degraded_since", None)
    entry.pop("retired_at", None)

    slot = (pool.setdefault("formal_layer3_slots", {})).setdefault(MODEL_NAME, {})
    slot.update({
        "status": "artifact_backed_model_pool_active",
        "version": version,
        "gcs_path": artifact_path,
        "artifact_schema": metadata.get("artifact_schema"),
        "runtime_package": metadata.get("runtime_package", "neuralforecast"),
        "seq_len": metadata.get("seq_len"),
        "pred_len": metadata.get("pred_len"),
        "metadata_path": metadata.get("metadata_path"),
        "direct_prediction": False,
        "vote_weight": 0.0,
        "note": "Production serving is owned by model_pool.models.iTransformer via NeuralForecast artifact.",
        "last_updated": promoted_at,
    })

    pool["last_updated"] = promoted_at
    pool_blob.upload_from_string(
        json.dumps(pool, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"old_version": old_version, "new_version": version, "artifact_path": artifact_path, "promoted_at": promoted_at}


def train_itransformer_universal(payload: dict | None = None) -> dict[str, Any]:
    payload = dict(payload or {})
    promote_to_active = bool(payload.get("promote_to_active", True))
    payload["promote_to_active"] = promote_to_active
    result = train_neuralforecast_sequence_artifact(payload, model_name=MODEL_NAME)
    pool_update = None
    if promote_to_active:
        bucket = _get_bucket()
        if bucket is None:
            raise RuntimeError("GCS bucket not available")
        pool_update = _update_model_pool_active(
            bucket,
            version=result["version"],
            artifact_path=result["artifact_path"],
            metadata=result["metadata"],
            reason=str(payload.get("promotion_reason") or "formal NeuralForecast iTransformer artifact retrain approved by Wei"),
        )
    model_cpcv = (
        result.get("model_cpcv")
        or (result.get("metadata") or {}).get("model_cpcv")
        or (result.get("metrics") or {}).get("model_cpcv")
    )
    return {
        **result,
        "model_cpcv": model_cpcv,
        "pool_update": pool_update,
    }
