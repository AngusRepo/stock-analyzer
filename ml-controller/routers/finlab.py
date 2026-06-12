from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.finlab_execution_smoke import run_finlab_execution_smoke
from services.finlab_execution_preview_service import run_finlab_execution_preview
from services.finlab_live_submit_service import run_finlab_live_submit
from services.finlab_production_simulated_loop import (
    build_execution_loop_plan as build_production_simulated_loop_plan,
    run_production_simulated_execution_loop,
)
from services.finlab_sinopac_l5_market_data import run_finlab_l5_market_data

router = APIRouter(prefix="/finlab", tags=["finlab"])

DEFAULT_CONTROLLER_PUBLIC_URL = "https://ml-controller-530028717113.asia-east1.run.app"
D1_PROXY_ALLOWED_READ = {"SELECT", "PRAGMA"}
D1_PROXY_ALLOWED_DML = {"INSERT", "UPDATE", "DELETE", "REPLACE"}


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


class FinLabD1QueryRequest(BaseModel):
    sql: str
    params: list[Any] = Field(default_factory=list)


class FinLabD1BatchStatement(BaseModel):
    sql: str
    params: list[Any] = Field(default_factory=list)


class FinLabD1BatchRequest(BaseModel):
    statements: list[FinLabD1BatchStatement]
    chunk_size: int = Field(250, ge=1, le=500)


class FinLabBackfillCallbackRequest(BaseModel):
    task: str = "finlab-v4-backfill"
    status: str
    summary: str = ""
    duration_ms: int = 0
    run_id: str | None = None
    run_date: str | None = None
    error: str | None = None
    continue_evening_chain: bool = False
    result: dict[str, Any] = Field(default_factory=dict)


class FinLabExecutionSmokeRequest(BaseModel):
    allow_broker_login: bool = False
    preview_noop: bool = True


class FinLabL5MarketDataRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list)
    allow_broker_login: bool = False


class FinLabExecutionPreviewRequest(BaseModel):
    intent: dict[str, Any] = Field(default_factory=dict)
    allow_broker_login: bool = False


class FinLabLiveSubmitRequest(BaseModel):
    intent: dict[str, Any] = Field(default_factory=dict)
    allow_live_submit: bool = False


class FinLabProductionSimulatedLoopRequest(BaseModel):
    duration_seconds: int = Field(0, ge=0, le=300)
    poll_seconds: int = Field(10, ge=1, le=60)
    rolling_bar_seconds: int = Field(30, ge=1, le=300)
    max_symbols: int = Field(5, ge=1, le=20)
    dry_run: bool = True
    allow_worker_paper_order: bool = True


def _model_dump(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _controller_base_url() -> str:
    return (
        os.environ.get("ML_CONTROLLER_PUBLIC_URL", "").strip()
        or os.environ.get("ML_CONTROLLER_URL", "").strip()
        or DEFAULT_CONTROLLER_PUBLIC_URL
    ).rstrip("/")


def _controller_token() -> str:
    return (
        os.environ.get("ML_CONTROLLER_TOKEN", "").strip()
        or os.environ.get("ML_CONTROLLER_SECRET", "").strip()
        or os.environ.get("INTERNAL_TOKEN", "").strip()
    )


def _sql_verb(sql: str) -> str:
    cleaned = (sql or "").strip()
    if not cleaned:
        raise ValueError("sql is required")
    if ";" in cleaned:
        raise ValueError("multiple SQL statements are not allowed")
    return cleaned.split(None, 1)[0].upper()


def _validate_d1_proxy_sql(sql: str, *, allow_read: bool, allow_dml: bool) -> str:
    verb = _sql_verb(sql)
    allowed: set[str] = set()
    if allow_read:
        allowed.update(D1_PROXY_ALLOWED_READ)
    if allow_dml:
        allowed.update(D1_PROXY_ALLOWED_DML)
    if verb not in allowed:
        raise ValueError(f"SQL verb not allowed for FinLab D1 proxy: {verb}")
    return verb


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
    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    worker_token = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
    if worker_url:
        payload["callback_url"] = f"{worker_url}/api/admin/scheduler-callback"
    if worker_token:
        payload["callback_token"] = worker_token
    controller_base_url = _controller_base_url()
    controller_token = _controller_token()
    if controller_base_url:
        payload["controller_callback_url"] = f"{controller_base_url}/finlab/backfill/callback"
        payload["controller_d1_query_url"] = f"{controller_base_url}/finlab/backfill/d1/query"
        payload["controller_d1_batch_url"] = f"{controller_base_url}/finlab/backfill/d1/batch"
    if controller_token:
        payload["controller_token"] = controller_token
    return payload


def _truthy_flag(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def _int_env(name: str, default: int) -> int:
    try:
        value = int(str(os.environ.get(name) or "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _finlab_backfill_prefix() -> str:
    return os.environ.get("FINLAB_BACKFILL_GCS_PREFIX", "finlab/v4/backfill").strip().strip("/") or "finlab/v4/backfill"


def _long_sequence_base_5y_prefix(bucket_name: str) -> str:
    explicit = os.environ.get("FINLAB_LONG_SEQUENCE_5Y_BASE_PREFIX", "").strip().rstrip("/")
    if explicit:
        return explicit
    run_id = os.environ.get("FINLAB_LONG_SEQUENCE_5Y_BASE_RUN_ID", "finlab-v4-5y-20260518-024944").strip()
    return f"gs://{bucket_name}/{_finlab_backfill_prefix()}/{run_id}"


async def _maybe_spawn_long_sequence_refresh(body: dict[str, Any]) -> dict[str, Any]:
    """Refresh long-history sequence prep after a successful daily 3Y FinLab run."""
    if not _truthy_flag(os.environ.get("FINLAB_LONG_SEQUENCE_REFRESH_ENABLED", "1")):
        return {"status": "skipped", "reason": "disabled"}
    if str(body.get("status") or "").lower() != "success":
        return {"status": "skipped", "reason": "non_success_backfill"}

    result = body.get("result") if isinstance(body.get("result"), dict) else {}
    run_id = str(result.get("run_id") or body.get("run_id") or "").strip()
    if not run_id or "-3y-" not in run_id:
        return {"status": "skipped", "reason": "not_daily_3y_backfill", "run_id": run_id}

    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        return {"status": "skipped", "reason": "GCS_BUCKET_NAME_not_configured"}

    output_prefix = os.environ.get("FINLAB_LONG_SEQUENCE_OUTPUT_PREFIX", "universal/sequence_long/latest").strip().strip("/")
    tail_prefix = f"gs://{bucket_name}/{_finlab_backfill_prefix()}/{run_id}"
    payload = {
        "source_gcs_prefixes": [
            _long_sequence_base_5y_prefix(bucket_name),
            tail_prefix,
        ],
        "output_gcs_prefix": output_prefix,
        "min_len": _int_env("FINLAB_LONG_SEQUENCE_MIN_LEN", 65),
        "batch_size": _int_env("FINLAB_LONG_SEQUENCE_BATCH_SIZE", 512),
        "trigger_source": "finlab_backfill_controller_callback",
        "trigger_run_id": run_id,
        "run_date": body.get("run_date"),
    }

    from services import modal_client

    spawned = await modal_client.build_finlab_long_sequence_prep(payload, fire_and_forget=True)
    return {
        "status": spawned.get("status", "spawned"),
        "function": "build_finlab_long_sequence_prep",
        "output_gcs_prefix": output_prefix,
        "source_gcs_prefixes": payload["source_gcs_prefixes"],
        "trigger_run_id": run_id,
    }


@router.post("/backfill/run")
async def run_finlab_backfill(req: FinLabBackfillRunRequest) -> dict:
    """Spawn FinLab backfill on Modal; do not run the long job in ml-controller."""
    try:
        payload = build_finlab_backfill_modal_payload(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    executor = os.environ.get("FINLAB_BACKFILL_EXECUTOR", "").strip().lower()
    if req.dry_run:
        safe_payload = {
            **payload,
            "callback_token": "***" if payload.get("callback_token") else "",
            "controller_token": "***" if payload.get("controller_token") else "",
        }
        return {
            "status": "dry_run",
            "executor": executor or "not_configured",
            "payload": safe_payload,
        }
    if req.continue_evening_chain and not (payload.get("callback_url") and payload.get("callback_token")):
        raise HTTPException(
            status_code=409,
            detail="STOCKVISION_WORKER_URL and STOCKVISION_AUTH_TOKEN are required for FinLab evening-chain callback",
        )
    if not (
        payload.get("controller_callback_url")
        and payload.get("controller_d1_query_url")
        and payload.get("controller_d1_batch_url")
        and payload.get("controller_token")
    ):
        raise HTTPException(
            status_code=409,
            detail="ML_CONTROLLER_PUBLIC_URL and ML_CONTROLLER_SECRET are required for Modal FinLab controller callback/D1 proxy",
        )
    if executor != "modal":
        raise HTTPException(
            status_code=409,
            detail="FINLAB_BACKFILL_EXECUTOR=modal is required before spawning Modal FinLab backfill",
        )
    from services import modal_client

    return await modal_client.spawn_finlab_v4_backfill(payload)


@router.post("/backfill/d1/query")
async def finlab_backfill_d1_query(req: FinLabD1QueryRequest) -> dict:
    """Controller-owned D1 proxy for Modal FinLab backfill read/write steps."""
    try:
        verb = _validate_d1_proxy_sql(req.sql, allow_read=True, allow_dml=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from services import d1_client

    if verb in D1_PROXY_ALLOWED_READ:
        rows = d1_client.query(req.sql, req.params, timeout=120.0)
        item = {
            "success": True,
            "results": rows,
            "meta": {"mode": "controller_d1_proxy", "operation": "query"},
        }
    else:
        result = d1_client.execute(req.sql, req.params, timeout=120.0)
        item = {
            "success": True,
            "results": result.get("results", []),
            "meta": {**(result.get("meta") or {}), "mode": "controller_d1_proxy", "operation": "execute"},
        }
    return {"success": True, "result": [item]}


@router.post("/backfill/d1/batch")
async def finlab_backfill_d1_batch(req: FinLabD1BatchRequest) -> dict:
    """Controller-owned D1 batch proxy for Modal FinLab canonical writes."""
    if not req.statements:
        raise HTTPException(status_code=400, detail="statements must be a non-empty array")
    statements: list[tuple[str, list[Any]]] = []
    try:
        for statement in req.statements:
            _validate_d1_proxy_sql(statement.sql, allow_read=False, allow_dml=True)
            statements.append((statement.sql, statement.params))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from services import d1_client

    result = d1_client.batch_execute(statements, timeout=120.0, chunk_size=req.chunk_size)
    return {"ok": True, **result}


@router.post("/backfill/callback")
async def finlab_backfill_controller_callback(req: FinLabBackfillCallbackRequest) -> dict:
    """Receive Modal FinLab completion on GCP, then forward scheduler callback to Worker."""
    from routers.pipeline import _callback_worker

    body = _model_dump(req)
    long_sequence_refresh = await _maybe_spawn_long_sequence_refresh(body)
    await _callback_worker(body)
    return {
        "ok": True,
        "forwarded": True,
        "task": body.get("task"),
        "status": body.get("status"),
        "run_id": body.get("run_id"),
        "run_date": body.get("run_date"),
        "long_sequence_refresh": long_sequence_refresh,
    }


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


@router.post("/execution/live-submit")
async def run_finlab_live_submit_route(req: FinLabLiveSubmitRequest) -> dict:
    """Submit a validated StockVision order intent through FinLab/Sinopac.

    The route is installed before real trading so the execution contract is
    production-shaped, but it stays blocked unless FINLAB_LIVE_SUBMIT_ENABLED
    and request allow_live_submit are both explicit.
    """
    return run_finlab_live_submit(
        intent=req.intent,
        allow_live_submit=req.allow_live_submit,
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
    return await _run_finlab_production_simulated_loop(req)
