"""Partial serving/config/OPB acknowledgements are not automation closure."""
import asyncio
from copy import deepcopy

import pytest

from routers import walk_forward as route


def registration_summary(owner='l4_alpha_ev'):
    return (f'opb_arm_prior_refresh status=candidate_registered owner={owner} date=2026-09-09 '
            'scope=candidate_registration receipt=opb-candidate-registration-v1 registered=1 '
            f'promotion_owner=daily_nav artifact=opb_arm_prior%3Atest checksum={"a" * 64} promoted=0')


def request_and_response():
    request = {'l4_alpha_ev': {'artifact_id': 'l4:version:checksum',
        'artifact': {'model_version': 'version'}}}
    response = {'outcomes': {'l4_alpha_ev': {'promoted': True, 'model_version': 'version',
        'pointer_commit': {'artifact_id': 'l4:version:checksum', 'payload_checksum': 'a' * 64},
        'config_projection_error': None}}}
    return request, response


def test_pointer_commit_with_failed_kv_projection_is_partial_not_complete():
    request, response = request_and_response()
    response['outcomes']['l4_alpha_ev']['config_projection_error'] = 'fixture_kv_down'
    result = route._candidate_forward_promotion_closure(request, response)
    assert result['promoted_any'] is True  # Durable pointer must not be denied.
    assert result['complete'] is False
    assert result['errors_by_owner']['l4_alpha_ev'] == ['config_projection_incomplete']


@pytest.mark.parametrize('mutation', ['missing_commit', 'wrong_artifact', 'wrong_version', 'missing_checksum'])
def test_claimed_promotion_without_exact_commit_receipt_is_not_confirmed(mutation):
    request, response = request_and_response()
    outcome = response['outcomes']['l4_alpha_ev']
    if mutation == 'missing_commit':
        outcome.pop('pointer_commit')
    elif mutation == 'wrong_artifact':
        outcome['pointer_commit']['artifact_id'] = 'another'
    elif mutation == 'wrong_version':
        outcome['model_version'] = 'another'
    else:
        outcome['pointer_commit'].pop('payload_checksum')
    result = route._candidate_forward_promotion_closure(request, response)
    assert result['complete'] is False and result['promoted_any'] is False
    assert result['errors_by_owner']['l4_alpha_ev'] == ['pointer_commit_identity_unverified']


def test_exact_receipt_completes_without_changing_caller_payload():
    request, response = request_and_response()
    before = deepcopy((request, response))
    assert route._candidate_forward_promotion_closure(request, response)['complete'] is True
    assert (request, response) == before


def test_missing_projection_result_cannot_certify_full_closure():
    request, response = request_and_response()
    response['outcomes']['l4_alpha_ev'].pop('config_projection_error')
    result = route._candidate_forward_promotion_closure(request, response)
    assert result['promoted_any'] and not result['complete']
    assert result['errors_by_owner']['l4_alpha_ev'] == ['config_projection_receipt_missing']


@pytest.mark.parametrize('response', [
    {}, {'success': True}, {'success': True, 'mode': 'async'},
    {'success': True, 'result': 'opb_arm_prior_refresh status=validated owner=l4_alpha_ev promoted=0'},
    {'success': True, 'result': 'opb_arm_prior_refresh status=validated owner=allocator_ev_fusion promoted=1'},
    {'success': True, 'result': 'opb_arm_prior_refresh status=failed_validation owner=l4_alpha_ev promoted=1'},
])
def test_opb_refresh_rejects_unverified_transport_success(monkeypatch, response):
    from services import worker_config_client
    async def fetch(*_a, **_kw):
        return response
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    with pytest.raises(RuntimeError, match='opb_refresh_receipt_unverified'):
        asyncio.run(route._refresh_expected_return_opb('2026-09-09', 'l4_alpha_ev'))


def test_opb_refresh_accepts_only_actual_sync_owner_summary(monkeypatch):
    from services import worker_config_client
    calls = []
    async def fetch(path, **kw):
        calls.append((path, kw))
        return {'success': True, 'run_id': 'isolated',
            'result': registration_summary()}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(route._refresh_expected_return_opb('2026-09-09', 'l4_alpha_ev'))
    assert result['status'] == 'completed' and result['owner'] == 'l4_alpha_ev'
    assert result['completion_scope'] == 'candidate_registration' and result['promoted'] is False
    assert 'sync=1&date=2026-09-09&expected_return_owner=l4_alpha_ev' in calls[0][0]


@pytest.mark.parametrize('resolved', ['l4_alpha_ev', 'allocator_ev_fusion'])
def test_auto_opb_uses_verified_resolved_owner_not_requested_pointer(monkeypatch, resolved):
    from services import worker_config_client
    async def fetch(path, **kw):
        assert path.endswith('expected_return_owner=auto')
        return {'success': True, 'result':
                registration_summary(resolved)}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(route._refresh_expected_return_opb('2026-09-09', 'auto'))
    assert result['owner'] == resolved and result['status'] == 'completed'


@pytest.mark.parametrize('resolved', ['auto', 'unknown', '', 'formal_ml_buy_admission'])
def test_auto_does_not_accept_unresolved_or_non_ev_publication(monkeypatch, resolved):
    from services import worker_config_client
    async def fetch(*args, **kw):
        return {'success': True, 'result':
                registration_summary(resolved)}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    with pytest.raises(RuntimeError, match='receipt_unverified'):
        asyncio.run(route._refresh_expected_return_opb('2026-09-09', 'auto'))


@pytest.mark.parametrize('old,new', [
    ('registered=1', 'registered=0'), ('promoted=0', 'promoted=1'),
    ('date=2026-09-09', 'date=2026-09-08'), ('scope=candidate_registration', 'scope=publication'),
    ('promotion_owner=daily_nav', 'promotion_owner=offline'),
    ('checksum=' + 'a' * 64, 'checksum=missing'),
])
def test_candidate_summary_rejects_partial_or_stale_registration(monkeypatch, old, new):
    from services import worker_config_client
    async def fetch(*args, **kw):
        return {'success': True, 'result': registration_summary().replace(old, new)}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    with pytest.raises(RuntimeError, match='receipt_unverified'):
        asyncio.run(route._refresh_expected_return_opb('2026-09-09', 'auto'))
