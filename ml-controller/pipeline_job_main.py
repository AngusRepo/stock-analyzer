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

# Reuse the callback + sub-task emission helpers from the router module so
# Worker's dashboard tiles behave identically to the old implementation.
from routers.pipeline import _callback_worker, _emit_subtask_callbacks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("pipeline_job")


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
        result = await run_pipeline_v2(run_date=run_date)
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

    logger.info(
        "[JobEntry] Pipeline finished: status=%s elapsed=%dms", status, elapsed_ms
    )
    return 0 if status == "success" else 1


def main() -> None:
    exit_code = asyncio.run(_run())
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
