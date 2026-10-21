import asyncio
import pytest
from services import pipeline_progress as progress


def test_phase_keeps_failure_and_real_elapsed_without_raising_telemetry_errors(monkeypatch):
    events=[]
    async def report(name, **kwargs): events.append((name,kwargs))
    monkeypatch.setattr(progress,'report',report)
    monkeypatch.setattr(progress,'_completed',[])
    async def run():
        async with progress.phase('node_capture_atomic_inputs'):
            raise ValueError('original failure')
    with pytest.raises(ValueError):
        asyncio.run(run())
    assert events[0][0]=='node_capture_atomic_inputs'
    assert events[-1][1]['status']=='failed'
    assert progress._completed[0]['status']=='failed'
    assert progress._completed[0]['elapsed_ms']>=0


def test_outage_does_not_change_pipeline_result(monkeypatch):
    for key,value in {'PIPELINE_PARENT_RUN_ID':'run','PIPELINE_RUN_DATE':'2026-10-14',
        'STOCKVISION_WORKER_URL':'https://test.invalid','STOCKVISION_AUTH_TOKEN':'fake'}.items():
        monkeypatch.setenv(key,value)
    class Broken:
        def __init__(self,**kwargs): pass
        async def __aenter__(self): raise RuntimeError('unavailable')
        async def __aexit__(self,*args): pass
    monkeypatch.setattr(progress.httpx,'AsyncClient',Broken)
    asyncio.run(progress.report('startup'))


def test_explicit_blocked_result_is_reported_without_failing_node(monkeypatch):
    events=[]
    async def report(name, **kwargs): events.append((name,kwargs))
    monkeypatch.setattr(progress,'report',report)
    monkeypatch.setattr(progress,'_completed',[])
    async def run():
        async with progress.phase('node_prepare_sequence_inputs') as outcome:
            outcome['status']=progress.node_result_status('node_prepare_sequence_inputs',{'sequence_input_summary':{'status':'blocked'}})
        return 'continues'
    assert asyncio.run(run()) == 'continues'
    assert events[-1][1]['status']=='blocked'
    assert progress._completed[0]['status']=='blocked'
    assert progress.node_result_status('node_capture_atomic_inputs',{'paired_nav_atomic_inputs':{'status':'failed'}})=='failed'
    assert progress.node_result_status('node_recommend',{'status':'blocked'})=='completed'


def test_expected_dependency_keeps_original_exception_and_waiting_telemetry(monkeypatch):
    class DependencyPending(Exception): pass
    async def report(*args,**kwargs): pass
    monkeypatch.setattr(progress,'report',report)
    monkeypatch.setattr(progress,'_completed',[])
    async def run():
        async with progress.phase('prepare_prediction_request',deferred_exception=DependencyPending):
            raise DependencyPending('same dependency')
    with pytest.raises(DependencyPending,match='same dependency'):
        asyncio.run(run())
    assert progress._completed[0]['status']=='waiting'
