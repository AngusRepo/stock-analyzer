"""Screener V2 Cloud Run Job trigger.

The Worker owns screener semantics, but the full-market run is too large for a
request-scoped Worker execution. This endpoint only starts the dedicated
Cloud Run Job; the Job runs to completion and callbacks Worker.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/screener", tags=["screener"])

SCREENER_JOB_NAME = os.environ.get("SCREENER_JOB_NAME", "screener-v2").strip() or "screener-v2"
_screener_jobs_client = CloudRunJobsClient(job_name=SCREENER_JOB_NAME)


class ScreenerRunRequest(BaseModel):
    run_date: Optional[str] = None
    chain_run_id: Optional[str] = None


@router.post("/v2/run")
async def trigger_screener_v2(
    req: ScreenerRunRequest = ScreenerRunRequest(),
    date: str = Query(default="", description="Run date (YYYY-MM-DD, default today TW)"),
    chain_run_id: str = Query(default="", description="Evening-chain/finalizer run id for continuation"),
):
    run_date = (req.run_date or date or "").strip()
    continuation_run_id = (req.chain_run_id or chain_run_id or "").strip()
    run_id = f"screener-v2-{int(time.time())}-{uuid.uuid4().hex[:8]}"

    env_overrides = {
        "SCREENER_RUN_DATE": run_date,
        "SCREENER_RUN_ID": run_id,
        "SCREENER_CHAIN_RUN_ID": continuation_run_id,
        "SCREENER_CALLBACK_TASK": "screener",
    }

    try:
        execution = _screener_jobs_client.run_job(env_overrides=env_overrides)
    except JobAlreadyRunningError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"{SCREENER_JOB_NAME} already has an active execution",
                "execution_id": e.execution.execution_id,
                "execution_name": e.execution.execution_name,
                "run_id": run_id,
                "date": run_date or "today",
            },
        ) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("[screener/v2/run] Failed to trigger Cloud Run Job")
        raise HTTPException(
            status_code=502,
            detail=f"Cloud Run Jobs trigger failed: {type(e).__name__}: {e}",
        ) from e

    return JSONResponse(
        status_code=202,
        content={
            "status": "triggered",
            "run_id": run_id,
            "date": run_date or "today",
            "chain_run_id": continuation_run_id or None,
            "execution_id": execution.execution_id,
            "execution_name": execution.execution_name,
            "note": "screener-v2 running as Cloud Run Job; Worker scheduler log will be updated via callback",
        },
    )
