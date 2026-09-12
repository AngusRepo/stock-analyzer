"""Strict frozen OPB prior inputs for isolated NAV, not serving authorization."""
from dataclasses import asdict, replace
from datetime import date, datetime, timedelta, timezone
import hashlib
import json

from services.evidence_contracts import (
    L4_ARTIFACT_CONTRACT_VERSION, L4_EXPECTED_RETURN_SEMANTIC,
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC,
)
from services.online_portfolio_bandit import DEFAULT_ARMS
from services.paired_nav_journal import digest, number, _timestamp


def verify_opb_prior(artifact, *, checksum, decision_at):
    """FAIL/pending efficacy may be observed; corrupt/unavailable data may not."""
    if (not isinstance(artifact, dict) or artifact.get('schema_version') != 'opb-arm-prior-artifact-v3'
            or digest(artifact) != checksum or not isinstance(decision_at, datetime)
            or decision_at.tzinfo is None or decision_at.utcoffset() is None):
        raise ValueError('paired_nav_opb_prior_identity_invalid')
    try:
        generated = _timestamp(artifact['generated_at'])
        trained = date.fromisoformat(artifact['trained_until'])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('paired_nav_opb_prior_clock_invalid') from exc
    if (generated > decision_at
            or trained > generated.astimezone(timezone(timedelta(hours=8))).date()):
        raise ValueError('paired_nav_opb_prior_not_available')
    semantic = {k: v for k, v in artifact.items() if k not in {'artifact_id', 'model_version', 'generated_at'}}
    fingerprint = hashlib.sha256(json.dumps(semantic, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()
    version = f"opb-prior-{artifact.get('expected_return_owner')}-{trained.strftime('%Y%m%d')}-{fingerprint}"
    if artifact.get('model_version') != version or artifact.get('artifact_id') != 'opb_arm_prior:' + version:
        raise ValueError('paired_nav_opb_prior_content_identity_invalid')
    contracts = {'l4_alpha_ev': (L4_ARTIFACT_CONTRACT_VERSION, L4_EXPECTED_RETURN_SEMANTIC),
        'allocator_ev_fusion': (ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION, ALLOCATOR_EV_EXPECTED_RETURN_SEMANTIC)}
    expected = contracts.get(artifact.get('expected_return_owner'))
    if expected is None or expected != (artifact.get('source_expected_return_contract_version'),
                                        artifact.get('source_expected_return_semantic')):
        raise ValueError('paired_nav_opb_prior_contract_invalid')
    if artifact.get('arm_policy') != [asdict(arm) for arm in DEFAULT_ARMS]:
        raise ValueError('paired_nav_opb_prior_arm_policy_changed')
    priors = artifact.get('arm_priors')
    if (not isinstance(priors, list) or len(priors) != len(DEFAULT_ARMS)
            or any(not isinstance(row, dict) for row in priors)
            or {row.get('arm_id') for row in priors} != {arm.arm_id for arm in DEFAULT_ARMS}):
        raise ValueError('paired_nav_opb_prior_arm_set_invalid')
    by_id = {row['arm_id']: row for row in priors}
    arms = []
    for arm in DEFAULT_ARMS:
        row = by_id[arm.arm_id]
        mean = number(row.get('prior_reward_mean'), 'opb_prior_mean')
        samples = row.get('prior_samples')
        if type(samples) is not int or samples < 1:
            raise ValueError('paired_nav_opb_prior_samples_invalid')
        arms.append(replace(arm, prior_reward_mean=mean, prior_samples=samples))
    return tuple(arms)
