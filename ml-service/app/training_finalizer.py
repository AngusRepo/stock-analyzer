"""Training finalization helpers for split universal retrain.

Tree and sequence models run in separate Modal jobs. This module keeps the
join contract explicit so the orchestrator can fail closed and train the rank
stacker from standard OOS artifacts instead of relying on one monolithic job.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterable

import numpy as np

TREE_MODELS = ["LightGBM", "XGBoost", "ExtraTrees"]
SEQUENCE_GROUPS = {"dlinear", "patchtst"}
OOS_ARTIFACT_GROUPS = {"tree"}
SEQUENCE_MODEL_BY_GROUP = {"dlinear": "DLinear", "patchtst": "PatchTST"}


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


def reduce_training_group_results(
    tree_result: dict | None,
    aux_train: dict[str, dict] | None = None,
) -> dict:
    """Reduce split training results into the orchestrator finalization contract.

    This is intentionally side-effect free. Registration, GCS writes, rank
    stacker training, and callbacks stay with the caller, while the merge rules
    are shared by the current orchestrator and a future detached finalizer.
    """

    aux_train = aux_train or {}
    merged_results: dict[str, dict] = {}
    merged_ic: dict[str, dict] = {}
    partial_errors: list[dict] = []
    circuit_breaker = False
    total_samples = 0

    for group, partial in (("tree", tree_result or {}),):
        if not partial:
            continue
        if partial.get("error"):
            partial_errors.append({"group": group, "error": str(partial["error"])})
            continue
        try:
            total_samples = max(total_samples, int(partial.get("total_samples", 0) or 0))
        except (TypeError, ValueError):
            pass
        for name, result in (partial.get("results") or {}).items():
            if isinstance(result, dict) and not result.get("skipped") and not result.get("error"):
                merged_results[name] = result
        for name, ic in (partial.get("ic_tracking") or {}).items():
            if not isinstance(ic, dict):
                continue
            merged_ic[name] = ic
            if not ic.get("passed", True):
                circuit_breaker = True

    sequence_candidate_models: dict[str, str] = {}
    for group, model_name in SEQUENCE_MODEL_BY_GROUP.items():
        partial = aux_train.get(group) or {}
        if not partial:
            continue
        if partial.get("error"):
            partial_errors.append({"group": group, "error": str(partial["error"])})
        else:
            sequence_candidate_models[group] = model_name
        for name, ic in (partial.get("ic_tracking") or {}).items():
            if not isinstance(ic, dict):
                continue
            merged_ic[name] = ic
            if not ic.get("passed", True):
                circuit_breaker = True

    candidate_models = sorted(set(merged_results) | set(sequence_candidate_models.values()))
    return {
        "merged_results": merged_results,
        "merged_ic": merged_ic,
        "circuit_breaker": circuit_breaker,
        "total_samples": total_samples,
        "candidate_models": candidate_models,
        "sequence_candidate_models": sequence_candidate_models,
        "partial_errors": partial_errors,
    }


def build_suppressed_legacy_challenger_registrations(
    *,
    register_challengers: bool,
    candidate_models: Iterable[str],
    existing_registrations: dict | None,
    candidate_version: str,
) -> dict[str, dict]:
    """Return disabled legacy registration notices outside registry candidates."""

    if register_challengers is not True:
        return {}
    existing = set((existing_registrations or {}).keys())
    suppressed: dict[str, dict] = {}
    for model_name in sorted({str(name) for name in candidate_models if str(name)}):
        if model_name in existing:
            continue
        suppressed[model_name] = {
            "status": "disabled",
            "version": candidate_version,
            "reason": "legacy_model_pool_challenger_disabled_for_active9_artifact_registry_flow",
        }
    return suppressed


def _child_model_names(partial: dict) -> list[str]:
    names = [
        name
        for name, result in (partial.get("results") or {}).items()
        if isinstance(result, dict) and not result.get("skipped")
    ]
    if names:
        return names
    return [name for name in (partial.get("ic_tracking") or {})]


def reduce_tree_model_child_results(
    child_results: dict[str, dict],
    *,
    combined_oos_artifact: dict | None = None,
    oos_artifact_error: str | None = None,
) -> dict:
    """Merge per-tree-model child results into the existing tree-group shape."""

    merged_results: dict[str, dict] = {}
    merged_ic: dict[str, dict] = {}
    challenger_registrations: dict[str, dict] = {}
    child_elapsed_s: dict[str, float] = {}
    child_manifests: dict[str, str] = {}
    child_errors: list[dict] = []
    total_samples = 0
    train_samples = 0
    test_samples = 0
    feature_count = 0
    circuit_breaker = False
    trained_at_values: list[str] = []

    for child_key, partial in (child_results or {}).items():
        partial = partial or {}
        model_names = _child_model_names(partial) or [str(child_key)]
        model_key = model_names[0] if model_names else str(child_key)
        if partial.get("error"):
            child_errors.append({"model": model_key, "error": str(partial["error"])})
            continue
        try:
            child_elapsed_s[model_key] = float(partial.get("elapsed_s", 0.0) or 0.0)
        except (TypeError, ValueError):
            child_elapsed_s[model_key] = 0.0
        for key, current in (
            ("total_samples", total_samples),
            ("train_samples", train_samples),
            ("test_samples", test_samples),
            ("feature_count", feature_count),
        ):
            try:
                value = int(partial.get(key, 0) or 0)
            except (TypeError, ValueError):
                value = 0
            if key == "total_samples":
                total_samples = max(current, value)
            elif key == "train_samples":
                train_samples = max(current, value)
            elif key == "test_samples":
                test_samples = max(current, value)
            elif key == "feature_count":
                feature_count = max(current, value)
        for name, result in (partial.get("results") or {}).items():
            if isinstance(result, dict) and not result.get("skipped") and not result.get("error"):
                merged_results[name] = result
        for name, metrics in (partial.get("ic_tracking") or {}).items():
            if not isinstance(metrics, dict):
                continue
            merged_ic[name] = metrics
            if not metrics.get("passed", True):
                circuit_breaker = True
        for name, registration in (partial.get("challenger_registrations") or {}).items():
            if isinstance(registration, dict):
                challenger_registrations[name] = registration
        if partial.get("training_manifest_path"):
            child_manifests[model_key] = str(partial["training_manifest_path"])
        if partial.get("trained_at"):
            trained_at_values.append(str(partial["trained_at"]))

    if oos_artifact_error:
        child_errors.append({"model": "tree", "error": str(oos_artifact_error)})

    required = set(TREE_MODELS)
    trained = set(merged_results)
    missing = sorted(required - trained, key=TREE_MODELS.index)
    if missing:
        child_errors.append({"model": "tree", "error": f"missing_tree_models:{','.join(missing)}"})

    return {
        "type": "tree_models_split",
        "split_mode": "per_tree_model",
        "total_samples": total_samples,
        "train_samples": train_samples,
        "test_samples": test_samples,
        "feature_count": feature_count,
        "elapsed_s": round(max(child_elapsed_s.values() or [0.0]), 3),
        "child_elapsed_s": child_elapsed_s,
        "results": merged_results,
        "ic_tracking": merged_ic,
        "circuit_breaker": circuit_breaker,
        "candidate_version": _first_present(*(partial.get("candidate_version") for partial in (child_results or {}).values())),
        "challenger_registrations": challenger_registrations,
        "oos_artifact": combined_oos_artifact,
        "child_manifests": dict(sorted(child_manifests.items())),
        "child_errors": child_errors,
        "trained_at": trained_at_values[0] if trained_at_values else None,
        "error": "tree_model_child_errors" if child_errors else None,
    }


def _first_present(*values):
    for value in values:
        if value:
            return value
    return None


def _ic_summary_value(metrics: dict) -> float | None:
    value = metrics.get("ic")
    if value is None:
        value = metrics.get("oos_ic")
    if value is None:
        value = metrics.get("ic_4w_avg")
    return value


def _max_partial_int(partial_results: dict[str, dict], key: str) -> int:
    values = []
    for partial in (partial_results or {}).values():
        try:
            values.append(int(partial.get(key, 0) or 0))
        except (TypeError, ValueError):
            continue
    return max(values) if values else 0


def _first_trained_at(partial_results: dict[str, dict]) -> str:
    for partial in (partial_results or {}).values():
        trained_at = partial.get("trained_at")
        if trained_at:
            return str(trained_at)
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_retrain_followup_payload(
    *,
    run_id: str | None,
    lock_key: str | None,
    run_date: str | None,
    is_monthly: bool,
    batch_count: int,
    gcs_prefix: str,
    candidate_version: str,
    window_id: str | None,
    result: dict,
    partial_results: dict[str, dict],
    elapsed_s: float,
) -> dict:
    """Build the controller followup payload for inline or detached finalizers."""

    from .modal_telemetry import build_retrain_orchestrator_telemetry

    stages = result.get("stages", {}) or {}
    train_stage = stages.get("train", {}) or {}
    return {
        "run_id": run_id,
        "trained_at": _first_trained_at(partial_results),
        "lock_key": lock_key,
        "run_date": run_date,
        "is_monthly": bool(is_monthly),
        "batch_count": int(batch_count),
        "gcs_prefix": gcs_prefix,
        "candidate_version": train_stage.get("candidate_version") or candidate_version,
        "challenger_registrations": train_stage.get("challenger_registrations") or {},
        "window_id": window_id,
        "total_samples": int(train_stage.get("total_samples", 0) or 0),
        "train_samples": _max_partial_int(partial_results, "train_samples"),
        "feature_count": _max_partial_int(partial_results, "feature_count"),
        "elapsed_s": elapsed_s,
        "circuit_breaker": bool(train_stage.get("circuit_breaker", False)),
        "ic_summary": {
            name: _ic_summary_value(metrics)
            for name, metrics in (train_stage.get("ic_tracking", {}) or {}).items()
            if isinstance(metrics, dict)
        },
        "status": "completed" if train_stage.get("status") == "ok" else "error",
        "error": train_stage.get("error"),
        "stages": stages,
        "modal_telemetry": build_retrain_orchestrator_telemetry(
            stages,
            total_elapsed_s=elapsed_s,
            is_monthly=bool(is_monthly),
            run_id=run_id,
            partial_results=partial_results,
        ),
    }


def _ordered_model_names(names: Iterable[str]) -> list[str]:
    order = {
        name: idx
        for idx, name in enumerate([*TREE_MODELS, *SEQUENCE_MODEL_BY_GROUP.values()])
    }
    return sorted({str(name) for name in names}, key=lambda name: (order.get(name, 999), name))


def combine_oos_rank_payloads(
    payloads: Iterable[dict],
    *,
    group: str,
    version: str,
) -> dict:
    """Combine per-model OOS payloads into one group artifact payload."""

    merged_predictions: dict[str, np.ndarray] = {}
    expected_y: np.ndarray | None = None
    expected_dates: np.ndarray | None = None
    expected_features: np.ndarray | None = None

    for payload in payloads or []:
        preds = payload.get("predictions") or {}
        if not preds:
            continue

        y_arr = np.asarray(payload.get("y_test"), dtype=float).reshape(-1)
        if expected_y is None:
            expected_y = y_arr
        elif len(y_arr) != len(expected_y) or not np.allclose(y_arr, expected_y, equal_nan=True):
            raise ValueError(f"OOS artifact y_test mismatch for group={payload.get('group', 'unknown')}")

        if "dates_test" in payload:
            dates_arr = np.asarray(payload.get("dates_test")).reshape(-1)
            if expected_dates is None:
                expected_dates = dates_arr
            elif len(dates_arr) != len(expected_dates) or not np.array_equal(dates_arr.astype(str), expected_dates.astype(str)):
                raise ValueError(f"OOS artifact dates_test mismatch for group={payload.get('group', 'unknown')}")

        if "feature_names" in payload:
            feature_arr = np.asarray(payload.get("feature_names"), dtype=object).reshape(-1)
            if expected_features is None:
                expected_features = feature_arr
            elif len(feature_arr) != len(expected_features) or not np.array_equal(feature_arr.astype(str), expected_features.astype(str)):
                raise ValueError(f"OOS artifact feature_names mismatch for group={payload.get('group', 'unknown')}")

        expected_len = len(expected_y)
        for model_name, values in preds.items():
            arr = np.asarray(values, dtype=float).reshape(-1)
            if len(arr) != expected_len:
                raise ValueError(f"OOS prediction length mismatch for {model_name}: {len(arr)} != {expected_len}")
            merged_predictions[str(model_name)] = np.clip(arr, 0.0, 1.0)

    if expected_y is None or not merged_predictions:
        raise ValueError("No OOS predictions to combine")

    model_order = _ordered_model_names(merged_predictions.keys())
    return {
        "group": str(group),
        "version": str(version),
        "model_order": model_order,
        "predictions": {name: merged_predictions[name] for name in model_order},
        "y_test": expected_y,
        "dates_test": expected_dates if expected_dates is not None else np.asarray([], dtype=object),
        "feature_names": expected_features if expected_features is not None else np.asarray([], dtype=object),
        "samples": int(len(expected_y)),
    }


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
