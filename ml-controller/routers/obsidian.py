"""
obsidian.py — Obsidian note generation endpoints

POST /obsidian/daily  → Generate Daily + Trade + Pipeline notes
POST /obsidian/weekly → Generate Weekly Review note
GET  /obsidian/health → Query vault repo last commit; flag stale (>24h)
"""

import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from datetime import datetime, timezone, timedelta
import logging
from typing import Any

from services.wiki_writer import (
    bootstrap_wiki_vault,
    build_wiki_recall_context,
    build_wiki_recall_receipt,
    inspect_wiki_vault,
)

logger = logging.getLogger("obsidian")

router = APIRouter()

TW_TZ = timezone(timedelta(hours=8))
GITHUB_API = "https://api.github.com"


class ObsidianRequest(BaseModel):
    date: str | None = None


class WikiNoteRequest(BaseModel):
    product: str = "StockVision"
    type: str = "session"
    title: str
    body: str
    slug: str | None = None
    status: str | None = None
    research_track: str | None = None
    source_refs: list[str] = Field(default_factory=list)
    source_files: list[str] = Field(default_factory=list)
    related: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    confirm: bool = False
    update_moc: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class WikiBootstrapRequest(BaseModel):
    product: str = "StockVision"
    overwrite: bool = False
    confirm: bool = False


class WikiSearchRequest(BaseModel):
    query: str
    product: str = "StockVision"
    max_results: int = 10
    include_archived: bool = False


class WikiRecallRequest(BaseModel):
    query: str
    product: str = "StockVision"
    max_results: int = 5
    include_archived: bool = False


class WikiHealthRequest(BaseModel):
    product: str = "StockVision"
    stale_days: int = 3


def _request_payload(req: BaseModel) -> dict[str, Any]:
    if hasattr(req, "model_dump"):
        return req.model_dump()
    return req.dict()


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

@router.post("/wiki-note/dry-run")
async def build_wiki_note_preview(req: WikiNoteRequest):
    """Build a structured Wei-Codex wiki note payload without writing it."""
    from services.wiki_writer import build_wiki_note_dry_run

    try:
        return build_wiki_note_dry_run(_request_payload(req))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/wiki-note")
async def write_wiki_note(req: WikiNoteRequest):
    """Fail-closed wiki write endpoint."""
    if req.confirm is not True:
        raise HTTPException(status_code=400, detail="wiki note write requires confirm=true")

    from services.wiki_writer import append_moc_links_to_local_vault, build_wiki_note_dry_run, write_wiki_note_to_local_vault

    try:
        preview = build_wiki_note_dry_run(_request_payload(req))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    local_vault = os.environ.get("OBSIDIAN_WIKI_VAULT_PATH", "").strip()
    if local_vault:
        try:
            result = write_wiki_note_to_local_vault(_request_payload(req), vault_root=local_vault)
            if req.update_moc:
                result = {
                    **result,
                    "moc_update": append_moc_links_to_local_vault(result, vault_root=local_vault),
                }
            return result
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    repo = os.environ.get("GITHUB_REPO_WIKI", "").strip()
    if not repo:
        raise HTTPException(
            status_code=501,
            detail={
                "reason": "GITHUB_REPO_WIKI not configured",
                "preview": preview,
            },
        )
    raise HTTPException(status_code=501, detail="wiki note persistence not wired")


@router.post("/wiki-bootstrap")
async def bootstrap_wiki_vault_endpoint(req: WikiBootstrapRequest):
    """Fail-closed local vault bootstrap endpoint."""
    if req.confirm is not True:
        raise HTTPException(status_code=400, detail="wiki bootstrap requires confirm=true")

    local_vault = os.environ.get("OBSIDIAN_WIKI_VAULT_PATH", "").strip()
    if not local_vault:
        raise HTTPException(status_code=501, detail="OBSIDIAN_WIKI_VAULT_PATH not configured")

    try:
        return bootstrap_wiki_vault(
            local_vault,
            product=req.product,
            overwrite=req.overwrite,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/wiki-search")
async def search_wiki_notes(req: WikiSearchRequest):
    """Search the Wei-Codex wiki before filling memory-sensitive gaps."""
    local_vault = os.environ.get("OBSIDIAN_WIKI_VAULT_PATH", "").strip()
    if not local_vault:
        raise HTTPException(status_code=501, detail="OBSIDIAN_WIKI_VAULT_PATH not configured")

    from services.wiki_writer import search_wiki_vault

    try:
        return search_wiki_vault(
            req.query,
            vault_root=local_vault,
            product=req.product,
            max_results=req.max_results,
            include_archived=req.include_archived,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/wiki-recall")
async def recall_wiki_context(req: WikiRecallRequest):
    """Build a citation-ready wiki context pack for no-guess memory recovery."""
    local_vault = os.environ.get("OBSIDIAN_WIKI_VAULT_PATH", "").strip()
    if not local_vault:
        raise HTTPException(status_code=501, detail="OBSIDIAN_WIKI_VAULT_PATH not configured")

    try:
        return build_wiki_recall_context(
            req.query,
            vault_root=local_vault,
            product=req.product,
            max_results=req.max_results,
            include_archived=req.include_archived,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/wiki-recall-receipt")
async def build_wiki_recall_receipt_endpoint(req: WikiRecallRequest):
    """Build a copy-pasteable receipt proving wiki recall was attempted."""
    local_vault = os.environ.get("OBSIDIAN_WIKI_VAULT_PATH", "").strip()
    if not local_vault:
        raise HTTPException(status_code=501, detail="OBSIDIAN_WIKI_VAULT_PATH not configured")

    try:
        return build_wiki_recall_receipt(
            req.query,
            vault_root=local_vault,
            product=req.product,
            max_results=req.max_results,
            include_archived=req.include_archived,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/wiki-health")
async def inspect_wiki_health(req: WikiHealthRequest = WikiHealthRequest()):
    """Inspect local Wei-Codex wiki structure and recent session activity."""
    local_vault = os.environ.get("OBSIDIAN_WIKI_VAULT_PATH", "").strip()
    if not local_vault:
        raise HTTPException(status_code=501, detail="OBSIDIAN_WIKI_VAULT_PATH not configured")

    try:
        return inspect_wiki_vault(
            vault_root=local_vault,
            product=req.product,
            stale_days=req.stale_days,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
        import httpx

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
