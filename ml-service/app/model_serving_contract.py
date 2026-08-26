"""Canonical D1-backed model serving contract."""

from __future__ import annotations

from typing import Optional

ALPHA_PREDICTION_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)
TIMESFM_L2_SIDECAR_MODELS = ("TimesFM",)
RETIRED_ALPHA_MODELS = (
    "CatBoost",
    "FT-Transformer",
    "FTTransformer",
    "Chronos",
    "Chronos2ZeroShot",
    "Chronos2LoRA",
)
MANAGED_MODELS = {
    "LightGBM": ("tree_feature", "tree", "joblib"),
    "XGBoost": ("tree_feature", "tree", "joblib"),
    "ExtraTrees": ("tree_feature", "tree", "joblib"),
    "TabM": ("tabular_neural", "tabular", "pt"),
    "GNN": ("cross_stock_graphsage", "graph", "pt"),
    "DLinear": ("time_series_learnable", "time_series", "pt"),
    "PatchTST": ("time_series_neuralforecast_patchtst", "time_series", "zip"),
    "iTransformer": ("time_series_neuralforecast_itransformer", "time_series", "zip"),
}
L2_FEATURE_SIDECARS = {
    "TimesFM": ("time_series_foundation", "timesfm_l2", "json"),
}
EXPERIMENTAL_SHADOW_MODELS = {
    "ResidualMLP": ("tabular_neural_shadow", "experimental", "joblib"),
}


def load_pool() -> dict:
    """Read the exact Learning-D1 champion snapshot used by production."""
    from .serving_resolver import resolve_serving_pool

    return resolve_serving_pool()


def gcs_path_for(model_name: str, version: str) -> str:
    """Return immutable artifact storage path; this never selects serving."""
    if model_name in EXPERIMENTAL_SHADOW_MODELS:
        _model_type, _family, ext = EXPERIMENTAL_SHADOW_MODELS[model_name]
        return f"experimental_shadow/{model_name.lower().replace('-', '_')}/{version}.{ext}"
    if model_name in L2_FEATURE_SIDECARS:
        _model_type, _family, ext = L2_FEATURE_SIDECARS[model_name]
    elif model_name in MANAGED_MODELS:
        _model_type, _family, ext = MANAGED_MODELS[model_name]
    else:
        raise ValueError(f"unknown governed model: {model_name}")
    return f"universal/{model_name.lower().replace('-', '_')}/{version}.{ext}"


def gcs_metadata_path_for(model_name: str, version: str) -> str:
    return f"universal/{model_name.lower().replace('-', '_')}/metadata_{version}.json"


def get_active_version(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    entry = ((pool or load_pool()).get("models") or {}).get(model_name)
    if not isinstance(entry, dict) or entry.get("serving_eligible") is not True:
        return None
    version = str(entry.get("version") or "").strip()
    return version or None


def get_active_path(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    entry = ((pool or load_pool()).get("models") or {}).get(model_name)
    if not isinstance(entry, dict) or entry.get("serving_eligible") is not True:
        return None
    path = str(entry.get("gcs_path") or "").strip()
    return path or None


def get_explicit_shadow_path(model_name: str, pool: Optional[dict] = None) -> Optional[str]:
    """Return a shadow path only when a complete immutable identity is present."""
    entry = ((pool or load_pool()).get("shadow_models") or {}).get(model_name)
    if not isinstance(entry, dict) or entry.get("status") not in {"challenger", "shadow"}:
        return None
    required = ("version", "gcs_path", "artifact_id", "checksum")
    if any(not str(entry.get(field) or "").strip() for field in required):
        return None
    return str(entry["gcs_path"])