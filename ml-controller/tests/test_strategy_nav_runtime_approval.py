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
