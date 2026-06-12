"""NeuralForecast-backed PatchTST production runtime."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .model_store import _get_bucket
from .neuralforecast_sequence_runtime import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_STEPS,
    DEFAULT_PRED_LEN,
    DEFAULT_SEQ_LEN,
    MODEL_CONFIG,
    neuralforecast_batch_predict,
    train_neuralforecast_sequence_artifact,
)

MODEL_NAME = "PatchTST"
GCS_WEIGHTS_PREFIX = MODEL_CONFIG[MODEL_NAME]["gcs_prefix"]
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
        "model_type": MODEL_CONFIG[MODEL_NAME]["model_type"],
        "artifact_schema": metadata.get("artifact_schema"),
        "runtime_package": metadata.get("runtime_package", "neuralforecast"),
        "seq_len": metadata.get("seq_len"),
        "pred_len": metadata.get("pred_len"),
        "metadata_path": metadata.get("metadata_path"),
        "balance_family": "time_series",
        "promoted_at": promoted_at,
        "last_ic_status": "awaiting_live_ic",
        "last_ic_root_cause": "new_neuralforecast_patchtst_artifact_awaiting_verified_predictions",
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
            "source": "neuralforecast_patchtst_formal_retrain",
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
        "note": "Production serving is owned by model_pool.models.PatchTST via NeuralForecast artifact.",
        "last_updated": promoted_at,
    })

    pool["last_updated"] = promoted_at
    pool_blob.upload_from_string(
        json.dumps(pool, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"old_version": old_version, "new_version": version, "artifact_path": artifact_path, "promoted_at": promoted_at}


def train_patchtst(
    series_close: list[list[float]] | None = None,
    sequence_records: list[dict] | None = None,
    seq_len: int = DEFAULT_SEQ_LEN,
    pred_len: int = DEFAULT_PRED_LEN,
    n_epochs: int = DEFAULT_MAX_STEPS,
    batch_size: int = DEFAULT_BATCH_SIZE,
    val_ratio: float = 0.2,
    version: str = "v1",
    **kwargs: Any,
) -> dict[str, Any]:
    """Train NeuralForecast PatchTST and return artifact metadata.

    `series_close` is accepted only for caller compatibility; production
    training should provide `sequence_records` so symbol/date lineage exists.
    """
    records = sequence_records or [
        {"symbol": f"series_{idx}", "close": close, "dates": []}
        for idx, close in enumerate(series_close or [])
    ]
    result = train_neuralforecast_sequence_artifact(
        {
            **kwargs,
            "candidate_id": MODEL_NAME,
            "version": version,
            "sequence_records": records,
            "seq_len": seq_len,
            "pred_len": pred_len,
            "max_steps": int(kwargs.get("max_steps") or n_epochs),
            "batch_size": batch_size,
            "oos_ratio": val_ratio,
            "promote_to_active": bool(kwargs.get("promote_to_active", False)),
        },
        model_name=MODEL_NAME,
    )
    pool_update = None
    if bool(kwargs.get("promote_to_active", False)):
        bucket = _get_bucket()
        if bucket is None:
            raise RuntimeError("GCS bucket not available")
        pool_update = _update_model_pool_active(
            bucket,
            version=result["version"],
            artifact_path=result["artifact_path"],
            metadata=result["metadata"],
            reason=str(kwargs.get("promotion_reason") or "formal NeuralForecast PatchTST artifact retrain approved by Wei"),
        )
    return {
        "metadata": result["metadata"],
        "ic_tracking": {
            MODEL_NAME: {
                "oos_ic": result["metrics"]["oos_ic"],
                "oos_samples": result["metrics"]["oos_samples"],
                "pbo": result["metrics"]["pbo"],
                "passed": float(result["metrics"]["oos_ic"] or 0.0) > 0.0,
                "source": "neuralforecast_sequence_oos",
            }
        },
        "saved": {
            "weights_path": result["artifact_path"],
            "metadata_path": result["metadata_path"],
            "checksum": result["checksum"],
        },
        "version": result["version"],
        "elapsed_s": result["elapsed_s"],
        "type": "neuralforecast_patchtst_universal",
        "pool_update": pool_update,
    }


def save_to_gcs(_state_dict: Any, metadata: dict, version: str = "v1") -> dict[str, Any]:
    """Compatibility shim.

    NeuralForecast artifacts are saved by `train_patchtst`; this function
    returns the already-written artifact paths and never writes legacy .pt.
    """
    return {
        "weights_path": metadata.get("artifact_path") or f"{GCS_WEIGHTS_PREFIX}/{version}.zip",
        "metadata_path": metadata.get("metadata_path") or f"{GCS_WEIGHTS_PREFIX}/metadata_{version}.json",
        "checksum": metadata.get("checksum"),
    }


def patchtst_batch_predict(
    series_list: list[dict],
    horizon_used: int = DEFAULT_PRED_LEN,
    version: str = "v1",
) -> list[dict]:
    return neuralforecast_batch_predict(
        model_name=MODEL_NAME,
        series_list=series_list,
        horizon_used=horizon_used,
        version=version,
    )


CURRENT_CONFIG = {
    "version": "v1",
    "seq_len": DEFAULT_SEQ_LEN,
    "pred_len": DEFAULT_PRED_LEN,
    "runtime": "NeuralForecast",
    "artifact_schema": MODEL_CONFIG[MODEL_NAME]["artifact_schema"],
    "strategy": "NeuralForecast PatchTST artifact-backed batch serving",
}
