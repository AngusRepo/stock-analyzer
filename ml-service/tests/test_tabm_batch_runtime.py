from __future__ import annotations

import pytest
import numpy as np

from app import model_pool, tabm_batch_runtime


def test_tabm_artifact_requires_torch_path(monkeypatch):
    tabm_batch_runtime.clear_tabm_artifact_cache()
    monkeypatch.setattr(
        model_pool,
        "load_pool",
        lambda: {
            "models": {
                "TabM": {
                    "status": "active",
                    "version": "v1",
                    "gcs_path": "universal/tabm/v1.joblib",
                }
            }
        },
    )

    with pytest.raises(RuntimeError, match="TabM production artifact must be a .*torch artifact"):
        tabm_batch_runtime.load_tabm_artifact()


def test_tabm_standardization_applies_artifact_scaling_and_clip():
    features = np.asarray([[100.0, -100.0]], dtype=np.float32)
    scaled = tabm_batch_runtime._standardize_features(
        features,
        {
            "feature_standardization": {
                "medians": [1.0, 1.0],
                "scales": [2.0, 0.0],
                "clip_value": 8.0,
            }
        },
    )

    assert scaled.tolist() == [[8.0, -8.0]]
