"""Original registry boundary: research creates candidates, never champions."""
import asyncio

import pytest

from routers import opb_arm_prior as route
from test_opb_publication_closure import publication


@pytest.mark.parametrize('decision', ['PASS', 'FAIL'])
def test_offline_result_never_grants_publication(publication, decision):
    artifact, db, config, calls, request = publication
    artifact['validation'] = {'decision': decision,
                              'failed_checks': [] if decision == 'PASS' else ['insufficient_dates']}
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['status'] == 'candidate_registered'
    assert result['completion_scope'] == 'candidate_registration'
    assert result['promotion_owner'] == 'daily_nav'
    assert result['registry_verified'] is True
    assert result['promoted'] is False
    assert result['production_mutation_allowed'] is False
    assert result['config_projection_verified'] is False
    assert result['artifact_checksum'] == route._checksum(result['artifact'])
    assert calls == [] and config == {}
    assert db.execute('SELECT state FROM model_artifact_registry').fetchone()[0] == (
        'offline_passed' if decision == 'PASS' else 'offline_failed')


def test_preview_does_not_create_registry_or_config(publication):
    _, db, config, calls, request = publication
    result = asyncio.run(route.refresh_opb_arm_prior(request.model_copy(update={'dry_run': True})))
    assert result['status'] == 'preview'
    assert result['registry_verified'] is False
    assert not result['promoted'] and not result['production_mutation_allowed']
    assert db.execute('SELECT count(*) FROM model_artifact_registry').fetchone()[0] == 0
    assert calls == [] and config == {}


@pytest.mark.parametrize('state', ['production', 'archived', 'rejected', 'live_gate_passed'])
def test_registration_retry_does_not_own_candidate_lifecycle(publication, state):
    _, db, config, calls, request = publication
    first = asyncio.run(route.refresh_opb_arm_prior(request))
    assert first['registry_verified']
    db.execute('UPDATE model_artifact_registry SET state=?,live_evidence_json=?',
               [state, '{"original_nav_receipt":"preserve"}'])
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    calls.clear()
    config_before = dict(config)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    assert result['status'] == 'candidate_registered'
    assert result['candidate_state'] == state
    assert result['promoted'] is False
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before
    assert calls == [] and config == config_before
