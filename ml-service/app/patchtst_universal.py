"""NeuralForecast-backed PatchTST production runtime."""

from __future__ import annotations

from typing import Any

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
