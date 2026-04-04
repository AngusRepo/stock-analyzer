"""
pipeline.py — LangGraph-style daily pipeline endpoint (P1#11)

POST /pipeline/run → Execute daily pipeline (screener → ML → recommend)
                     with checkpoint, retry 3x, and auto-pass
"""
import os
import logging
from fastapi import APIRouter, Query

from graphs.daily_pipeline import build_daily_pipeline

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/pipeline", tags=["pipeline"])

WORKER_URL = os.environ.get(
    "STOCKVISION_WORKER_URL",
    "https://stockvision-worker.angus-solo-dev.workers.dev"
)
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


@router.post("/run")
async def trigger_pipeline(
    resume: bool = Query(default=True, description="Resume from checkpoint if available"),
    date: str = Query(default="", description="Run date (YYYY-MM-DD, default today)"),
):
    """
    P1#11 Daily Pipeline with StateGraph:
    1. Screener → 2. ML Predict → 3. Recommend
    Each step retries 3x with exponential backoff.
    State checkpointed after each step (resumable).
    """
    logger.info(f"[Pipeline] Triggered: resume={resume}, date={date or 'today'}")
    try:
        pipeline = build_daily_pipeline(WORKER_URL, WORKER_AUTH)
        result = await pipeline.run(run_date=date, resume=resume)
        return result
    except Exception as e:
        logger.exception("[Pipeline] Failed")
        return {"status": "error", "error": str(e)}
