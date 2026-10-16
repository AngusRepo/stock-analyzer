import importlib.util
import json
from pathlib import Path
import pytest
spec=importlib.util.spec_from_file_location('telemetry',Path(__file__).resolve().parents[2]/'ml-service/app/pipeline_stage_telemetry.py')
telemetry=importlib.util.module_from_spec(spec);spec.loader.exec_module(telemetry)

def test_start_and_suspend_keep_original_control_flow_and_authenticated_observation(monkeypatch):
    events=[]
    class Response:
        def __enter__(self):return self
        def __exit__(self,*args):pass
    def send(request,timeout):
        assert request.get_header('X-service-token')=='fake'
        assert timeout==3
        events.append(json.loads(request.data));return Response()
    monkeypatch.setattr(telemetry,'urlopen',send)
    class Suspended(Exception):pass
    with pytest.raises(Suspended):
        with telemetry.observe_prediction({'callback_url':'https://test.invalid','callback_token':'fake','run_id':'r','run_date':'2026-10-16'}):
            raise Suspended('GPU continuation')
    assert [e['progress']['status'] for e in events]==['running','waiting']
    assert events[0]['progress']['execution_id']==events[1]['progress']['execution_id']
    assert events[1]['progress']['completed'][0]['elapsed_ms']>=0

def test_observation_outage_never_fails_computation(monkeypatch):
    def fail(*a,**kw):raise OSError('offline')
    monkeypatch.setattr(telemetry,'urlopen',fail)
    with telemetry.observe_prediction({'callback_url':'https://test.invalid','callback_token':'fake'}):
        result=42
    assert result==42
