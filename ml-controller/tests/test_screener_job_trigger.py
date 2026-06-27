from __future__ import annotations

import asyncio
import json
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

from routers import screener  # noqa: E402


def test_screener_v2_trigger_passes_run_context_to_cloud_run_job(monkeypatch):
    observed: dict = {}

    class FakeJobsClient:
        def run_job(self, env_overrides=None, *, reject_if_running=True):
            observed["env_overrides"] = env_overrides
            observed["reject_if_running"] = reject_if_running
            return types.SimpleNamespace(
                execution_id="screener-v2-exec",
                execution_name="projects/p/locations/r/jobs/screener-v2/executions/screener-v2-exec",
            )

    monkeypatch.setattr(screener, "_screener_jobs_client", FakeJobsClient())

    response = asyncio.run(
        screener.trigger_screener_v2(
            req=screener.ScreenerRunRequest(run_date="2026-06-26", chain_run_id="indicator-run-1"),
            date="",
            chain_run_id="",
        )
    )
    body = json.loads(response.body)

    assert response.status_code == 202
    assert body["status"] == "triggered"
    assert body["chain_run_id"] == "indicator-run-1"
    assert observed["env_overrides"]["SCREENER_RUN_DATE"] == "2026-06-26"
    assert observed["env_overrides"]["SCREENER_CHAIN_RUN_ID"] == "indicator-run-1"
    assert observed["env_overrides"]["SCREENER_CALLBACK_TASK"] == "screener"


def test_screener_job_main_callbacks_with_chain_metadata():
    source = Path("ml-controller/screener_job_main.py").read_text(encoding="utf-8")

    assert '"task": callback_task' in source
    assert '"continue_post_screener_pipeline": bool(chain_run_id)' in source
    assert 'payload["chain_run_id"] = chain_run_id' in source
    assert 'from routers.pipeline import _callback_worker' in source
