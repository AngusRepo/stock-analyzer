"""
audit.py — Weekly AI Audit Report endpoint (P2#16)

POST /audit/weekly → Generate weekly performance diagnosis report
"""
import logging
from fastapi import APIRouter

from graphs.weekly_audit_graph import generate_weekly_audit

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
