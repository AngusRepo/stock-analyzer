from __future__ import annotations

from typing import Any

from .timesfm_adapter import run_benchmark as _run_timesfm_benchmark


TIMESFM25_MODEL_ID = "google/timesfm-2.5-200m-pytorch"


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    payload = dict(payload or {})
    data_slice = dict(payload.get("data_slice") or {})
    data_slice.setdefault("model_id", TIMESFM25_MODEL_ID)
    data_slice.setdefault("seq_len", int(data_slice.get("seq_len") or payload.get("seq_len") or 256))
    payload["data_slice"] = data_slice
    payload.setdefault("model_id", TIMESFM25_MODEL_ID)
    result = _run_timesfm_benchmark(payload)
    result["candidate_id"] = "TimesFM25"
    if isinstance(result.get("data_slice_report"), dict):
        result["data_slice_report"]["adapter_note"] = "TimesFM 2.5 maintained-runtime migration benchmark."
        result["data_slice_report"]["model_id"] = TIMESFM25_MODEL_ID
    return result
