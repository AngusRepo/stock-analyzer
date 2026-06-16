import asyncio
import pytest
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import google.cloud as google_cloud
except ImportError:
    google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
setattr(google_cloud, "run_v2", run_v2_stub)
sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)

from routers import pipeline


def test_pipeline_subtask_callbacks_include_run_date(monkeypatch):
    payloads = []

    async def fake_callback_worker(payload, client=None):
        payloads.append(payload)

    monkeypatch.setattr(pipeline, "_callback_worker", fake_callback_worker)

    asyncio.run(
        pipeline._emit_subtask_callbacks(
            "pipeline-v2-test",
            {"metrics": {"predictions_written": 10, "prediction_symbols": 2, "prediction_output_models": 5, "recommendations_updated": 2}},
            "success",
            None,
            1234,
            run_date="2026-05-04",
        )
    )

    assert {payload["task"] for payload in payloads} == {"ml-predict", "recommendation"}
    assert all(payload["run_date"] == "2026-05-04" for payload in payloads)
    assert [p for p in payloads if p["task"] == "ml-predict"][0]["summary"] == "run_id=pipeline-v2-test symbols=2 rows=10 models=5"


def test_pipeline_subtask_callbacks_do_not_overwrite_worker_owned_screener():
    source = Path(pipeline.__file__).read_text(encoding="utf-8")

    callback_body = source[source.index("subtasks = ["):source.index("async with httpx.AsyncClient")]
    assert '"screener"' not in callback_body
    assert "Screener is Worker-owned before" in source


def test_pipeline_terminal_callback_has_longer_timeout():
    source = Path(pipeline.__file__).read_text(encoding="utf-8")

    assert 'timeout_s = 60.0 if payload.get("task") == "pipeline" else 15.0' in source
    assert "httpx.AsyncClient(timeout=timeout_s)" in source
    assert "CallbackWorkerError" in source
    assert "cannot close scheduler callback" in source


def test_pipeline_callback_requires_worker_auth(monkeypatch):
    monkeypatch.setattr(pipeline, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(pipeline, "WORKER_AUTH", "")

    with pytest.raises(pipeline.CallbackWorkerError, match="STOCKVISION_AUTH_TOKEN missing"):
        asyncio.run(pipeline._callback_worker({"task": "pipeline", "status": "success"}))


def test_pipeline_callback_http_failure_raises(monkeypatch):
    class FakeResponse:
        status_code = 500
        text = "worker failed"

    class FakeClient:
        async def post(self, url, headers=None, json=None):
            return FakeResponse()

    monkeypatch.setattr(pipeline, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(pipeline, "WORKER_AUTH", "service-token")

    with pytest.raises(pipeline.CallbackWorkerError, match="HTTP 500"):
        asyncio.run(pipeline._callback_worker({"task": "pipeline", "status": "success"}, client=FakeClient()))
