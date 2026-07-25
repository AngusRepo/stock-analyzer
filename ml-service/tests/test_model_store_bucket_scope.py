from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import model_store  # noqa: E402


class _ObjectOnlyBucket:
    def exists(self) -> bool:
        raise AssertionError("bucket metadata must not be queried by object-only workloads")


class _ObjectOnlyClient:
    def __init__(self, bucket: _ObjectOnlyBucket):
        self._bucket = bucket

    def bucket(self, name: str) -> _ObjectOnlyBucket:
        assert name == "stockvision-models-test"
        return self._bucket

    def create_bucket(self, *_args, **_kwargs):
        raise AssertionError("runtime workloads must not create production buckets")


def test_get_bucket_supports_bucket_scoped_object_writer(monkeypatch):
    from google.cloud import storage

    bucket = _ObjectOnlyBucket()
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: _ObjectOnlyClient(bucket))
    monkeypatch.setattr(model_store, "_bucket", None)

    assert model_store._get_bucket() is bucket