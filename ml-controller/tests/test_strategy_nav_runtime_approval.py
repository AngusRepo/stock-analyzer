"""Exact source reapproval cannot grant configuration drift or maturity transfer."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest

from services.active8_paper_admission import RUNTIME_SCHEMA, validate_runtime_approval
from services.paired_nav_collection import allocator_source_identity
from services.paired_nav_recommendation_path import recommendation_source_identity
from services.native_paper_sandbox import native_execution_identity
from services.paired_nav_journal import digest
from test_native_paper_sandbox import native_runner


def seal(value):
    value['approval_checksum'] = digest({k: v for k, v in value.items() if k != 'approval_checksum'})
    return value


@pytest.fixture
def source_grant(native_runner, monkeypatch):
    monkeypatch.setenv('NATIVE_PAPER_RUNNER', str(native_runner))
    sources = {'allocator_source_identity': allocator_source_identity(),
               'l3_inference_source_identity': recommendation_source_identity()}
    before = {'trading_config': {'opb': {'enabled': True}, 'fees': {'commission': .001425}},
              'risk_config': {'cap': .3}, **deepcopy(sources),
              'native_execution_policy': {'execution_owner_version': 'native-paper-v1:' + '0' * 64,
                  'variables': {'LIVE_EXECUTION_CLIENT_ENABLED': '0'}, 'frozen_kv': {'policy': 'unchanged'}}}
    before['allocator_source_identity']['paired_nav_collection.py'] = '0' * 64
    admission = {'approved_at': '2026-10-12T12:00:00Z', 'configuration': deepcopy(before)}
    prior = seal({'schema_version': RUNTIME_SCHEMA, 'admission': admission, 'configuration': before,
        'scope': 'paper', 'approved': True, 'maturity_transfer': False, 'efficacy_status': 'unproven',
        'source_reference': 'private synthetic prior operator record', 'approved_at': admission['approved_at']})
    owner = native_execution_identity()
    manifest = {'schema_version': 'strategy-nav-source-release-v1', 'scope': 'paper',
        'production_baseline_verified': True, 'source_equivalence': False, 'maturity_transfer': False,
        'prior_approval_checksum': prior['approval_checksum'], 'prior_configuration_checksum': digest(before),
        'approved_sources': sources, 'execution_owner_version': owner}
    original_read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps(manifest)
        if path.name == 'strategy_nav_source_release.json' else original_read(path, *a, **kw))
    after = deepcopy(before)
    after.update(deepcopy(sources))
    after['native_execution_policy']['execution_owner_version'] = owner
    approval = seal({**deepcopy(prior), 'configuration': after, 'prior_runtime_approval': deepcopy(prior),
        'approved_at': '2026-10-14T12:00:00Z', 'source_reference': 'private synthetic NAV source grant',
        'approved_strategy_nav_source_change': {'release_manifest_checksum': digest(manifest)}})
    return admission, approval, manifest


def test_exact_source_release_preserves_economics_and_new_native_identity(source_grant):
    admission, approval, _ = source_grant
    assert validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc)) == approval


@pytest.mark.parametrize('fault', ['risk', 'fees', 'opb', 'live', 'source', 'owner', 'prior', 'maturity', 'manifest', 'future'])
def test_new_source_grant_rejects_other_drift(source_grant, fault):
    admission, approval, manifest = source_grant
    config = approval['configuration']
    if fault == 'risk': config['risk_config']['cap'] = .4
    elif fault == 'fees': config['trading_config']['fees']['commission'] = 0
    elif fault == 'opb': config['trading_config']['opb']['enabled'] = False
    elif fault == 'live': config['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'source': config['l3_inference_source_identity']['paired_nav_atomic_candidate.py'] = 'f' * 64
    elif fault == 'owner': config['native_execution_policy']['execution_owner_version'] = 'native-paper-v1:' + 'f' * 64
    elif fault == 'prior':
        # A different internally valid record is still unapproved.
        approval['prior_runtime_approval']['source_reference'] = 'different prior record'
        seal(approval['prior_runtime_approval'])
    elif fault == 'maturity': approval['maturity_transfer'] = True
    elif fault == 'manifest':
        manifest['source_equivalence'] = True
        approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    elif fault == 'future': approval['approved_at'] = '2026-10-15T12:00:00Z'
    seal(approval)
    with pytest.raises(RuntimeError):
        validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc))


def policy_grant(source_grant):
    from services.l4_distribution_runtime import distribution_policy_identity
    admission, approval, manifest = source_grant
    prior = approval['prior_runtime_approval']
    old = {'scope': 'paper', 'artifact': {'model_checksum': 'a' * 64, 'l3_identity': {'source': 'fixed'}},
           'constraints': {'covariance_horizon_sessions': 1, 'name_cap': .125},
           'opb': {'enabled': True, 'approved_policy_identity': 'b' * 64}}
    prior['configuration']['trading_config']['l4Distribution'] = deepcopy(old)
    prior['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    seal(prior)
    manifest['prior_approval_checksum'] = prior['approval_checksum']
    manifest['prior_configuration_checksum'] = digest(prior['configuration'])
    new = deepcopy(old)
    new['constraints']['covariance_horizon_sessions'] = 5
    new['sealedExecution'] = {'schema_version': 'l4-sealed-execution-v1',
        'rotation_mode': 'selected_ready_or_filled', 'expiry': 'retain_until_next_seal',
        'require_matched_risk_horizon': True, 'minimum_covariance_windows': 20}
    new['opb']['approved_policy_identity'] = distribution_policy_identity(new, new['artifact']['l3_identity'])
    approval['configuration']['trading_config']['l4Distribution'] = new
    approval['configuration']['native_execution_policy']['variables']['LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'] = '0'
    activation = {'schema_version': 'l4-execution-policy-activation-v1', 'scope': 'paper',
        'maturity_transfer': False, 'account_reset': False, 'minimum_covariance_windows': 20,
        'previous_policy_checksum': digest(old), 'next_policy_checksum': digest(new),
        'engineering_receipt_checksum': 'c' * 64, 'source_reference': 'test-only fixture'}
    manifest['policy_activation'] = activation
    approval['approved_strategy_nav_source_change']['release_manifest_checksum'] = digest(manifest)
    approval['approved_l4_execution_policy_change'] = {'activation_checksum': digest(activation)}
    seal(approval)
    return admission, approval


def test_explicit_policy_grant_activates_only_measured_horizon_and_fixed_rotation(source_grant):
    admission, approval = policy_grant(source_grant)
    assert validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc)) == approval


@pytest.mark.parametrize('fault', ['cap', 'model', 'opb', 'minimum', 'expiry', 'calibration', 'live', 'grant'])
def test_policy_activation_rejects_unreviewed_changes(source_grant, fault):
    admission, approval = policy_grant(source_grant)
    config = approval['configuration']
    policy = config['trading_config']['l4Distribution']
    if fault == 'cap': policy['constraints']['name_cap'] = .5
    elif fault == 'model': policy['artifact']['model_checksum'] = 'f' * 64
    elif fault == 'opb': policy['opb']['enabled'] = False
    elif fault == 'minimum': policy['sealedExecution']['minimum_covariance_windows'] = 2
    elif fault == 'expiry': policy['sealedExecution']['expiry'] = 'sell_anyway'
    elif fault == 'calibration': policy['sealedExecution']['uncertainty_calibration_checksum'] = 'f' * 64
    elif fault == 'live': config['native_execution_policy']['variables']['LIVE_EXECUTION_CLIENT_ENABLED'] = '1'
    elif fault == 'grant': approval.pop('approved_l4_execution_policy_change')
    seal(approval)
    with pytest.raises(RuntimeError):
        validate_runtime_approval(approval, admission, now=datetime(2026, 10, 14, 13, tzinfo=timezone.utc))


@pytest.mark.parametrize('active_policy', ['old', 'new', 'revoked'])
def test_staged_policy_grant_does_not_activate_until_config_changes(source_grant, monkeypatch, active_policy):
    from services import active8_paper_admission as paper, kv_client
    admission, candidate = policy_grant(source_grant)
    source = deepcopy(candidate)
    source.pop('approved_l4_execution_policy_change')
    source['configuration']['trading_config']['l4Distribution'] = deepcopy(
        candidate['prior_runtime_approval']['configuration']['trading_config']['l4Distribution'])
    seal(source)
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: json.dumps({
        'runtime_admission':'source-test','policy_runtime_admission':'policy-test'})
        if path.name=='native_execution_behavior_release.json' else read(path,*a,**kw))
    values={paper.KEY:None if active_policy=='revoked' else admission,
        'source-test':source,'policy-test':candidate,
        'trading:config':(candidate if active_policy=='new' else source)['configuration']['trading_config']}
    monkeypatch.setattr(kv_client,'get_json',lambda key,**kwargs:deepcopy(values.get(key)))
    if active_policy=='revoked':
        with pytest.raises(RuntimeError,match='revoked'):
            paper.verify_active_approval(admission)
    else:
        assert paper.verify_active_approval(admission)==(candidate if active_policy=='new' else source)
