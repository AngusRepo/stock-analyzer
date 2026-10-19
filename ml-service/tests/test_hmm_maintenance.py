"""All training and cloud I/O are fakes; these tests cannot retrain production."""
import copy
import hashlib
import json
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from google.api_core.exceptions import NotFound, PreconditionFailed

from app.hmm_input_contract import CONTRACT_HASH, SOURCE, checksum
from app.hmm_lifecycle import model_fresh, refresh_due
from app.hmm_maintenance import maintain_hmm, POLICY_PATH, META_PATH, LEASE_PATH

NOW = datetime(2026, 10, 19, 6, tzinfo=timezone.utc)


class Blob:
    def __init__(self, bucket, name, generation=None):
        self.bucket, self.name, self.generation = bucket, name, generation

    def reload(self):
        if self.name not in self.bucket.data:
            raise NotFound(self.name)
        self.generation = self.bucket.data[self.name][0]

    def download_as_bytes(self, if_generation_match=None):
        generation, raw = self.bucket.data[self.name]
        expected = if_generation_match or self.generation
        if expected is not None and generation != expected:
            raise PreconditionFailed('read generation changed')
        return raw

    def upload_from_string(self, value, *, content_type, if_generation_match):
        if self.name in self.bucket.fail:
            raise PreconditionFailed('injected write conflict')
        old = self.bucket.data.get(self.name, (0, b''))[0]
        if if_generation_match != old:
            raise PreconditionFailed('write generation changed')
        raw = value.encode() if isinstance(value, str) else value
        self.bucket.data[self.name] = old + 1, raw
        self.generation = old + 1
        self.bucket.writes.append(self.name)


class Bucket:
    def __init__(self):
        self.data, self.writes, self.fail = {}, [], set()

    def blob(self, name, generation=None):
        return Blob(self, name, generation)

    def seed(self, name, value):
        self.data[name] = 1, json.dumps(value).encode()


class Model:
    monitor_ = type('Monitor', (), {'converged': True})()
    transmat_ = np.array([[.9, .1], [.1, .9]])
    startprob_ = np.array([.5, .5])
    covars_ = np.array([np.eye(6), np.eye(6)])

    def predict_proba(self, rows):
        return np.tile([.4, .6], (len(rows), 1))


class Detector:
    def __init__(self, features, input_checksum):
        self.model = Model()
        self.feature_means, self.feature_stds = np.zeros(6), np.ones(6)
        self.training_input_checksum = input_checksum
        self.training_feature_checksum = hashlib.sha256(features.astype('<f8').tobytes()).hexdigest()

    def compatible(self):
        return True

    def predict_regime(self, rows):
        return {'regime_surface': {'bull_market': .4, 'sideways': .6}}


def fixture():
    bucket = Bucket()
    bucket.seed(POLICY_PATH, {'schema_version': 'hmm-maintenance-policy-v1', 'enabled': True,
        'approved_by': 'Wei', 'approval_ref': 'TEST_ONLY', 'input_contract': CONTRACT_HASH,
        'target_prefix': 'market_regime', 'refresh_after_days': 7, 'max_age_days': 9,
        'max_attempts_per_input': 2})
    bucket.seed(META_PATH, {'input_contract': CONTRACT_HASH, 'artifact_generation': '1', 'trained_at': (NOW - timedelta(days=8)).isoformat()})
    history = {(NOW.date() - timedelta(days=39-i)).isoformat(): {
        'market_return_1d': .001, 'market_return_5d': .005, 'risk_score': 10,
        'market_bias_20d': .01, 'realized_vol_3d': .002, 'benchmark_source': SOURCE,
        'risk_quality_status': 'score_verified'} for i in range(40)}
    env = {'history': history, 'hmm_input_contract': CONTRACT_HASH,
           'hmm_input_checksum': checksum(history), 'requested_run_date': NOW.date().isoformat(),
           'inference_as_of': NOW.isoformat()}
    payload = {'market_env': env, 'mode': 'live', 'required_until': (NOW + timedelta(days=1)).isoformat()}
    calls = []
    def fit(features):
        calls.append('fit')
        return Detector(features, env['hmm_input_checksum'])
    return bucket, payload, calls, fit


@pytest.mark.parametrize('offset,valid', [(-1, True), (0, True), (1, False)])
def test_exact_216_hour_boundary(offset, valid):
    meta = {'input_contract': CONTRACT_HASH, 'artifact_generation': '1', 'trained_at': (NOW-timedelta(days=9, seconds=offset)).isoformat()}
    assert model_fresh(meta, as_of=NOW) is valid


def test_weekend_coverage_and_refresh_are_distinct_from_hard_expiry():
    meta = {'input_contract': CONTRACT_HASH, 'artifact_generation': '1', 'trained_at': (NOW-timedelta(days=6)).isoformat()}
    assert not refresh_due(meta, now=NOW, required_until=NOW+timedelta(days=1))
    assert refresh_due(meta, now=NOW, required_until=NOW+timedelta(days=4))
    assert model_fresh(meta, as_of=NOW)
    assert not model_fresh({'input_contract': CONTRACT_HASH, 'artifact_generation': '1', 'trained_at': (NOW+timedelta(seconds=1)).isoformat()}, as_of=NOW)
    assert not model_fresh({'trained_at': '2026-10-19T00:00:00'}, as_of=NOW)


def test_disabled_policy_never_fits_or_writes():
    bucket, payload, calls, fit = fixture()
    policy = json.loads(bucket.data[POLICY_PATH][1]); policy['enabled'] = False
    bucket.seed(POLICY_PATH, policy)
    with pytest.raises(ValueError, match='NOT_APPROVED'):
        maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)
    assert calls == [] and bucket.writes == []


def test_fresh_or_busy_maintenance_never_fits():
    bucket, payload, calls, fit = fixture()
    bucket.seed(META_PATH, {'input_contract': CONTRACT_HASH, 'artifact_generation': '1', 'trained_at': (NOW-timedelta(days=1)).isoformat()})
    assert maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)['status'] == 'fresh'
    bucket.seed(META_PATH, {'input_contract': CONTRACT_HASH, 'artifact_generation': '1', 'trained_at': (NOW-timedelta(days=8)).isoformat()})
    bucket.seed(LEASE_PATH, {'token': 'another', 'expires_at': (NOW+timedelta(minutes=1)).isoformat()})
    assert maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)['status'] == 'running'
    assert not calls and not bucket.writes


def test_candidate_validation_failure_preserves_active_metadata_and_limits_retries():
    bucket, payload, calls, fit = fixture()
    original = bucket.data[META_PATH]
    def bad_fit(features):
        detector = fit(features)
        detector.model = copy.deepcopy(detector.model)
        detector.model.startprob_ = np.array([.9, .9])
        return detector
    for _ in range(2):
        with pytest.raises(ValueError, match='PROBABILITIES'):
            maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=bad_fit)
    assert bucket.data[META_PATH] == original
    assert maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=bad_fit)['status'] == 'attempt_limit'
    assert len(calls) == 2


def test_admission_pins_new_path_and_repeated_dispatch_does_not_retrain():
    bucket, payload, calls, fit = fixture()
    result = maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)
    assert result['status'] == 'admitted' and calls == ['fit']
    meta = json.loads(bucket.data[META_PATH][1])
    assert meta['artifact_path'].startswith('market_regime/versions/')
    assert 'market_regime/hmm_detector.joblib' not in bucket.writes
    assert meta['trained_at'] == NOW.isoformat()
    assert maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)['status'] == 'fresh'
    assert len(calls) == 1


def test_activation_conflict_preserves_old_metadata():
    bucket, payload, calls, fit = fixture()
    original = bucket.data[META_PATH]
    bucket.fail.add(META_PATH)
    with pytest.raises(PreconditionFailed):
        maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)
    assert bucket.data[META_PATH] == original


def test_expired_owner_cannot_activate_candidate():
    bucket, payload, calls, fit = fixture()
    original = bucket.data[META_PATH]
    def stale_fit(features):
        result = fit(features)
        bucket.seed(LEASE_PATH, {'token': 'new_owner', 'expires_at': (NOW+timedelta(minutes=20)).isoformat()})
        return result
    with pytest.raises(ValueError, match='LEASE_OR_APPROVAL_CHANGED'):
        maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=stale_fit)
    assert bucket.data[META_PATH] == original


def test_historical_or_future_input_cannot_fit():
    bucket, payload, calls, fit = fixture()
    payload['mode'] = 'historical'
    with pytest.raises(ValueError, match='LIVE_INPUT'):
        maintain_hmm(payload, bucket=bucket, clock=lambda: NOW, fit=fit)
    assert not calls and not bucket.writes


def test_retry_identity_does_not_reset_on_non_model_macro_annotations():
    from app.hmm_input_contract import training_input_key
    _, payload, _, _ = fixture()
    env = payload['market_env']
    changed = copy.deepcopy(env)
    changed['history'][changed['requested_run_date']]['pmi'] = 52
    changed['hmm_input_checksum'] = checksum(changed['history'])
    assert changed['hmm_input_checksum'] != env['hmm_input_checksum']
    assert training_input_key(changed) == training_input_key(env)


def test_actual_gcs_loader_uses_exact_age_without_changing_other_model_policy(monkeypatch):
    from app import model_store
    class FixedClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW
    monkeypatch.setattr(model_store, 'datetime', FixedClock)
    metadata = {'trained_at': (NOW-timedelta(days=9,hours=6)).isoformat()}
    assert model_store.is_model_fresh(metadata, max_age_days=9) is True
    assert model_store.is_model_fresh(metadata, max_age_days=9, exact_age=True) is False
