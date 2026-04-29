from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import joblib

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import model_store  # noqa: E402


class _FakeBlob:
    def __init__(self, data: bytes | str | None):
        self.data = data
        self.download_count = 0

    def exists(self) -> bool:
        return self.data is not None

    def download_to_file(self, buf: io.BytesIO) -> None:
        self.download_count += 1
        assert isinstance(self.data, bytes)
        buf.write(self.data)

    def download_as_text(self) -> str:
        self.download_count += 1
        assert isinstance(self.data, str)
        return self.data


class _FakeBucket:
    def __init__(self, blobs: dict[str, _FakeBlob]):
        self.blobs = blobs

    def blob(self, path: str) -> _FakeBlob:
        return self.blobs.get(path, _FakeBlob(None))


def test_universal_explicit_model_load_is_cached_within_container(monkeypatch):
    buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, buf)
    model_blob = _FakeBlob(buf.getvalue())
    meta_blob = _FakeBlob(json.dumps({"feature_names": ["a"], "n_samples": 10}))
    bucket = _FakeBucket(
        {
            "universal/xgboost/v1.joblib": model_blob,
            "universal/xgboost/metadata_v1.json": meta_blob,
        }
    )
    monkeypatch.setattr(model_store, "_bucket", bucket)
    model_store.clear_model_cache()

    first_model, first_meta = model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
    )
    second_model, second_meta = model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
    )

    assert first_model == second_model == {"model": "xgb"}
    assert first_meta == second_meta
    assert model_blob.download_count == 1
    assert meta_blob.download_count == 1


def test_clear_model_cache_invalidates_cached_model(monkeypatch):
    first_buf = io.BytesIO()
    second_buf = io.BytesIO()
    joblib.dump({"model": "old"}, first_buf)
    joblib.dump({"model": "new"}, second_buf)
    model_blob = _FakeBlob(first_buf.getvalue())
    meta_blob = _FakeBlob(json.dumps({"feature_names": ["a"], "n_samples": 10}))
    bucket = _FakeBucket(
        {
            "universal/xgboost/v1.joblib": model_blob,
            "universal/xgboost/metadata_v1.json": meta_blob,
        }
    )
    monkeypatch.setattr(model_store, "_bucket", bucket)
    model_store.clear_model_cache()

    old_model, _ = model_store.load_model(0, "XGBoost", explicit_path="universal/xgboost/v1.joblib")
    model_blob.data = second_buf.getvalue()
    model_store.clear_model_cache()
    new_model, _ = model_store.load_model(0, "XGBoost", explicit_path="universal/xgboost/v1.joblib")

    assert old_model == {"model": "old"}
    assert new_model == {"model": "new"}
    assert model_blob.download_count == 2
