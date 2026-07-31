"""Cloud Run Job trigger for the durable S12 structure batch."""
from __future__ import annotations

import json
import logging
import os
import re
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
    source: Literal["evening_chain", "historical_shadow", "manual_repair", "intraday_watch", "intraday_session"] = "evening_chain"
    symbols: list[str] | None = None


@router.post("/batch/run")
async def trigger_s12_structure_batch(req: S12StructureRunRequest):
    run_date = req.run_date.strip()[:10]
    if len(run_date) != 10:
        raise HTTPException(status_code=400, detail="run_date must use YYYY-MM-DD")
    symbols = list(dict.fromkeys(
        str(value).strip().upper()
        for value in (req.symbols or [])
        if str(value).strip()
    ))
    if len(symbols) > 200:
        raise HTTPException(status_code=400, detail="symbols cannot exceed 200")
    invalid_symbols = [value for value in symbols if re.fullmatch(r"[0-9A-Z]{4,8}", value) is None]
    if invalid_symbols:
        raise HTTPException(status_code=400, detail=f"invalid Taiwan symbols: {invalid_symbols[:5]}")
    if req.source == "intraday_watch" and not symbols:
        raise HTTPException(status_code=400, detail="intraday_watch requires symbols")
    if req.source != "intraday_watch" and symbols:
        raise HTTPException(status_code=400, detail="symbols are only valid for intraday_watch")
    chain_run_id = (req.chain_run_id or "").strip()
    identity = f"{run_date}:{req.source}:{chain_run_id}:{','.join(symbols)}"
    run_id = f"s12-structure-{run_date}-{uuid.uuid5(uuid.NAMESPACE_URL, identity).hex[:16]}"
    env_overrides = {
        "S12_STRUCTURE_RUN_DATE": run_date,
        "S12_STRUCTURE_RUN_ID": run_id,
        "S12_STRUCTURE_RUN_SOURCE": req.source,
        "S12_STRUCTURE_CHAIN_RUN_ID": chain_run_id,
    }
    if symbols:
        env_overrides["S12_STRUCTURE_SYMBOLS_JSON"] = json.dumps(symbols, separators=(",", ":"))
    try:
        execution = _jobs.run_job(env_overrides=env_overrides)
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
