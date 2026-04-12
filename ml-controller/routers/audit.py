"""
audit.py — Audit endpoints

POST /audit/weekly → Generate weekly performance diagnosis report
POST /audit/shap   → Trigger SHAP feature importance audit (Modal GPU)
"""
import logging
from typing import Optional
from fastapi import APIRouter
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
