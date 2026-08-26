from __future__ import annotations

import io
import json
import sys
import hashlib
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


def test_d1_champion_missing_artifact_does_not_fallback_to_legacy(monkeypatch):
    from app import model_serving_contract

    legacy_buf = io.BytesIO()
    joblib.dump({"model": "legacy-flat"}, legacy_buf)
    bucket = _FakeBucket({
        "universal/xgboost.joblib": _FakeBlob(legacy_buf.getvalue()),
    })
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(
        model_serving_contract,
        "load_pool",
        lambda: {
            "models": {
                "XGBoost": {
                    "status": "active",
                    "serving_eligible": True,
                    "version": "v9",
                    "gcs_path": "universal/xgboost/v9.joblib",
                }
            }
        },
    )
    model_store.clear_model_cache()

    assert model_store.load_model(0, "XGBoost") == (None, None)


def test_universal_model_requires_d1_champion_even_when_legacy_flat_file_exists(monkeypatch):
    from app import model_serving_contract

    legacy_buf = io.BytesIO()
    joblib.dump({"model": "legacy-flat"}, legacy_buf)
    bucket = _FakeBucket({"universal/xgboost.joblib": _FakeBlob(legacy_buf.getvalue())})
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(model_serving_contract, "load_pool", lambda: None)
    model_store.clear_model_cache()

    assert model_store.load_model(0, "XGBoost") == (None, None)

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


def test_d1_champion_rejects_legacy_metadata_schema(monkeypatch):
    from app import model_serving_contract

    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    bucket = _FakeBucket({
        "universal/xgboost/v1.joblib": _FakeBlob(model_buf.getvalue()),
        "universal/xgboost/metadata_v1.json": _FakeBlob(json.dumps({"feature_names": ["a"]})),
    })
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(
        model_serving_contract,
        "load_pool",
        lambda: {
            "models": {
                "XGBoost": {
                    "status": "active",
                    "serving_eligible": True,
                    "version": "v1",
                    "gcs_path": "universal/xgboost/v1.joblib",
                }
            }
        },
    )
    model_store.clear_model_cache()

    assert model_store.load_model(0, "XGBoost") == (None, None)


def test_d1_champion_rejects_inconsistent_sklearn_health(monkeypatch):
    from app import model_serving_contract

    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    bucket = _FakeBucket({
        "universal/xgboost/v2.joblib": _FakeBlob(model_buf.getvalue()),
        "universal/xgboost/metadata_v2.json": _FakeBlob(_valid_artifact_metadata()),
    })

    def fake_loader(_buf, *, artifact_name):
        return {"model": "xgb"}, {
            "status": "failed",
            "artifact_name": artifact_name,
            "warnings": [{"category": "InconsistentVersionWarning", "message": "bad"}],
        }

    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(
        model_serving_contract,
        "load_pool",
        lambda: {
            "models": {
                "XGBoost": {
                    "status": "active",
                    "serving_eligible": True,
                    "version": "v2",
                    "gcs_path": "universal/xgboost/v2.joblib",
                }
            }
        },
    )
    monkeypatch.setattr(model_store, "load_joblib_with_artifact_health", fake_loader)
    model_store.clear_model_cache()

    assert model_store.load_model(0, "XGBoost") == (None, None)

def _governed_metadata(raw: bytes, *, schema_version: str = "model-artifact-v2") -> str:
    return json.dumps({
        "schema_version": schema_version,
        "model_name": "XGBoost",
        "feature_names": ["a"],
        "feature_medians": {"a": 0.0},
        "sample_count": 10,
        "trained_at": "2026-08-14T00:00:00Z",
        "artifact_checksum": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "training_run_id": "test-governed-explicit-path",
    })


def test_governed_explicit_path_accepts_valid_v2_metadata_and_checksum(monkeypatch):
    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    raw = model_buf.getvalue()
    bucket = _FakeBucket({
        "universal/xgboost/v1.joblib": _FakeBlob(raw),
        "universal/xgboost/metadata_v1.json": _FakeBlob(_governed_metadata(raw)),
    })
    monkeypatch.setattr(model_store, "_bucket", bucket)
    model_store.clear_model_cache()
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()

    model, metadata = model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
        explicit_metadata_path="universal/xgboost/metadata_v1.json",
        expected_version="v1",
        expected_artifact_id="XGBoost:v1:test",
        expected_checksum=checksum,
        require_governed_artifact=True,
    )

    assert model == {"model": "xgb"}
    assert metadata["artifact_integrity_report"]["status"] == "ok"
    assert metadata["artifact_health_report"]["status"] == "ok"


def test_governed_explicit_path_rejects_missing_metadata_before_deserialization(monkeypatch):
    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    bucket = _FakeBucket({
        "universal/xgboost/v1.joblib": _FakeBlob(model_buf.getvalue()),
    })
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(
        model_store,
        "load_joblib_with_artifact_health",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("governed artifact must not deserialize without metadata")
        ),
    )
    model_store.clear_model_cache()

    assert model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
        explicit_metadata_path="universal/xgboost/metadata_v1.json",
        expected_version="v1",
        expected_artifact_id="XGBoost:v1:test",
        expected_checksum="sha256:" + hashlib.sha256(model_buf.getvalue()).hexdigest(),
        require_governed_artifact=True,
    ) == (None, None)


def test_governed_explicit_path_rejects_legacy_metadata_before_deserialization(monkeypatch):
    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    bucket = _FakeBucket({
        "universal/xgboost/v1.joblib": _FakeBlob(model_buf.getvalue()),
        "universal/xgboost/metadata_v1.json": _FakeBlob(json.dumps({"feature_names": ["a"]})),
    })
    monkeypatch.setattr(model_store, "_bucket", bucket)
    monkeypatch.setattr(
        model_store,
        "load_joblib_with_artifact_health",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("governed artifact must not deserialize legacy metadata")
        ),
    )
    model_store.clear_model_cache()

    assert model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
        explicit_metadata_path="universal/xgboost/metadata_v1.json",
        expected_version="v1",
        expected_artifact_id="XGBoost:v1:test",
        expected_checksum="sha256:" + hashlib.sha256(model_buf.getvalue()).hexdigest(),
        require_governed_artifact=True,
    ) == (None, None)


def test_governed_explicit_path_does_not_reuse_ungoverned_cache(monkeypatch):
    model_buf = io.BytesIO()
    joblib.dump({"model": "xgb"}, model_buf)
    raw = model_buf.getvalue()
    bucket = _FakeBucket({
        "universal/xgboost/v1.joblib": _FakeBlob(raw),
        "universal/xgboost/metadata_v1.json": _FakeBlob(json.dumps({"feature_names": ["a"]})),
    })
    monkeypatch.setattr(model_store, "_bucket", bucket)
    model_store.clear_model_cache()

    ungoverned, _ = model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
    )
    governed = model_store.load_model(
        0,
        "XGBoost",
        explicit_path="universal/xgboost/v1.joblib",
        explicit_metadata_path="universal/xgboost/metadata_v1.json",
        expected_version="v1",
        expected_artifact_id="XGBoost:v1:test",
        expected_checksum="sha256:" + hashlib.sha256(raw).hexdigest(),
        require_governed_artifact=True,
    )

    assert ungoverned == {"model": "xgb"}
    assert governed == (None, None)
