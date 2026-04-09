"""
pipeline.py — Daily prediction pipeline endpoints

POST /pipeline/v2/run → Real LangGraph StateGraph (2026-04-07 LangGraph A+B refactor)
                        Since 2026-04-08 Part 5 Option A: fire-and-forget + callback
POST /pipeline/run    → [DEPRECATED] Old fake-LangGraph fire-and-forget shell
"""
import os
import time
import uuid
import asyncio
import logging
import httpx

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/pipeline", tags=["pipeline"])

WORKER_URL = os.environ.get(
    "STOCKVISION_WORKER_URL",
    "https://stockvision-worker.angus-solo-dev.workers.dev"
)
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


# ─── 2026-04-08 Part 5 Option A: Fire-and-forget + callback ──────────────────
#
# Problem: CF Worker fetch() to Cloud Run has ~100-150s subrequest timeout
# (empirical, not documented). Pipelines > 144s → Worker sees HTTP 524 and
# logs cron:log:pipeline as error even though ml-controller actually finishes
# successfully. Dashboard shows red for successful runs.
#
# Solution: Decouple trigger from observation.
#   1. /pipeline/v2/run starts asyncio.create_task and returns 202 immediately
#      (< 100ms). Worker gets trigger confirmation, not completion.
#   2. Background task runs the full pipeline.
#   3. On completion, background task POSTs Worker /api/admin/cron-callback
#      with the real final status. Worker overwrites cron:log:pipeline.
#
# Trade-off: Worker's initial log says "triggered" (near-instant), then the
# callback overwrites it with "success" or "error". Dashboard is eventually
# consistent within pipeline wall-clock (~2-5 min).

# In-memory sentinel for concurrent runs (per process). Multiple Cloud Run
# revisions could each run one pipeline simultaneously, but since run_pipeline_v2
# writes to the same D1 tables with INSERT OR REPLACE, concurrent runs would
# just re-write the same rows — not corrupt, just wasted compute.
_IN_FLIGHT: set[str] = set()


async def _callback_worker(payload: dict, client: httpx.AsyncClient | None = None) -> None:
    """
    POST to Worker /api/admin/cron-callback with pipeline completion status.
    Best-effort: failure to callback is logged but does not raise.
    """
    url = f"{WORKER_URL.rstrip('/')}/api/admin/cron-callback"
    headers = {"Content-Type": "application/json"}
    if WORKER_AUTH:
        headers["Authorization"] = f"Bearer {WORKER_AUTH}"

    async def _post(c: httpx.AsyncClient):
        try:
            resp = await c.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                logger.warning(
                    f"[Pipeline V2 callback] Worker returned "
                    f"{resp.status_code} for task={payload.get('task')}: "
                    f"{resp.text[:200]}"
                )
        except Exception as e:
            logger.warning(
                f"[Pipeline V2 callback] Worker unreachable "
                f"(task={payload.get('task')}): {e}"
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
    """
    Emit individual cron:log entries for dashboard tiles that reflect the
    sub-steps inside pipeline (screener / ml-predict / recommendation).

    Worker's dashboard reads cron:log:{task}:{date} per task in TASK_NAMES
    (cronLogger.ts). Pipeline endpoint runs them all internally but writes
    only cron:log:pipeline, so dashboard tiles for those individual tasks
    remain dark. This batches the reverse callbacks so the UI lights up.

    Status derivation:
      - If overall_status == 'error': all sub-tasks marked 'error' with same error
      - Otherwise per-sub-task status derived from metrics (rows > 0 = success)
    """
    metrics = {}
    if isinstance(result, dict):
        metrics = result.get("metrics") or {}

    # node_write_d1 populates these fields (graphs/daily_pipeline_v2.py:272-278)
    predictions_n = int(metrics.get("predictions_written", 0) or 0)
    recos_n = int(metrics.get("recommendations_updated", 0) or 0)

    # Dashboard tile mapping:
    # - 'screener': lit when pipeline produced predictions (screener candidates > 0
    #    is implicit; no direct candidate count in metrics yet)
    # - 'ml-predict': lit when predictions_written > 0
    # - 'recommendation': lit when recommendations_updated > 0
    subtasks = [
        (
            "screener",
            predictions_n > 0,
            f"run_id={run_id} predictions_written={predictions_n}",
        ),
        (
            "ml-predict",
            predictions_n > 0,
            f"run_id={run_id} predictions={predictions_n}",
        ),
        (
            "recommendation",
            recos_n > 0,
            f"run_id={run_id} recos={recos_n}",
        ),
    ]

    async with httpx.AsyncClient(timeout=15.0) as client:
        for task, ok, summary in subtasks:
            status = "success" if (overall_status == "success" and ok) else "error"
            payload = {
                "task": task,
                "status": status,
                "summary": summary,
                "duration_ms": elapsed_ms,
                "run_id": run_id,
            }
            if status == "error":
                payload["error"] = overall_error or f"{task}: no output"
            await _callback_worker(payload, client=client)


async def _run_pipeline_v2_with_callback(run_id: str, run_date: str) -> None:
    """Background task: runs pipeline and posts completion to Worker."""
    from graphs.daily_pipeline_v2 import run_pipeline_v2

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None
    result: dict | None = None

    try:
        result = await run_pipeline_v2(run_date=run_date)
        # run_pipeline_v2 returns {"status": "completed"|"error", "metrics": {...}, ...}
        if isinstance(result, dict) and result.get("status") == "completed":
            status = "success"
            metrics = result.get("metrics") or {}
            summary = (
                f"run_id={run_id} "
                f"preds={metrics.get('predictions_written', 0)} "
                f"recos={metrics.get('recommendations_updated', 0)} "
                f"llm_reasons={metrics.get('llm_reasons_count', 0)}"
            )
        else:
            status = "error"
            err_detail = (
                result.get("error") if isinstance(result, dict) else str(result)
            )
            error = str(err_detail or "pipeline returned non-completed status")
            summary = f"run_id={run_id} {error[:120]}"
    except Exception as e:
        logger.exception("[Pipeline V2 bg] Failed")
        error = f"{type(e).__name__}: {e}"
        summary = f"run_id={run_id} {error[:120]}"
    finally:
        elapsed_ms = int((time.time() - t0) * 1000)
        _IN_FLIGHT.discard(run_id)

        # Overall pipeline callback (top-level cron:log:pipeline tile)
        overall_payload = {
            "task": "pipeline",
            "status": status,
            "summary": summary,
            "duration_ms": elapsed_ms,
            "run_id": run_id,
        }
        if error:
            overall_payload["error"] = error
        await _callback_worker(overall_payload)

        # Per-sub-task callbacks (screener / ml-predict / recommendation)
        # so dashboard tiles reflect pipeline internals.
        await _emit_subtask_callbacks(run_id, result, status, error, elapsed_ms)

        logger.info(
            f"[Pipeline V2 bg] {run_id} finished: status={status} "
            f"elapsed={elapsed_ms}ms"
        )


# ─── V2 ENDPOINT — Fire-and-forget with callback ─────────────────────────────

@router.post("/v2/run")
async def trigger_pipeline_v2(
    date: str = Query(default="", description="Run date (YYYY-MM-DD, default today TW)"),
):
    """
    LangGraph V2 daily pipeline (2026-04-08 Option A: fire-and-forget):
      load_inputs → load_market_env → compute_sector_flow → build_payloads
        → ml_predict → recommend → gen_llm_reasons → write_d1

    Returns 202 immediately with a run_id. Pipeline runs in background.
    When complete, ml-controller POSTs Worker /api/admin/cron-callback with
    final status. Worker overwrites cron:log:pipeline accordingly.

    See memory/project_session_2026_04_08_part5.md for rationale (CF Worker
    subrequest ~144s timeout vs ml-controller pipeline ~2-5 min wall clock).
    """
    run_id = f"pv2-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    if run_id in _IN_FLIGHT:
        # Extremely unlikely given uuid, but cheap to check
        return JSONResponse(
            status_code=409,
            content={"status": "error", "error": "run_id collision", "run_id": run_id},
        )

    _IN_FLIGHT.add(run_id)
    # Fire-and-forget — DO NOT await
    asyncio.create_task(_run_pipeline_v2_with_callback(run_id, date))

    logger.info(f"[Pipeline V2] Triggered run_id={run_id} date={date or 'today'}")
    return JSONResponse(
        status_code=202,
        content={
            "status": "triggered",
            "run_id": run_id,
            "date": date or "today",
            "note": "Pipeline running in background; cron:log:pipeline will be overwritten on completion",
        },
    )


# ─── LEGACY ENDPOINT — Deprecated, kept for fallback ─────────────────────────

@router.post("/run")
async def trigger_pipeline_legacy(
    resume: bool = Query(default=True, description="Resume from checkpoint if available"),
    date: str = Query(default="", description="Run date (YYYY-MM-DD, default today)"),
):
    """
    [DEPRECATED 2026-04-07] Use /pipeline/v2/run instead.

    Old fake-LangGraph fire-and-forget shell that suffered from "假 success" — step fn
    打 worker /admin/trigger/{task} 立刻 return 200，但 worker 那邊 background fn 被 30 sec
    waitUntil 砍掉，整條 pipeline 看似 success 實際 0 prediction 寫入。

    Will be removed 2026-04-21 after 1 week of V2 stability.
    """
    logger.warning("[Pipeline] /pipeline/run is DEPRECATED, use /pipeline/v2/run")
    try:
        from graphs.daily_pipeline import build_daily_pipeline
        pipeline = build_daily_pipeline(WORKER_URL, WORKER_AUTH)
        result = await pipeline.run(run_date=date, resume=resume)
        result["deprecation_warning"] = "Use /pipeline/v2/run — this endpoint will be removed 2026-04-21"
        return result
    except Exception as e:
        logger.exception("[Pipeline Legacy] Failed")
        return {"status": "error", "error": str(e)}
