from __future__ import annotations

import hashlib
import json
import sys

import pytest
from google.api_core.exceptions import PreconditionFailed
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.pipeline_modal_handoff import (  # noqa: E402
    dispatch_modal_prediction_continuation,
    load_verified_modal_prediction_bundle,
)


class Blob:
    def __init__(self):
        self.raw: bytes | None = None
        self.generation = 0

    def upload_from_string(self, value, **kwargs):
        expected_generation = kwargs.get("if_generation_match")
        if expected_generation is not None and expected_generation != self.generation:
            raise PreconditionFailed("generation precondition failed")
        self.raw = value.encode("utf-8") if isinstance(value, str) else bytes(value)
        self.generation += 1

    def download_as_bytes(self):
        if self.raw is None:
            raise FileNotFoundError
        return self.raw

    def download_as_text(self):
        return self.download_as_bytes().decode("utf-8")

    def reload(self):
        return None


class Bucket:
    def __init__(self):
        self.blobs = {}

    def blob(self, path):
        return self.blobs.setdefault(path, Blob())


class StorageClient:
    def __init__(self):
        self.buckets = {}

    def bucket(self, name):
        return self.buckets.setdefault(name, Bucket())


class JobsClient:
    def __init__(self):
        self.calls = []

    def run_job(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(execution_id="pipeline-v2-test", execution_name="jobs/pipeline-v2-test")


def test_checksum_bundle_loader_and_durable_job_dispatch(monkeypatch):
    storage = StorageClient()
    bundle = {
        "schema_version": "pipeline-modal-prediction-bundle-v1",
        "run_id": "pipeline-v2-parent",
        "run_date": "2026-07-17",
        "state_gcs_uri": "gs://stockvision-models/pipeline-v2/states/parent.json",
        "predict_batch_v2_results": [],
    }
    raw = json.dumps(bundle, sort_keys=True).encode("utf-8")
    checksum = hashlib.sha256(raw).hexdigest()
    result_path = "pipeline-v2/modal-results/2026-07-17/result.json"
    storage.bucket("stockvision-models").blob(result_path).raw = raw

    loaded = load_verified_modal_prediction_bundle(
        result_gcs_uri=f"gs://stockvision-models/{result_path}",
        expected_checksum=checksum,
        storage_client=storage,
    )
    assert loaded == bundle

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    jobs = JobsClient()
    dispatch = dispatch_modal_prediction_continuation(
        {
            "schema_version": "pipeline-modal-prediction-callback-v2",
            "run_id": "pipeline-v2-parent",
            "run_date": "2026-07-17",
            "state_gcs_uri": "gs://stockvision-models/pipeline-v2/states/parent.json",
            "result_gcs_uri": f"gs://stockvision-models/{result_path}",
            "result_checksum": checksum,
            "elapsed_s": 91.2,
        },
        jobs_client=jobs,
        storage_client=storage,
    )

    assert dispatch["status"] == "dispatched"
    assert dispatch["execution_id"] == "pipeline-v2-test"
    assert len(jobs.calls) == 1
    overrides = jobs.calls[0]["env_overrides"]
    assert overrides["PIPELINE_MODAL_CONTINUATION_MODE"] == "1"
    assert overrides["PIPELINE_PARENT_RUN_ID"] == "pipeline-v2-parent"
    assert overrides["PIPELINE_MODAL_RESULT_CHECKSUM"] == checksum
    assert jobs.calls[0]["reject_if_running"] is False

    replay = dispatch_modal_prediction_continuation(
        {
            "schema_version": "pipeline-modal-prediction-callback-v2",
            "run_id": "pipeline-v2-parent",
            "run_date": "2026-07-17",
            "state_gcs_uri": "gs://stockvision-models/pipeline-v2/states/parent.json",
            "result_gcs_uri": f"gs://stockvision-models/{result_path}",
            "result_checksum": checksum,
            "elapsed_s": 91.2,
        },
        jobs_client=jobs,
        storage_client=storage,
    )
    assert replay["idempotent"] is True
    assert len(jobs.calls) == 1


def _dispatch_fixture(*, storage, jobs, state_gcs_uri, marker):
    bundle = {
        "schema_version": "pipeline-modal-prediction-bundle-v1",
        "run_id": "pipeline-v2-parent",
        "run_date": "2026-07-17",
        "state_gcs_uri": state_gcs_uri,
        "marker": marker,
    }
    raw = json.dumps(bundle, sort_keys=True).encode("utf-8")
    checksum = hashlib.sha256(raw).hexdigest()
    result_path = "pipeline-v2/modal-results/2026-07-17/result.json"
    storage.bucket("stockvision-models").blob(result_path).raw = raw
    payload = {
        "schema_version": "pipeline-modal-prediction-callback-v2",
        "run_id": bundle["run_id"],
        "run_date": bundle["run_date"],
        "state_gcs_uri": bundle["state_gcs_uri"],
        "result_gcs_uri": f"gs://stockvision-models/{result_path}",
        "result_checksum": checksum,
    }
    return dispatch_modal_prediction_continuation(
        payload,
        jobs_client=jobs,
        storage_client=storage,
    )


def test_dispatch_rejects_divergent_checksum_for_same_run(monkeypatch):
    storage = StorageClient()
    jobs = JobsClient()
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    state_uri = "gs://stockvision-models/pipeline-v2/states/parent.json"

    _dispatch_fixture(storage=storage, jobs=jobs, state_gcs_uri=state_uri, marker="A")
    with pytest.raises(
        ValueError,
        match="pipeline_modal_continuation_receipt_conflict:result_checksum",
    ):
        _dispatch_fixture(storage=storage, jobs=jobs, state_gcs_uri=state_uri, marker="B")

    assert len(jobs.calls) == 1


def test_dispatch_rejects_different_state_for_same_run(monkeypatch):
    storage = StorageClient()
    jobs = JobsClient()
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")

    _dispatch_fixture(
        storage=storage,
        jobs=jobs,
        state_gcs_uri="gs://stockvision-models/pipeline-v2/states/parent.json",
        marker="A",
    )
    with pytest.raises(
        ValueError,
        match="pipeline_modal_continuation_receipt_conflict:state_gcs_uri",
    ):
        _dispatch_fixture(
            storage=storage,
            jobs=jobs,
            state_gcs_uri="gs://stockvision-models/pipeline-v2/states/divergent.json",
            marker="B",
        )

    assert len(jobs.calls) == 1


def test_dispatch_rejects_cross_run_bundle_lineage(monkeypatch):
    storage = StorageClient()
    bundle = {
        "schema_version": "pipeline-modal-prediction-bundle-v1",
        "run_id": "different-run",
        "run_date": "2026-07-17",
        "state_gcs_uri": "gs://stockvision-models/pipeline-v2/states/parent.json",
    }
    raw = json.dumps(bundle, sort_keys=True).encode("utf-8")
    checksum = hashlib.sha256(raw).hexdigest()
    result_path = "pipeline-v2/modal-results/2026-07-17/mismatch.json"
    storage.bucket("stockvision-models").blob(result_path).raw = raw
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models")
    jobs = JobsClient()

    with pytest.raises(ValueError, match="pipeline_modal_result_lineage_mismatch:run_id"):
        dispatch_modal_prediction_continuation(
            {
                "schema_version": "pipeline-modal-prediction-callback-v2",
                "run_id": "pipeline-v2-parent",
                "run_date": "2026-07-17",
                "state_gcs_uri": "gs://stockvision-models/pipeline-v2/states/parent.json",
                "result_gcs_uri": f"gs://stockvision-models/{result_path}",
                "result_checksum": checksum,
            },
            jobs_client=jobs,
            storage_client=storage,
        )

    assert jobs.calls == []
