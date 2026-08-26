from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_monthly_training_contract import (  # noqa: E402
    normalize_monthly_raw_artifact_receipt,
)


def test_normalizer_accepts_registry_and_saved_wrapper_shapes_without_cross_model_fallback():
    registry = normalize_monthly_raw_artifact_receipt({
        "version": "v1",
        "gcs_path": "universal/lightgbm/v1.joblib",
        "metadata_path": "universal/lightgbm/metadata_v1.json",
        "checksum": "sha256:" + "a" * 64,
        "metadata": {"version": "v1"},
    })
    saved_wrapper = normalize_monthly_raw_artifact_receipt({
        "version": "v2",
        "saved": {
            "weights_path": "universal/patchtst/v2.zip",
            "metadata_path": "universal/patchtst/metadata_v2.json",
            "checksum": "b" * 64,
        },
        "metadata": {"version": "v2"},
    })

    assert registry["artifact_path"].endswith("v1.joblib")
    assert registry["checksum"].startswith("sha256:")
    assert saved_wrapper["artifact_path"].endswith("v2.zip")
    assert saved_wrapper["checksum"] == "b" * 64


def test_normalizer_leaves_missing_identity_missing_for_fail_closed_validator():
    receipt = normalize_monthly_raw_artifact_receipt({"status": "error", "error": "gpu unavailable"})

    assert receipt["artifact_path"] is None
    assert receipt["metadata"] == {}
