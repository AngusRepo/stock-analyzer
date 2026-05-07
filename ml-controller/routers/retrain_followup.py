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

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from services import d1_client, retrain_lock
from services.cost_tracker import record_modal_call
from services.modal_client import _modal_resource_spec

logger = logging.getLogger("retrain_followup")
router = APIRouter()
WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


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
    modal_telemetry: list[dict[str, Any]] = Field(default_factory=list)
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


def _scheduler_status(status: str) -> str:
    normalized = str(status or "").strip().lower()
    if normalized in {"completed", "complete", "success", "succeeded", "ok"}:
        return "success"
    if normalized in {"skipped", "skip", "locked"}:
        return "skipped"
    if normalized in {"running", "triggered"}:
        return normalized
    return "error"


def _build_scheduler_callback_payload(payload: RetrainFollowupPayload) -> dict[str, Any]:
    scheduler_status = _scheduler_status(payload.status)
    task = "monthly-retrain" if payload.is_monthly else "retrain"
    summary_bits = [
        f"run_id={payload.run_id or payload.trained_at or '-'}",
        f"monthly={bool(payload.is_monthly)}",
        f"batches={payload.batch_count if payload.batch_count is not None else '-'}",
        f"samples={payload.total_samples}",
        f"features={payload.feature_count}",
    ]
    if payload.candidate_version:
        summary_bits.append(f"candidate={payload.candidate_version}")
    if payload.error:
        summary_bits.append(f"error={payload.error}")

    callback: dict[str, Any] = {
        "task": task,
        "status": scheduler_status,
        "summary": "retrain followup " + " ".join(summary_bits),
        "duration_ms": int(max(float(payload.elapsed_s or 0.0), 0.0) * 1000),
        "run_id": payload.run_id or payload.trained_at,
        "run_date": payload.run_date,
    }
    if payload.error or scheduler_status == "error":
        callback["error"] = payload.error or f"retrain status={payload.status}"
    return {k: v for k, v in callback.items() if v is not None}


async def _callback_worker_scheduler(payload: RetrainFollowupPayload) -> dict[str, Any]:
    if not WORKER_URL:
        return {"attempted": False, "ok": False, "reason": "STOCKVISION_WORKER_URL missing"}

    callback_payload = _build_scheduler_callback_payload(payload)
    url = f"{WORKER_URL.rstrip('/')}/api/admin/scheduler-callback"
    headers = {"Content-Type": "application/json"}
    if WORKER_AUTH:
        headers["Authorization"] = f"Bearer {WORKER_AUTH}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=callback_payload)
        return {
            "attempted": True,
            "ok": resp.status_code == 200,
            "status_code": resp.status_code,
            "task": callback_payload.get("task"),
            "response": resp.text[:300],
        }
    except Exception as exc:  # noqa: BLE001 - followup persistence remains authoritative.
        logger.warning("[RetrainFollowup] Worker scheduler callback failed: %s", exc)
        return {
            "attempted": True,
            "ok": False,
            "task": callback_payload.get("task"),
            "error": str(exc),
        }


async def _record_modal_telemetry(events: list[dict[str, Any]]) -> dict[str, Any]:
    recorded = 0
    skipped = 0
    errors: list[str] = []

    for event in events or []:
        function_name = str(event.get("function_name") or "").strip()
        compute_sec = float(event.get("compute_sec") or 0.0)
        if not function_name or compute_sec <= 0:
            skipped += 1
            continue

        spec = _modal_resource_spec(function_name)
        meta = dict(event.get("meta") or {})
        if event.get("wall_sec") is not None:
            meta["wall_sec"] = float(event["wall_sec"])
        if event.get("status"):
            meta["status"] = event.get("status")

        try:
            await record_modal_call(
                source=str(event.get("source") or "modal_followup"),
                function_name=function_name,
                compute_sec=round(compute_sec, 3),
                cpu=float(event.get("cpu") or spec["cpu"]),
                memory_mb=int(event.get("memory_mb") or spec["memory_mb"]),
                gpu=event.get("gpu", spec.get("gpu")),
                meta=meta,
            )
            recorded += 1
        except Exception as exc:  # noqa: BLE001 - callback success must not depend on telemetry.
            errors.append(f"{function_name}: {exc}")

    return {
        "recorded": recorded,
        "skipped": skipped,
        "errors": errors,
    }


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
            "modal_telemetry": payload.modal_telemetry,
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
    telemetry_status = await _record_modal_telemetry(payload.modal_telemetry)
    scheduler_callback = await _callback_worker_scheduler(payload)
    logger.info(
        f"[RetrainFollowup] {idem_key} status={payload.status} write={write_status} "
        f"gcs={payload.gcs_prefix} wid={payload.window_id} lock={payload.lock_key} "
        f"telemetry={telemetry_status['recorded']}/{len(payload.modal_telemetry or [])} "
        f"scheduler_callback={scheduler_callback}"
    )

    return {
        "status": payload.status,
        "write_status": write_status,
        "idempotency_key": idem_key,
        "received_at": received_at,
        "action": "retrain_followup",
        "lock_release": lock_release,
        "modal_telemetry": telemetry_status,
        "scheduler_callback": scheduler_callback,
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
