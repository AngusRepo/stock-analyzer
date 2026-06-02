from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import modal_client
from services.finlab_execution_smoke import run_finlab_execution_smoke
from services.finlab_execution_preview_service import run_finlab_execution_preview
from services.finlab_ai_factor_miner import discover_finlab_raw_factor_candidates
from services.finlab_production_simulated_loop import (
    build_execution_loop_plan as build_production_simulated_loop_plan,
    run_production_simulated_execution_loop,
)
from services.finlab_sinopac_l5_market_data import run_finlab_l5_market_data

router = APIRouter(prefix="/finlab", tags=["finlab"])
logger = logging.getLogger(__name__)
WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "")


class FinLabBackfillRunRequest(BaseModel):
    years: int = Field(3, description="FinLab archive lookback years. Production supports 3 or 5.")
    run_id: str | None = None
    run_date: str | None = None
    write_d1: bool = True
    apply_canonical_d1: bool = True
    canonical_window_days: int = Field(7, ge=1, le=30)
    canonical_start_date: str | None = None
    canonical_end_date: str | None = None
    canonical_datasets: str | None = None
    canonical_limit_per_dataset: int | None = None
    canonical_d1_chunk_size: int | None = None
    canonical_dry_run: bool = False
    gcs_bucket: str | None = None
    gcs_prefix: str = "finlab/v4/backfill"
    callback_task: str = "finlab-v4-backfill"
    trigger_source: str = "controller"
    trigger_id: str | None = None
    force: bool = False
    continue_evening_chain: bool = False
    lanes: str | None = None
    skip_diff_counts: bool = False
    dry_run: bool = False


class FinLabExecutionSmokeRequest(BaseModel):
    allow_broker_login: bool = False
    preview_noop: bool = True


class FinLabL5MarketDataRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list)
    allow_broker_login: bool = False


class FinLabExecutionPreviewRequest(BaseModel):
    intent: dict[str, Any] = Field(default_factory=dict)
    allow_broker_login: bool = False


class FinLabProductionSimulatedLoopRequest(BaseModel):
    duration_seconds: int = Field(0, ge=0, le=300)
    poll_seconds: int = Field(10, ge=1, le=60)
    rolling_bar_seconds: int = Field(30, ge=1, le=300)
    max_symbols: int = Field(5, ge=1, le=20)
    dry_run: bool = True
    allow_worker_paper_order: bool = True


class FinLabAiFactorDiscoveryRequest(BaseModel):
    max_per_lane: int = Field(8, ge=1, le=30)
    dry_run: bool = True


def _model_dump(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


async def _callback_worker_scheduler(payload: dict[str, Any]) -> dict[str, Any]:
    """Best-effort callback to keep Worker scheduler status in sync."""
    if not WORKER_URL:
        logger.warning("[FinLab callback] STOCKVISION_WORKER_URL missing; skip task=%s", payload.get("task"))
        return {"attempted": False, "ok": False, "reason": "worker_url_missing"}
    url = f"{WORKER_URL.rstrip('/')}/api/admin/scheduler-callback"
    headers = {"Content-Type": "application/json"}
    if WORKER_AUTH:
        headers["Authorization"] = f"Bearer {WORKER_AUTH}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code != 200:
            logger.warning(
                "[FinLab callback] Worker returned %s for task=%s: %s",
                resp.status_code,
                payload.get("task"),
                resp.text[:200],
            )
            return {"attempted": True, "ok": False, "status_code": resp.status_code}
        return {"attempted": True, "ok": True, "status_code": resp.status_code}
    except Exception as exc:  # noqa: BLE001
        logger.warning("[FinLab callback] Worker unreachable task=%s: %s", payload.get("task"), exc)
        return {"attempted": True, "ok": False, "reason": exc.__class__.__name__}


def _scheduler_status_for_loop(result: dict[str, Any]) -> str:
    status = str(result.get("status") or "").strip().lower()
    if status == "completed":
        return "success"
    if status == "dry_run":
        return "skipped"
    return "error"


def _scheduler_summary_for_loop(result: dict[str, Any]) -> str:
    status = str(result.get("status") or "unknown")
    cycles_attempted = result.get("cycles_attempted")
    cycles_failed = result.get("cycles_failed")
    if cycles_attempted is not None:
        return f"production_simulated_loop {status} cycles={cycles_attempted} failed={cycles_failed}"
    reason = result.get("reason")
    return f"production_simulated_loop {status}{f' reason={reason}' if reason else ''}"


def build_finlab_backfill_modal_payload(req: FinLabBackfillRunRequest) -> dict[str, Any]:
    if req.years not in {3, 5}:
        raise ValueError("years must be 3 or 5")
    payload = {
        key: value
        for key, value in _model_dump(req).items()
        if value is not None and key != "dry_run"
    }
    payload["executor"] = "modal"
    payload["source"] = "finlab_v4_backfill"
    return payload


def _truthy_flag(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes"}


@router.post("/backfill/run")
async def run_finlab_backfill(req: FinLabBackfillRunRequest) -> dict:
    """Spawn FinLab backfill on Modal; do not run the long job in ml-controller."""
    try:
        payload = build_finlab_backfill_modal_payload(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    executor = os.environ.get("FINLAB_BACKFILL_EXECUTOR", "").strip().lower()
    if req.dry_run:
        return {
            "status": "dry_run",
            "executor": executor or "not_configured",
            "payload": payload,
        }
    if executor != "modal":
        raise HTTPException(
            status_code=409,
            detail="FINLAB_BACKFILL_EXECUTOR=modal is required before spawning Modal FinLab backfill",
        )
    return await modal_client.spawn_finlab_v4_backfill(payload)


@router.post("/execution/smoke")
async def run_finlab_execution_smoke_route(req: FinLabExecutionSmokeRequest) -> dict:
    """Read-only FinLab/Sinopac execution lane smoke check.

    This route never submits live orders. Broker login is blocked unless the
    caller explicitly sets allow_broker_login=true.
    """
    return run_finlab_execution_smoke(
        allow_broker_login=req.allow_broker_login,
        preview_noop=req.preview_noop,
    )


@router.post("/execution/l5-market-data")
async def run_finlab_l5_market_data_route(req: FinLabL5MarketDataRequest) -> dict:
    """Production-simulated L5 market-data readback.

    This route may log in for live market data when explicitly allowed, but it
    never creates, previews, submits, updates, or cancels orders.
    """
    payload = run_finlab_l5_market_data(
        symbols=req.symbols,
        allow_broker_login=req.allow_broker_login,
    )
    payload["production_like_market_data"] = True
    payload["live_submit_enabled"] = False
    payload["can_submit_real_order"] = False
    return payload


@router.post("/execution/preview")
async def run_finlab_execution_preview_route(req: FinLabExecutionPreviewRequest) -> dict:
    """Preview a StockVision order intent through the pre-pilot FinLab adapter.

    This route never submits live orders. Without an enabled broker preview
    factory it fails closed with a visible reason.
    """
    return run_finlab_execution_preview(
        intent=req.intent,
        allow_broker_login=req.allow_broker_login,
    )


async def _run_finlab_production_simulated_loop(req: FinLabProductionSimulatedLoopRequest) -> dict:
    """Run a bounded 10-second execution loop with simulated paper orders.

    dry_run=true returns the plan only. dry_run=false calls Worker
    intraday-check every poll interval, so StockVision still owns the decision
    and paper order path. This route never submits real broker orders.
    """
    plan = build_production_simulated_loop_plan(
        duration_seconds=req.duration_seconds,
        poll_seconds=req.poll_seconds,
        rolling_bar_seconds=req.rolling_bar_seconds,
        max_symbols=req.max_symbols,
    )
    if req.dry_run:
        return {"status": "dry_run", "reason": None, "plan": plan}
    if not req.allow_worker_paper_order:
        return {"status": "blocked", "reason": "worker_paper_order_not_allowed", "plan": plan, "live_submit_enabled": False}
    if not _truthy_flag(os.environ.get("FINLAB_EXECUTION_LOOP_ENABLED")):
        return {"status": "blocked", "reason": "finlab_execution_loop_disabled", "plan": plan, "live_submit_enabled": False}
    return await run_production_simulated_execution_loop(
        duration_seconds=req.duration_seconds,
        poll_seconds=req.poll_seconds,
        rolling_bar_seconds=req.rolling_bar_seconds,
        max_symbols=req.max_symbols,
        worker_url=os.environ.get("STOCKVISION_WORKER_URL", ""),
        worker_auth_token=os.environ.get("STOCKVISION_AUTH_TOKEN", ""),
    )


@router.post("/execution/production-simulated-loop")
async def run_finlab_execution_production_simulated_loop_route(req: FinLabProductionSimulatedLoopRequest) -> dict:
    """Run the production-like loop with simulated paper orders only.

    This is the preferred route name for the pre-real-order stage: live market
    data and active Worker gates are allowed, but broker submit stays disabled.
    """
    started = time.monotonic()
    run_id = f"intraday-check-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    result = await _run_finlab_production_simulated_loop(req)
    duration_ms = round((time.monotonic() - started) * 1000)
    if not req.dry_run:
        callback = await _callback_worker_scheduler({
            "task": "intraday-check",
            "status": _scheduler_status_for_loop(result),
            "summary": _scheduler_summary_for_loop(result),
            "duration_ms": duration_ms,
            "run_id": run_id,
            "error": str(result.get("reason") or "") or None,
            "metadata": {
                "controller": "ml-controller",
                "route": "/finlab/execution/production-simulated-loop",
                "mode": result.get("mode"),
                "cycles_attempted": result.get("cycles_attempted"),
                "cycles_failed": result.get("cycles_failed"),
                "paper_order_mode": result.get("paper_order_mode"),
                "live_submit_enabled": result.get("live_submit_enabled"),
                "can_submit_real_order": result.get("can_submit_real_order"),
            },
        })
        result = {**result, "scheduler_callback": callback, "scheduler_run_id": run_id}
    return result


@router.post("/ai-factor-discovery")
async def run_finlab_ai_factor_discovery_route(req: FinLabAiFactorDiscoveryRequest) -> dict:
    """Read-only FinLab API factor discovery.

    This route searches official FinLab datasets and returns research-only
    factor candidates. It does not write strategy specs or production config.
    """
    payload = discover_finlab_raw_factor_candidates(max_per_lane=req.max_per_lane)
    payload["mode"] = "dry_run" if req.dry_run else "research_payload_only"
    payload["production_effect"] = False
    return payload
