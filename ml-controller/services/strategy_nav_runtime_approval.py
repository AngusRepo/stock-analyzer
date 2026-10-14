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
    # All model, OPB, risk, frozen-KV, execution variables and costs stay exact.
    # Pin the complete already-verified baseline; do not recursively reinterpret
    # a historical source grant using today's different on-disk sources.
    if digest(after) != digest(before):
        raise RuntimeError('strategy_nav_runtime_economic_configuration_changed')
    return deepcopy(approval)
