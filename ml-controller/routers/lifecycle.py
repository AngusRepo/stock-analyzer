"""
lifecycle.py — Model Lifecycle Management endpoints (P1#8)

POST /lifecycle/check   → Weekly lifecycle evaluation
"""
import logging
from fastapi import APIRouter, Query

from services.lifecycle_service import run_lifecycle_check

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/lifecycle", tags=["lifecycle"])


@router.post("/check")
async def trigger_lifecycle_check(
    degrade: float = Query(default=0.45, ge=0.30, le=0.55,
                           description="Degrade threshold (30d accuracy)"),
    restore: float = Query(default=0.55, ge=0.45, le=0.70,
                           description="Restore threshold (30d accuracy)"),
):
    """
    P1#8 Weekly Model Lifecycle Check:
    1. Fetch 30d/90d model accuracies from D1
    2. Evaluate: active → degraded (2 weeks below) → restore (above threshold)
    3. Balance guard: min 3 price + 3 feature models
    4. Suggest replacements from candidate library
    5. Write lifecycle state + events to D1
    """
    logger.info(f"[Lifecycle] Triggered: degrade={degrade}, restore={restore}")
    try:
        return await run_lifecycle_check(degrade, restore)
    except Exception as e:
        logger.exception("[Lifecycle] Check failed")
        return {"status": "error", "error": str(e)}
