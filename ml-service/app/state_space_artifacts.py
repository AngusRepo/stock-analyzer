"""Independent immutable storage for state-space hyperparameter artifacts."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

GCS_STATE_SPACE_PREFIX = "per_stock_state_space"
SCHEMA_VERSION = "1.0"
DEFAULT_STATE_SPACE_HYPERPARAMS = {
    "KalmanFilter": {
        "process_noise": 0.01,
        "observation_noise": 1.0,
        "init_cov_scale": 1.0,
        "smoothing": False,
    },
    "MarkovSwitching": {
        "n_regimes": 2,
        "transition_prior": 0.95,
        "switching_vol": True,
        "ar_order": 2,
    },
}


def state_space_hyperparams_path(model_name: str, version: str = "v1") -> str:
    if model_name not in DEFAULT_STATE_SPACE_HYPERPARAMS:
        raise ValueError(f"{model_name} is not a state-space overlay")
    folder = "kalman" if model_name == "KalmanFilter" else "markov_switching"
    return f"{GCS_STATE_SPACE_PREFIX}/{folder}/hyperparams_{version}.json"


def _get_bucket():
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    from google.cloud import storage

    return storage.Client().bucket(bucket_name)


def load_state_space_hyperparams(model_name: str, version: str = "v1") -> dict:
    path = state_space_hyperparams_path(model_name, version)
    blob = _get_bucket().blob(path)
    if not blob.exists():
        raise FileNotFoundError(f"state-space hyperparams missing: {path}")
    payload = json.loads(blob.download_as_text().lstrip("\ufeff"))
    if not isinstance(payload, dict):
        raise ValueError(f"state-space hyperparams payload must be object: {path}")
    return payload


def save_state_space_hyperparams(model_name: str, hyperparams: dict, version: str = "v1") -> str:
    expected = set(DEFAULT_STATE_SPACE_HYPERPARAMS.get(model_name) or {})
    if not expected:
        raise ValueError(f"{model_name} is not a state-space overlay")
    missing = expected - set(hyperparams)
    extra = set(hyperparams) - expected
    if missing or extra:
        raise ValueError(f"invalid {model_name} hyperparams missing={sorted(missing)} extra={sorted(extra)}")
    path = state_space_hyperparams_path(model_name, version)
    payload = dict(hyperparams)
    payload["_meta"] = {
        "model": model_name,
        "version": version,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": SCHEMA_VERSION,
    }
    _get_bucket().blob(path).upload_from_string(
        json.dumps(payload, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    return path