"""Report-friendly health read model backed by exact Learning-D1 champion identities."""

from __future__ import annotations

from typing import Any

from services.model_serving_resolver import load_d1_champion_pool


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def read_model_pool_health_rows() -> list[dict[str, Any]]:
    pool = load_d1_champion_pool()
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
            "lifecycle_weight": 1.0 if raw.get("serving_eligible") is True else 0.0,
            "ic_4w_avg": ic_4w,
            "rolling_ic": rolling_ic,
            "ic_mean": ic_4w if ic_4w is not None else rolling_ic,
            "last_ic_status": raw.get("last_ic_status"),
            "last_ic_root_cause": raw.get("last_ic_root_cause"),
            "last_ic_sample_count": raw.get("last_ic_sample_count") or 0,
            "last_ic_diagnostics": raw.get("last_ic_diagnostics") or {},
            "weekly_ic_count": len(raw.get("weekly_ic") or []),
            "metadata_exists": bool(raw.get("metadata_path")),
            "serving_artifact_id": raw.get("serving_artifact_id"),
            "serving_block_reason": raw.get("serving_block_reason"),
            "source_of_truth": "model_champion_pointers/model_artifact_registry",
        })
    return rows