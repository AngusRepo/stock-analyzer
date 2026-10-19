"""Bounded HMM maintenance, separate from read-only inference.

The deployed operator policy is required before fit or any model publication.
All model objects are immutable; one generation-CAS metadata write activates one.
"""
import hashlib
import io
import json
import uuid
from datetime import datetime, timedelta, timezone

from .hmm_input_contract import CONTRACT_HASH, FEATURES, validate_environment, training_input_key
from .hmm_lifecycle import model_fresh, refresh_due, timestamp

POLICY_PATH = 'market_regime/maintenance-policy.json'
META_PATH = 'market_regime/metadata.json'
LEASE_PATH = 'market_regime/maintenance-lease.json'
MAX_ATTEMPTS = 2
LEASE_SECONDS = 600  # Exceeds the Modal function's hard 300-second timeout.


def read_json(bucket, name):
    from google.api_core.exceptions import NotFound
    blob = bucket.blob(name)
    try:
        blob.reload()
        generation = int(blob.generation)
        raw = blob.download_as_bytes(if_generation_match=generation)
        return json.loads(raw), generation
    except NotFound:
        return None, 0


def write_json(bucket, name, value, generation):
    bucket.blob(name).upload_from_string(json.dumps(value, sort_keys=True, allow_nan=False),
        content_type='application/json', if_generation_match=generation)


def require_policy(policy):
    if (not isinstance(policy, dict) or policy.get('schema_version') != 'hmm-maintenance-policy-v1'
            or policy.get('enabled') is not True or policy.get('approved_by') != 'Wei'
            or not str(policy.get('approval_ref') or '').strip()
            or policy.get('input_contract') != CONTRACT_HASH
            or policy.get('target_prefix') != 'market_regime'
            or policy.get('refresh_after_days') != 7 or policy.get('max_age_days') != 9
            or policy.get('max_attempts_per_input') != MAX_ATTEMPTS):
        raise ValueError('HMM_AUTOMATIC_MAINTENANCE_NOT_APPROVED')
    return policy


def validate_candidate(detector, features):
    import numpy as np
    if not detector.compatible() or not detector.model.monitor_.converged:
        raise ValueError('HMM_CANDIDATE_NOT_CONVERGED_OR_INCOMPATIBLE')
    normalized = (features - detector.feature_means) / detector.feature_stds
    posterior = detector.model.predict_proba(normalized)
    for matrix in (posterior, detector.model.transmat_, detector.model.startprob_):
        if not np.isfinite(matrix).all() or (matrix < 0).any() or not np.allclose(matrix.sum(axis=-1), 1):
            raise ValueError('HMM_CANDIDATE_PROBABILITIES_INVALID')
    covariance = detector.model.covars_
    if not np.isfinite(covariance).all() or not (np.linalg.eigvalsh(covariance) > 0).all():
        raise ValueError('HMM_CANDIDATE_COVARIANCE_INVALID')
    if not detector.predict_regime(features).get('regime_surface'):
        raise ValueError('HMM_CANDIDATE_POSTERIOR_UNAVAILABLE')


def maintain_hmm(payload, *, bucket=None, clock=None, fit=None):
    """At most two attempts per certified input; no changes to other models."""
    from google.api_core.exceptions import PreconditionFailed
    from .regime import RegimeDetector, build_market_feature_rows
    from .model_store import _get_bucket
    import joblib

    bucket = bucket or _get_bucket()
    if bucket is None:
        raise RuntimeError('HMM_STORAGE_UNAVAILABLE')
    clock = clock or (lambda: datetime.now(timezone.utc))
    policy, _ = read_json(bucket, POLICY_PATH)
    require_policy(policy)
    env = payload['market_env']
    validate_environment(env)
    now = clock()
    cutoff = timestamp(env['inference_as_of'])
    required_until = timestamp(payload['required_until'])
    if cutoff > now or required_until < now or required_until > now + timedelta(days=9):
        raise ValueError('HMM_MAINTENANCE_CLOCK_INVALID')
    # A backfill cannot grant permission to fit a production model.
    if payload.get('mode') != 'live' or env['requested_run_date'] > now.astimezone(timezone(timedelta(hours=8))).date().isoformat():
        raise ValueError('HMM_MAINTENANCE_REQUIRES_LIVE_INPUT')
    def due(metadata):
        return (not metadata or metadata.get('input_contract') != CONTRACT_HASH
                or not str(metadata.get('artifact_generation') or '').isdigit()
                or refresh_due(metadata, now=clock(), required_until=required_until))
    meta, _ = read_json(bucket, META_PATH)
    if not due(meta):
        return {'status': 'fresh', 'trained_at': meta['trained_at'], 'training_calls': 0}
    lease, lease_generation = read_json(bucket, LEASE_PATH)
    if lease and timestamp(lease['expires_at']) > now:
        return {'status': 'running', 'training_calls': 0}
    token = uuid.uuid4().hex
    lease = {'token': token, 'expires_at': (now + timedelta(seconds=LEASE_SECONDS)).isoformat()}
    try:
        write_json(bucket, LEASE_PATH, lease, lease_generation)
    except PreconditionFailed:
        return {'status': 'running', 'training_calls': 0}
    attempt_path = 'market_regime/maintenance-attempts/' + training_input_key(env) + '.json'
    attempt_generation = None
    try:
        # Recheck after acquiring the global lock; another worker may have published.
        meta, meta_generation = read_json(bucket, META_PATH)
        if not due(meta):
            return {'status': 'fresh', 'trained_at': meta['trained_at'], 'training_calls': 0}
        previous, attempt_generation = read_json(bucket, attempt_path)
        count = int((previous or {}).get('attempts', 0))
        if count >= MAX_ATTEMPTS:
            return {'status': 'attempt_limit', 'training_calls': 0}
        receipt = {'status': 'running', 'attempts': count + 1, 'input_checksum': env['hmm_input_checksum'],
                   'started_at': clock().isoformat(), 'approval_ref': policy['approval_ref'], 'token': token}
        write_json(bucket, attempt_path, receipt, attempt_generation)
        _, attempt_generation = read_json(bucket, attempt_path)
        dates, features = build_market_feature_rows(env)
        if features is None or len(features) < 30:
            raise ValueError('HMM_TRAINING_REQUIRES_30_CERTIFIED_SESSIONS')
        detector = (fit or (lambda values: RegimeDetector().fit(values,
            input_contract=CONTRACT_HASH, training_input_checksum=env['hmm_input_checksum'])))(features)
        trained_at = clock().isoformat()
        validate_candidate(detector, features)
        if detector.training_input_checksum != env['hmm_input_checksum']:
            raise ValueError('HMM_TRAINING_INPUT_CHANGED')
        if detector.training_feature_checksum != hashlib.sha256(features.astype('<f8').tobytes()).hexdigest():
            raise ValueError('HMM_TRAINING_FEATURES_CHANGED')
        raw = io.BytesIO()
        joblib.dump(detector, raw)
        model_bytes = raw.getvalue()
        model_path = f'market_regime/versions/{token}/hmm_detector.joblib'
        blob = bucket.blob(model_path)
        blob.upload_from_string(model_bytes, content_type='application/octet-stream', if_generation_match=0)
        blob.reload()
        candidate = {'trained_at': trained_at, 'input_contract': CONTRACT_HASH, 'feature_order': list(FEATURES),
            'artifact_path': model_path, 'artifact_generation': str(blob.generation),
            'artifact_sha256': hashlib.sha256(model_bytes).hexdigest(), 'gcs_prefix': 'market_regime',
            'training_input_checksum': env['hmm_input_checksum'], 'training_feature_checksum': detector.training_feature_checksum,
            'train_start': dates[0], 'train_end': dates[-1], 'history_days': len(dates),
            'approval_ref': policy['approval_ref'], 'previous_metadata_generation': str(meta_generation)}
        pinned = bucket.blob(model_path, generation=int(blob.generation)).download_as_bytes()
        if hashlib.sha256(pinned).hexdigest() != candidate['artifact_sha256']:
            raise ValueError('HMM_STAGED_ARTIFACT_CHANGED')
        restored = joblib.load(io.BytesIO(pinned))
        validate_candidate(restored, features)
        current_lease, _ = read_json(bucket, LEASE_PATH)
        current_policy, _ = read_json(bucket, POLICY_PATH)
        require_policy(current_policy)
        if current_policy != policy or current_lease['token'] != token or timestamp(current_lease['expires_at']) <= clock():
            raise ValueError('HMM_MAINTENANCE_LEASE_OR_APPROVAL_CHANGED')
        if not model_fresh(candidate, as_of=required_until):
            raise ValueError('HMM_CANDIDATE_DECISION_COVERAGE_INVALID')
        write_json(bucket, f'market_regime/versions/{token}/previous-metadata.json', meta, 0)
        # This is the only activation. Failed CAS leaves the old model intact.
        write_json(bucket, META_PATH, candidate, meta_generation)
        active, active_generation = read_json(bucket, META_PATH)
        if active != candidate:
            raise ValueError('HMM_ACTIVATION_READBACK_CHANGED')
        receipt.update(status='admitted', completed_at=clock().isoformat(), model=candidate,
                       metadata_generation=str(active_generation), training_calls=1)
        write_json(bucket, attempt_path, receipt, attempt_generation)
        return receipt
    except Exception as exc:
        if attempt_generation is not None:
            failure = {**locals().get('receipt', {}), 'status': 'failed',
                       'error_type': type(exc).__name__, 'error': str(exc)[:400], 'completed_at': clock().isoformat()}
            write_json(bucket, attempt_path, failure, attempt_generation)
        raise
    finally:
        current, generation = read_json(bucket, LEASE_PATH)
        if current and current.get('token') == token:
            write_json(bucket, LEASE_PATH, {**current, 'expires_at': clock().isoformat()}, generation)
