from __future__ import annotations

import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import payload_builder  # noqa: E402
from services.model_lifecycle_policy import resolve_degraded_dampening  # noqa: E402


def test_degraded_dampening_defaults_to_low_diagnostic_weight():
    assert resolve_degraded_dampening({}) == 0.1
    assert resolve_degraded_dampening({"mlPool": {"degradedDampening": 0.25}}) == 0.25
    assert resolve_degraded_dampening({"mlPool": {"degradedDampening": "bad"}}) == 0.1


def test_payload_builder_lifecycle_weights_use_low_degraded_default(monkeypatch):
    google_mod = types.ModuleType("google")
    google_cloud_mod = types.ModuleType("google.cloud")
    google_storage_mod = types.ModuleType("google.cloud.storage")
    google_cloud_mod.storage = google_storage_mod
    google_mod.cloud = google_cloud_mod
    monkeypatch.setitem(sys.modules, "google", google_mod)
    monkeypatch.setitem(sys.modules, "google.cloud", google_cloud_mod)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", google_storage_mod)

    pool = {
        "models": {
            "XGBoost": {"status": "active"},
            "ExtraTrees": {"status": "degraded"},
            "PatchTST": {"status": "retired"},
            "DLinear": {"status": "challenger"},
        }
    }

    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            return json.dumps(pool)

    class Bucket:
        def blob(self, path):
            assert path == "universal/model_pool.json"
            return Blob()

    class Client:
        def bucket(self, name):
            assert name == "stockvision-models-test"
            return Bucket()

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(google_storage_mod, "Client", lambda: Client(), raising=False)

    weights = payload_builder._load_lifecycle_weights_from_model_pool({})

    assert "XGBoost" not in weights
    assert weights["ExtraTrees"] == 0.1
    assert weights["PatchTST"] == 0.0
    assert weights["DLinear"] == 0.0
