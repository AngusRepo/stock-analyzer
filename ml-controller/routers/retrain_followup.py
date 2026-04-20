"""
retrain_followup.py — 2026-04-20 #10 Phase 1 Webhook receiver

POST /retrain/followup
  ml-service universal_retrain 完成時 POST 這裡，取代「CCD session 等長任務結束」
  (see memory/feedback_ccd_session_discipline.md).

Idempotency: INSERT OR IGNORE into D1 webhook_log by trained_at key.
Safety-net:  18:00 TW daily cron scans GCS metadata for missed callbacks (separate).
Action:      logs only in v1 — downstream pipeline trigger stays on 17:30 cron.
             Future: optional auto-trigger pipeline via config flag.
"""
from __future__ import annotations

import os
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from services import d1_client

logger = logging.getLogger("retrain_followup")
router = APIRouter()


class RetrainFollowupPayload(BaseModel):
    trained_at: str = Field(..., description="ISO8601 UTC — idempotency key")
    gcs_prefix: str = "universal"
    window_id: int | None = None
    total_samples: int = 0
    train_samples: int = 0
    feature_count: int = 0
    elapsed_s: float = 0.0
    circuit_breaker: bool = False
    ic_summary: dict[str, float | None] = Field(default_factory=dict)


INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "") or os.environ.get("ML_CONTROLLER_TOKEN", "")


def _check_token(request: Request) -> None:
    if not INTERNAL_TOKEN:
        return  # dev / unset = accept (existing verify_token dependency is the primary gate)
    provided = request.headers.get("X-Service-Token", "")
    if provided != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="invalid service token")


@router.post("/retrain/followup")
async def retrain_followup(payload: RetrainFollowupPayload, request: Request) -> dict[str, Any]:
    """Idempotent retrain-complete callback.

    Flow:
      1. Validate service token (optional header-based).
      2. INSERT OR IGNORE into webhook_log keyed by `trained_at`.
      3. Return status: 'logged' on first-time, 'skipped_dup' on retry.

    Does NOT auto-trigger pipeline in v1 — downstream is handled by existing
    17:30 cron which picks up the new GCS model naturally. Add trigger later
    if Wei confirms need.
    """
    _check_token(request)

    received_at = datetime.now(timezone.utc).isoformat()
    idem_key = payload.trained_at

    summary = json.dumps({
        "gcs_prefix":    payload.gcs_prefix,
        "window_id":     payload.window_id,
        "samples":       payload.total_samples,
        "feature_count": payload.feature_count,
        "elapsed_s":     payload.elapsed_s,
        "cb":            payload.circuit_breaker,
        "ic":            payload.ic_summary,
    })

    # Idempotent insert. INSERT OR IGNORE returns meta.changes=0 on collision.
    sql = """
        INSERT OR IGNORE INTO webhook_log
          (idempotency_key, received_at, source, action, payload_summary, status, downstream_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    try:
        res = d1_client.execute(
            sql,
            [idem_key, received_at, "ml-service", "retrain_followup", summary, "logged", "v1_no_trigger"],
        )
    except Exception as e:
        logger.error(f"[RetrainFollowup] D1 execute failed: {e}")
        raise HTTPException(status_code=502, detail=f"D1 write failed: {e}")

    # d1_client.execute returns {"success": bool, "meta": {"changes": int, ...}, "results": [...]}
    changes = 0
    try:
        meta = res.get("meta", {}) if isinstance(res, dict) else {}
        changes = int(meta.get("changes", 0))
    except Exception:
        changes = 0

    status = "logged" if changes > 0 else "skipped_dup"
    logger.info(f"[RetrainFollowup] {idem_key} → status={status} gcs={payload.gcs_prefix} wid={payload.window_id}")

    return {
        "status":       status,
        "idempotency_key": idem_key,
        "received_at":  received_at,
        "action":       "v1_log_only",
        "summary":      {
            "gcs_prefix":    payload.gcs_prefix,
            "window_id":     payload.window_id,
            "ic_summary":    payload.ic_summary,
            "feature_count": payload.feature_count,
        },
    }
