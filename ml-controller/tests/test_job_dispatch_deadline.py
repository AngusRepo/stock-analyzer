import asyncio
import json
import threading
import time
from types import SimpleNamespace
import pytest

from services.cloud_run_jobs_client import CloudRunJobsClient


def client_fixture(monkeypatch):
    client=object.__new__(CloudRunJobsClient)
    client._parent='projects/test/locations/region/jobs/verify'
    client._require_source_alignment=False  # __init__ default (8d43888b5); bypassed by __new__
    seen=[]
    def listing(**kwargs):seen.append(('list',kwargs));return []
    def run(**kwargs):
        seen.append(('run',kwargs))
        return SimpleNamespace(metadata=SimpleNamespace(name=client._parent+'/executions/one'))
    monkeypatch.setattr(client,'_get_executions_client',lambda:SimpleNamespace(list_executions=listing))
    monkeypatch.setattr(client,'_get_client',lambda:SimpleNamespace(run_job=run))
    return client,seen


def test_dispatch_budget_reaches_read_and_run_rpcs_without_auto_retry(monkeypatch):
    client,seen=client_fixture(monkeypatch)
    assert client.run_job(deadline_seconds=20).execution_id=='one'
    assert [x[0] for x in seen]==['list','run']
    assert seen[0][1]['request'].page_size==100
    for _,kwargs in seen:
        assert 0<kwargs['timeout']<=20 and kwargs['retry'] is None


def test_unfinished_lookup_never_becomes_permission_to_dispatch(monkeypatch):
    client,seen=client_fixture(monkeypatch)
    def lookup(**kwargs):raise TimeoutError('read deadline; active status unknown')
    monkeypatch.setattr(client,'get_active_execution',lookup)
    with pytest.raises(TimeoutError):client.run_job(deadline_seconds=20)
    assert not seen


def test_expired_budget_does_not_dispatch_after_lookup(monkeypatch):
    client,seen=client_fixture(monkeypatch)
    def lookup(**kwargs):time.sleep(.02);return None
    monkeypatch.setattr(client,'get_active_execution',lookup)
    with pytest.raises(TimeoutError,match='before_rpc'):client.run_job(deadline_seconds=.001)
    assert not seen


def test_verify_ack_dispatch_runs_off_event_loop(monkeypatch):
    from routers import verify
    caller=threading.get_ident();seen=[]
    def run_job(**kwargs):
        seen.append((threading.get_ident(),kwargs))
        return SimpleNamespace(execution_id='one',execution_name='jobs/verify/executions/one')
    monkeypatch.setattr(verify,'_verify_jobs_client',SimpleNamespace(run_job=run_job))
    response=asyncio.run(verify.post_verify_run(verify.VerifyRunRequest(async_mode=True,run_date='2026-10-15')))
    assert response.status_code==202 and json.loads(response.body)['status']=='triggered'
    assert seen[0][0]!=caller and seen[0][1]['deadline_seconds']==20
