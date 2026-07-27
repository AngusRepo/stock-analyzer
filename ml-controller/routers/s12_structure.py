"""Cloud Run Job trigger for the durable S12 structure batch."""
from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/s12-structure", tags=["s12-structure"])

S12_STRUCTURE_JOB_NAME = os.environ.get(
    "S12_STRUCTURE_JOB_NAME", "s12-structure-batch",
).strip() or "s12-structure-batch"
_jobs = CloudRunJobsClient(job_name=S12_STRUCTURE_JOB_NAME)


class S12StructureRunRequest(BaseModel):
    run_date: str
    chain_run_id: str | None = None
    source: Literal["evening_chain", "historical_shadow", "manual_repair"] = "evening_chain"


@router.post("/batch/run")
async def trigger_s12_structure_batch(req: S12StructureRunRequest):
    run_date = req.run_date.strip()[:10]
    if len(run_date) != 10:
        raise HTTPException(status_code=400, detail="run_date must use YYYY-MM-DD")
    identity = f"{run_date}:{req.source}"
    run_id = f"s12-structure-{run_date}-{uuid.uuid5(uuid.NAMESPACE_URL, identity).hex[:16]}"
    try:
        execution = _jobs.run_job(env_overrides={
            "S12_STRUCTURE_RUN_DATE": run_date,
            "S12_STRUCTURE_RUN_ID": run_id,
            "S12_STRUCTURE_RUN_SOURCE": req.source,
            "S12_STRUCTURE_CHAIN_RUN_ID": (req.chain_run_id or "").strip(),
        })
    except JobAlreadyRunningError as exc:
        raise HTTPException(status_code=409, detail={
            "message": f"{S12_STRUCTURE_JOB_NAME} already has an active execution",
            "execution_id": exc.execution.execution_id,
            "run_id": run_id,
            "date": run_date,
        }) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to trigger S12 structure batch")
        raise HTTPException(
            status_code=502,
            detail=f"Cloud Run Jobs trigger failed: {type(exc).__name__}: {exc}",
        ) from exc
    return {
        "status": "triggered",
        "run_id": run_id,
        "date": run_date,
        "execution_id": execution.execution_id,
        "execution_name": execution.execution_name,
    }
