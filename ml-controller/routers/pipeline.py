"""
pipeline.py — Daily prediction pipeline endpoints

POST /pipeline/v2/run → Real LangGraph StateGraph (2026-04-07 LangGraph A+B refactor)
POST /pipeline/run    → [DEPRECATED] Old fake-LangGraph fire-and-forget shell
"""
import os
import logging
from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/pipeline", tags=["pipeline"])

WORKER_URL = os.environ.get(
    "STOCKVISION_WORKER_URL",
    "https://stockvision-worker.angus-solo-dev.workers.dev"
)
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


# ─── V2 ENDPOINT — Real LangGraph (2026-04-07) ───────────────────────────────

@router.post("/v2/run")
async def trigger_pipeline_v2(
    date: str = Query(default="", description="Run date (YYYY-MM-DD, default today TW)"),
):
    """
    LangGraph V2 daily pipeline:
      load_inputs → load_market_env → build_payloads → ml_predict
        → recommend → llm_reasons → write_d1

    State-based, checkpointed (SqliteSaver), all D1/ML calls done by ml-controller
    directly. No fire-and-forget HTTP to worker.

    Synchronous: caller waits until full pipeline completes (~2-7 min for 30-80 stocks).
    """
    from graphs.daily_pipeline_v2 import run_pipeline_v2

    logger.info(f"[Pipeline V2] Triggered: date={date or 'today'}")
    try:
        result = await run_pipeline_v2(run_date=date)
        return result
    except Exception as e:
        logger.exception("[Pipeline V2] Failed")
        return {"status": "error", "error": str(e)}


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
