"""
pipeline.py — Daily prediction pipeline endpoints

POST /pipeline/v2/run → Triggers the Cloud Run Job `pipeline-v2` which runs the
                        LangGraph V2 pipeline to completion and callbacks Worker
                        /api/admin/scheduler-callback with the final status.

History:
  - 2026-04-07 LangGraph A+B refactor (fake → real StateGraph in controller)
  - 2026-04-16: Cloud Run Job handoff replaced request-scoped background work.
                container idle-kills after ~15 min and silently truncated every
                pipeline since 4/13, leaving bot with 4 trading days of 0 orders.
                The Job has its own lifecycle and runs to completion.
"""
from __future__ import annotations

import logging
import os
import time
import uuid

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/pipeline", tags=["pipeline"])

WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "")

# Shared module-level Jobs client — the underlying gRPC channel is reusable
# across requests and lazy-initialised inside the class.
_jobs_client = CloudRunJobsClient()


# ─── Worker callback helpers (imported by pipeline_job_main too) ─────────────
#
# These two functions are kept in this router module because:
#   1. They're the dashboard-facing contract (scheduler:run:{task}:{date} payload shape).
#   2. The Cloud Run Job entrypoint (`pipeline_job_main.py`) imports them so the
#      callback behaviour is identical whether the pipeline ran in a Job or was
#      triggered ad-hoc some future way. Avoid duplicating the payload spec.


async def _callback_worker(
    payload: dict, client: httpx.AsyncClient | None = None
) -> None:
    """POST to Worker /api/admin/scheduler-callback. Best-effort; never raises."""
    if not WORKER_URL:
        logger.warning(
            "[Pipeline callback] STOCKVISION_WORKER_URL missing; skip callback for task=%s",
            payload.get("task"),
        )
        return
    url = f"{WORKER_URL.rstrip('/')}/api/admin/scheduler-callback"
    headers = {"Content-Type": "application/json"}
    if WORKER_AUTH:
        headers["Authorization"] = f"Bearer {WORKER_AUTH}"

    async def _post(c: httpx.AsyncClient) -> None:
        try:
            resp = await c.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                logger.warning(
                    "[Pipeline callback] Worker returned %d for task=%s: %s",
                    resp.status_code,
                    payload.get("task"),
                    resp.text[:200],
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[Pipeline callback] Worker unreachable (task=%s): %s",
                payload.get("task"),
                e,
            )

    if client is not None:
        await _post(client)
    else:
        async with httpx.AsyncClient(timeout=15.0) as c:
            await _post(c)


async def _emit_subtask_callbacks(
    run_id: str,
    result: dict | None,
    overall_status: str,
    overall_error: str | None,
    elapsed_ms: int,
) -> None:
    """Fan out per-subtask callbacks so dashboard tiles light up correctly.

    Dashboard reads scheduler:run:{task}:{date}; pipeline runs screener / ml-predict /
    recommendation internally but only writes scheduler:run:pipeline. This reverse-
    callback pattern keeps the UI tiles aligned with reality.
    """
    metrics: dict = {}
    if isinstance(result, dict):
        metrics = result.get("metrics") or {}

    # Populated by node_write_d1 in graphs/daily_pipeline_v2.py.
    predictions_n = int(metrics.get("predictions_written", 0) or 0)
    recos_n = int(metrics.get("recommendations_updated", 0) or 0)

    subtasks = [
        ("screener", predictions_n > 0, f"run_id={run_id} predictions_written={predictions_n}"),
        ("ml-predict", predictions_n > 0, f"run_id={run_id} predictions={predictions_n}"),
        ("recommendation", recos_n > 0, f"run_id={run_id} recos={recos_n}"),
    ]

    async with httpx.AsyncClient(timeout=15.0) as client:
        for task, ok, summary in subtasks:
            status = "success" if (overall_status == "success" and ok) else "error"
            payload: dict = {
                "task": task,
                "status": status,
                "summary": summary,
                "duration_ms": elapsed_ms,
                "run_id": run_id,
            }
            if status == "error":
                payload["error"] = overall_error or f"{task}: no output"
            await _callback_worker(payload, client=client)


# ─── V2 trigger endpoint ─────────────────────────────────────────────────────


@router.post("/v2/run")
async def trigger_pipeline_v2(
    date: str = Query(default="", description="Run date (YYYY-MM-DD, default today TW)"),
):
    """Trigger the Cloud Run Job `pipeline-v2` and return 202 with execution id.

    The Job runs `pipeline_job_main.py` which drives run_pipeline_v2() to
    completion and POSTs Worker /api/admin/scheduler-callback when done. This
    endpoint returns as soon as the Job execution is accepted by Cloud Run
    (~1 s), not when the pipeline finishes.

    Worker subrequest timeout (~100-150 s) is far larger than the Jobs API
    round-trip, so no timeout concerns on the trigger side.
    """
    run_id = f"pv2-{int(time.time())}-{uuid.uuid4().hex[:8]}"

    try:
        execution = _jobs_client.run_job(
            env_overrides={"PIPELINE_RUN_DATE": date} if date else None,
        )
    except JobAlreadyRunningError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "pipeline-v2 already has an active execution",
                "execution_id": e.execution.execution_id,
                "execution_name": e.execution.execution_name,
                "date": date or "today",
            },
        ) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("[Pipeline V2] Failed to trigger Job execution")
        raise HTTPException(
            status_code=502,
            detail=f"Cloud Run Jobs trigger failed: {type(e).__name__}: {e}",
        ) from e

    logger.info(
        "[Pipeline V2] Triggered run_id=%s date=%s execution=%s",
        run_id,
        date or "today",
        execution.execution_id,
    )
    return JSONResponse(
        status_code=202,
        content={
            "status": "triggered",
            "run_id": run_id,
            "date": date or "today",
            "execution_id": execution.execution_id,
            "execution_name": execution.execution_name,
            "note": (
                "Pipeline running as Cloud Run Job; scheduler:run:pipeline will be "
                "overwritten on completion via /api/admin/scheduler-callback."
            ),
        },
    )
