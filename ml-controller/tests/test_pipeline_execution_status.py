from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
import ast
from pathlib import Path

import pytest
from google.cloud import run_v2
from services.pipeline_execution_status import lookup_execution, failure_callback

PARENT='projects/p/locations/r/jobs/pipeline-v2'
STAMP=datetime(2026,9,18,14,42,tzinfo=timezone.utc)


def execution(name='job-a', *, run='run-a', day='2026-09-18', state=3, created=STAMP, message='The configured memory limit was reached.'):
    return run_v2.Execution(name=f'{PARENT}/executions/{name}', create_time=created,
        completion_time=STAMP if state in (3,4) else None,
        template=run_v2.TaskTemplate(containers=[run_v2.Container(env=[
            run_v2.EnvVar(name='PIPELINE_PARENT_RUN_ID',value=run),
            run_v2.EnvVar(name='PIPELINE_RUN_DATE',value=day),
            run_v2.EnvVar(name='TOKEN',value='must-not-escape'),
        ])]), conditions=[run_v2.Condition(type_='Completed',state=state,message=message,last_transition_time=STAMP)])


class Client:
    def __init__(self,rows):self.rows=rows
    def get_execution(self,request,timeout):return next(e for e in self.rows if e.name==request.name)
    def list_executions(self,request,timeout):
        assert request.parent==PARENT
        return iter(sorted(self.rows, key=lambda e: (e.create_time, e.name), reverse=True))


def lookup(rows,**kwargs):return lookup_execution(Client(rows),parent=PARENT,run_date='2026-09-18',run_id='run-a',**kwargs)


def test_real_sdk_failed_state_closes_only_exact_run_without_secrets():
    result=lookup([execution(run='other',created=STAMP+timedelta(days=1)),execution()])
    assert result['state']=='failed' and result['failure_code']=='memory_limit'
    callback=failure_callback(result)
    assert callback['status']=='error' and callback['run_id']=='run-a'
    assert 'must-not-escape' not in str(callback)
    assert 'completed_at=2026-09-18T14:42:00+00:00;' in callback['error']


@pytest.mark.parametrize('state',[0,1,2,4])
def test_nonfailed_execution_never_manufactures_pipeline_success_or_failure(state):
    result=lookup([execution(state=state)])
    assert failure_callback(result) is None
    if state==4:assert result['reason']=='awaiting_pipeline_callback'


def test_continuation_failure_selected_after_successful_dispatch():
    first=execution(state=4)
    continuation=execution('continuation',created=STAMP+timedelta(seconds=30))
    assert lookup([first,continuation],execution_name=first.name)['execution_name']==continuation.name
    running=execution('retry-running',state=2,created=STAMP+timedelta(seconds=60))
    assert failure_callback(lookup([first,continuation,running],execution_name=first.name)) is None


def test_pinned_identity_cannot_be_replaced_by_another_runs_execution():
    other=execution(run='other')
    with pytest.raises(ValueError,match='run_mismatch'):lookup([other],execution_name=other.name)
    with pytest.raises(ValueError,match='job_mismatch'):lookup([],execution_name='projects/other/executions/x')
    assert lookup([execution(day='2026-09-17')])['state']=='unknown'
    assert lookup([execution(run='other'),execution('second',run='other')],scan_limit=1)['reason']=='execution_scan_budget_exceeded'


def test_terminal_timestamp_alone_is_not_failure_proof():
    row=execution(state=0);row.completion_time=STAMP
    assert lookup([row])['state']=='unknown'


@pytest.mark.asyncio
async def test_real_reconcile_route_uses_existing_callback_only_for_verified_failure(monkeypatch):
    # Compile the actual route function without importing unrelated server apps.
    import asyncio
    from fastapi import Query, Request, HTTPException
    source=Path(__file__).resolve().parents[1]/'routers/pipeline.py'
    fn=next(n for n in ast.parse(source.read_text(encoding='utf-8')).body
            if isinstance(n,ast.AsyncFunctionDef) and n.name=='reconcile_pipeline_execution')
    fn.decorator_list=[];sent=[];auth=[]
    async def callback(body):sent.append(body)
    current=lookup([execution()])
    ns={'Request':Request,'Query':Query,'HTTPException':HTTPException,'asyncio':asyncio,
        '_jobs_client':SimpleNamespace(pipeline_execution_status=lambda **kw:current),
        '_callback_worker':callback,'_check_service_token':lambda request:auth.append(request)}
    exec(compile(ast.Module(body=[fn],type_ignores=[]),'pipeline.py','exec'),ns)
    result=await ns['reconcile_pipeline_execution']('authenticated-request',date='2026-09-18',run_id='run-a',execution_name='')
    assert result['failure_callback_sent'] is True and len(sent)==1 and auth
    current=lookup([execution(state=4)])
    result=await ns['reconcile_pipeline_execution']('authenticated-request',date='2026-09-18',run_id='run-a',execution_name='')
    assert result['failure_callback_sent'] is False and len(sent)==1


def test_old_job_history_does_not_block_recent_exact_run():
    rows=[execution('old-'+str(i), run='other',created=STAMP-timedelta(days=1)) for i in range(105)]
    result=lookup(rows+[execution()])
    assert result['state']=='failed' and result['observed_executions']==1
