from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.paper_corporate import router


def test_tick_route_reports_incomplete_pairs_as_http_failure_without_accepting_override(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    calls = []
    def tick(**request):
        calls.append(request)
        return {'status': 'failed', 'pairs': [{'status': 'failed', 'reason': 'paired_native_previous_frame_missing'}]}
    monkeypatch.setattr('services.paired_native_runtime.run_native_execution_tick', tick)
    client = TestClient(app)
    response = client.post('/paper/native-execution-tick', json={'session_date': '2026-09-08'})
    assert response.status_code == 409
    assert response.json()['detail']['pairs'][0]['status'] == 'failed'
    response = client.post('/paper/native-execution-tick', json={'session_date': '2026-09-08', 'force': True})
    assert response.status_code == 422 and len(calls) == 1


import asyncio
import threading
import pytest


@pytest.mark.parametrize('cancel_first', [False, True])
def test_overlapping_ticks_share_work_and_disconnect_does_not_cancel_writer(monkeypatch, cancel_first):
    from routers.paper_corporate import native_execution_tick, NativeTickRequest, _native_tick_tasks
    entered, release = threading.Event(), threading.Event()
    calls = []
    def tick(**request):
        calls.append(request)
        entered.set()
        assert release.wait(3)
        return {'status':'ok', 'pairs':[]}
    monkeypatch.setattr('services.paired_native_runtime.run_native_execution_tick', tick)
    async def scenario():
        request = NativeTickRequest(session_date='2026-09-29')
        first = asyncio.create_task(native_execution_tick(request))
        try:
            for _ in range(100):
                if entered.is_set(): break
                await asyncio.sleep(.005)
            assert entered.is_set()
            if cancel_first:
                first.cancel()
                with pytest.raises(asyncio.CancelledError): await first
            second = asyncio.create_task(native_execution_tick(request))
            await asyncio.sleep(.01)
            assert len(calls)==1
        finally:
            release.set()
        assert (await second)['status']=='ok'
        if not cancel_first: assert await first == await second
        await asyncio.sleep(0)
        assert not _native_tick_tasks
    asyncio.run(scenario())
