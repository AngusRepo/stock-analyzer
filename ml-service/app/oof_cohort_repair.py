"""Verified repair of a failed Active-8 OOF cohort manifest."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import statistics
from typing import Any

import numpy as np

from .model_validation import build_model_cpcv_evidence
from .oof_lineage import OOF_PREDICTION_SCHEMA_VERSION, OOF_TARGET_SEMANTIC_VERSION


def manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    payload = json.dumps(unsigned, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _verify_artifact(
    bucket: Any,
    *,
    path: str,
    checksum: str,
    cohort_id: str,
    fold_id: str,
    model_name: str,
) -> None:
    if not path or len(checksum) != 64:
        raise ValueError(f"oof_repair_artifact_reference_invalid:{fold_id}:{model_name}")
    payload = bucket.blob(path).download_as_bytes()
    if hashlib.sha256(payload).hexdigest() != checksum:
        raise ValueError(f"oof_repair_artifact_checksum_mismatch:{fold_id}:{model_name}")
    artifact = np.load(io.BytesIO(payload), allow_pickle=True)
    metadata = json.loads(str(artifact["metadata"].item()))
    expected = {
        "schema_version": OOF_PREDICTION_SCHEMA_VERSION,
        "generation_mode": "purged_oof",
        "cohort_id": cohort_id,
        "fold_id": fold_id,
        "model_name": model_name,
        "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"oof_repair_artifact_metadata_mismatch:{fold_id}:{model_name}:{key}")


def _model_metric(model_name: str, model_result: dict[str, Any]) -> dict[str, Any]:
    tracking = (model_result.get("ic_tracking") or {}).get(model_name) or {}
    artifact = model_result.get("oof_artifact") or {}
    if model_result.get("error") or not artifact.get("path"):
        raise ValueError(f"oof_repair_model_result_failed:{model_name}")
    return {
        "status": "ready",
        "oos_ic": tracking.get("oos_ic"),
        "test_samples": tracking.get("oos_samples"),
        "oof_artifact": artifact.get("path"),
        "artifact_checksum": artifact.get("payload_checksum"),
    }


def repair_failed_oof_manifest(
    manifest: dict[str, Any],
    *,
    fold_id: str,
    model_name: str,
    model_result: dict[str, Any],
    bucket: Any,
) -> dict[str, Any]:
    repaired = copy.deepcopy(manifest)
    if repaired.get("manifest_checksum") != manifest_checksum(repaired):
        raise ValueError("oof_repair_manifest_checksum_mismatch")
    if repaired.get("status") != "failed" or repaired.get("generation_mode") != "purged_oof":
        raise ValueError("oof_repair_manifest_not_failed_oof")
    models = list(repaired.get("model_set") or [])
    if model_name not in models:
        raise ValueError(f"oof_repair_model_not_in_cohort:{model_name}")

    target_window = None
    for window in repaired.get("windows") or []:
        if f"w{int(window.get('window_id'))}" == fold_id:
            target_window = window
            break
    if target_window is None:
        raise ValueError(f"oof_repair_fold_missing:{fold_id}")
    current = (target_window.get("model_metrics") or {}).get(model_name) or {}
    if current.get("status") == "ready":
        raise ValueError(f"oof_repair_model_already_ready:{fold_id}:{model_name}")

    metric = _model_metric(model_name, model_result)
    _verify_artifact(
        bucket,
        path=str(metric["oof_artifact"]),
        checksum=str(metric["artifact_checksum"]),
        cohort_id=str(repaired["cohort_id"]),
        fold_id=fold_id,
        model_name=model_name,
    )
    target_window.setdefault("model_metrics", {})[model_name] = metric

    for window in repaired.get("windows") or []:
        window_fold_id = f"w{int(window.get('window_id'))}"
        source_cohort = str(window.get("source_cohort_id") or repaired["cohort_id"])
        metrics = window.get("model_metrics") or {}
        missing = []
        for expected_model in models:
            row = metrics.get(expected_model) or {}
            if row.get("status") != "ready":
                missing.append(expected_model)
                continue
            _verify_artifact(
                bucket,
                path=str(row.get("oof_artifact") or ""),
                checksum=str(row.get("artifact_checksum") or ""),
                cohort_id=source_cohort,
                fold_id=window_fold_id,
                model_name=expected_model,
            )
        window["missing_oof_models"] = missing
        window["oof_fold_ready"] = not missing

    per_model: dict[str, list[float]] = {}
    for window in repaired["windows"]:
        for expected_model, row in (window.get("model_metrics") or {}).items():
            if row.get("oos_ic") is not None:
                per_model.setdefault(expected_model, []).append(float(row["oos_ic"]))
    summary = {
        name: {
            "n_windows": len(values),
            "mean_ic": sum(values) / len(values),
            "std_ic": statistics.stdev(values) if len(values) >= 2 else 0.0,
            "min_ic": min(values),
            "max_ic": max(values),
            "positive_share": sum(value > 0 for value in values) / len(values),
            "ic_per_window": values,
        }
        for name, values in per_model.items()
        if values
    }
    promotion_evidence = {}
    for expected_model in models:
        fold_metrics = []
        for window in repaired["windows"]:
            row = (window.get("model_metrics") or {}).get(expected_model) or {}
            if row.get("oos_ic") is None:
                continue
            samples = int(row.get("test_samples") or 0)
            fold_metrics.append({
                "fold_id": f"w{int(window['window_id'])}",
                "oos_ic": row["oos_ic"],
                "test_rows": samples,
                "coverage": 1.0 if samples > 0 else 0.0,
            })
        promotion_evidence[expected_model] = build_model_cpcv_evidence(
            model=expected_model,
            fold_metrics=fold_metrics,
            stage="promotion",
            method="outer_purged_walk_forward_rank_ic",
        )

    aggregate = repaired.setdefault("aggregate", {})
    failed_folds = [
        window["window_id"] for window in repaired["windows"] if not window["oof_fold_ready"]
    ]
    aggregate.update({
        "n_windows_total": len(repaired["windows"]),
        "n_windows_errored": sum(not bool(window.get("model_metrics")) for window in repaired["windows"]),
        "per_model": summary,
        "oof_ready_folds": len(repaired["windows"]) - len(failed_folds),
        "oof_failed_folds": failed_folds,
        "per_model_promotion_evidence": promotion_evidence,
        "full_fit_eligible_models": [
            name for name, evidence in promotion_evidence.items()
            if evidence.get("decision") == "PASS"
        ],
        "full_fit_blocked_models": {
            name: evidence.get("failed_gates") or []
            for name, evidence in promotion_evidence.items()
            if evidence.get("decision") != "PASS"
        },
    })
    aggregate["oof_cohort_ready"] = not failed_folds
    repaired["status"] = "ready" if aggregate["oof_cohort_ready"] else "failed"
    repaired["manifest_checksum"] = manifest_checksum(repaired)
    return repaired
