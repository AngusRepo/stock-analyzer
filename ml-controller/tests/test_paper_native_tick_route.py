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
