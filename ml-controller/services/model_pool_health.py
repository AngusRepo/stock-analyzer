"""Model health view backed by model_pool.json.

model_health_daily is a legacy D1 snapshot table. Runtime health, IC, and
lifecycle status are owned by universal/model_pool.json.
"""

from __future__ import annotations

import json
import os
from typing import Any

from google.cloud import storage


def _bucket_name() -> str:
    return os.environ.get("GCS_BUCKET_NAME", "").strip()


def _as_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out


def read_model_pool_health_rows() -> list[dict[str, Any]]:
    """Return a report-friendly model health view from model_pool.json."""
    bucket_name = _bucket_name()
    if not bucket_name:
        return []

    blob = storage.Client().bucket(bucket_name).blob("universal/model_pool.json")
    if not blob.exists():
        return []

    pool = json.loads(blob.download_as_text())
    rows: list[dict[str, Any]] = []
    for model_name, raw in sorted((pool.get("models") or {}).items()):
        if not isinstance(raw, dict):
            continue
        ic_4w = _as_float(raw.get("ic_4w_avg"))
        rolling_ic = _as_float(raw.get("rolling_ic"))
        rows.append({
            "model_name": model_name,
            "accuracy_30d": None,
            "accuracy_90d": None,
            "profit_factor": None,
            "expectancy": None,
            "lifecycle_status": raw.get("status") or "unknown",
            "lifecycle_weight": raw.get("weight_mult", 1.0),
            "ic_4w_avg": ic_4w,
            "rolling_ic": rolling_ic,
            "ic_mean": ic_4w if ic_4w is not None else rolling_ic,
            "last_ic_status": raw.get("last_ic_status"),
            "last_ic_sample_count": raw.get("last_ic_sample_count") or 0,
            "weekly_ic_count": len(raw.get("weekly_ic") or []),
            "metadata_exists": raw.get("metadata_exists"),
            "source_of_truth": "model_pool.json",
        })
    return rows

