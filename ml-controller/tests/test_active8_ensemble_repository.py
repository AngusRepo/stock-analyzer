import json

import pytest

from services.active8_ensemble_artifact import payload_checksum
from services.active8_ensemble_repository import persist_active8_ensemble_candidate


class Blob:
    def __init__(self):
        self.value = None
    def exists(self):
        return self.value is not None
    def download_as_text(self):
        return self.value
    def upload_from_string(self, value, content_type=None):
        assert content_type == "application/json"
        self.value = value


class Bucket:
    name = "immutable-test"
    def __init__(self):
        self.blobs = {}
    def blob(self, path):
        return self.blobs.setdefault(path, Blob())


class D1:
    def __init__(self):
        self.row = None
    def execute(self, _sql, params):
        candidate = dict(zip((
            "artifact_id", "cohort_id", "training_run_id", "knowledge_cutoff_date",
            "schema_version", "payload_json", "payload_checksum",
            "base_artifact_set_checksum", "validation_decision", "validation_json",
            "archive_uri",
        ), params))
        candidate.update(state="candidate", production_effect=0)
        if self.row is None:
            self.row = candidate
        return {"success": True}
    def query(self, _sql, params):
        return [self.row] if self.row and self.row["artifact_id"] == params[0] else []


def payload():
    value = {
        "schema_version": "active8-oof-ensemble-serving-artifact-v1",
        "cohort_id": "cohort-1",
        "knowledge_cutoff_date": "2026-08-25",
        "base_artifact_set_checksum": "b" * 64,
        "validation": {"decision": "PASS"},
    }
    value["payload_checksum"] = payload_checksum(value)
    return value


def test_candidate_is_archived_then_exactly_read_back():
    bucket, d1 = Bucket(), D1()
    result = persist_active8_ensemble_candidate(
        payload(), training_run_id="run-1", bucket=bucket, d1_client=d1,
    )
    assert result["status"] == "persisted"
    assert result["production_effect"] is False
    archived = next(iter(bucket.blobs.values())).value
    assert json.loads(archived)["payload_checksum"] == result["payload_checksum"]
    assert d1.row["state"] == "candidate"


def test_archive_conflict_fails_closed():
    bucket, d1 = Bucket(), D1()
    first = payload()
    persist_active8_ensemble_candidate(first, training_run_id="run-1", bucket=bucket, d1_client=d1)
    next(iter(bucket.blobs.values())).value = "{}"
    with pytest.raises(RuntimeError, match="immutable_conflict"):
        persist_active8_ensemble_candidate(first, training_run_id="run-1", bucket=bucket, d1_client=d1)


def test_d1_identity_conflict_fails_closed():
    bucket, d1 = Bucket(), D1()
    first = payload()
    persist_active8_ensemble_candidate(first, training_run_id="run-1", bucket=bucket, d1_client=d1)
    d1.row["payload_json"] = "{}"
    with pytest.raises(RuntimeError, match="immutable_conflict"):
        persist_active8_ensemble_candidate(first, training_run_id="run-1", bucket=bucket, d1_client=d1)
