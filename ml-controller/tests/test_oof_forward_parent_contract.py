from __future__ import annotations

import hashlib
import json

from routers.walk_forward import _oof_forward_parent_contract


class _Blob:
    def __init__(self, exists: bool):
        self._exists = exists

    def exists(self) -> bool:
        return self._exists


class _Bucket:
    def __init__(self, paths: set[str]):
        self.paths = paths

    def blob(self, path: str) -> _Blob:
        return _Blob(path in self.paths)


def _manifest() -> tuple[dict, set[str]]:
    cohort_id = "active8-oof-v6-test"
    window_id = 4
    version = f"{cohort_id}-w{window_id}"
    paths: set[str] = set()
    metrics = {}
    registrations = {}
    for model_name in ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"):
        oof_path = f"oof/{model_name}.npz"
        paths.add(oof_path)
        metrics[model_name] = {
            "status": "ready",
            "oof_artifact": oof_path,
            "artifact_checksum": "a" * 64,
        }
    for model_name in ("LightGBM", "XGBoost", "ExtraTrees"):
        artifact_path = f"frozen/{model_name}.joblib"
        metadata_path = f"frozen/{model_name}.json"
        paths.update((artifact_path, metadata_path))
        registrations[model_name] = {
            "status": "shadow_source",
            "promotion_eligible": False,
            "version": version,
            "gcs_path": artifact_path,
            "metadata_path": metadata_path,
            "checksum": "sha256:" + "b" * 64,
        }
    window = {
        "window_id": window_id,
        "model_metrics": metrics,
        "tree_result": {"artifact_registrations": registrations},
    }
    for model_name in ("TabM", "GNN"):
        artifact_path = f"frozen/{model_name}.pt"
        metadata_path = f"frozen/{model_name}.json"
        paths.update((artifact_path, metadata_path))
        window[f"{model_name}_result"] = {
            "status": "ok",
            "version": version,
            "artifact_path": artifact_path,
            "metadata_path": metadata_path,
            "checksum": "sha256:" + "c" * 64,
        }
    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v4",
        "status": "ready",
        "generation_mode": "purged_oof",
        "cohort_id": cohort_id,
        "target_semantic_version": (
            "next-session-canonical-adjusted-open-to-fifth-session-"
            "canonical-adjusted-close-net-v4"
        ),
        "score_semantic_version": "same-market-same-date-average-tie-percentile-rank-v2",
        "windows": [window],
    }
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return manifest, paths


def test_oof_parent_contract_accepts_checksum_bound_exact_latest_fold():
    manifest, paths = _manifest()
    result = _oof_forward_parent_contract(_Bucket(paths), manifest)
    assert result["ready"] is True
    assert result["reasons"] == []
    assert result["expected_version"] == "active8-oof-v6-test-w4"


def test_oof_parent_contract_rejects_legacy_fold_without_exact_tree_sources():
    manifest, paths = _manifest()
    manifest["schema_version"] = "active8-oof-cohort-manifest-v3"
    manifest["windows"][0]["tree_result"]["artifact_registrations"] = {}
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(
            {key: value for key, value in manifest.items() if key != "manifest_checksum"},
            sort_keys=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    result = _oof_forward_parent_contract(_Bucket(paths), manifest)
    assert result["ready"] is False
    assert "manifest_schema_not_exact_artifact_capable" in result["reasons"]
    assert "exact_tree_source_state_invalid:LightGBM" in result["reasons"]


def test_oof_parent_contract_rejects_legacy_tie_unsafe_score_semantic():
    manifest, paths = _manifest()
    manifest["score_semantic_version"] = "same-market-same-date-percentile-rank-v1"
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(
            {key: value for key, value in manifest.items() if key != "manifest_checksum"},
            sort_keys=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    result = _oof_forward_parent_contract(_Bucket(paths), manifest)
    assert result["ready"] is False
    assert "score_semantic_mismatch" in result["reasons"]
