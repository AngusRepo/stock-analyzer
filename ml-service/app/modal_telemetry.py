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


def _event(function_name: str, elapsed_s: float, *, meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": "modal_followup",
        "function_name": function_name,
        "compute_sec": round(float(elapsed_s), 3),
        "wall_sec": round(float(elapsed_s), 3),
        "meta": meta,
    }


def build_retrain_orchestrator_telemetry(
    stages: dict[str, Any],
    *,
    total_elapsed_s: float,
    is_monthly: bool,
    run_id: str | None = None,
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
        telemetry.append(
            _event(
                "feature_selection_pipeline",
                feature_elapsed,
                meta={
                    "run_id": run_id,
                    "stage": "feature_selection",
                    "status": feature_stage.get("status"),
                },
            )
        )

    train_stage = stages.get("train") or {}
    group_coverage = train_stage.get("group_coverage") or {}
    for group, function_name in _TRAIN_GROUP_TO_FUNCTION.items():
        group_info = group_coverage.get(group) or {}
        group_elapsed = _positive_float(group_info.get("elapsed_s"))
        if group_elapsed is None:
            continue
        telemetry.append(
            _event(
                function_name,
                group_elapsed,
                meta={
                    "run_id": run_id,
                    "stage": "train",
                    "group": group,
                    "status": group_info.get("status"),
                },
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
