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
    def listing(**kwargs):seen.append(('list',kwargs));return SimpleNamespace(executions=[],next_page_token='')
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


def paged_client(monkeypatch, executions, step):
    """A client over a paged provider: every ListExecutions call returns one page (as the
    GAPIC pager's own response) and takes `step` s of a fake monotonic clock (never more
    than its timeout); iterating a page would fetch the rest, as the real pager does."""
    from services import cloud_run_jobs_client as jobs
    clock=[0.0];calls=[];runs=[]
    monkeypatch.setattr(time,'monotonic',lambda:clock[0])
    client=object.__new__(jobs.CloudRunJobsClient)
    client._parent='projects/test/locations/region/jobs/oof'
    client._require_source_alignment=False
    def listing(request=None,**kwargs):
        calls.append((request.page_token,kwargs.get('timeout'),kwargs.get('retry','unset')))
        clock[0]+=min(step,kwargs.get('timeout') or step)
        start=int(request.page_token or 0);size=request.page_size
        page=executions[start:start+size]
        class Page:
            def __init__(self):
                self.executions=page
                self.next_page_token=str(start+size) if start+size<len(executions) else ''
            def __iter__(self):return iter(executions[start:])
        return Page()
    def run(**kwargs):
        runs.append(kwargs);return SimpleNamespace(metadata=SimpleNamespace(name=client._parent+'/executions/new'))
    monkeypatch.setattr(client,'_get_executions_client',lambda:SimpleNamespace(list_executions=listing))
    monkeypatch.setattr(client,'_get_client',lambda:SimpleNamespace(run_job=run))
    return client,clock,calls,runs


def done(n):
    return [SimpleNamespace(name=f'projects/test/locations/region/jobs/oof/executions/d{i}',completion_time=1,conditions=[])
            for i in range(n)]


def test_active_lookup_requests_each_page_with_what_is_left_of_the_deadline(monkeypatch):
    """Round 16: the GAPIC pager would fetch later pages with the first call's timeout. Each
    page now gets min(8, remaining), and is requested with the next page token."""
    running=SimpleNamespace(name='projects/test/locations/region/jobs/oof/executions/live',completion_time=None,conditions=[])
    client,clock,calls,_=paged_client(monkeypatch,done(250)+[running],7)
    active=client.get_active_execution(deadline=22.0)
    assert active.execution_id=='live'
    assert calls==[('',8.0,None),('100',8.0,None),('200',8.0,None)] and clock[0]==21.0
    # Shorter budget: the third page only gets what is left.
    client,clock,calls,_=paged_client(monkeypatch,done(250)+[running],6.5)
    assert client.get_active_execution(deadline=20.0).execution_id=='live'
    assert [c[1] for c in calls]==[8.0,8.0,7.0] and clock[0]<=20.0


def test_active_lookup_sends_no_page_under_one_second_and_run_job_starts_nothing(monkeypatch):
    """Under MIN_PAGE_SECONDS left no page is requested: TimeoutError, as an exhausted
    deadline always was, so run_job(reject_if_running) fails closed without RunJob."""
    from services import cloud_run_jobs_client as jobs
    assert jobs.MIN_PAGE_SECONDS==1.0 and jobs.MAX_PAGE_SECONDS==8.0
    client,clock,calls,runs=paged_client(monkeypatch,done(250),8)
    with pytest.raises(TimeoutError,match='cloud_run_active_lookup_deadline'):
        client.get_active_execution(deadline=16.5)
    assert [c[0] for c in calls]==['','100'], 'no third page with 0.5 s left'
    client,clock,calls,runs=paged_client(monkeypatch,done(5),1)
    with pytest.raises(TimeoutError,match='cloud_run_active_lookup_deadline'):
        client.get_active_execution(deadline=0.9)
    assert calls==[]
    with pytest.raises(TimeoutError):
        client.run_job(deadline_seconds=0.5)
    assert calls==[] and runs==[]
    # A long history that the budget cannot cover: no dispatch either.
    client,clock,calls,runs=paged_client(monkeypatch,done(1000),8)
    with pytest.raises(TimeoutError):
        client.run_job(deadline_seconds=20)
    assert [c[1] for c in calls]==[8.0,8.0,4.0] and runs==[] and clock[0]<=20


def test_active_lookup_without_a_deadline_keeps_the_sdk_pager(monkeypatch):
    """No deadline (oof_prep_events, run_job without deadline_seconds): one SDK call with the
    SDK's own timeout and retry, iterated as before (unchanged)."""
    running=SimpleNamespace(name='projects/test/locations/region/jobs/oof/executions/live',completion_time=None,conditions=[])
    client,clock,calls,runs=paged_client(monkeypatch,done(250)+[running],1)
    assert client.get_active_execution().execution_id=='live'
    assert calls==[('',None,'unset')]
    assert client.get_active_execution() is not None and client.run_job is not None
    client,clock,calls,runs=paged_client(monkeypatch,done(3),1)
    assert client.get_active_execution() is None and len(calls)==1
