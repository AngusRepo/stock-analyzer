"""
obsidian.py — Obsidian note generation endpoints

POST /obsidian/daily  → Generate Daily + Trade + Pipeline notes
POST /obsidian/weekly → Generate Weekly Review note
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import logging

logger = logging.getLogger("obsidian")

router = APIRouter()

TW_TZ = timezone(timedelta(hours=8))


class ObsidianRequest(BaseModel):
    date: str | None = None


@router.post("/daily")
async def generate_daily_notes(req: ObsidianRequest = ObsidianRequest()):
    """Generate Daily + Trade + Pipeline notes for the given date."""
    from services.obsidian_writer import ObsidianWriter

    date = req.date or datetime.now(TW_TZ).strftime("%Y-%m-%d")
    logger.info(f"[Obsidian] POST /daily date={date}")

    try:
        writer = ObsidianWriter()
        result = await writer.generate_daily(date)
        return result
    except Exception as e:
        logger.error(f"[Obsidian] daily failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/weekly")
async def generate_weekly_review(req: ObsidianRequest = ObsidianRequest()):
    """Generate Weekly Review note."""
    from services.obsidian_writer import ObsidianWriter

    date = req.date or datetime.now(TW_TZ).strftime("%Y-%m-%d")
    logger.info(f"[Obsidian] POST /weekly date={date}")

    try:
        writer = ObsidianWriter()
        result = await writer.generate_weekly(date)
        return result
    except Exception as e:
        logger.error(f"[Obsidian] weekly failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
