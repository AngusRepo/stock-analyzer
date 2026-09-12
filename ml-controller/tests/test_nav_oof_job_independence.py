"""Run the actual durable job with original isolated NAV receipts, no network."""
import asyncio
from types import SimpleNamespace

import pytest

import oof_materialize_job_main as job
from services import paired_nav_review_store as store
from test_paired_nav_lifecycle import environment, stamp
from test_paired_nav_daily_review import local_policy
from test_paired_nav_review_store import migrate, two_sessions


@pytest.fixture
def isolated_job(environment, monkeypatch, local_policy):
    from routers import walk_forward
    from services import active8_prep_lifecycle, d1_domain_client
    db, bucket, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    from services import walk_forward_retrain
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: bucket)
    client = SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=db.writer)
    client.original_oof_lifecycle = walk_forward.run_walk_forward_oof_lifecycle
    monkeypatch.setattr(d1_domain_client, 'client_for_domain', lambda domain: client)
    original = walk_forward._materialize_nav_with_reviews
    monkeypatch.setattr(walk_forward, '_materialize_nav_with_reviews',
        lambda **kw: original(**{**kw, 'now': stamp('2026-09-09')}))
    callbacks, prep_calls, route_calls = [], [], []
    async def prep(**kw):
        prep_calls.append(kw)
        return {'status': 'ready'}
    async def route(req):
        route_calls.append(req)
        return {'status': 'shadow_evaluated', 'cohort_id': 'fixture',
            'calendar': {'mature_max_date': '2026-08-31'},
            'physical_prediction_coverage': {'max_date': '2026-08-31'}}
    async def callback(payload):
        callbacks.append(payload)
    monkeypatch.setattr(active8_prep_lifecycle, 'ensure_active8_daily_prep', prep)
    monkeypatch.setattr(walk_forward, 'run_walk_forward_oof_lifecycle', route)
    monkeypatch.setattr(job, '_callback_worker', callback)
    for key, value in {'MODE':'oof_lifecycle', 'CADENCE':'daily', 'END_DATE':'2026-09-09',
            'PROMOTE':'0', 'DISPATCH_FULL_FIT':'0', 'CONTINUATION_ATTEMPT':'0',
            'CONTINUATION_ONLY':'0', 'SCHEDULER_TICKET_ID':'', 'SCHEDULER_RUN_ID':''}.items():
        monkeypatch.setenv('OOF_MATERIALIZE_' + key, value)
    return db, client, callbacks, prep_calls, route_calls


def test_original_nav_reviews_complete_even_when_prep_raises(isolated_job, monkeypatch):
    from services import active8_prep_lifecycle
    db, _, callbacks, _, routes = isolated_job
    async def failed_prep(**kw):
        raise RuntimeError('fixture_prep_unavailable')
    monkeypatch.setattr(active8_prep_lifecycle, 'ensure_active8_daily_prep', failed_prep)
    assert asyncio.run(job._run()) == 1
    assert callbacks[-1]['status'] == 'error' and not routes
    assert db.query(f"SELECT * FROM {store.RECORDS} WHERE record_kind='review'", [])
    nav = callbacks[-1]['metadata']['paired_nav_maturity']
    assert nav['family_reviews']['status'] == 'daily_nav_reviews_current'
    assert 'fixture_prep_unavailable' in callbacks[-1]['summary']


def test_review_failure_does_not_starve_oof_but_requires_retry(isolated_job, monkeypatch):
    db, client, callbacks, prep, routes = isolated_job
    def failed_writer(statements):
        if store.RECORDS in statements[0][0]:
            raise RuntimeError('fixture_review_storage_down')
        return db.writer(statements)
    client.atomic_batch_execute = failed_writer
    assert asyncio.run(job._run()) == 0
    assert len(prep) == len(routes) == 1
    assert callbacks[-1]['status'] == 'triggered'
    assert callbacks[-1]['metadata']['nav_retry_required'] is True
    assert callbacks[-1]['metadata']['dependency_retry_reason'] == 'paired_nav_daily_closure_incomplete'
    nav = callbacks[-1]['metadata']['paired_nav_maturity']
    assert nav['accounting_status'] == 'up_to_date'
    assert nav['journal_chain_verified'] is True
    assert nav['family_reviews']['status'] == 'partial_daily_nav_reviews'
    assert nav['family_reviews']['failure_counts']
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    client.atomic_batch_execute = db.writer
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'success'
    assert callbacks[-1]['metadata']['nav_retry_required'] is False
    headers = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert asyncio.run(job._run()) == 0
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == headers
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == before


def test_nav_retry_exhaustion_never_reports_success(isolated_job, monkeypatch):
    _, client, callbacks, _, routes = isolated_job
    def unavailable(*a):
        raise RuntimeError('fixture_learning_unavailable')
    client.query = unavailable
    monkeypatch.setenv('OOF_MATERIALIZE_CONTINUATION_ATTEMPT', '12')
    assert asyncio.run(job._run()) == 1
    assert len(routes) == 1
    assert callbacks[-1]['status'] == 'error'
    assert 'paired_nav_daily_closure_incomplete' in callbacks[-1]['error']


def test_invalid_scheduler_identity_performs_no_nav_writes(isolated_job, monkeypatch):
    db, _, callbacks, prep, routes = isolated_job
    monkeypatch.setenv('OOF_MATERIALIZE_SCHEDULER_TICKET_ID', 'incomplete')
    assert asyncio.run(job._run()) == 1
    assert not prep and not routes
    assert not db.query(f'SELECT * FROM {store.RECORDS}', [])
    assert callbacks[-1]['status'] == 'error'


def test_nav_runs_before_prep_pending_and_retry_preserves_review_headers(isolated_job, monkeypatch):
    from services import active8_prep_lifecycle
    db, _, callbacks, _, routes = isolated_job
    async def pending_prep(**kw):
        raise active8_prep_lifecycle.Active8PrepDependencyPending('fixture_waiting_prep', {'status':'pending'})
    monkeypatch.setattr(active8_prep_lifecycle, 'ensure_active8_daily_prep', pending_prep)
    assert asyncio.run(job._run()) == 0
    assert callbacks[-1]['status'] == 'triggered' and not routes
    assert callbacks[-1]['metadata']['paired_nav_maturity']['family_reviews']['status'] == 'daily_nav_reviews_current'
    before = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert before
    assert asyncio.run(job._run()) == 0
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == before


def test_cached_oof_with_nav_failure_emits_worker_retryable_pending(isolated_job, monkeypatch):
    from routers import walk_forward
    _, client, callbacks, _, routes = isolated_job
    def unavailable(*a):
        raise RuntimeError('fixture_learning_unavailable')
    client.query = unavailable
    async def cached(req):
        routes.append(req)
        return {'status': 'idempotent_complete'}
    monkeypatch.setattr(walk_forward, 'run_walk_forward_oof_lifecycle', cached)
    monkeypatch.setenv('OOF_MATERIALIZE_PROMOTE', '1')
    assert asyncio.run(job._run()) == 0
    assert routes[0].promote is False
    metadata = callbacks[-1]['metadata']
    assert callbacks[-1]['status'] == 'triggered'
    assert metadata['lifecycle_status'] == 'pending'
    assert metadata['oof_lifecycle_status'] == 'idempotent_complete'


def test_daily_oof_only_cache_cannot_skip_original_nav_reconciliation(monkeypatch):
    from routers import walk_forward
    monkeypatch.setattr(walk_forward, '_latest_ready_oof_manifest',
        lambda *a: pytest.fail('must not substitute OOF receipt for NAV closure'))
    assert walk_forward._pre_dispatch_completed_oof_lifecycle(
        walk_forward.OofLifecycleRequest(end_date='2026-09-09'), cadence='daily', bucket=object()) is None


@pytest.mark.parametrize('day', ['2099-01-01', '20260909', 'not-a-date'])
def test_invalid_or_future_nav_cutoff_performs_no_storage_io(monkeypatch, day):
    from services import d1_domain_client
    monkeypatch.setattr(d1_domain_client, 'client_for_domain',
        lambda *a: pytest.fail('date must be checked before D1 I/O'))
    result = job._execute_daily_nav(end_date=day)
    assert result['status'] == 'failed'
    assert result['error_type'] == 'ValueError'
