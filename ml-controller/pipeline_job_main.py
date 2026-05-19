"""
pipeline_job_main.py — Cloud Run Job entrypoint for daily pipeline V2.

Invoked as `python -m pipeline_job_main` by the Cloud Run Job `pipeline-v2`.
Reads PIPELINE_RUN_DATE from env (Worker sets it at trigger time), runs the
existing LangGraph pipeline to completion, and POSTs the result back to
Worker via the shared _callback_worker helper.

Replaces the fire-and-forget asyncio.create_task path that used to live in
routers/pipeline.py — Cloud Run Service would idle-kill the background task
after ~15 min, leaving predictions unwritten.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from datetime import datetime, timedelta

# Reuse the callback + sub-task emission helpers from the router module so
# Worker's dashboard tiles behave identically to the old implementation.
from routers.pipeline import _callback_worker, _emit_subtask_callbacks
from services.cloud_run_jobs_client import CloudRunJobsClient, JobExecution

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("pipeline_job")


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


async def _run_deferred_snapshot_inline(*, run_date: str, run_id: str) -> None:
    """Close the deferred research-snapshot loop inside the pipeline job.

    The graph intentionally reports `snapshot=deferred` so serving callbacks can
    continue quickly. This inline fallback keeps compatibility when no detached
    dataset snapshot Job is configured.
    """
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
        logger.exception("[JobEntry] Deferred dataset snapshot follow-up failed")
        error = f"{type(e).__name__}: {e}"
        summary = f"run_id={run_id}:snapshot {error[:180]}"

    await _callback_worker({
        "task": "dataset-snapshot-export",
        "status": status,
        "summary": summary,
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": f"{run_id}:snapshot",
        "run_date": run_date,
        **({"error": error} if error else {}),
    })


async def _run_deferred_snapshot_followup(*, run_date: str, run_id: str) -> None:
    """Start the deferred research-snapshot loop without extending pipeline-v2.

    When DATASET_SNAPSHOT_JOB_NAME is configured, pipeline-v2 only triggers the
    detached Job and exits after callbacks. The detached Job writes GCS/D1
    manifests and emits the terminal dataset-snapshot-export callback.
    """
    if _falsey_env("STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP", "1"):
        return
    if not run_date:
        return

    mode = _snapshot_followup_mode()
    job_name = _dataset_snapshot_job_name()
    if not _should_trigger_snapshot_job(mode, job_name):
        await _run_deferred_snapshot_inline(run_date=run_date, run_id=run_id)
        return

    started = time.time()
    export_run_id = f"{run_id}:snapshot"
    try:
        execution = await asyncio.to_thread(
            _trigger_deferred_snapshot_job,
            run_date=run_date,
            run_id=run_id,
        )
        await _callback_worker({
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
        logger.exception("[JobEntry] Failed to trigger detached dataset snapshot job")
        error = f"{type(e).__name__}: {e}"
        await _callback_worker({
            "task": "dataset-snapshot-export",
            "status": "error",
            "summary": f"run_id={export_run_id} detached trigger failed: {error[:180]}",
            "duration_ms": int((time.time() - started) * 1000),
            "run_id": export_run_id,
            "run_date": run_date,
            "error": error,
        })


async def _run() -> int:
    """Execute run_pipeline_v2, callback Worker, return process exit code."""
    from graphs.daily_pipeline_v2 import run_pipeline_v2

    run_date = os.environ.get("PIPELINE_RUN_DATE", "") or ""
    run_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"job-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )

    logger.info("[JobEntry] Starting pipeline V2 run_id=%s date=%s", run_id, run_date or "today")

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None
    result: dict | None = None

    try:
        result = await run_pipeline_v2(run_date=run_date, producer_run_id=run_id)
        if isinstance(result, dict) and result.get("status") == "completed":
            status = "success"
            metrics = result.get("metrics") or {}
            snapshot_status = (metrics.get("dataset_snapshot_export") or {}).get("status", "n/a")
            error_count = len(result.get("errors") or [])
            summary = (
                f"run_id={run_id} "
                f"preds={metrics.get('predictions_written', 0)} "
                f"recos={metrics.get('recommendations_updated', 0)} "
                f"llm_reasons={metrics.get('llm_reasons_count', 0)} "
                f"snapshot={snapshot_status} "
                f"errors={error_count}"
            )
        else:
            err_detail = result.get("error") if isinstance(result, dict) else str(result)
            error = str(err_detail or "pipeline returned non-completed status")
            summary = f"run_id={run_id} {error[:120]}"
    except Exception as e:  # noqa: BLE001
        logger.exception("[JobEntry] Pipeline failed")
        error = f"{type(e).__name__}: {e}"
        summary = f"run_id={run_id} {error[:120]}"

    elapsed_ms = int((time.time() - t0) * 1000)
    overall_payload: dict = {
        "task": "pipeline",
        "status": status,
        "summary": summary,
        "duration_ms": elapsed_ms,
        "run_id": run_id,
    }
    if run_date:
        overall_payload["run_date"] = run_date
    if error:
        overall_payload["error"] = error

    await _callback_worker(overall_payload)
    await _emit_subtask_callbacks(run_id, result, status, error, elapsed_ms, run_date=run_date or None)

    snapshot_state = ((result or {}).get("metrics") or {}).get("dataset_snapshot_export") or {}
    if status == "success" and snapshot_state.get("status") == "deferred":
        await _run_deferred_snapshot_followup(run_date=run_date, run_id=run_id)

    logger.info(
        "[JobEntry] Pipeline finished: status=%s elapsed=%dms", status, elapsed_ms
    )
    return 0 if status == "success" else 1


def main() -> None:
    exit_code = asyncio.run(_run())
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
