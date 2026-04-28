from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import model_pool  # noqa: E402


class _FakeBlob:
    def __init__(self, text: str | None = None):
        self._text = text

    def exists(self) -> bool:
        return self._text is not None

    def download_as_text(self) -> str:
        if self._text is None:
            raise RuntimeError("missing blob")
        return self._text


class _FakeBucket:
    def __init__(self, blobs: dict[str, str]):
        self._blobs = blobs

    def blob(self, path: str) -> _FakeBlob:
        return _FakeBlob(self._blobs.get(path))


class _FakeStorageClient:
    def __init__(self, bucket: _FakeBucket):
        self._bucket = bucket

    def bucket(self, name: str) -> _FakeBucket:
        assert name == "stockvision-models-test"
        return self._bucket


@pytest.mark.asyncio
async def test_lineage_returns_active_and_challenger_metadata(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "last_updated": "2026-04-26T00:00:00+00:00",
        "models": {
            "XGBoost": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/xgboost/v1.joblib",
                "model_type": "feature",
                "balance_family": "feature",
                "weekly_ic": [0.1],
                "ic_4w_avg": 0.1,
                "challenger": {
                    "version": "v2",
                    "gcs_path": "universal/xgboost/v2.joblib",
                    "weekly_ic": [0.2],
                    "ic_4w_avg": 0.2,
                    "shadow_since": "2026-04-20",
                },
            }
        },
        "lifecycle_events": [{"model": "XGBoost", "transition": "register"}],
    }
    blobs = {
        "universal/model_pool.json": json.dumps(pool),
        "universal/xgboost/metadata_v1.json": json.dumps({"version": "v1", "feature_count": 106, "ignored": True}),
        "universal/xgboost/metadata_v2.json": json.dumps({"version": "v2", "feature_count": 106}),
    }
    from google.cloud import storage

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: _FakeStorageClient(_FakeBucket(blobs)))

    result = await model_pool.lineage()

    model = result["models"]["XGBoost"]
    assert result["status"] == "ok"
    assert model["artifact_uri"] == "gs://stockvision-models-test/universal/xgboost/v1.joblib"
    assert model["metadata_exists"] is True
    assert model["metadata"] == {"version": "v1", "feature_count": 106}
    assert model["challenger"]["metadata_exists"] is True
    assert result["events"] == [{"model": "XGBoost", "transition": "register"}]
