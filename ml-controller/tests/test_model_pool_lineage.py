from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = RuntimeError

    class AsyncClient:  # pragma: no cover - lineage tests do not use real HTTP.
        pass

    httpx_stub.AsyncClient = AsyncClient
    sys.modules["httpx"] = httpx_stub

if "google.cloud.storage" not in sys.modules:
    google_stub = sys.modules.setdefault("google", types.ModuleType("google"))
    cloud_stub = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
    storage_stub = types.ModuleType("google.cloud.storage")

    class Client:  # pragma: no cover - tests monkeypatch this client.
        pass

    storage_stub.Client = Client
    cloud_stub.storage = storage_stub
    google_stub.cloud = cloud_stub
    sys.modules["google.cloud.storage"] = storage_stub

from routers import model_pool  # noqa: E402


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _clear_model_pool_read_cache():
    model_pool._invalidate_model_pool_read_cache("test_setup")
    yield
    model_pool._invalidate_model_pool_read_cache("test_teardown")


class _FakeBlob:
    def __init__(self, text: str | None = None, downloads: dict[str, int] | None = None, path: str | None = None):
        self._text = text
        self._downloads = downloads
        self._path = path

    def exists(self) -> bool:
        return self._text is not None

    def download_as_text(self) -> str:
        if self._text is None:
            raise RuntimeError("missing blob")
        if self._downloads is not None and self._path is not None:
            self._downloads[self._path] = self._downloads.get(self._path, 0) + 1
        return self._text


class _FakeBucket:
    def __init__(self, blobs: dict[str, str]):
        self._blobs = blobs
        self.downloads: dict[str, int] = {}

    def blob(self, path: str) -> _FakeBlob:
        return _FakeBlob(self._blobs.get(path), self.downloads, path)


class _FakeStorageClient:
    def __init__(self, bucket: _FakeBucket):
        self._bucket = bucket

    def bucket(self, name: str) -> _FakeBucket:
        assert name == "stockvision-models-test"
        return self._bucket


@pytest.mark.anyio
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
                "last_ic_status": "computed",
                "last_ic_root_cause": "ok",
                "last_ic_sample_count": 90,
                "last_ic_diagnostics": {"raw_rows": 90, "production_rows": 90},
                "last_ic_by_segment": {"LISTED": {"ic": 0.1, "n_samples": 90}},
                "last_ic_score_sources": {"forecast_data.rank_score": 90},
                "challenger": {
                    "version": "v2",
                    "gcs_path": "universal/xgboost/v2.joblib",
                    "weekly_ic": [0.2],
                    "ic_4w_avg": 0.2,
                    "last_ic_status": "computed",
                    "last_ic_root_cause": "ok",
                    "last_ic_sample_count": 88,
                    "last_ic_diagnostics": {"raw_rows": 88, "production_rows": 88},
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
    assert model["last_ic_status"] == "computed"
    assert model["last_ic_root_cause"] == "ok"
    assert model["last_ic_sample_count"] == 90
    assert model["last_ic_diagnostics"]["production_rows"] == 90
    assert model["last_ic_by_segment"]["LISTED"]["n_samples"] == 90
    assert model["lifecycle_diagnosis"]["status"] == "ok"
    assert model["lifecycle_diagnosis"]["coverage"] == 1.0
    assert model["last_ic_score_sources"] == {"forecast_data.rank_score": 90}
    assert model["challenger"]["metadata_exists"] is True
    assert model["challenger"]["last_ic_root_cause"] == "ok"
    assert model["challenger"]["last_ic_sample_count"] == 88
    assert set(result["formal_layer3_slots"]) == {"TabM", "GNN", "iTransformer", "TimesFM"}
    assert result["research_benchmarks"] == result["formal_layer3_slots"]
    assert result["events"] == [{"model": "XGBoost", "transition": "register"}]


@pytest.mark.anyio
async def test_lineage_marks_tabm_artifact_mismatch(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "models": {
            "TabM": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/tabm/v1.joblib",
                "model_type": "feature",
                "balance_family": "feature",
                "weekly_ic": [],
                "ic_4w_avg": None,
                "last_ic_status": "insufficient_samples",
                "last_ic_root_cause": "prediction_missing",
                "last_ic_sample_count": 0,
                "last_ic_diagnostics": {"raw_rows": 0, "production_rows": 0},
            }
        },
    }
    blobs = {"universal/model_pool.json": json.dumps(pool)}
    from google.cloud import storage

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: _FakeStorageClient(_FakeBucket(blobs)))

    result = await model_pool.lineage()

    diagnosis = result["models"]["TabM"]["lifecycle_diagnosis"]
    assert diagnosis["status"] == "artifact_mismatch"
    assert "metadata_missing" in diagnosis["blockers"]
    assert "prediction_missing" in diagnosis["blockers"]


@pytest.mark.anyio
async def test_lineage_marks_verification_missing_as_actionable_root_cause(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/xgboost/v1.joblib",
                "model_type": "feature",
                "balance_family": "feature",
                "weekly_ic": [0.02],
                "ic_4w_avg": 0.02,
                "last_ic_status": "insufficient_samples",
                "last_ic_root_cause": "verification_missing",
                "last_ic_sample_count": 0,
                "last_ic_diagnostics": {
                    "raw_rows": 90,
                    "verified_rows": 0,
                    "production_rows": 0,
                    "unverified_rows": 90,
                },
            }
        },
    }
    blobs = {
        "universal/model_pool.json": json.dumps(pool),
        "universal/xgboost/metadata_v1.json": json.dumps({"version": "v1", "feature_count": 106}),
    }
    from google.cloud import storage

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: _FakeStorageClient(_FakeBucket(blobs)))

    result = await model_pool.lineage()

    diagnosis = result["models"]["XGBoost"]["lifecycle_diagnosis"]
    assert diagnosis["status"] == "verification_missing"
    assert diagnosis["root_cause"] == "verification_missing"
    assert "verify-v2" in diagnosis["reason"]


@pytest.mark.anyio
async def test_lineage_preserves_artifact_diff_metadata(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "models": {
            "DLinear": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/dlinear/v1.pt",
                "model_type": "time_series",
                "balance_family": "time_series",
                "challenger": {
                    "version": "v20260505",
                    "gcs_path": "universal/dlinear/v20260505.pt",
                    "shadow_since": "2026-05-05",
                },
            }
        },
    }
    blobs = {
        "universal/model_pool.json": json.dumps(pool),
        "universal/dlinear/metadata_v1.json": json.dumps({
            "version": "v1",
            "n_input_series": 128,
            "n_train_windows": 1000,
            "n_val_windows": 120,
            "val_dir_accuracy": 0.54,
            "sequence_report": {"input_series": 128, "train_windows": 1000, "oos_windows": 120},
        }),
        "universal/dlinear/metadata_v20260505.json": json.dumps({
            "version": "v20260505",
            "n_input_series": 140,
            "n_train_windows": 1100,
            "n_val_windows": 130,
            "val_dir_accuracy": 0.57,
            "oos_ic": 0.08,
            "daily_ic_count": 14,
            "sequence_report": {"input_series": 140, "train_windows": 1100, "oos_windows": 130},
        }),
    }
    from google.cloud import storage

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: _FakeStorageClient(_FakeBucket(blobs)))

    result = await model_pool.lineage()

    model = result["models"]["DLinear"]
    assert model["metadata"]["n_input_series"] == 128
    assert model["metadata"]["sequence_report"]["input_series"] == 128
    assert model["challenger"]["lifecycle_diagnosis"]["status"] == "awaiting_live_shadow"
    assert "verified outcomes" in model["challenger"]["lifecycle_diagnosis"]["reason"]
    assert model["challenger"]["artifact_evidence"]["status"] == "ready"
    assert model["challenger"]["metadata"]["n_input_series"] == 140
    assert model["challenger"]["metadata"]["oos_ic"] == 0.08
    assert model["challenger"]["artifact_evidence"]["oos_ic"] == 0.08
    assert model["challenger"]["metadata"]["daily_ic_count"] == 14
    assert model["challenger"]["artifact_evidence"]["daily_ic_count"] == 14
    assert model["challenger"]["metadata"]["sequence_report"]["oos_windows"] == 130


@pytest.mark.anyio
async def test_lineage_reuses_short_ttl_read_cache(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "last_updated": "2026-05-24T00:00:00+00:00",
        "models": {
            "XGBoost": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/xgboost/v1.joblib",
                "model_type": "feature",
                "balance_family": "feature",
            }
        },
    }
    blobs = {
        "universal/model_pool.json": json.dumps(pool),
        "universal/xgboost/metadata_v1.json": json.dumps({"version": "v1", "feature_count": 106}),
    }
    bucket = _FakeBucket(blobs)
    from google.cloud import storage

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setenv("MODEL_POOL_READ_CACHE_TTL_SECONDS", "60")
    monkeypatch.setattr(storage, "Client", lambda: _FakeStorageClient(bucket))

    first = await model_pool.lineage()
    second = await model_pool.lineage()

    assert second == first
    assert bucket.downloads["universal/model_pool.json"] == 1
    assert bucket.downloads["universal/xgboost/metadata_v1.json"] == 1

    await model_pool.lineage(bypass_cache=True)

    assert bucket.downloads["universal/model_pool.json"] == 2
    assert bucket.downloads["universal/xgboost/metadata_v1.json"] == 2


@pytest.mark.anyio
async def test_artifact_registry_read_cache_reuses_query_and_invalidates(monkeypatch):
    calls = {"count": 0}

    def fake_list_artifact_registry(**kwargs):
        calls["count"] += 1
        return [{
            "artifact_id": f"XGBoost:v{calls['count']}:monthly_release",
            "model_name": kwargs.get("model_name"),
        }]

    monkeypatch.setenv("MODEL_POOL_READ_CACHE_TTL_SECONDS", "60")
    monkeypatch.setattr(model_pool, "list_artifact_registry", fake_list_artifact_registry)

    first = await model_pool.artifact_registry(model_name="XGBoost", limit=10)
    second = await model_pool.artifact_registry(model_name="XGBoost", limit=10)

    assert first == second
    assert calls["count"] == 1

    model_pool._invalidate_model_pool_read_cache("test_mutation")
    third = await model_pool.artifact_registry(model_name="XGBoost", limit=10)

    assert third["artifacts"][0]["artifact_id"] == "XGBoost:v2:monthly_release"
    assert calls["count"] == 2
