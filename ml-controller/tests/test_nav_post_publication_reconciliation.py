"""Actual daily orchestration with transport fixtures, not numerical NAV proof.

Original Worker source/reconciliation proofs are also exercised through
test_nav_atomic_publication; these tests isolate publication ordering/retry.
"""
import asyncio
from copy import deepcopy

import pytest

from services.paired_nav_journal import digest
from test_nav_daily_adoption import entry
from test_nav_oof_job_independence import isolated_job, environment, local_policy

DAY = '2026-09-21'


def inventory():
    atomic = entry(owner='atomic_strategy', state='candidate')
    route = entry(owner='l15_route', state='candidate', token='b')
    for item in (atomic, route):
        item['payload']['evaluation_business_date'] = DAY
    atomic['payload']['policy_definition'] = {'replacement': {'candidateId': 'new', 'incumbentId': 'old'}}
    atomic['payload']['prospective_validation']['nav_validation']['decision_checksum'] = 'f' * 64
    route['payload']['policy_definition'] = {'challenger_version': 'fixture-route'}
    route['payload']['prospective_validation']['nav_validation']['decision_checksum'] = 'f' * 64
    return [atomic, route]


def atomic_reconciliation(request, changed=False):
    entries = [{**item, 'state': 'awaiting_current_source' if changed else 'candidate',
        'decision_checksum': 'f' * 64, 'context_checksum': 'c' * 64,
        'reason': 'route_publication_after_current_canonical' if changed else 'same_current_comparator'}
        for item in request['candidates']]
    return {'schema_version': 'strategy-atomic-nav-reconciliation-v1', 'complete': True, 'read_only': True,
        'owner': 'atomic_strategy', 'as_of_date': DAY, 'source': 'original_atomic_registry_policy_and_receipts',
        'request_checksum': digest(request), 'entries': entries, 'entries_checksum': digest(entries),
        'promotion_allowed': False, 'nav_maturity_credit': 0,
        **dict.fromkeys(['current_registry_checksum', 'canonical_source_checksum', 'canonical_policy_checksum',
            'route_dependency_checksum'], 'c' * 64), 'route_dependency_matches_canonical': not changed}


def route_reconciliation(request):
    entries = [{**row, 'state': 'candidate', 'reason': 'same_current_comparator',
        'decision_checksum': 'f' * 64, 'context_checksum': 'c' * 64} for row in request.get('candidates', [])]
    body = {'schema_version': 'strategy-route-nav-reconciliation-v1', 'complete': True, 'read_only': True,
        'owner': 'l15_route', 'business_date': DAY, 'source': 'original_route_head_and_canonical_selection',
        'request_checksum': digest(request), 'publication': None, 'promotion_allowed': False, 'nav_maturity_credit': 0,
        'entries': entries, 'entries_checksum': digest(entries)}
    return {**body, 'reconciliation_checksum': digest(body)}


def route_publication(payload):
    common = {'owner': 'l15_route', 'artifact_id': payload['artifact_id'], 'artifact_checksum': payload['artifact_checksum'],
        'publication_receipt_checksum': 'd' * 64}
    observation = {**common, 'schema_version': 'nav-canonical-screener-observation-v1',
        'published_at': DAY + 'T14:00:00Z', 'business_date': DAY,
        'source': 'original_canonical_screener', 'scope': 'canonical_l1_l15_selection',
        'status': 'not_observed', 'executed': False, 'reason': 'current_canonical_not_available',
        'read_only': True, 'promotion_allowed': False, 'nav_maturity_credit': 0, 'orders_executed_verified': False,
        **dict.fromkeys(['canonical_artifact_id', 'canonical_artifact_checksum', 'producer_run_id',
            'source_checksum', 'source_observed_at', 'baseline_checksum', 'policy_checksum'])}
    return {**common, 'complete': True, 'completion_scope': 'publication',
        'source': 'route_head_and_original_reader', 'pointer_committed': True, 'serving_readers_verified': True,
        'serving_activation_verified': False, 'serving': {'runId': 'route-original', 'routeVersion': 'fixture-route', 'routeFloor': None},
        'execution_observation': {**observation, 'observation_checksum': digest(observation)}}


def test_route_change_rechecks_atomic_in_same_run_instead_of_attempting_stale_publication(monkeypatch):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    candidates, calls = inventory(), []
    original = deepcopy(candidates)
    async def fetch(path, **kw):
        calls.append(path)
        if path.endswith('strategy-atomic/reconcile'):
            return atomic_reconciliation(kw['json_body'], changed=any(p.endswith('strategy-route/promote') for p in calls))
        if path.endswith('strategy-route/reconcile'):
            return route_reconciliation(kw['json_body'])
        if path.endswith('strategy-route/promote'):
            return route_publication(kw['json_body'])
        raise RuntimeError('stale_atomic_publication_must_not_be_attempted')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date=DAY))
    assert result['status'] == 'completed', result
    assert [p.rsplit('/', 2)[-2:] for p in calls] == [
        ['strategy-atomic', 'reconcile'], ['strategy-route', 'reconcile'],
        ['strategy-route', 'promote'], ['strategy-atomic', 'reconcile']]
    assert 'atomic' not in result
    assert result['waiting'] == [{'owner': 'atomic_strategy', 'artifact_id': candidates[0]['payload']['artifact_id'],
        'state': 'awaiting_current_source', 'reason': 'route_publication_after_current_canonical'}]
    assert result['atomic_post_route_reconciliation']['entries'][0]['state'] == 'awaiting_current_source'
    assert candidates == original


@pytest.mark.parametrize('fault', ['transport', 'checksum'])
def test_failed_post_route_read_cannot_be_treated_as_normal_wait(monkeypatch, fault):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    calls = []
    async def fetch(path, **kw):
        calls.append(path)
        if path.endswith('strategy-atomic/reconcile'):
            changed = any(p.endswith('strategy-route/promote') for p in calls)
            if changed and fault == 'transport':
                raise TimeoutError('fixture_read_failed')
            result = atomic_reconciliation(kw['json_body'], changed)
            if changed: result['entries_checksum'] = '0' * 64
            return result
        if path.endswith('strategy-route/reconcile'): return route_reconciliation(kw['json_body'])
        if path.endswith('strategy-route/promote'): return route_publication(kw['json_body'])
        raise RuntimeError('must_not_attempt_atomic')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=inventory(), business_date=DAY))
    assert result['status'] == 'incomplete'
    assert result['stage'] == 'atomic_post_route_reconciliation'
    assert result['route']['complete']
    assert result['waiting'] == []


def test_unchanged_comparator_after_route_read_does_not_create_artificial_wait(monkeypatch):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    calls = []
    async def fetch(path, **kw):
        calls.append(path)
        if path.endswith('strategy-atomic/reconcile'): return atomic_reconciliation(kw['json_body'])
        if path.endswith('strategy-route/reconcile'): return route_reconciliation(kw['json_body'])
        if path.endswith('strategy-route/promote'): return route_publication(kw['json_body'])
        assert path.endswith('strategy-atomic/promote')
        return {'owner': 'atomic_strategy', 'complete': True, 'completion_scope': 'publication',
            'source': 'original_registry_and_policy_reader', 'artifact_id': kw['json_body']['artifact_id'],
            'artifact_checksum': kw['json_body']['artifact_checksum'], 'pointer_committed': True,
            'serving_readers_verified': True, 'publication_receipt_checksum': 'd' * 64,
            'policy': {'checksum': 'e' * 64, 'created_at': DAY + 'T14:00:00Z',
                'knowledge_cutoff_date': DAY, 'weights': {'old': 0, 'new': 1}}}
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=inventory(), business_date=DAY))
    assert result['status'] == 'completed' and result['waiting'] == []
    assert result['atomic']['complete']
    assert len([path for path in calls if path.endswith('strategy-atomic/reconcile')]) == 2


@pytest.mark.parametrize('broken_read', [False, True])
def test_job_callback_preserves_expected_wait_but_retries_read_failure(isolated_job, monkeypatch, broken_read):
    import oof_materialize_job_main as job
    from services import worker_config_client
    _, _, callbacks, _, routes = isolated_job
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: {
        'status': 'up_to_date', 'as_of_date': DAY, '_adoption_candidates': inventory()})
    calls = []
    async def fetch(path, **kw):
        calls.append(path)
        if path.endswith('strategy-atomic/reconcile'):
            changed = any(p.endswith('strategy-route/promote') for p in calls)
            if changed and broken_read: raise TimeoutError('fixture_read_unavailable')
            return atomic_reconciliation(kw['json_body'], changed)
        if path.endswith('strategy-route/reconcile'): return route_reconciliation(kw['json_body'])
        if path.endswith('strategy-route/promote'): return route_publication(kw['json_body'])
        pytest.fail('stale Atomic must not publish')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    assert asyncio.run(job._run()) == 0
    assert routes and routes[0].promote is False
    assert callbacks[-1]['status'] == ('triggered' if broken_read else 'success')
    assert 'nav_committed=l15_route' in callbacks[-1]['summary']
    adoption = callbacks[-1]['metadata']['paired_nav_maturity']['adoption']
    assert adoption['status'] == ('incomplete' if broken_read else 'completed')
    if broken_read:
        assert adoption['stage'] == 'atomic_post_route_reconciliation'
    else:
        assert adoption['waiting'][0]['reason'] == 'route_publication_after_current_canonical'
        assert adoption['atomic_post_route_reconciliation']['route_dependency_matches_canonical'] is False
        assert 'nav_waiting=atomic_strategy:awaiting_current_source' in callbacks[-1]['summary']


@pytest.mark.parametrize('owner,key', [('ensemble', 'ensemble'), ('l15_route', 'route'),
    ('atomic_strategy', 'atomic'), ('opb_arm_prior', 'opb')])
@pytest.mark.parametrize('verified', [False, True])
def test_summary_counts_only_verified_non_ev_publications(owner, key, verified):
    import oof_materialize_job_main as job
    result = {'status': 'shadow_evaluated', 'paired_nav_maturity': {'adoption': {
        'status': 'completed' if verified else 'incomplete', key: {'owner': owner,
            'complete': verified, 'completion_scope': 'publication', 'pointer_committed': True}, 'waiting': []}}}
    summary = job._summary('fixture', result, mode='oof_lifecycle')
    assert 'nav_committed=' + (owner if verified else 'none') in summary


@pytest.mark.parametrize('owner', ['ensemble', 'l4_alpha_ev', 'opb_arm_prior'])
@pytest.mark.parametrize('fault', [None, 'transport', 'checksum', 'decision_swap'])
def test_atomic_rechecks_upstream_without_route_publication(monkeypatch, owner, fault):
    from services import paired_nav_daily_adoption as adoption, worker_config_client
    from test_nav_daily_adoption import acknowledged, publication_response
    from test_nav_adoption_closure import registration_summary
    atomic = inventory()[0]
    upstream = entry(owner=owner, state='candidate' if owner == 'ensemble' else 'shadowing', token='e')
    switched, calls = False, []
    async def ensemble(payload, day):
        nonlocal switched
        switched = True
        return {'complete': True, 'owner': 'ensemble', 'pointer_committed': True, 'completion_scope': 'publication'}
    async def fetch(path, **kw):
        nonlocal switched
        calls.append(path)
        if path.endswith('strategy-atomic/reconcile'):
            if switched and fault == 'transport':
                raise TimeoutError('isolated-read-failed')
            result = atomic_reconciliation(kw['json_body'])
            if switched:
                for row in result['entries']:
                    row.update(state='baseline_changed', reason='ml_baseline_changed' if owner == 'ensemble' else 'configuration_changed')
                result['entries_checksum'] = digest(result['entries'])
                if fault == 'checksum': result['entries_checksum'] = '0' * 64
                if fault == 'decision_swap':
                    result['entries'][0]['decision_checksum'] = '0' * 64
                    result['entries_checksum'] = digest(result['entries'])
            return result
        if path.endswith('expected-return/promote'):
            switched = True
            return acknowledged(kw['json_body'])
        if path.endswith('opb/promote'):
            switched = True
            return publication_response(kw['json_body'], 'awaiting_next_allocation')
        if '/api/admin/trigger/opb-arm-prior-refresh' in path:
            return {'success': True, 'result': registration_summary()}
        raise RuntimeError('stale_atomic_must_not_reach_publisher')
    monkeypatch.setattr(adoption, 'adopt_daily_ensemble', ensemble)
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    before = deepcopy([upstream, atomic])
    result = asyncio.run(adoption.run_daily_ev_adoption(candidates=[upstream, atomic], business_date=DAY))
    assert calls.count('/api/admin/config/strategy-atomic/reconcile') == 2, result
    assert not any(path.endswith('strategy-atomic/promote') for path in calls)
    assert result['status'] == ('incomplete' if fault else 'completed'), result
    if fault:
        assert result['stage'] == 'atomic_post_dependency_reconciliation'
    else:
        assert result['waiting'][0]['state'] == 'baseline_changed'
        assert 'atomic_strategy' not in result['requested_artifacts']
    assert [upstream, atomic] == before


def test_atomic_already_changed_baseline_reports_wait_on_first_read(monkeypatch):
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    calls = []
    async def fetch(path, **kw):
        calls.append(path)
        assert path.endswith('strategy-atomic/reconcile')
        return atomic_reconciliation(kw['json_body'], changed=True)
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(run_daily_ev_adoption(candidates=inventory()[:1], business_date=DAY))
    assert result['status'] == 'no_adoption_due' and len(calls) == 1
    assert result['waiting'][0]['state'] == 'awaiting_current_source'
    import oof_materialize_job_main as job
    assert job._nav_callback_summary({'adoption': result})['adoption']['waiting'] == result['waiting']


@pytest.mark.parametrize('owner', ['ensemble', 'l4_alpha_ev', 'opb_arm_prior'])
@pytest.mark.parametrize('corrupt', [False, True])
def test_route_rechecks_after_earlier_owner_and_never_hides_invalid_response(monkeypatch, owner, corrupt):
    from services import paired_nav_daily_adoption as adoption, worker_config_client
    from test_nav_daily_adoption import acknowledged, publication_response
    from test_nav_adoption_closure import registration_summary
    route = inventory()[1]
    upstream = entry(owner=owner, state='candidate' if owner == 'ensemble' else 'shadowing', token='e')
    switched, calls = False, []
    async def ensemble(payload, day):
        nonlocal switched
        switched = True
        return {'complete': True, 'owner': 'ensemble', 'pointer_committed': True, 'completion_scope': 'publication'}
    async def fetch(path, **kw):
        nonlocal switched
        calls.append(path)
        if path.endswith('strategy-route/reconcile'):
            result = route_reconciliation(kw['json_body'])
            if switched:
                for row in result['entries']:
                    row.update(state='baseline_changed', reason='ml_baseline_changed' if owner == 'ensemble' else 'configuration_changed')
                result['entries_checksum'] = digest(result['entries'])
                result['reconciliation_checksum'] = digest({k: v for k, v in result.items() if k != 'reconciliation_checksum'})
                if corrupt: result['entries_checksum'] = '0' * 64
            return result
        if path.endswith('expected-return/promote'):
            switched = True
            return acknowledged(kw['json_body'])
        if path.endswith('opb/promote'):
            switched = True
            return publication_response(kw['json_body'], 'awaiting_next_allocation')
        if '/api/admin/trigger/opb-arm-prior-refresh' in path:
            return {'success': True, 'result': registration_summary()}
        pytest.fail('stale Route must not reach publisher')
    monkeypatch.setattr(adoption, 'adopt_daily_ensemble', ensemble)
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
    result = asyncio.run(adoption.run_daily_ev_adoption(candidates=[upstream, route], business_date=DAY))
    assert result['status'] == ('incomplete' if corrupt else 'completed'), result
    assert calls.count('/api/admin/config/strategy-route/reconcile') == 2
    if corrupt:
        assert result['stage'] == 'route_post_dependency_reconciliation'
        assert result['waiting'] == []
    else:
        assert 'route' not in result and 'l15_route' not in result['requested_artifacts']
        assert result['waiting'][0]['state'] == 'baseline_changed'
        assert result['route_post_dependency_reconciliation']['entries'][0]['reason'] == result['waiting'][0]['reason']
