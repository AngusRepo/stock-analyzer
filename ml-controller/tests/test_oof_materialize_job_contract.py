import asyncio
from pathlib import Path

import oof_materialize_job_main

ROOT = Path(__file__).resolve().parents[2]


def test_oof_materialize_job_closes_scheduler_callback(monkeypatch):
    callbacks = []

    async def fake_execute_lifecycle(**_kwargs):
        return {
            "status": "materialized",
            "cohort_id": "cohort-1",
            "promoted": False,
            "promotion_reason": "quality_or_operational_parity_not_passed",
        }

    async def fake_callback(payload):
        callbacks.append(payload)

    monkeypatch.setattr(oof_materialize_job_main, "_execute_lifecycle", fake_execute_lifecycle)
    monkeypatch.setattr(oof_materialize_job_main, "_callback_worker", fake_callback)
    monkeypatch.setenv("OOF_MATERIALIZE_CADENCE", "daily")
    monkeypatch.setenv("OOF_MATERIALIZE_END_DATE", "2026-07-17")
    monkeypatch.setenv("OOF_MATERIALIZE_RUN_ID", "run-1")
    monkeypatch.setenv("CLOUD_RUN_EXECUTION", "execution-1")

    assert asyncio.run(oof_materialize_job_main._run()) == 0
    assert len(callbacks) == 1
    callback = callbacks[0]
    assert callback["task"] == "active8-oof-daily"
    assert callback["status"] == "success"
    assert callback["run_id"] == "run-1"
    assert callback["attempt_id"] == "execution-1"
    assert callback["run_date"] == "2026-07-17"
    assert "status=materialized" in callback["summary"]
    assert "cohort=cohort-1" in callback["summary"]


def test_allocator_snapshot_mode_closes_scheduler_callback(monkeypatch):
    callbacks = []
    execution_kwargs = {}

    async def fake_execute_allocator_snapshot(**_kwargs):
        execution_kwargs.update(_kwargs)
        return {"status": "ok", "snapshots_built": 135, "written": 135, "skipped_days": 0}

    async def fake_callback(payload):
        callbacks.append(payload)

    monkeypatch.setattr(
        oof_materialize_job_main,
        "_execute_allocator_snapshot",
        fake_execute_allocator_snapshot,
    )
    monkeypatch.setattr(oof_materialize_job_main, "_callback_worker", fake_callback)
    monkeypatch.setenv("OOF_MATERIALIZE_MODE", "allocator_snapshot")
    monkeypatch.setenv("OOF_MATERIALIZE_START_DATE", "2026-07-16")
    monkeypatch.setenv("OOF_MATERIALIZE_END_DATE", "2026-07-16")
    monkeypatch.setenv("OOF_MATERIALIZE_RUN_ID", "evening-chain-20260716")
    monkeypatch.setenv(
        "OOF_MATERIALIZE_CALLBACK_TASK",
        "allocator-ev-feature-snapshot-backfill",
    )

    assert asyncio.run(oof_materialize_job_main._run()) == 0
    assert len(callbacks) == 1
    callback = callbacks[0]
    assert callback["task"] == "allocator-ev-feature-snapshot-backfill"
    assert callback["status"] == "success"
    assert callback["run_id"] == "evening-chain-20260716"
    assert callback["run_date"] == "2026-07-16"
    assert execution_kwargs["lineage_cohort_id"] == "evening-chain-20260716"
    assert "built=135 written=135" in callback["summary"]


def test_oof_materialize_job_contract_is_durable_and_deployed():
    router = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text()
    worker = (ROOT / "worker" / "src" / "lib" / "controllerResearchWorkflows.ts").read_text()
    deploy = (ROOT / "deploy_ml_controller.sh").read_text(encoding="utf-8")

    assert "OOF_MATERIALIZE_JOB_EXECUTION" in router
    assert "CloudRunJobsClient(job_name=job_name).run_job" in router
    assert '"status": "spawned"' in router
    assert "The controller only dispatches a durable Cloud Run Job" in worker
    assert "OOF_MATERIALIZE_JOB_NAME" in deploy
    assert "oof_materialize_job_main" in deploy


def test_oof_materialize_job_reports_full_fit_pending_as_running(monkeypatch):
    callbacks = []

    async def fake_execute_lifecycle(**kwargs):
        assert kwargs["expected_cohort_id"] == "cohort-1"
        return {
            "status": "materialized",
            "cohort_id": "cohort-1",
            "dependency_retry_required": True,
            "full_fit_dispatch": {"status": "dispatched", "retry_required": True},
        }

    async def fake_callback(payload):
        callbacks.append(payload)

    monkeypatch.setattr(oof_materialize_job_main, "_execute_lifecycle", fake_execute_lifecycle)
    monkeypatch.setattr(oof_materialize_job_main, "_callback_worker", fake_callback)
    monkeypatch.setenv("OOF_MATERIALIZE_CADENCE", "weekly")
    monkeypatch.setenv("OOF_MATERIALIZE_END_DATE", "2026-07-17")
    monkeypatch.setenv("OOF_MATERIALIZE_EXPECTED_COHORT_ID", "cohort-1")
    monkeypatch.setenv("OOF_MATERIALIZE_RUN_ID", "run-pending")

    assert asyncio.run(oof_materialize_job_main._run()) == 0
    assert callbacks[0]["status"] == "running"
    assert "error" not in callbacks[0]