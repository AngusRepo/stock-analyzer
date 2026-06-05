"""TabM torch artifact serving for the TabM alpha family.

TabM is a formal L3 slot. Production serving must load a registered torch
artifact, not a legacy joblib object.
"""

from __future__ import annotations

from dataclasses import dataclass
import io
import json
from typing import Any

import numpy as np

MODEL_NAME = "TabM"

_ARTIFACT_CACHE: dict[tuple[str, str], "TabMArtifact"] = {}


@dataclass(frozen=True)
class TabMArtifact:
    model: Any
    metadata: dict
    source_path: str
    version: str


def clear_tabm_artifact_cache() -> None:
    _ARTIFACT_CACHE.clear()


def _get_bucket():
    from .model_store import _get_bucket as _shared_get_bucket

    bucket = _shared_get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    return bucket


def _active_tabm_entry(pool: dict | None = None) -> dict:
    from .model_pool import gcs_path_for, load_pool

    snapshot = pool or load_pool()
    if not snapshot:
        raise RuntimeError("model_pool.json unavailable; TabM torch runtime fails closed")
    entry = (snapshot.get("models") or {}).get(MODEL_NAME)
    if not isinstance(entry, dict):
        raise RuntimeError("TabM missing from model_pool.models")
    status = str(entry.get("status") or "retired")
    if status not in {"active", "degraded"}:
        raise RuntimeError(f"TabM skipped by model_pool status={status}")
    version = str(entry.get("version") or "").strip()
    if not version:
        raise RuntimeError("TabM active model_pool entry is missing version")
    return {
        **entry,
        "version": version,
        "gcs_path": str(entry.get("gcs_path") or gcs_path_for(MODEL_NAME, version)),
    }


def _metadata_path_for(artifact_path: str, version: str) -> str:
    folder = artifact_path.rsplit("/", 1)[0]
    return f"{folder}/metadata_{version}.json"


def _build_tabm_ranker(config: dict, metadata: dict):
    from tabm import TabM

    n_features = int(
        config.get("n_features")
        or config.get("input_dim")
        or metadata.get("feature_count")
        or len(metadata.get("feature_names") or [])
        or 0
    )
    if n_features <= 0:
        raise RuntimeError("TabM artifact architecture missing n_features")

    try:
        return TabM.make(n_num_features=n_features, cat_cardinalities=[], d_out=1)
    except TypeError:
        return TabM.make(n_num_features=n_features, d_out=1)


def load_tabm_artifact(pool: dict | None = None) -> TabMArtifact:
    """Load the active TabM torch artifact from model_pool.json."""

    entry = _active_tabm_entry(pool)
    artifact_path = str(entry["gcs_path"])
    version = str(entry["version"])
    if not artifact_path.endswith((".pt", ".pth")):
        raise RuntimeError(
            "TabM production artifact must be a .pt/.pth torch artifact; "
            f"got {artifact_path}"
        )

    cache_key = (artifact_path, version)
    if cache_key in _ARTIFACT_CACHE:
        return _ARTIFACT_CACHE[cache_key]

    bucket = _get_bucket()
    blob = bucket.blob(artifact_path)
    if not blob.exists():
        raise RuntimeError(f"TabM artifact missing in GCS: {artifact_path}")

    import torch

    buf = io.BytesIO()
    blob.download_to_file(buf)
    buf.seek(0)
    payload = torch.load(buf, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict):
        raise RuntimeError("TabM artifact payload must be a dict")

    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        meta_blob = bucket.blob(_metadata_path_for(artifact_path, version))
        metadata = json.loads(meta_blob.download_as_text()) if meta_blob.exists() else {}

    architecture = payload.get("architecture")
    if not isinstance(architecture, dict):
        architecture = metadata.get("architecture") if isinstance(metadata.get("architecture"), dict) else {}
    declared_type = str(architecture.get("type") or metadata.get("model_type") or "").lower()
    if declared_type not in {"tabm", "tabm_ranker", "tabular_neural", "tabular_neural_tabm"}:
        raise RuntimeError("TabM artifact is not declared as TabM")

    state_dict = payload.get("state_dict")
    if not isinstance(state_dict, dict):
        raise RuntimeError("TabM artifact missing state_dict")

    model = _build_tabm_ranker(architecture, metadata)
    model.load_state_dict(state_dict)
    model.eval()
    artifact = TabMArtifact(
        model=model,
        metadata=metadata,
        source_path=artifact_path,
        version=version,
    )
    _ARTIFACT_CACHE[cache_key] = artifact
    return artifact


def _tabm_forward(model: Any, x):
    try:
        return model(x)
    except TypeError:
        pass
    try:
        return model(x_num=x, x_cat=None)
    except TypeError:
        pass

    import torch

    x_cat = torch.empty((x.shape[0], 0), dtype=torch.long, device=x.device)
    return model(x, x_cat)


def _reduce_tabm_output(output: Any) -> np.ndarray:
    if isinstance(output, (tuple, list)):
        output = output[0]
    arr = output.detach().cpu().numpy() if hasattr(output, "detach") else np.asarray(output)
    arr = np.asarray(arr, dtype=np.float32)
    if arr.ndim == 3:
        arr = arr.mean(axis=1)
    if arr.ndim > 1:
        arr = arr.reshape(arr.shape[0], -1).mean(axis=1)
    return arr.reshape(-1)


def predict_tabm_scores(artifact: TabMArtifact, *, features: np.ndarray) -> np.ndarray:
    """Run TabM batch inference and return one rank score per row."""

    import torch

    x = torch.tensor(np.asarray(features, dtype=np.float32), dtype=torch.float32)
    with torch.no_grad():
        raw_scores = _reduce_tabm_output(_tabm_forward(artifact.model, x))

    transform = str((artifact.metadata or {}).get("output_transform") or "auto").lower()
    if transform == "sigmoid" or (
        transform == "auto" and (np.nanmin(raw_scores) < 0.0 or np.nanmax(raw_scores) > 1.0)
    ):
        raw_scores = 1.0 / (1.0 + np.exp(-raw_scores))
    return np.clip(raw_scores, 0.0, 1.0)
