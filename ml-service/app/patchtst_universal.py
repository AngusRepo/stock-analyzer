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


def _sequence_input_series_count(
    series_close: list[list[float]],
    sequence_report: dict | None,
) -> int:
    if sequence_report and int(sequence_report.get("input_series") or 0) > 0:
        return int(sequence_report["input_series"])
    return len(series_close)


def train_patchtst(
    series_close: list[list[float]] | None = None,
    sequence_records: list[dict] | None = None,
    seq_len: int = DEFAULT_SEQ_LEN,
    pred_len: int = DEFAULT_PRED_LEN,
    n_epochs: int = DEFAULT_MAX_STEPS,
    batch_size: int = DEFAULT_BATCH_SIZE,
    val_ratio: float = 0.2,
    version: str = "v1",
    model_cpcv_policy: dict | None = None,
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
            "model_cpcv_policy": model_cpcv_policy or {},

        },
        model_name=MODEL_NAME,
    )
    generation_mode = str(kwargs.get("generation_mode") or "native").strip().lower()
    if generation_mode == "purged_oof":
        model_cpcv = (
            result.get("model_cpcv")
            or (result.get("metadata") or {}).get("model_cpcv")
            or (result.get("metrics") or {}).get("model_cpcv")
        )
        return {
            **result,
            "model_cpcv": model_cpcv,

        }
    model_cpcv = (
        result.get("model_cpcv")
        or (result.get("metadata") or {}).get("model_cpcv")
        or (result.get("metrics") or {}).get("model_cpcv")
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
                "model_cpcv": model_cpcv,
            }
        },
        "model_cpcv": model_cpcv,
        "saved": {
            "weights_path": result["artifact_path"],
            "metadata_path": result["metadata_path"],
            "checksum": result["checksum"],
        },
        "version": result["version"],
        "elapsed_s": result["elapsed_s"],
        "type": "neuralforecast_patchtst_universal",

        "oof_artifact": result.get("oof_artifact"),
    }


def patchtst_batch_predict(
    series_list: list[dict],
    horizon_used: int = DEFAULT_PRED_LEN,
    version: str = "v1",
    *,
    artifact_identity: dict[str, Any] | None = None,
) -> list[dict]:
    return neuralforecast_batch_predict(
        model_name=MODEL_NAME,
        series_list=series_list,
        horizon_used=horizon_used,
        version=version,
        artifact_identity=artifact_identity,
    )


CURRENT_CONFIG = {
    "version": "v1",
    "seq_len": DEFAULT_SEQ_LEN,
    "pred_len": DEFAULT_PRED_LEN,
    "runtime": "NeuralForecast",
    "artifact_schema": MODEL_CONFIG[MODEL_NAME]["artifact_schema"],
    "strategy": "NeuralForecast PatchTST artifact-backed batch serving",
}
