"""Exact fitted-artifact contract for frozen OOF forward inference."""

from __future__ import annotations

from typing import Any


TREE_MODELS = ("LightGBM", "XGBoost", "ExtraTrees")
CORE_MODELS = (*TREE_MODELS, "TabM", "GNN")


def sha256_contract_valid(value: object) -> bool:
    raw = str(value or "").strip().lower()
    if raw.startswith("sha256:"):
        raw = raw[7:]
    return len(raw) == 64 and all(char in "0123456789abcdef" for char in raw)


def assess_fold_forward_sources(
    window: dict[str, Any],
    *,
    cohort_id: str,
    bucket: Any | None = None,
) -> dict[str, Any]:
    """Fail closed unless the fold owns all exact core inference artifacts."""

    reasons: list[str] = []
    window_id = int(window.get("window_id") or 0)
    expected_version = f"{cohort_id}-w{window_id}"
    metrics = window.get("model_metrics") if isinstance(window.get("model_metrics"), dict) else {}

    def require_object(path: object, reason: str) -> None:
        normalized = str(path or "").strip()
        if not normalized:
            reasons.append(reason)
            return
        if bucket is None:
            return
        try:
            if not bucket.blob(normalized).exists():
                reasons.append(f"{reason}:object_missing")
        except Exception as exc:  # noqa: BLE001 - storage preflight must fail closed.
            reasons.append(f"{reason}:storage_error:{type(exc).__name__}")

    for model_name in CORE_MODELS:
        metric = metrics.get(model_name) if isinstance(metrics.get(model_name), dict) else {}
        if metric.get("status") != "ready":
            reasons.append(f"core_oof_metric_not_ready:{model_name}")
        require_object(metric.get("oof_artifact"), f"core_oof_artifact_missing:{model_name}")
        if not sha256_contract_valid(metric.get("artifact_checksum")):
            reasons.append(f"core_oof_checksum_invalid:{model_name}")

    tree_result = window.get("tree_result") if isinstance(window.get("tree_result"), dict) else {}
    registrations = (
        tree_result.get("artifact_registrations")
        if isinstance(tree_result.get("artifact_registrations"), dict)
        else {}
    )
    for model_name in TREE_MODELS:
        artifact = registrations.get(model_name) if isinstance(registrations.get(model_name), dict) else {}
        if artifact.get("status") != "shadow_source" or artifact.get("promotion_eligible") is not False:
            reasons.append(f"exact_tree_source_state_invalid:{model_name}")
        if str(artifact.get("version") or "") != expected_version:
            reasons.append(f"exact_tree_source_version_mismatch:{model_name}")
        if not sha256_contract_valid(artifact.get("checksum")):
            reasons.append(f"exact_tree_source_checksum_invalid:{model_name}")
        require_object(artifact.get("gcs_path"), f"exact_tree_source_artifact_missing:{model_name}")
        require_object(artifact.get("metadata_path"), f"exact_tree_source_metadata_missing:{model_name}")

    for model_name in ("TabM", "GNN"):
        result = window.get(f"{model_name}_result")
        result = result if isinstance(result, dict) else {}
        if result.get("status") != "ok":
            reasons.append(f"exact_core_source_state_invalid:{model_name}")
        if str(result.get("version") or "") != expected_version:
            reasons.append(f"exact_core_source_version_mismatch:{model_name}")
        if not sha256_contract_valid(result.get("checksum")):
            reasons.append(f"exact_core_source_checksum_invalid:{model_name}")
        require_object(result.get("artifact_path"), f"exact_core_source_artifact_missing:{model_name}")
        require_object(result.get("metadata_path"), f"exact_core_source_metadata_missing:{model_name}")

    return {
        "schema_version": "active8-oof-forward-source-contract-v1",
        "ready": not reasons,
        "reasons": reasons,
        "window_id": window_id,
        "expected_version": expected_version,
    }
