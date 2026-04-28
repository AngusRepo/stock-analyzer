"""Training finalization helpers for split universal retrain.

Tree, FT, and sequence models run in separate Modal jobs. This module keeps the
join contract explicit so the orchestrator can fail closed and train the rank
stacker from standard OOS artifacts instead of relying on one monolithic job.
"""

from __future__ import annotations

import re
from typing import Iterable

import numpy as np

TREE_MODELS = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]
FTT_MODELS = ["FT-Transformer"]
SEQUENCE_GROUPS = {"dlinear", "patchtst"}
OOS_ARTIFACT_GROUPS = {"tree", "ftt"}


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug or "unknown"


def derive_oos_artifact_group(models_filter: list[str] | None) -> str:
    """Return a stable artifact group name for a train split."""

    if not models_filter:
        return "full"
    ordered = list(models_filter)
    if ordered == TREE_MODELS:
        return "tree"
    if ordered == FTT_MODELS:
        return "ftt"
    return "custom_" + "_".join(_safe_slug(name) for name in ordered)


def build_oos_artifact_path(gcs_prefix: str | None, version: str, group: str) -> str:
    prefix = (gcs_prefix or "universal").strip("/")
    return f"{prefix}/oos/{version}/{_safe_slug(group)}.npz"


def summarize_training_stage_status(coverage: dict[str, dict]) -> str:
    """Summarize group coverage without allowing partial success to look clean."""

    if not coverage:
        return "error"
    statuses = {str(v.get("status", "unknown")) for v in coverage.values()}
    if statuses and statuses <= {"ok"}:
        return "ok"
    if "ok" in statuses:
        return "degraded"
    return "error"


def expected_oos_artifact_groups(requested_groups: list[str]) -> list[str]:
    """Return split groups that must provide OOS artifacts before stacker save."""

    return [group for group in requested_groups if group in OOS_ARTIFACT_GROUPS]


def missing_expected_oos_groups(expected_groups: list[str], payloads: Iterable[dict]) -> list[str]:
    present = {str(payload.get("group")) for payload in payloads if payload.get("group")}
    return [group for group in expected_groups if group not in present]


def validate_sequence_series(
    series_close: Iterable[Iterable[float]],
    *,
    min_len: int = 65,
) -> tuple[list[list[float]], dict]:
    """Filter raw close sequences before dispatching sequence-model jobs."""

    valid: list[list[float]] = []
    report = {
        "input_series": 0,
        "valid_series": 0,
        "dropped_short": 0,
        "dropped_non_finite": 0,
        "min_len": int(min_len),
    }
    for row in series_close or []:
        report["input_series"] += 1
        arr = np.asarray(list(row), dtype=float).reshape(-1)
        if len(arr) < min_len:
            report["dropped_short"] += 1
            continue
        if not np.isfinite(arr).all():
            report["dropped_non_finite"] += 1
            continue
        valid.append([float(v) for v in arr])

    report["valid_series"] = len(valid)
    return valid, report


def merge_oos_rank_payloads(
    payloads: Iterable[dict],
) -> tuple[list[dict[str, float]], np.ndarray, list[str]]:
    """Merge split OOS rank artifacts into stacker rows.

    Each payload must contain:
      - predictions: {model_name: 1d array-like}
      - y_test: 1d array-like

    The reducer requires identical y length and values across payloads. In the
    current split architecture tree and FT read the same prep batches and split
    config, so mismatches indicate a broken training contract.
    """

    merged_predictions: dict[str, np.ndarray] = {}
    expected_y: np.ndarray | None = None
    expected_len: int | None = None

    for payload in payloads:
        preds = payload.get("predictions") or {}
        if not preds:
            continue

        y_arr = np.asarray(payload.get("y_test"), dtype=float).reshape(-1)
        if expected_y is None:
            expected_y = y_arr
            expected_len = len(y_arr)
        elif len(y_arr) != expected_len or not np.allclose(y_arr, expected_y, equal_nan=True):
            group = payload.get("group", "unknown")
            raise ValueError(f"OOS artifact y_test mismatch for group={group}")

        for model_name, values in preds.items():
            arr = np.asarray(values, dtype=float).reshape(-1)
            if expected_len is None or len(arr) != expected_len:
                raise ValueError(
                    f"OOS prediction length mismatch for {model_name}: "
                    f"{len(arr)} != {expected_len}"
                )
            merged_predictions[model_name] = np.clip(arr, 0.0, 1.0)

    if expected_y is None or expected_len is None or not merged_predictions:
        return [], np.asarray([], dtype=float), []

    model_order = list(merged_predictions.keys())
    rows = [
        {model_name: float(merged_predictions[model_name][idx]) for model_name in model_order}
        for idx in range(expected_len)
    ]
    return rows, expected_y, model_order
