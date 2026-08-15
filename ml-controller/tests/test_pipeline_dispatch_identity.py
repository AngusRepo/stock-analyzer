from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


class _ImportCloudRunJobsClient:
    pass


class _ImportJobAlreadyRunningError(RuntimeError):
    def __init__(self, execution=None):
        super().__init__("already running")
        self.execution = execution


cloud_run_stub = types.ModuleType("services.cloud_run_jobs_client")
cloud_run_stub.CloudRunJobsClient = _ImportCloudRunJobsClient
cloud_run_stub.JobAlreadyRunningError = _ImportJobAlreadyRunningError
sys.modules["services.cloud_run_jobs_client"] = cloud_run_stub

from routers import pipeline  # noqa: E402


class JobsClient:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def run_job(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            execution_id="pipeline-v2-test",
            execution_name="jobs/pipeline-v2-test",
        )


def test_requested_worker_run_id_is_the_job_and_callback_identity(monkeypatch):
    jobs = JobsClient()
    monkeypatch.setattr(pipeline, "_jobs_client", jobs)
    requested_run_id = "pipeline-dispatch:2026-08-14:1234abcd"
    request = SimpleNamespace(headers={"X-Pipeline-Run-Id": requested_run_id})

    response = asyncio.run(
        pipeline.trigger_pipeline_v2(request=request, date="2026-08-14")
    )
    payload = json.loads(response.body)

    assert response.status_code == 202
    assert payload["run_id"] == requested_run_id
    assert jobs.calls == [{
        "env_overrides": {
            "PIPELINE_PARENT_RUN_ID": requested_run_id,
            "PIPELINE_RUN_DATE": "2026-08-14",
        }
    }]
