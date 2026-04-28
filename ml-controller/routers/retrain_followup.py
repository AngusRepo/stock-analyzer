"""
POST /retrain/followup

Run-level monthly retrain callback receiver.

ml-service / Modal orchestrator reports the final retrain outcome here so the
controller can:
1. upsert one authoritative status row in D1 webhook_log
2. release the long-running retrain lock
3. expose success/failure truth for later cron / UI / debugging
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from services import d1_client, retrain_lock

logger = logging.getLogger("retrain_followup")
router = APIRouter()


class RetrainFollowupPayload(BaseModel):
    run_id: str | None = None
    trained_at: str | None = Field(default=None, description="ISO8601 UTC fallback idempotency key")
    lock_key: str | None = None
    run_date: str | None = None
    is_monthly: bool | None = None
    batch_count: int | None = None
    gcs_prefix: str = "universal"
    candidate_version: str | None = None
    challenger_registrations: dict[str, Any] = Field(default_factory=dict)
    window_id: int | None = None
    total_samples: int = 0
    train_samples: int = 0
    feature_count: int = 0
    elapsed_s: float = 0.0
    circuit_breaker: bool = False
    ic_summary: dict[str, float | None] = Field(default_factory=dict)
    status: str = "completed"
    error: str | None = None
    stages: dict[str, Any] = Field(default_factory=dict)


INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "") or os.environ.get("ML_CONTROLLER_TOKEN", "")


def _check_token(request: Request) -> None:
    if not INTERNAL_TOKEN:
        return
    provided = request.headers.get("X-Service-Token", "")
    if provided != INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="invalid service token")


@router.post("/retrain/followup")
async def retrain_followup(payload: RetrainFollowupPayload, request: Request) -> dict[str, Any]:
    _check_token(request)

    received_at = datetime.now(timezone.utc).isoformat()
    idem_key = payload.run_id or payload.trained_at
    if not idem_key:
        raise HTTPException(status_code=400, detail="run_id or trained_at is required")

    lock_release = {
        "attempted": False,
        "released": False,
        "error": None,
    }
    downstream_notes = "no_lock_key"
    if payload.lock_key:
        lock_release["attempted"] = True
        try:
            retrain_lock.release(payload.lock_key)
            lock_release["released"] = True
            downstream_notes = "lock_released"
        except Exception as e:
            lock_release["error"] = str(e)
            downstream_notes = "lock_release_failed"
            logger.error(f"[RetrainFollowup] lock release failed: key={payload.lock_key} error={e}")

    summary = json.dumps(
        {
            "run_id": payload.run_id,
            "trained_at": payload.trained_at,
            "lock_key": payload.lock_key,
            "run_date": payload.run_date,
            "is_monthly": payload.is_monthly,
            "batch_count": payload.batch_count,
            "gcs_prefix": payload.gcs_prefix,
            "candidate_version": payload.candidate_version,
            "challenger_registrations": payload.challenger_registrations,
            "window_id": payload.window_id,
            "total_samples": payload.total_samples,
            "train_samples": payload.train_samples,
            "feature_count": payload.feature_count,
            "elapsed_s": payload.elapsed_s,
            "circuit_breaker": payload.circuit_breaker,
            "ic_summary": payload.ic_summary,
            "status": payload.status,
            "error": payload.error,
            "stages": payload.stages,
        },
        ensure_ascii=False,
    )

    sql = """
        INSERT INTO webhook_log
          (idempotency_key, received_at, source, action, payload_summary, status, downstream_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          received_at = excluded.received_at,
          source = excluded.source,
          action = excluded.action,
          payload_summary = excluded.payload_summary,
          status = excluded.status,
          downstream_notes = excluded.downstream_notes
    """

    try:
        res = d1_client.execute(
            sql,
            [
                idem_key,
                received_at,
                "ml-service",
                "retrain_followup",
                summary,
                payload.status,
                downstream_notes,
            ],
        )
    except Exception as e:
        logger.error(f"[RetrainFollowup] D1 execute failed: {e}")
        raise HTTPException(status_code=502, detail=f"D1 write failed: {e}")

    changes = 0
    try:
        meta = res.get("meta", {}) if isinstance(res, dict) else {}
        changes = int(meta.get("changes", 0))
    except Exception:
        changes = 0

    write_status = "upserted" if changes > 0 else "unchanged"
    logger.info(
        f"[RetrainFollowup] {idem_key} status={payload.status} write={write_status} "
        f"gcs={payload.gcs_prefix} wid={payload.window_id} lock={payload.lock_key}"
    )

    return {
        "status": payload.status,
        "write_status": write_status,
        "idempotency_key": idem_key,
        "received_at": received_at,
        "action": "retrain_followup",
        "lock_release": lock_release,
        "summary": {
            "run_id": payload.run_id,
            "trained_at": payload.trained_at,
            "lock_key": payload.lock_key,
            "run_date": payload.run_date,
            "is_monthly": payload.is_monthly,
            "batch_count": payload.batch_count,
            "gcs_prefix": payload.gcs_prefix,
            "window_id": payload.window_id,
            "feature_count": payload.feature_count,
            "error": payload.error,
        },
    }
