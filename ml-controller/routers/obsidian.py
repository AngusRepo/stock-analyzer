"""
obsidian.py — Obsidian note generation endpoints

POST /obsidian/daily  → Generate Daily + Trade + Pipeline notes
POST /obsidian/weekly → Generate Weekly Review note
GET  /obsidian/health → Query vault repo last commit; flag stale (>24h)
"""

import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import logging

import httpx

logger = logging.getLogger("obsidian")

router = APIRouter()

TW_TZ = timezone(timedelta(hours=8))
GITHUB_API = "https://api.github.com"


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


# ── Health check (2026-04-21 #13 / memory project_obsidian_brain_stale) ──────
# Query GitHub vault repo's latest commit; flag stale when >24h. This is the
# "daily health check" Wei proposed in 2026-04-09 memory when the 4/5-4/9
# stoppage was discovered. Vault repo is the source-of-truth — file writes
# always produce a Git commit, so commit staleness == obsidian staleness.

_STALE_THRESHOLD_HOURS = 30  # 24 + 6 slack for cron timing / weekend gap


@router.get("/health")
async def obsidian_health():
    """
    Check vault repo's last commit timestamp; return staleness flag.

    Returns 200 always (never 500) — this is a monitoring endpoint, not a
    deployment gate. Callers decide how to react to `is_stale=true`.
    """
    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPO_VAULT", "")
    if not token or not repo:
        return {
            "status": "unknown",
            "reason": "GITHUB_TOKEN or GITHUB_REPO_VAULT missing in env",
            "is_stale": False,
        }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo}/commits",
                params={"per_page": 1},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
            )
        if resp.status_code != 200:
            return {
                "status": "api_error",
                "http_status": resp.status_code,
                "reason": (resp.text or "")[:200],
                "is_stale": False,
            }
        commits = resp.json()
        if not commits:
            return {"status": "empty_repo", "is_stale": True}
        last = commits[0]
        committed_at = last["commit"]["committer"]["date"]  # ISO UTC
        committed_dt = datetime.fromisoformat(committed_at.replace("Z", "+00:00"))
        hours_since = (datetime.now(timezone.utc) - committed_dt).total_seconds() / 3600
        is_stale = hours_since > _STALE_THRESHOLD_HOURS
        return {
            "status": "stale" if is_stale else "ok",
            "last_commit_at":  committed_at,
            "hours_since":     round(hours_since, 1),
            "stale_threshold_hours": _STALE_THRESHOLD_HOURS,
            "is_stale":        is_stale,
            "last_sha":        last["sha"][:8],
            "last_message":    (last["commit"]["message"] or "")[:200],
            "vault_repo":      repo,
        }
    except Exception as e:
        return {
            "status": "error",
            "reason": f"{type(e).__name__}: {e}",
            "is_stale": False,
        }
