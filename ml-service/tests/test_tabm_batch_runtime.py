from __future__ import annotations

import pytest

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
