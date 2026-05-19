"""Helpers for Modal runtime telemetry payloads.

The Modal app cannot write controller D1 directly in a clean way, so it sends
billable runtime observations through the existing retrain follow-up callback.
"""
from __future__ import annotations

from typing import Any


_TRAIN_GROUP_TO_FUNCTION = {
    "tree": "train_tree_models",
    "ftt": "train_ftt_model",
    "dlinear": "train_dlinear_universal",
    "patchtst": "train_patchtst_universal",
}


def _positive_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _positive_int(value: Any) -> int | None:
    try:
        out = int(float(value))
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _event(function_name: str, elapsed_s: float, *, meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": "modal_followup",
        "function_name": function_name,
        "compute_sec": round(float(elapsed_s), 3),
        "wall_sec": round(float(elapsed_s), 3),
        "meta": meta,
    }


def _artifact_models(partial: dict[str, Any]) -> list[str]:
    artifact = partial.get("oos_artifact") if isinstance(partial.get("oos_artifact"), dict) else {}
    artifact_models = artifact.get("models") if isinstance(artifact, dict) else None
    if isinstance(artifact_models, list) and artifact_models:
        return [str(name) for name in artifact_models if str(name)]

    names: list[str] = []
    for name, result in (partial.get("results") or {}).items():
        if not isinstance(result, dict):
            continue
        if result.get("skipped") or result.get("error"):
            continue
        names.append(str(name))
    return names


def _train_group_artifact_meta(partial: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(partial, dict) or partial.get("error"):
        return {}
    models = _artifact_models(partial)
    meta: dict[str, Any] = {}
    if models:
        meta["artifact_count"] = len(models)
        meta["model_artifacts"] = models
    for key in ("total_samples", "train_samples", "test_samples", "feature_count", "candidate_version"):
        if partial.get(key) is not None:
            meta[key] = partial.get(key)
    return meta


def _feature_selection_scope_meta(stage: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    active_count = _positive_int(stage.get("active_count") or stage.get("feature_count"))
    if active_count is not None:
        meta["active_count"] = active_count
        meta["feature_count"] = active_count
    for key in ("reserve_count", "tree_active_count", "ft_active_count", "target_permutation_n", "objective_cache_hits"):
        value = _positive_int(stage.get(key))
        if value is not None:
            meta[key] = value
    trials = _positive_int(
        stage.get("trials")
        or stage.get("k_sweep_trials")
        or stage.get("actual_trials")
        or stage.get("n_trials")
        or stage.get("target_permutation_n")
    )
    if trials is not None:
        meta["trials"] = trials
    return meta


def build_retrain_orchestrator_telemetry(
    stages: dict[str, Any],
    *,
    total_elapsed_s: float,
    is_monthly: bool,
    run_id: str | None = None,
    partial_results: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build billable Modal runtime observations for one retrain orchestrator run."""
    telemetry: list[dict[str, Any]] = []
    base_meta = {"run_id": run_id, "stage": "orchestrator"}
    total_elapsed = _positive_float(total_elapsed_s)
    if total_elapsed is not None:
        telemetry.append(_event("retrain_orchestrator", total_elapsed, meta=base_meta))

    feature_stage = stages.get("feature_selection") or {}
    feature_elapsed = _positive_float(feature_stage.get("elapsed_s"))
    if is_monthly and feature_elapsed is not None:
        feature_meta = {
            "run_id": run_id,
            "stage": "feature_selection",
            "status": feature_stage.get("status"),
        }
        feature_meta.update(_feature_selection_scope_meta(feature_stage))
        telemetry.append(
            _event(
                "feature_selection_pipeline",
                feature_elapsed,
                meta=feature_meta,
            )
        )

    train_stage = stages.get("train") or {}
    group_coverage = train_stage.get("group_coverage") or {}
    partial_results = partial_results or {}
    for group, function_name in _TRAIN_GROUP_TO_FUNCTION.items():
        group_info = group_coverage.get(group) or {}
        group_elapsed = _positive_float(group_info.get("elapsed_s"))
        if group_elapsed is None:
            continue
        meta = {
            "run_id": run_id,
            "stage": "train",
            "group": group,
            "status": group_info.get("status"),
            "gcs_io": group_info.get("gcs_io"),
        }
        meta.update(_train_group_artifact_meta(partial_results.get(group) or {}))
        telemetry.append(
            _event(
                function_name,
                group_elapsed,
                meta=meta,
            )
        )

    shap_stage = stages.get("shap") or {}
    shap_elapsed = _positive_float(shap_stage.get("elapsed_s"))
    if shap_elapsed is not None:
        telemetry.append(
            _event(
                "shap_feature_audit",
                shap_elapsed,
                meta={
                    "run_id": run_id,
                    "stage": "shap",
                    "status": shap_stage.get("status"),
                },
            )
        )

    return telemetry
