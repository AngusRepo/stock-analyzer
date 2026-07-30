from __future__ import annotations

from app.oof_forward_source_contract import assess_fold_forward_sources


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


def _valid_window() -> tuple[dict, set[str]]:
    cohort_id = "active8-oof-v6-test"
    version = f"{cohort_id}-w4"
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
        "window_id": 4,
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
    return window, paths


def test_exact_fold_forward_source_contract_passes_complete_inventory():
    window, paths = _valid_window()
    result = assess_fold_forward_sources(
        window,
        cohort_id="active8-oof-v6-test",
        bucket=_Bucket(paths),
    )
    assert result["ready"] is True
    assert result["reasons"] == []


def test_exact_fold_forward_source_contract_rejects_legacy_or_wrong_fold_source():
    window, paths = _valid_window()
    window["tree_result"]["artifact_registrations"] = {}
    window["TabM_result"]["version"] = "active8-oof-v6-test-w3"
    result = assess_fold_forward_sources(
        window,
        cohort_id="active8-oof-v6-test",
        bucket=_Bucket(paths),
    )
    assert result["ready"] is False
    assert "exact_tree_source_state_invalid:LightGBM" in result["reasons"]
    assert "exact_core_source_version_mismatch:TabM" in result["reasons"]
