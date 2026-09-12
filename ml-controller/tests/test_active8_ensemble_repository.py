import json

import pytest
from google.api_core.exceptions import PreconditionFailed

from services.active8_ensemble_artifact import payload_checksum
from services.active8_ensemble_repository import (
    persist_active8_ensemble_candidate,
    persist_active8_ensemble_validation_attempt,
)


class Blob:
    def __init__(self):
        self.value = None
        self.writes = 0
    def exists(self):
        return self.value is not None
    def download_as_text(self):
        return self.value
    def upload_from_string(self, value, content_type=None, if_generation_match=None):
        assert content_type == "application/json"
        assert if_generation_match == 0
        if self.value is not None:
            raise PreconditionFailed('already exists')
        self.value = value
        self.writes += 1


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
    from test_paired_nav_l3_candidate import fixed_artifact
    return fixed_artifact('registry-fixture')


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


@pytest.mark.parametrize('fault', ['checksum', 'failed_validation', 'training_run', 'bucket_name'])
def test_invalid_candidate_is_rejected_before_any_archive_or_d1_write(fault):
    bucket, d1, candidate = Bucket(), D1(), payload()
    training = 'run-1'
    if fault == 'checksum':
        candidate['knowledge_cutoff_date'] = '2026-08-26'
    elif fault == 'failed_validation':
        candidate['validation'] = {'decision': 'FAIL'}
        candidate['payload_checksum'] = payload_checksum({k: v for k, v in candidate.items() if k != 'payload_checksum'})
    elif fault == 'training_run':
        training = ''
    else:
        bucket.name = ''
    with pytest.raises((ValueError, RuntimeError), match='identity|contract'):
        persist_active8_ensemble_candidate(candidate, training_run_id=training, bucket=bucket, d1_client=d1)
    assert bucket.blobs == {} and d1.row is None


def test_lost_upload_ack_retries_without_overwriting_and_only_then_registers():
    bucket, d1, candidate = Bucket(), D1(), payload()
    path = f"active8/ensemble/{candidate['cohort_id']}/{candidate['payload_checksum']}.json"
    blob = bucket.blob(path)
    upload = blob.upload_from_string

    def lost_ack(*args, **kwargs):
        upload(*args, **kwargs)
        raise TimeoutError('simulated upload acknowledgement loss')

    blob.upload_from_string = lost_ack
    with pytest.raises(TimeoutError):
        persist_active8_ensemble_candidate(candidate, training_run_id='run-1', bucket=bucket, d1_client=d1)
    assert d1.row is None and blob.writes == 1
    blob.upload_from_string = upload
    first = persist_active8_ensemble_candidate(candidate, training_run_id='run-1', bucket=bucket, d1_client=d1)
    assert persist_active8_ensemble_candidate(candidate, training_run_id='run-1', bucket=bucket, d1_client=d1) == first
    assert blob.writes == 1


@pytest.mark.parametrize('same_payload', [True, False])
def test_concurrent_creator_never_gets_overwritten(same_payload):
    bucket, d1, candidate = Bucket(), D1(), payload()
    path = f"active8/ensemble/{candidate['cohort_id']}/{candidate['payload_checksum']}.json"
    blob = bucket.blob(path)

    def competing_upload(value, **kwargs):
        assert kwargs['if_generation_match'] == 0
        blob.value = value if same_payload else '{}'
        raise PreconditionFailed('another writer won')

    blob.upload_from_string = competing_upload
    if same_payload:
        assert persist_active8_ensemble_candidate(candidate, training_run_id='run-1', bucket=bucket, d1_client=d1)['status'] == 'persisted'
    else:
        with pytest.raises(RuntimeError, match='immutable_conflict'):
            persist_active8_ensemble_candidate(candidate, training_run_id='run-1', bucket=bucket, d1_client=d1)
        assert d1.row is None and blob.value == '{}'


def test_successful_upload_ack_without_exact_readback_does_not_register():
    bucket, d1, candidate = Bucket(), D1(), payload()
    path = f"active8/ensemble/{candidate['cohort_id']}/{candidate['payload_checksum']}.json"
    blob = bucket.blob(path)
    blob.upload_from_string = lambda *args, **kwargs: None
    with pytest.raises(RuntimeError, match='immutable_conflict'):
        persist_active8_ensemble_candidate(candidate, training_run_id='run-1', bucket=bucket, d1_client=d1)
    assert d1.row is None


class AttemptD1:
    def __init__(self):
        self.row = None
    def execute(self, _sql, params):
        candidate = dict(zip((
            "attempt_id", "cohort_id", "training_run_id", "knowledge_cutoff_date",
            "schema_version", "source_manifest_checksum",
            "observation_artifact_set_checksum", "validation_decision",
            "validation_json", "receipt_json", "receipt_checksum",
        ), params))
        candidate["production_effect"] = 0
        if self.row is None:
            self.row = candidate
        return {"success": True}
    def query(self, _sql, params):
        return [self.row] if self.row and self.row["attempt_id"] == params[0] else []


def failed_validation():
    return {
        "schema_version": "active8-oof-ensemble-validation-v1",
        "decision": "FAIL",
        "failed_gates": ["chronological_validation_equal_date_market_rank_ic_lcb90_non_positive"],
        "rank_ic_equal_date_market_lcb90": -0.1,
    }


def observation_artifacts():
    return {
        "DLinear": {
            "artifact_id": "DLinear:v1:oof_full_fit_release",
            "model_name": "DLinear",
            "version": "v1",
            "checksum": "sha256:" + "a" * 64,
            "artifact_path": "DLinear/v1.joblib",
            "metadata_path": "DLinear/v1.json",
            "candidate_type": "oof_full_fit_release",
            "training_run_id": "run-1",
        },
    }


def test_failed_validation_attempt_is_immutable_and_has_no_production_effect():
    d1 = AttemptD1()
    first = persist_active8_ensemble_validation_attempt(
        failed_validation(),
        base_artifacts=observation_artifacts(),
        cohort_id="cohort-1",
        training_run_id="run-1",
        knowledge_cutoff_date="2026-08-27",
        source_manifest_checksum="b" * 64,
        d1_client=d1,
    )
    second = persist_active8_ensemble_validation_attempt(
        failed_validation(),
        base_artifacts=observation_artifacts(),
        cohort_id="cohort-1",
        training_run_id="run-1",
        knowledge_cutoff_date="2026-08-27",
        source_manifest_checksum="b" * 64,
        d1_client=d1,
    )
    assert first == second
    assert first["validation_decision"] == "FAIL"
    assert first["production_effect"] is False
    assert json.loads(d1.row["receipt_json"])["production_effect"] is False


def test_failed_validation_attempt_identity_conflict_fails_closed():
    d1 = AttemptD1()
    persist_active8_ensemble_validation_attempt(
        failed_validation(),
        base_artifacts=observation_artifacts(),
        cohort_id="cohort-1",
        training_run_id="run-1",
        knowledge_cutoff_date="2026-08-27",
        source_manifest_checksum="b" * 64,
        d1_client=d1,
    )
    d1.row["validation_json"] = "{}"
    with pytest.raises(RuntimeError, match="immutable_conflict"):
        persist_active8_ensemble_validation_attempt(
            failed_validation(),
            base_artifacts=observation_artifacts(),
            cohort_id="cohort-1",
            training_run_id="run-1",
            knowledge_cutoff_date="2026-08-27",
            source_manifest_checksum="b" * 64,
            d1_client=d1,
        )
