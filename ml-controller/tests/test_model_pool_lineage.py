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
    assert result["events"] == [{"model": "XGBoost", "transition": "register"}]


@pytest.mark.asyncio
async def test_lineage_marks_ft_transformer_artifact_mismatch(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "models": {
            "FT-Transformer": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/ft_transformer/v1.joblib",
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

    diagnosis = result["models"]["FT-Transformer"]["lifecycle_diagnosis"]
    assert diagnosis["status"] == "artifact_mismatch"
    assert "metadata_missing" in diagnosis["blockers"]
    assert "prediction_missing" in diagnosis["blockers"]


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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
    assert model["challenger"]["metadata"]["n_input_series"] == 140
    assert model["challenger"]["metadata"]["oos_ic"] == 0.08
    assert model["challenger"]["metadata"]["daily_ic_count"] == 14
    assert model["challenger"]["metadata"]["sequence_report"]["oos_windows"] == 130
