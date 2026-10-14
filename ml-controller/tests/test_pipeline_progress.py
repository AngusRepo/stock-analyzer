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
