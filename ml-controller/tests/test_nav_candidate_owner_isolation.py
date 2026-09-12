"""Original daily job: one discovery failure must not starve other projections.

Original private NAV evidence; only the failing inventory read is injected.
No new gate, synthetic statistical PASS, network or production writes.
"""
import asyncio

import pytest

import oof_materialize_job_main as job
from services import paired_nav_daily_candidates as ev
from services import paired_nav_opb_daily as opb
from services import paired_nav_l3_daily as l3
from services import paired_nav_policy_daily as policies
from test_nav_oof_job_independence import isolated_job, environment, local_policy


OWNERS = (
    ('candidate_decisions', ev, 'refresh_registered_ev_nav_decisions', 'frozen_candidate_inventory'),
    ('opb_candidate_decisions', opb, 'refresh_registered_opb_nav_decisions', 'frozen_opb_inventory'),
    ('l3_candidate_decisions', l3, 'refresh_registered_l3_nav_decisions', 'frozen_l3_inventory'),
    ('atomic_candidate_decisions', policies, 'refresh_registered_atomic_nav_decisions', 'frozen_policy_inventory'),
    ('route_candidate_decisions', policies, 'refresh_registered_route_nav_decisions', 'frozen_policy_inventory'),
)


@pytest.mark.parametrize('broken', [row[0] for row in OWNERS])
@pytest.mark.parametrize('phase', ['inventory', 'after_projection'])
def test_discovery_failure_retains_each_owner_outcome_and_retries_without_readopting(isolated_job, monkeypatch, broken, phase):
    from services import worker_config_client, paired_nav_review_store as store
    db, _, callbacks, _, routes = isolated_job
    called = []
    failing = True
    def track(key, original):
        def run(**kwargs):
            called.append(key)
            result = original(**kwargs)
            if failing and key == broken and phase == 'after_projection':
                raise RuntimeError('fixture_projection_reply_lost')
            return result
        return run
    for key, module, method, inventory in OWNERS:
        monkeypatch.setattr(module, method, track(key, getattr(module, method)))
        if key == broken and phase == 'inventory':
            original_inventory = getattr(module, inventory)
            broken_module, broken_inventory = module, inventory
            def fail_inventory(_original=original_inventory,
                               _owner={'atomic_candidate_decisions': 'atomic_strategy',
                                       'route_candidate_decisions': 'l15_route'}.get(key), **kwargs):
                if _owner is not None and kwargs.get('owner') != _owner:
                    return _original(**kwargs)
                raise RuntimeError('fixture_inventory_unavailable')
            monkeypatch.setattr(module, inventory, fail_inventory)
    async def forbidden(*args, **kwargs):
        pytest.fail('an incomplete NAV job or original HOLD cannot publish')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    assert asyncio.run(job._run()) == 0
    assert called == [row[0] for row in OWNERS]
    callback = callbacks[-1]
    assert callback['status'] == 'triggered'
    nav = callback['metadata']['paired_nav_maturity']
    assert nav['status'] == 'failed' and nav['accounting_status'] == 'up_to_date'
    assert nav['adoption']['status'] == 'blocked_by_nav_failure'
    for key, *_ in OWNERS:
        part = nav[key]
        assert part['as_of_date'] == '2026-09-09'
        if key == broken:
            assert part['status'] == 'partial_nav_candidate_decisions'
            assert part['candidate_count'] is None and part['evaluated_count'] is None
            assert part['inventory_checksum'] is None and part['decisions_checksum'] is None
            assert part['registry_state_unchanged'] is None and part['promotion_allowed'] is False
            assert part['failure_count'] == 1
            assert part['failures'][0]['component'] == key
            assert part['failures'][0]['error_type'] == 'RuntimeError'
            assert part['failures'][0]['reason'] == 'nav_candidate_projection_incomplete'
        else:
            assert part['status'] == 'nav_candidate_decisions_current' and not part['failures']
    assert len(routes) == 1 and routes[0].promote is False
    headers = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert headers
    failing = False
    if phase == 'inventory':
        monkeypatch.setattr(broken_module, broken_inventory, original_inventory)
    called.clear()
    assert asyncio.run(job._run()) == 0
    assert called == [row[0] for row in OWNERS]
    assert callbacks[-1]['status'] == 'success'
    assert callbacks[-1]['metadata']['nav_retry_required'] is False
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == headers
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == journals


@pytest.mark.parametrize('exhaust_readiness', [False, True])
def test_original_nav_recovery_callbacks_close_the_same_admitted_root(isolated_job, monkeypatch, tmp_path, exhaust_readiness):
    import json
    import os
    from pathlib import Path
    import subprocess
    from types import SimpleNamespace
    from routers import walk_forward
    from services import cloud_run_jobs_client
    from services import paired_nav_review_store as store, worker_config_client
    db, client, callbacks, _, _ = isolated_job
    child_env = dict(os.environ)
    child_env.pop('NODE_TEST_CONTEXT', None)
    def native(mode, *args):
        result = subprocess.run(['node', '--import', 'tsx', 'tests/navCallbackRootProjection.ts',
            str(tmp_path), mode, *args], cwd=Path(__file__).parents[2] / 'worker', env=child_env,
            capture_output=True, text=True, encoding='utf-8', timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout
    identity, = [json.loads(line.removeprefix('NAV_ROOT_IDENTITY=')) for line in native('prepare').splitlines()
        if line.startswith('NAV_ROOT_IDENTITY=')]
    dispatched = []
    class PrivateCloudJob:
        def __init__(self, **kwargs):
            pass
        def run_job(self, *, env_overrides):
            dispatched.append(dict(env_overrides))
            return SimpleNamespace(execution_id='isolated-job', execution_name='isolated-job')
    def dispatch(request):
        with monkeypatch.context() as scoped:
            scoped.setattr(cloud_run_jobs_client, 'CloudRunJobsClient', PrivateCloudJob)
            scoped.delenv('OOF_MATERIALIZE_JOB_EXECUTION', raising=False)
            response = asyncio.run(client.original_oof_lifecycle(walk_forward.OofLifecycleRequest(**request)))
        assert response['status'] == 'spawned'
        assert dispatched[-1]['OOF_MATERIALIZE_RUN_ID'] == identity['callback_run_id']
        for key, value in dispatched[-1].items():
            monkeypatch.setenv(key, value)
        return response
    initial_request = {'cadence': 'daily', 'end_date': '2026-09-09', 'dry_run': False,
        'promote': True, 'dispatch_full_fit': True,
        'scheduler_ticket_id': identity['ticket_id'], 'scheduler_run_id': identity['run_id']}
    dispatch(initial_request)
    async def no_unqualified_publication(*args, **kwargs):
        pytest.fail('original immature NAV must not publish or make external requests')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', no_unqualified_publication)
    journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    def unavailable_review(statements):
        if store.RECORDS in statements[0][0]:
            raise RuntimeError('fixture_review_store_down')
        return db.writer(statements)
    client.atomic_batch_execute = unavailable_review
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'triggered'
    client.atomic_batch_execute = db.writer
    continuation_request = {**initial_request, 'expected_cohort_id': callbacks[-1]['metadata']['cohort_id'],
        'continuation_attempt': 1, 'continuation_only': True}
    continuation_dispatch = dispatch(continuation_request)
    if exhaust_readiness:
        monkeypatch.setenv('OOF_MATERIALIZE_CONTINUATION_ATTEMPT', '12')
    assert asyncio.run(job._run()) == 0
    headers = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert headers and callbacks[-1]['status'] == 'success'
    assert callbacks[-1]['metadata']['paired_nav_maturity']['adoption']['status'] == 'no_adoption_due'
    assert asyncio.run(job._run()) == 0
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == headers
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == journals
    source = tmp_path / 'original-nav-recovery-callbacks.json'
    source.write_text(json.dumps({'identity': identity, 'callbacks': callbacks,
        'exhaust_readiness': exhaust_readiness, 'continuation_request': continuation_request,
        'continuation_dispatch': continuation_dispatch}), encoding='utf-8')
    results = [json.loads(line.removeprefix('NAV_ROOT_RESULT=')) for line in native('verify', str(source)).splitlines()
        if line.startswith('NAV_ROOT_RESULT=')]
    assert len(results) == 1 and results[0]['root_status'] == ('error' if exhaust_readiness else 'success')
    assert results[0]['production_effect'] is False


def test_original_failed_job_callbacks_reach_worker_continuation(isolated_job, monkeypatch, tmp_path):
    import json
    import os
    from pathlib import Path
    import subprocess
    _, _, callbacks, *_ = isolated_job
    for index, (key, module, _, inventory) in enumerate(OWNERS):
        with monkeypatch.context() as local:
            original_inventory = getattr(module, inventory)
            def unavailable(_original=original_inventory,
                            _owner={'atomic_candidate_decisions': 'atomic_strategy',
                                    'route_candidate_decisions': 'l15_route'}.get(key), **kwargs):
                if _owner is not None and kwargs.get('owner') != _owner:
                    return _original(**kwargs)
                raise RuntimeError('fixture_inventory_unavailable')
            local.setattr(module, inventory, unavailable)
            local.setenv('OOF_MATERIALIZE_PROMOTE', '1')
            for attempt in (0, 12):
                local.setenv('OOF_MATERIALIZE_CONTINUATION_ATTEMPT', str(attempt))
                local.setenv('OOF_MATERIALIZE_RUN_ID', f'nav-local-{index}-{attempt}')
                assert asyncio.run(job._run()) == int(attempt == 12)
    assert len(callbacks) == len(OWNERS) * 2
    source = tmp_path / 'actual-nav-callbacks.json'
    source.write_text(json.dumps(callbacks), encoding='utf-8')
    child_env = dict(os.environ)
    child_env.pop('NODE_TEST_CONTEXT', None)
    checked = subprocess.run(['node', '--import', 'tsx', 'tests/navCallbackProjection.ts', str(source)],
        cwd=Path(__file__).parents[2] / 'worker', env=child_env,
        capture_output=True, text=True, encoding='utf-8', timeout=90)
    assert checked.returncode == 0, checked.stdout + checked.stderr


@pytest.mark.parametrize('broken', [row[0] for row in OWNERS] + ['all'])
def test_owner_failure_exhaustion_retains_components_and_never_certifies_closure(isolated_job, monkeypatch, broken):
    from services import worker_config_client
    _, _, callbacks, _, routes = isolated_job
    def unavailable(**kwargs):
        raise RuntimeError('fixture_inventory_unavailable')
    async def forbidden(*args, **kwargs):
        pytest.fail('failed NAV projection must never publish')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    for key, module, _, inventory in OWNERS:
        if broken in {key, 'all'}:
            original_inventory = getattr(module, inventory)
            def scoped_unavailable(_original=original_inventory,
                                   _owner=None if broken == 'all' else {
                                       'atomic_candidate_decisions': 'atomic_strategy',
                                       'route_candidate_decisions': 'l15_route'}.get(key), **kwargs):
                if _owner is not None and kwargs.get('owner') != _owner:
                    return _original(**kwargs)
                return unavailable(**kwargs)
            monkeypatch.setattr(module, inventory, scoped_unavailable)
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    monkeypatch.setenv('OOF_MATERIALIZE_CONTINUATION_ATTEMPT', '12')
    assert asyncio.run(job._run()) == 1
    callback = callbacks[-1]
    assert callback['status'] == 'error'
    assert 'paired_nav_daily_closure_incomplete' in callback['error']
    nav = callback['metadata']['paired_nav_maturity']
    assert nav['status'] == 'failed' and nav['accounting_status'] == 'up_to_date'
    assert nav['adoption']['status'] == 'blocked_by_nav_failure'
    for key, *_ in OWNERS:
        assert nav[key]['as_of_date'] == '2026-09-09'
        assert bool(nav[key]['failures']) == (broken in {key, 'all'})
    assert len(routes) == 1 and routes[0].promote is False
