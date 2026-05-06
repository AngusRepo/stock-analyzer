"""Model artifact contract and training manifest helpers.

This module is the M-layer owner for artifact metadata. Training code can call
it before writing model metadata, and serving code can call it before trusting
an artifact for inference.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable


ARTIFACT_SCHEMA_VERSION = "model-artifact-v2"
TRAINING_MANIFEST_SCHEMA_VERSION = "training-run-manifest-v1"


class ArtifactValidationError(ValueError):
    """Raised when a model artifact is unsafe for production serving."""

    def __init__(self, message: str, report: dict[str, Any] | None = None):
        super().__init__(message)
        self.report = report or {}


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_sha256(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_stable_json(value).encode("utf-8")).hexdigest()


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _as_string_list(values: Iterable[Any] | None) -> list[str]:
    out: list[str] = []
    for value in values or []:
        text = str(value).strip()
        if text:
            out.append(text)
    return out


def validate_model_artifact_metadata(
    metadata: dict[str, Any] | None,
    *,
    serving_features: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Validate artifact lineage and optional train/serve feature compatibility."""

    meta = metadata or {}
    feature_names = _as_string_list(meta.get("feature_names"))
    serving_feature_names = _as_string_list(serving_features)
    missing_required = [
        field
        for field in (
            "model_name",
            "feature_names",
            "sample_count",
            "trained_at",
            "schema_version",
            "artifact_checksum",
            "training_run_id",
        )
        if meta.get(field) in (None, "", [])
    ]

    missing_features: list[str] = []
    extra_features: list[str] = []
    if serving_feature_names:
        train_set = set(feature_names)
        serve_set = set(serving_feature_names)
        missing_features = sorted(train_set - serve_set)
        extra_features = sorted(serve_set - train_set)

    report = {
        "status": "ok",
        "schema_version": meta.get("schema_version"),
        "model_name": meta.get("model_name"),
        "feature_count": len(feature_names),
        "sample_count": meta.get("sample_count"),
        "missing_required": missing_required,
        "missing_features": missing_features,
        "extra_features": extra_features,
    }

    if meta.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
        report["status"] = "error"
        raise ArtifactValidationError("artifact schema_version mismatch", report)
    if missing_required:
        report["status"] = "error"
        raise ArtifactValidationError("artifact metadata missing required fields", report)
    if missing_features or extra_features:
        report["status"] = "error"
        raise ArtifactValidationError("artifact feature compatibility mismatch", report)
    return report


def validate_serving_feature_compatibility(
    *,
    training_features: Iterable[str] | None,
    serving_features: Iterable[str] | None,
    feature_medians: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate train/serve feature compatibility for inference.

    Extra serving features are safe because the artifact can ignore them.
    Missing training features are only safe when the artifact has training-time
    medians for deterministic backfill.
    """

    train = _as_string_list(training_features)
    serve = _as_string_list(serving_features)
    medians = feature_medians or {}
    train_set = set(train)
    serve_set = set(serve)
    missing_features = sorted(train_set - serve_set)
    extra_features = sorted(serve_set - train_set)
    missing_without_median = sorted(
        feature for feature in missing_features if feature not in medians
    )
    status = (
        "error"
        if missing_without_median
        else "degraded"
        if missing_features or extra_features
        else "ok"
    )
    report = {
        "status": status,
        "training_feature_count": len(train),
        "serving_feature_count": len(serve),
        "missing_features": missing_features,
        "missing_without_median": missing_without_median,
        "extra_features": extra_features,
    }
    if missing_without_median:
        raise ArtifactValidationError("artifact feature compatibility missing medians", report)
    return report


def build_training_run_manifest(
    *,
    run_id: str,
    model_names: Iterable[str],
    feature_names: Iterable[str],
    dataset: dict[str, Any],
    params: dict[str, Any] | None = None,
    code_version: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Create a deterministic audit manifest for a training run."""

    models = sorted(_as_string_list(model_names))
    features = _as_string_list(feature_names)
    params_payload = dict(params or {})
    return {
        "schema_version": TRAINING_MANIFEST_SCHEMA_VERSION,
        "run_id": str(run_id),
        "created_at": created_at or now_utc_iso(),
        "models": models,
        "feature_count": len(features),
        "features_hash": stable_sha256(features),
        "dataset": dict(dataset or {}),
        "reproducibility": {
            "code_version": code_version or "unknown",
            "params_hash": stable_sha256(params_payload),
            "params": params_payload,
        },
    }


def build_model_artifact_metadata(
    *,
    model_name: str,
    feature_names: Iterable[str],
    sample_count: int,
    training_run_id: str,
    artifact_payload: Any,
    feature_medians: dict[str, float] | None = None,
    gcs_prefix: str | None = None,
    extra_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build canonical metadata for a saved model artifact."""

    meta: dict[str, Any] = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "model_name": model_name,
        "feature_names": _as_string_list(feature_names),
        "feature_medians": feature_medians or {},
        "sample_count": int(sample_count),
        "trained_at": now_utc_iso(),
        "gcs_prefix": gcs_prefix,
        "artifact_checksum": stable_sha256(artifact_payload),
        "training_run_id": training_run_id,
    }
    if extra_metadata:
        meta.update(extra_metadata)
    return meta
