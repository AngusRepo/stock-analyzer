from __future__ import annotations

import sys
import types
import asyncio
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import google.cloud as google_cloud
except ImportError:
    google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
setattr(google_cloud, "run_v2", run_v2_stub)
sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)
sys.modules.setdefault("httpx", types.SimpleNamespace(AsyncClient=object))

import dataset_snapshot_job_main  # noqa: E402
import pipeline_job_main  # noqa: E402


def test_pipeline_triggers_detached_dataset_snapshot_job(monkeypatch):
    payloads: list[dict] = []
    calls: list[dict] = []

    class FakeJobsClient:
        def __init__(self, **kwargs):
            calls.append({"init": kwargs})

        def run_job(self, env_overrides=None, *, reject_if_running=True):
            calls.append({
                "env_overrides": dict(env_overrides or {}),
                "reject_if_running": reject_if_running,
            })
            return SimpleNamespace(execution_id="dataset-snapshot-job-abc")

    async def fake_callback_worker(payload):
        payloads.append(payload)

    monkeypatch.setenv("DATASET_SNAPSHOT_JOB_NAME", "dataset-snapshot-export")
    monkeypatch.delenv("STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP_MODE", raising=False)
    monkeypatch.setattr(pipeline_job_main, "CloudRunJobsClient", FakeJobsClient)
    monkeypatch.setattr(pipeline_job_main, "_callback_worker", fake_callback_worker)

    asyncio.run(pipeline_job_main._run_deferred_snapshot_followup(
        run_date="2026-05-18",
        run_id="pipeline-v2-test",
    ))

    assert calls[0]["init"]["job_name"] == "dataset-snapshot-export"
    assert calls[1]["env_overrides"] == {
        "DATASET_SNAPSHOT_RUN_DATE": "2026-05-18",
        "DATASET_SNAPSHOT_PARENT_RUN_ID": "pipeline-v2-test",
        "DATASET_SNAPSHOT_PRODUCER_RUN_ID": "pipeline-v2-test:snapshot",
    }
    assert calls[1]["reject_if_running"] is False
    assert payloads == [
        {
            "task": "dataset-snapshot-export",
            "status": "triggered",
            "summary": (
                "run_id=pipeline-v2-test:snapshot job=dataset-snapshot-export "
                "execution=dataset-snapshot-job-abc callback expected"
            ),
            "duration_ms": payloads[0]["duration_ms"],
            "run_id": "pipeline-v2-test:snapshot",
            "run_date": "2026-05-18",
        }
    ]


def test_pipeline_keeps_inline_snapshot_fallback_without_job_name(monkeypatch):
    inline_calls: list[dict] = []

    async def fake_inline(**kwargs):
        inline_calls.append(kwargs)

    monkeypatch.delenv("DATASET_SNAPSHOT_JOB_NAME", raising=False)
    monkeypatch.delenv("PIPELINE_DATASET_SNAPSHOT_JOB_NAME", raising=False)
    monkeypatch.delenv("STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP_MODE", raising=False)
    monkeypatch.setattr(pipeline_job_main, "_run_deferred_snapshot_inline", fake_inline)

    asyncio.run(pipeline_job_main._run_deferred_snapshot_followup(
        run_date="2026-05-18",
        run_id="pipeline-v2-test",
    ))

    assert inline_calls == [{"run_date": "2026-05-18", "run_id": "pipeline-v2-test"}]


def test_detached_dataset_snapshot_job_exports_and_callbacks(monkeypatch):
    payloads: list[dict] = []
    requests = []

    def fake_export(request):
        requests.append(request)
        return {
            "snapshots": {
                "backtest_dataset": {
                    "snapshot": {"snapshot_id": "backtest-1", "row_count": 12},
                },
                "price_history": {
                    "snapshot": {"snapshot_id": "price-1", "row_count": 5},
                },
            },
        }

    async def fake_callback_worker(payload):
        payloads.append(payload)

    monkeypatch.setenv("DATASET_SNAPSHOT_RUN_DATE", "2026-05-18")
    monkeypatch.setenv("DATASET_SNAPSHOT_PARENT_RUN_ID", "pipeline-v2-test")
    monkeypatch.setenv("DATASET_SNAPSHOT_PRODUCER_RUN_ID", "pipeline-v2-test:snapshot")
    monkeypatch.setenv("DATASET_SNAPSHOT_CHUNK_DAYS", "7")
    monkeypatch.setattr(dataset_snapshot_job_main, "export_daily_research_snapshots", fake_export)
    monkeypatch.setattr(dataset_snapshot_job_main, "_callback_worker", fake_callback_worker)

    exit_code = asyncio.run(dataset_snapshot_job_main._run())

    assert exit_code == 0
    assert requests[0].business_date == "2026-05-18"
    assert requests[0].end_date == "2026-05-18"
    assert requests[0].producer_run_id == "pipeline-v2-test:snapshot"
    assert requests[0].chunk_days == 7
    assert payloads[0]["task"] == "dataset-snapshot-export"
    assert payloads[0]["status"] == "success"
    assert payloads[0]["run_id"] == "pipeline-v2-test:snapshot"
    assert payloads[0]["run_date"] == "2026-05-18"
    assert "backtest=backtest-1 rows=12" in payloads[0]["summary"]
    assert "price=price-1 rows=5" in payloads[0]["summary"]
