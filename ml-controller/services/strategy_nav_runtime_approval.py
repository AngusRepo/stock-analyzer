"""Exact operator source reapproval; never source equivalence or NAV credit."""
from copy import deepcopy
import json
from pathlib import Path

from services.paired_nav_journal import digest, _timestamp


def validate_source_release(approval, admission, *, now):
    from services.active8_paper_admission import runtime_configuration_identity
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_recommendation_path import recommendation_source_identity
    from services.native_paper_sandbox import native_execution_identity

    manifest = json.loads(Path(__file__).with_name('strategy_nav_source_release.json').read_text(encoding='utf-8'))
    fail = lambda: RuntimeError('strategy_nav_runtime_source_release_invalid')
    if (manifest.get('schema_version') != 'strategy-nav-source-release-v1'
            or manifest.get('scope') != 'paper' or manifest.get('source_equivalence') is not False
            or manifest.get('maturity_transfer') is not False
            or not manifest.get('production_baseline_verified')
            or approval['approved_strategy_nav_source_change'] != {'release_manifest_checksum': digest(manifest)}):
        raise fail()
    prior = approval.get('prior_runtime_approval')
    if (not isinstance(prior, dict) or prior.get('admission') != admission
            or prior.get('scope') != 'paper' or prior.get('approved') is not True
            or prior.get('maturity_transfer') is not False or prior.get('efficacy_status') != 'unproven'
            or prior.get('approval_checksum') != digest({k: v for k, v in prior.items() if k != 'approval_checksum'})
            or prior.get('approval_checksum') != manifest['prior_approval_checksum']
            or not _timestamp(admission['approved_at']) <= _timestamp(prior['approved_at'])
                <= _timestamp(approval['approved_at']) <= now):
        raise fail()
    before = runtime_configuration_identity(prior['configuration'])
    after = runtime_configuration_identity(approval['configuration'])
    if digest(before) != manifest['prior_configuration_checksum']:
        raise fail()
    expected_sources = {'allocator_source_identity': allocator_source_identity(),
                        'l3_inference_source_identity': recommendation_source_identity()}
    for name, current in expected_sources.items():
        if current != manifest['approved_sources'][name] or after.get(name) != current:
            raise fail()
        after[name] = before[name]
    owner = native_execution_identity()
    if (owner != manifest['execution_owner_version']
            or after['native_execution_policy'].get('execution_owner_version') != owner):
        raise fail()
    after['native_execution_policy']['execution_owner_version'] = before['native_execution_policy']['execution_owner_version']
    change = approval.get('approved_l4_execution_policy_change')
    if change is not None:
        from services.l4_policy_activation import SCHEMAS, manifest_chain, named_chain, validate_activation_chain
        chain, named = manifest_chain(manifest), named_chain(change)
        # A grant names a prefix of this release's reviewed chain (P1 = 1, P2 = 1..2, ...).
        if (not isinstance(chain, list) or not all(isinstance(a, dict) for a in chain)
                or not isinstance(named, list) or not named or named != [digest(a) for a in chain[:len(named)]]):
            raise fail()
        prefix = chain[:len(named)]
        if any(a.get('schema_version') in SCHEMAS for a in prefix):
            validate_activation_chain(before, after, prefix)
        elif len(prefix) == 1:
            _validate_execution_policy_change(before, after, prefix[0])
        else:
            raise fail()
    # Source-only releases cannot change economics. A separate exact policy
    # grant may normalize only the reviewed horizon/rotation delta above.
    # Pin the complete already-verified baseline; do not recursively reinterpret
    # a historical source grant using today's different on-disk sources.
    if digest(after) != digest(before):
        raise RuntimeError('strategy_nav_runtime_economic_configuration_changed')
    return deepcopy(approval)


def _validate_execution_policy_change(before, after, activation):
    """Validate the first Paper activation, never arbitrary config migration."""
    from services.l4_distribution_runtime import distribution_policy_identity
    old = before['trading_config'].get('l4Distribution') or {}
    new = after['trading_config'].get('l4Distribution') or {}
    fail = lambda: RuntimeError('l4_execution_policy_activation_invalid')
    if (activation.get('schema_version') != 'l4-execution-policy-activation-v1'
            or activation.get('scope') != 'paper'
            or activation.get('maturity_transfer') is not False
            or activation.get('account_reset') is not False
            or activation.get('previous_policy_checksum') != digest(old)
            or activation.get('next_policy_checksum') != digest(new)
            or not activation.get('engineering_receipt_checksum')
            or not activation.get('source_reference')
            or old.get('scope') != 'paper' or new.get('scope') != 'paper'
            or old.get('sealedExecution') is not None
            or old.get('constraints', {}).get('covariance_horizon_sessions') != 1):
        raise fail()
    expected = deepcopy(old)
    expected['constraints']['covariance_horizon_sessions'] = 5
    expected['sealedExecution'] = {
        'schema_version': 'l4-sealed-execution-v1',
        'rotation_mode': 'selected_ready_or_filled',
        'expiry': 'retain_until_next_seal',
        'require_matched_risk_horizon': True,
        'minimum_covariance_windows': activation.get('minimum_covariance_windows'),
    }
    minimum = activation.get('minimum_covariance_windows')
    if type(minimum) is not int or minimum < 2:
        raise fail()
    expected['opb']['approved_policy_identity'] = distribution_policy_identity(
        expected, expected['artifact']['l3_identity'])
    if digest(expected) != digest(new):
        raise fail()
    for flag in ('LIVE_EXECUTION_CLIENT_ENABLED', 'LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'):
        if str(after['native_execution_policy']['variables'].get(flag, '')).lower() not in ('0', 'false', 'off', 'disabled'):
            raise fail()
    after['trading_config']['l4Distribution'] = deepcopy(old)
