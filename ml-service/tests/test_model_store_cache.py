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
    assert model_store.get_model_cache_stats()["misses"] == 1
    assert model_store.get_model_cache_stats()["hits"] == 1
    assert model_store.get_model_cache_stats()["gcs_downloads"] == 1


def test_universal_explicit_model_load_accepts_utf8_bom_metadata(monkeypatch):
    buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, buf)
    model_blob = _FakeBlob(buf.getvalue())
    meta_blob = _FakeBlob("\ufeff" + json.dumps({"feature_names": ["a"], "n_samples": 10}))
    bucket = _FakeBucket(
        {
            "universal/xgboost/v1.joblib": model_blob,
            "universal/xgboost/metadata_v1.json": meta_blob,
        }
    )
    monkeypatch.setattr(model_store, "_bucket", bucket)
    model_store.clear_model_cache()

    model, metadata = model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
    )

    assert model == {"model": "xgb"}
    assert metadata["feature_names"] == ["a"]


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


def test_model_pool_missing_artifact_does_not_fallback_to_legacy(monkeypatch):
    from app import model_pool

    legacy_buf = io.BytesIO()
    joblib.dump({"model": "legacy-flat"}, legacy_buf)
    bucket = _FakeBucket(
        {
            "universal/model_pool.json": _FakeBlob(
                json.dumps(
                    {
                        "models": {
                            "XGBoost": {
                                "status": "active",
                                "version": "v9",
                                "gcs_path": "universal/xgboost/v9.joblib",
                            }
                        }
                    }
                )
            ),
            "universal/xgboost.joblib": _FakeBlob(legacy_buf.getvalue()),
        }
    )
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(model_pool, "_get_bucket", lambda: bucket)
    model_store.clear_model_cache()

    model, metadata = model_store.load_model(0, "XGBoost")

    assert model is None
    assert metadata is None


def test_universal_model_requires_model_pool_even_when_legacy_flat_file_exists(monkeypatch):
    from app import model_pool

    legacy_buf = io.BytesIO()
    joblib.dump({"model": "legacy-flat"}, legacy_buf)
    bucket = _FakeBucket({"universal/xgboost.joblib": _FakeBlob(legacy_buf.getvalue())})
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(model_pool, "_get_bucket", lambda: bucket)
    model_store.clear_model_cache()

    model, metadata = model_store.load_model(0, "XGBoost")

    assert model is None
    assert metadata is None


def _valid_artifact_metadata(model_name: str = "XGBoost") -> str:
    return json.dumps(
        {
            "schema_version": "model-artifact-v2",
            "model_name": model_name,
            "feature_names": ["a"],
            "feature_medians": {"a": 0.0},
            "sample_count": 10,
            "trained_at": "2026-06-05T18:21:24Z",
            "gcs_prefix": "universal",
            "artifact_checksum": "sha256:model",
            "training_run_id": "v20260605181448",
        }
    )


def test_model_pool_active_rejects_legacy_metadata_schema(monkeypatch):
    from app import model_pool

    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    bucket = _FakeBucket(
        {
            "universal/model_pool.json": _FakeBlob(
                json.dumps(
                    {
                        "models": {
                            "XGBoost": {
                                "status": "active",
                                "version": "v1",
                                "gcs_path": "universal/xgboost/v1.joblib",
                            }
                        }
                    }
                )
            ),
            "universal/xgboost/v1.joblib": _FakeBlob(model_buf.getvalue()),
            "universal/xgboost/metadata_v1.json": _FakeBlob(json.dumps({"feature_names": ["a"]})),
        }
    )
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(model_pool, "_get_bucket", lambda: bucket)
    model_store.clear_model_cache()

    model, metadata = model_store.load_model(0, "XGBoost")

    assert model is None
    assert metadata is None


def test_model_pool_active_rejects_inconsistent_sklearn_health(monkeypatch):
    from app import model_pool

    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    bucket = _FakeBucket(
        {
            "universal/model_pool.json": _FakeBlob(
                json.dumps(
                    {
                        "models": {
                            "XGBoost": {
                                "status": "active",
                                "version": "v2",
                                "gcs_path": "universal/xgboost/v2.joblib",
                            }
                        }
                    }
                )
            ),
            "universal/xgboost/v2.joblib": _FakeBlob(model_buf.getvalue()),
            "universal/xgboost/metadata_v2.json": _FakeBlob(_valid_artifact_metadata()),
        }
    )

    def fake_loader(_buf, *, artifact_name):
        return {"model": "xgb"}, {
            "status": "failed",
            "artifact_name": artifact_name,
            "warnings": [{"category": "InconsistentVersionWarning", "message": "bad"}],
        }

    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(model_pool, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(model_store, "load_joblib_with_artifact_health", fake_loader)
    model_store.clear_model_cache()

    model, metadata = model_store.load_model(0, "XGBoost")

    assert model is None
    assert metadata is None
