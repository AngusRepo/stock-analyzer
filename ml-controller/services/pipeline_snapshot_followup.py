from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Awaitable, Callable

from services.cloud_run_jobs_client import CloudRunJobsClient, JobExecution

logger = logging.getLogger(__name__)
CallbackWorker = Callable[[dict], Awaitable[None]]


def _snapshot_export_start_date(run_date: str) -> str:
    try:
        lookback_days = int(os.environ.get("STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS", "504") or "504")
    except ValueError:
        lookback_days = 504
    lookback_days = max(30, min(lookback_days, 1600))
    return (datetime.strptime(run_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")


def _falsey_env(name: str, default: str = "") -> bool:
    return os.environ.get(name, default).strip().lower() in {"0", "false", "no", "off"}


def _dataset_snapshot_job_name() -> str:
    return (
        os.environ.get("DATASET_SNAPSHOT_JOB_NAME", "")
        or os.environ.get("PIPELINE_DATASET_SNAPSHOT_JOB_NAME", "")
    ).strip()


def _snapshot_followup_mode() -> str:
    return os.environ.get("STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP_MODE", "auto").strip().lower()


def _should_trigger_snapshot_job(mode: str, job_name: str) -> bool:
    if mode in {"inline", "blocking", "sync", "synchronous"}:
        return False
    if mode in {"cloud_run_job", "job", "detached", "async_job"}:
        return True
    return bool(job_name)


def _snapshot_job_env(*, run_date: str, run_id: str) -> dict[str, str]:
    return {
        "DATASET_SNAPSHOT_RUN_DATE": run_date,
        "DATASET_SNAPSHOT_PARENT_RUN_ID": run_id,
        "DATASET_SNAPSHOT_PRODUCER_RUN_ID": f"{run_id}:snapshot",
    }


def _trigger_deferred_snapshot_job(*, run_date: str, run_id: str) -> JobExecution:
    job_name = _dataset_snapshot_job_name()
    if not job_name:
        raise RuntimeError("DATASET_SNAPSHOT_JOB_NAME not configured")
    client = CloudRunJobsClient(job_name=job_name)
    return client.run_job(
        env_overrides=_snapshot_job_env(run_date=run_date, run_id=run_id),
        reject_if_running=not _falsey_env("DATASET_SNAPSHOT_JOB_REJECT_IF_RUNNING", "0"),
    )


async def _run_deferred_snapshot_inline(*, run_date: str, run_id: str, callback_worker: CallbackWorker) -> None:
    started = time.time()
    status = "error"
    summary = ""
    error: str | None = None
    try:
        from services.dataset_snapshot_exporter import (
            DatasetSnapshotExportRequest,
            export_daily_research_snapshots,
        )

        export_run_id = f"{run_id}:snapshot"
        request = DatasetSnapshotExportRequest(
            business_date=run_date,
            start_date=_snapshot_export_start_date(run_date),
            end_date=run_date,
            producer_run_id=export_run_id,
            include_signals=True,
        )
        combined = await asyncio.to_thread(export_daily_research_snapshots, request)
        snapshots = combined.get("snapshots") or {}
        backtest = ((snapshots.get("backtest_dataset") or {}).get("snapshot") or {})
        price = ((snapshots.get("price_history") or {}).get("snapshot") or {})
        status = "success"
        summary = (
            f"run_id={export_run_id} "
            f"backtest={backtest.get('snapshot_id')} rows={backtest.get('row_count')} "
            f"price={price.get('snapshot_id')} rows={price.get('row_count')}"
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("[PipelineSnapshotFollowup] Deferred dataset snapshot inline follow-up failed")
        error = f"{type(e).__name__}: {e}"
        summary = f"run_id={run_id}:snapshot {error[:180]}"

    await callback_worker({
        "task": "dataset-snapshot-export",
        "status": status,
        "summary": summary,
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": f"{run_id}:snapshot",
        "run_date": run_date,
        **({"error": error} if error else {}),
    })


async def run_deferred_snapshot_followup(*, run_date: str, run_id: str, callback_worker: CallbackWorker) -> None:
    from services.allocator_contract_guard import allocator_contract_guard_enabled

    if allocator_contract_guard_enabled():
        logger.warning("[AllocatorContractGuard] Deferred dataset snapshot follow-up skipped")
        return
    if _falsey_env("STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP", "1"):
        return
    if not run_date:
        return

    mode = _snapshot_followup_mode()
    job_name = _dataset_snapshot_job_name()
    if not _should_trigger_snapshot_job(mode, job_name):
        await _run_deferred_snapshot_inline(run_date=run_date, run_id=run_id, callback_worker=callback_worker)
        return

    started = time.time()
    export_run_id = f"{run_id}:snapshot"
    try:
        execution = await asyncio.to_thread(
            _trigger_deferred_snapshot_job,
            run_date=run_date,
            run_id=run_id,
        )
        await callback_worker({
            "task": "dataset-snapshot-export",
            "status": "triggered",
            "summary": (
                f"run_id={export_run_id} job={job_name} "
                f"execution={execution.execution_id} callback expected"
            ),
            "duration_ms": int((time.time() - started) * 1000),
            "run_id": export_run_id,
            "run_date": run_date,
        })
    except Exception as e:  # noqa: BLE001
        logger.exception("[PipelineSnapshotFollowup] Failed to trigger detached dataset snapshot job")
        error = f"{type(e).__name__}: {e}"
        await callback_worker({
            "task": "dataset-snapshot-export",
            "status": "error",
            "summary": f"run_id={export_run_id} detached trigger failed: {error[:180]}",
            "duration_ms": int((time.time() - started) * 1000),
            "run_id": export_run_id,
            "run_date": run_date,
            "error": error,
        })
