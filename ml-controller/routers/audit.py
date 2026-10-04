"""
audit.py — Audit endpoints

POST /audit/weekly → Generate weekly performance diagnosis report
POST /audit/shap   → Trigger SHAP feature importance audit (Modal GPU)
"""
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from graphs.weekly_audit_graph import generate_weekly_audit
from services.modal_client import shap_audit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/audit", tags=["audit"])


@router.post("/weekly")
async def trigger_weekly_audit():
    """
    P2#16: Generate weekly AI audit report.
    Reads L1/L2/L3 data, computes diagnosis, returns markdown report.
    """
    logger.info("[Audit] Generating weekly report...")
    try:
        return await generate_weekly_audit()
    except Exception as e:
        logger.exception("[Audit] Failed")
        return {"status": "error", "error": str(e)}


class ShapRequest(BaseModel):
    shap_samples: int = 5000


@router.post("/shap")
async def trigger_shap_audit(req: Optional[ShapRequest] = None):
    """Trigger SHAP Feature Importance Audit on Modal GPU (T4)."""
    payload = {"shap_samples": req.shap_samples if req else 5000}
    logger.info(f"[Audit/SHAP] Triggering with {payload['shap_samples']} samples...")
    try:
        result = await shap_audit(payload)
        if "error" in result:
            return {"status": "error", "error": result["error"]}
        logger.info(f"[Audit/SHAP] Done: {len(result.get('features', []))} features ranked")
        return result
    except Exception as e:
        logger.exception("[Audit/SHAP] Failed")
        return {"status": "error", "error": str(e)}


class WeeklyOperationsRequest(BaseModel):
    task: str
    run_date: str
    run_id: str
    scheduler_ticket_id: str | None = None
    scheduler_run_id: str | None = None


@router.post('/weekly_operations/run')
def trigger_weekly_operations(req: WeeklyOperationsRequest):
    from datetime import date
    import os
    from services.weekly_operations import TASKS
    from services.cloud_run_jobs_client import CloudRunJobsClient
    if req.task not in TASKS or not req.run_id or len(req.run_id) > 240:
        raise HTTPException(422, 'weekly_operations_identity_invalid')
    try:
        date.fromisoformat(req.run_date)
    except ValueError as exc:
        raise HTTPException(422, 'weekly_operations_date_invalid') from exc
    if bool(req.scheduler_ticket_id) != bool(req.scheduler_run_id):
        raise HTTPException(422, 'weekly_operations_ticket_identity_incomplete')
    execution = CloudRunJobsClient(job_name=os.environ.get('OPTUNA_RESEARCH_JOB_NAME', 'optuna-research-sweep')).run_job(
        env_overrides={'OPTUNA_JOB_MODE':'weekly_operations', 'OPTUNA_RUN_DATE':req.run_date,
            'OPTUNA_RUN_ID':req.run_id, 'OPTUNA_CALLBACK_TASK':req.task,
            'OPTUNA_SCHEDULER_TICKET_ID':req.scheduler_ticket_id or '',
            'OPTUNA_SCHEDULER_RUN_ID':req.scheduler_run_id or ''}, reject_if_running=False)
    return {'status':'triggered','backend':'cloud_run_job','run_id':req.run_id,
            'execution_id':execution.execution_id,'execution_name':execution.execution_name}
