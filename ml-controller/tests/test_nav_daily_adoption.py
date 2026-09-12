"""Transport/ordering contracts; fixture PASS here is NOT statistical evidence.

Original NAV numerical support and cross-language receipts are exercised by
test_nav_candidate_decision. No network, production pointers or retraining.
"""
import asyncio
from copy import deepcopy

import pytest

import oof_materialize_job_main as job
from test_nav_oof_job_independence import isolated_job, environment, local_policy


def entry(owner='l4_alpha_ev', state='shadowing', decision='PASS', day='2026-08-25', token='a'):
    checksum = token * 64
    return {'registry_state': state, 'payload': {
        'artifact_id': f'{owner}:fixture:{checksum}', 'artifact_checksum': checksum,
        'artifact': {'model_version': 'fixture'}, 'source_run_date': day,
        'prospective_validation': {'decision': decision, 'nav_validation': {'baseline_checksum': 'a' * 64}},
    }, 'owner': owner}


@pytest.mark.parametrize('owners,expected', [
    (['l4_alpha_ev'], 180), (['l4_alpha_ev', 'allocator_ev_fusion'], 300),
    (['opb_arm_prior'], 360), (['l15_route'], 180), (['atomic_strategy'], 240),
])
def test_actual_dispatch_budget_covers_nested_verification_and_timeout_is_not_closure(monkeypatch, owners, expected):
    import httpx
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    candidates = [entry(owner=owner, state='candidate' if owner in {'l15_route','atomic_strategy'} else 'shadowing')
                  for owner in owners]
    for candidate in candidates:
        candidate['payload']['evaluation_business_date'] = '2026-09-09'
    calls = []
    async def fetch(path, **kwargs):
        calls.append((path, kwargs['timeout']))
        raise httpx.ReadTimeout('isolated transport deadline')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date='2026-09-09'))
    assert len(calls) == 1 and calls[0][1] == expected
    assert result['status'] == 'incomplete' and result['error_type'] == 'ReadTimeout'
    assert result['training_dispatched'] is False


@pytest.mark.parametrize('decision,expected', [('PASS', 'incomplete'), ('HOLD', 'no_adoption_due'), ('PENDING', 'no_adoption_due')])
def test_l3_real_candidate_state_is_not_silently_erased_from_adoption(decision, expected):
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    result = asyncio.run(run_daily_ev_adoption(candidates=[entry(owner='ensemble', state='candidate', decision=decision)],
        business_date='2026-09-09'))
    assert result['status'] == expected
    if decision == 'PASS':
        assert result['stage'] == 'ensemble_publication'
        assert result['error_type'] == 'KeyError'  # Deliberately incomplete fixture, no external I/O.


def acknowledged(payload, error=None):
    return {'effective_owner': 'allocator_ev_fusion' if 'allocator_ev_fusion' in payload else 'l4_alpha_ev',
        'outcomes': {owner: {'promoted': True,
        'model_version': p['artifact']['model_version'],
        'pointer_commit': {'artifact_id': p['artifact_id'], 'payload_checksum': 'd' * 64,
                           'nav_review_date': '2026-09-09'},
        'config_projection_error': error} for owner, p in payload.items()}}


def test_daily_actual_adoption_finishes_before_failed_oof_and_is_not_repeated(monkeypatch):
    from services import worker_config_client
    events = []
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: {
        'status': 'up_to_date', 'as_of_date': '2026-09-09', '_adoption_candidates': [entry()]})
    async def fetch(path, **kwargs):
        if path.endswith('/promote'):
            events.append('adopt')
            return acknowledged(kwargs['json_body'])
        events.append('register_opb')
        from test_nav_adoption_closure import registration_summary
        return {'success': True, 'result': registration_summary()}
    async def oof(**kwargs):
        events.append('oof')
        assert kwargs['promote'] is False
        raise RuntimeError('fixture_oof_failed_after_nav')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    monkeypatch.setattr(job, '_execute_oof_lifecycle', oof)
    result = asyncio.run(job._execute_lifecycle(cadence='daily', end_date='2026-09-09', promote=True,
        dispatch_full_fit=False, expected_cohort_id=None, continuation_attempt=0, continuation_only=False))
    assert events == ['adopt', 'register_opb', 'oof']  # Registration is not OPB promotion.
    assert result['status'] == 'failed'
    assert result['paired_nav_maturity']['adoption']['status'] == 'completed'
    assert result['nav_retry_required'] is False
    assert '_adoption_candidates' not in result['paired_nav_maturity']


def test_real_hold_daily_gate_does_not_dispatch_or_leave_late_promotion(isolated_job, monkeypatch):
    from services import worker_config_client
    _, _, callbacks, _, routes = isolated_job
    async def forbidden(*args, **kwargs):
        pytest.fail('original two-session HOLD must not attempt adoption')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    assert asyncio.run(job._run()) == 0
    assert routes and routes[0].promote is False
    nav = callbacks[-1]['metadata']['paired_nav_maturity']
    assert nav['adoption']['status'] == 'no_adoption_due'
    assert callbacks[-1]['status'] == 'success'


@pytest.mark.parametrize('failure', ['projection', 'transport', 'opb'])
def test_daily_adoption_failures_use_existing_continuation_without_hiding_healthy_oof(monkeypatch, failure):
    from services import worker_config_client
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: {
        'status': 'up_to_date', 'as_of_date': '2026-09-09', '_adoption_candidates':
            [entry(), entry(owner='opb_arm_prior')] if failure == 'opb' else [entry()]})
    async def fetch(path, **kwargs):
        if path == '/api/admin/config/expected-return/promote':
            if failure == 'transport': raise RuntimeError('fixture_transport_unavailable')
            return acknowledged(kwargs['json_body'], 'fixture_projection' if failure == 'projection' else None)
        if '/api/admin/trigger/opb-arm-prior-refresh' in path:
            from test_nav_adoption_closure import registration_summary
            return {'success': True, 'result': registration_summary()}
        return {'success': True, 'mode': 'async'}
    async def oof(**kwargs):
        assert kwargs['promote'] is False
        return {'status': 'idempotent_complete'}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    monkeypatch.setattr(job, '_execute_oof_lifecycle', oof)
    result = asyncio.run(job._execute_lifecycle(cadence='daily', end_date='2026-09-09', promote=True,
        dispatch_full_fit=False, expected_cohort_id=None, continuation_attempt=0, continuation_only=True))
    assert result['status'] == 'pending'
    assert result['oof_lifecycle_status'] == 'idempotent_complete'
    assert result['nav_retry_required'] is True and result['dependency_retry_required'] is True
    assert result['paired_nav_maturity']['adoption']['status'] == 'incomplete'
    assert result['paired_nav_maturity']['accounting_status'] == 'up_to_date'


def test_frozen_ready_inventory_is_not_latest_n_or_highest_return():
    from services.paired_nav_daily_adoption import select_daily_adoption_requests
    oldest = entry(day='2026-08-25')
    later = [entry(day='2026-08-30') for i in range(90)]
    for i, item in enumerate(later):
        item['payload']['artifact_checksum'] = f'{i:064x}'
        item['payload']['artifact_id'] = f'l4_alpha_ev:fixture:{i:064x}'
    # Only identity and source order participate, never observed return values.
    oldest['payload']['prospective_validation']['mean_return'] = -1
    requested, waiting = select_daily_adoption_requests(later + [oldest, entry(state='archived', day='2026-08-01')])
    assert requested['l4_alpha_ev'] == oldest['payload'] and not waiting
    assert select_daily_adoption_requests([entry(state='retired')])[0] == {}


@pytest.mark.parametrize('state,decision', [('offline_failed', 'PASS'), ('production', 'HOLD')])
def test_unconnected_ready_owner_is_not_silent_no_adoption_due(monkeypatch, state, decision):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    async def forbidden(*_a, **_kw):
        pytest.fail('an unsupported publisher must not write generic config or invent authority')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    result = asyncio.run(run_daily_ev_adoption(candidates=[entry(owner='future_owner',
        state=state, decision=decision)], business_date='2026-09-09'))
    assert result['status'] == 'incomplete'
    assert result['reason'] == 'nav_adoption_owner_unhandled'
    assert result['unhandled_ready_candidates'][0]['owner'] == 'future_owner'


def test_production_hold_requests_recovery_and_exact_fusion_dependency_is_preserved():
    from services.paired_nav_daily_adoption import select_daily_adoption_requests
    production = entry(state='production', decision='HOLD')
    assert select_daily_adoption_requests([production])[0]['l4_alpha_ev'] == production['payload']
    with pytest.raises(ValueError, match='multiple_production'):
        select_daily_adoption_requests([production, deepcopy(production)])
    fusion = entry(owner='allocator_ev_fusion', token='c')
    requested, waiting = select_daily_adoption_requests([entry(token='b'), fusion])
    assert set(requested) == {'l4_alpha_ev'} and waiting[0]['reason'] == 'exact_l4_dependency_not_selected'
    requested, waiting = select_daily_adoption_requests([entry(token='a'), fusion])
    assert set(requested) == {'l4_alpha_ev', 'allocator_ev_fusion'} and not waiting


def test_ev_adoption_does_not_create_and_immediately_promote_a_new_opb(monkeypatch):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    # Both pointers can be committed while old Fusion is no longer serving.
    candidates = [entry(token='b'), entry(owner='allocator_ev_fusion',
                    token='c', state='production', decision='HOLD')]
    async def fetch(path, **kw):
        if path.endswith('/promote'):
            assert set(kw['json_body']) == {'l4_alpha_ev', 'allocator_ev_fusion'}
            return acknowledged(kw['json_body'])
        assert '/api/admin/trigger/opb-arm-prior-refresh' in path
        from test_nav_adoption_closure import registration_summary
        return {'success': True, 'result': registration_summary('allocator_ev_fusion')}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date='2026-09-09'))
    assert result['status'] == 'completed'
    assert result['opb']['status'] == 'no_adoption_due'
    assert result['opb_candidate_registration']['completion_scope'] == 'candidate_registration'


@pytest.mark.parametrize('fault', ['transport', 'async_ack', 'wrong_date'])
def test_registration_failure_uses_daily_continuation_not_skipped(isolated_job, monkeypatch, fault):
    from services import worker_config_client
    from test_nav_adoption_closure import registration_summary
    _, _, callbacks, _, _ = isolated_job
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: {
        'status': 'up_to_date', 'as_of_date': '2026-09-09', '_adoption_candidates': [entry()]})
    async def fetch(path, **kw):
        if path.endswith('/promote'):
            return acknowledged(kw['json_body'])
        if fault == 'transport': raise TimeoutError('fixture_registration_unavailable')
        if fault == 'async_ack': return {'success': True, 'mode': 'async'}
        return {'success': True, 'result': registration_summary().replace('date=2026-09-09','date=2026-09-10')}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'triggered'
    nav = callbacks[-1]['metadata']['paired_nav_maturity']
    assert nav['adoption']['status'] == 'incomplete'
    assert nav['adoption']['stage'] == 'opb_candidate_registration'
    assert nav['accounting_status'] == 'up_to_date'


def test_late_registration_retry_uses_original_committed_date_and_effective_owner(monkeypatch):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    from test_nav_adoption_closure import registration_summary
    candidate = entry(state='production', decision='HOLD')
    calls = []
    async def fetch(path, **kw):
        calls.append(path)
        if path.endswith('/promote'):
            return acknowledged(kw['json_body'])
        assert 'date=2026-09-09&expected_return_owner=l4_alpha_ev' in path
        return {'success': True, 'result': registration_summary()}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=[candidate], business_date='2026-09-10'))
    assert result['status'] == 'completed'
    assert result['opb']['status'] == 'no_adoption_due'
    assert len(calls) == 2


@pytest.mark.parametrize('state,decision', [('offline_failed', 'PASS'), ('production', 'HOLD')])
def test_opb_uses_its_verified_route_and_cannot_treat_publication_as_control(monkeypatch, state, decision):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    candidate = entry(owner='opb_arm_prior', state=state, decision=decision)
    calls = []
    async def fetch(path, **kw):
        calls.append(path)
        assert path == '/api/admin/config/opb/promote'
        assert kw['json_body'] == candidate['payload']
        return {'owner': 'opb_arm_prior', 'artifact_id': candidate['payload']['artifact_id'],
            'artifact_checksum': candidate['payload']['artifact_checksum'],
            'pointer_committed': True, 'config_projection_verified': True,
            'control_activation_verified': False, 'success': False, 'status': 'incomplete',
            'reason': 'opb_nav_control_activation_unverified', 'publication_receipt_checksum': 'd' * 64}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=[candidate], business_date='2026-09-09'))
    assert calls == ['/api/admin/config/opb/promote']
    assert result['status'] == 'incomplete'
    assert result['reason'] == 'nav_opb_adoption_incomplete'
    assert result['opb']['pointer_committed'] is True
    assert result['opb']['control_activation_verified'] is False


def test_opb_hold_without_existing_commit_is_normal_observation(monkeypatch):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    async def forbidden(*_a, **_kw):
        pytest.fail('Unqualified candidate must neither promote nor rebuild')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    result = asyncio.run(run_daily_ev_adoption(candidates=[entry(owner='opb_arm_prior',
        state='offline_failed', decision='HOLD')], business_date='2026-09-09'))
    assert result['status'] == 'no_adoption_due'


@pytest.mark.parametrize('fault', ['missing_owner', 'wrong_owner', 'missing_date', 'invalid_date', 'future_date'])
def test_registration_cannot_guess_adoption_owner_or_original_event_date(monkeypatch, fault):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    calls = []
    async def response(path, **kw):
        calls.append(path)
        assert path == '/api/admin/config/expected-return/promote'
        result = acknowledged(kw['json_body'])
        if fault == 'missing_owner': result.pop('effective_owner')
        elif fault == 'wrong_owner': result['effective_owner'] = 'unverified'
        else:
            result['outcomes']['l4_alpha_ev']['pointer_commit']['nav_review_date'] = {
                'missing_date': None, 'invalid_date': '2026-02-30', 'future_date': '2026-09-11'}[fault]
        return result
    monkeypatch.setattr(worker_config_client, 'worker_fetch', response)
    result = asyncio.run(run_daily_ev_adoption(candidates=[entry()], business_date='2026-09-09'))
    assert result['status'] == 'incomplete' and result['stage'] == 'opb_candidate_registration'
    assert len(calls) == 1


def publication_response(payload, state):
    """Transport fixture only; real seals are tested through original Hono."""
    common = {'owner': 'opb_arm_prior', 'artifact_id': payload['artifact_id'],
        'artifact_checksum': payload['artifact_checksum'], 'publication_receipt_checksum': 'd' * 64}
    control = {**common, 'published_at': '2026-09-09T05:00:00Z', 'can_write_order': False,
        'status': state, 'control_executed': state == 'completed', 'reason': None,
        'snapshot_id': 'e' * 64, 'payload_checksum': 'f' * 64, 'frozen_at': '2026-09-09T06:00:00Z'}
    if state == 'awaiting_next_allocation':
        control.update(reason='publication_precedes_next_allocation', snapshot_id=None, payload_checksum=None)
    elif state == 'not_applicable':
        control['reason'] = 'no_enabled_eligible_allocation'
    elif state == 'failed':
        control['reason'] = 'paired_nav_opb_control_execution_incomplete'
    return {**common, 'schema_version': 'opb-nav-adoption-receipt-v1', 'completion_scope': 'publication',
        'pointer_committed': True, 'config_projection_verified': True,
        'control_activation_verified': state == 'completed', 'control': control,
        'success': state != 'failed', 'status': 'incomplete' if state == 'failed' else 'completed'}


@pytest.mark.parametrize('state', ['awaiting_next_allocation', 'completed', 'not_applicable', 'failed'])
def test_actual_job_callback_distinguishes_published_wait_from_execution_failure(isolated_job, monkeypatch, state):
    from services import worker_config_client
    _, _, callbacks, _, _ = isolated_job
    candidate = entry(owner='opb_arm_prior')
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: {
        'status': 'up_to_date', 'as_of_date': '2026-09-09', '_adoption_candidates': [candidate]})
    async def response(path, **kw):
        assert path == '/api/admin/config/opb/promote'
        assert kw['json_body'] == candidate['payload']
        return publication_response(candidate['payload'], state)
    monkeypatch.setattr(worker_config_client, 'worker_fetch', response)
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == ('triggered' if state == 'failed' else 'success')
    adoption = callbacks[-1]['metadata']['paired_nav_maturity']['adoption']
    assert adoption['status'] == ('incomplete' if state == 'failed' else 'completed')
    assert adoption['opb']['control']['status'] == state
    assert adoption['opb']['control_activation_verified'] is (state == 'completed')


@pytest.mark.parametrize('fault', ['missing_schema', 'bad_scope', 'fake_activation', 'missing_seal', 'bad_clock', 'mixed_identity'])
def test_new_receipt_cannot_turn_missing_or_inconsistent_evidence_into_normal_wait(fault):
    from services.paired_nav_daily_adoption import opb_adoption_receipt
    payload = entry(owner='opb_arm_prior')['payload']
    response = publication_response(payload, 'completed')
    if fault == 'missing_schema': response.pop('schema_version')
    if fault == 'bad_scope': response['completion_scope'] = 'all_trading_completed'
    if fault == 'fake_activation': response['control_activation_verified'] = False
    if fault == 'missing_seal': response['control']['snapshot_id'] = None
    if fault == 'bad_clock': response['control']['published_at'] = '2026-09-09T05:00:00'
    if fault == 'mixed_identity': response['control']['artifact_checksum'] = '0' * 64
    assert opb_adoption_receipt(payload, response)['complete'] is False


@pytest.mark.parametrize('attempt,expected_exit,expected_status', [(0, 0, 'triggered'), (12, 1, 'error')])
def test_adoption_failure_reaches_actual_job_callback_and_retry_exhaustion(isolated_job, monkeypatch,
                                                                         attempt, expected_exit, expected_status):
    from services import worker_config_client
    _, _, callbacks, _, _ = isolated_job
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    monkeypatch.setenv('OOF_MATERIALIZE_CONTINUATION_ATTEMPT', str(attempt))
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: {
        'status': 'up_to_date', 'as_of_date': '2026-09-09', '_adoption_candidates': [entry()]})
    async def incomplete(*args, **kwargs):
        return {'success': True}  # transport ACK is deliberately insufficient
    monkeypatch.setattr(worker_config_client, 'worker_fetch', incomplete)
    assert asyncio.run(job._run()) == expected_exit
    assert callbacks[-1]['status'] == expected_status
    nav = callbacks[-1]['metadata']['paired_nav_maturity']
    assert nav['adoption']['status'] == 'incomplete'
    assert 'payload' not in str(nav)
