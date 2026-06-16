"""
Verify endpoints.

  POST /verify       ARF feedback receiver
  POST /verify/run   full verify pipeline V2 trigger

Long-running verify execution must never depend on the Cloud Run Service request
lifecycle. Async mode therefore hands work off to a dedicated Cloud Run Job,
mirroring the production-safe pipeline-v2 pattern.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Optional

from fastapi import HTTPException
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from services import verify_service
from services.arf_feedback_contract import validate_arf_feedback_results
from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError
from services.modal_client import batch_update_arf

logger = logging.getLogger(__name__)
router = APIRouter()
_verify_jobs_client = CloudRunJobsClient(job_name="verify-v2")


class VerifyRunRequest(BaseModel):
    run_date: Optional[str] = None
    lookback_days: int = 5
    limit: int = 200
    async_mode: bool = False
    callback_task: str = "verify-v2"
    update_aggregates: bool = False


def _format_verify_summary(result: dict) -> str:
    return (
        f"verified {result.get('verified', 0)}/{result.get('pending', 0)} "
        f"correct {result.get('correct', 0)} "
        f"pnl {(float(result.get('total_pnl_pct', 0.0)) * 100):.1f}% "
        f"arf {result.get('arf_updated', 0)}"
    )


@router.post("/verify/run")
async def post_verify_run(req: VerifyRunRequest = VerifyRunRequest()):
    """
    Trigger the verify pipeline V2.

    In async mode the request returns quickly and a dedicated Cloud Run Job
    writes the final result back to Worker via /api/admin/scheduler-callback.
    """
    from graphs.verify_pipeline import run_verify_v2

    logger.info(
        "[verify/run] lookback_days=%s limit=%s run_date=%s async=%s",
        req.lookback_days,
        req.limit,
        req.run_date,
        req.async_mode,
    )

    if req.async_mode:
        run_id = f"verify-{int(time.time())}-{uuid.uuid4().hex[:8]}"
        try:
            execution = _verify_jobs_client.run_job(
                env_overrides={
                    "VERIFY_RUN_DATE": req.run_date or "",
                    "VERIFY_LOOKBACK_DAYS": str(req.lookback_days),
                    "VERIFY_LIMIT": str(req.limit),
                    "VERIFY_CALLBACK_TASK": req.callback_task or "verify-v2",
                    "VERIFY_RUN_ID": run_id,
                    "VERIFY_UPDATE_AGGREGATES": "1" if req.update_aggregates else "0",
                },
            )
        except JobAlreadyRunningError as e:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "verify-v2 already has an active execution",
                    "execution_id": e.execution.execution_id,
                    "execution_name": e.execution.execution_name,
                    "run_id": run_id,
                },
            ) from e
        except Exception as e:  # noqa: BLE001
            logger.exception("[verify/run] Failed to trigger Cloud Run Job")
            raise HTTPException(
                status_code=502,
                detail=f"Cloud Run Jobs trigger failed: {type(e).__name__}: {e}",
            ) from e

        return JSONResponse(
            status_code=202,
            content={
                "status": "triggered",
                "run_id": run_id,
                "callback_task": req.callback_task,
                "execution_id": execution.execution_id,
                "execution_name": execution.execution_name,
                "note": "verify pipeline running as Cloud Run Job; Worker scheduler run log will be updated via callback",
            },
        )

    try:
        return await run_verify_v2(
            run_date=req.run_date or "",
            lookback_days=req.lookback_days,
            limit=req.limit,
            update_aggregates=req.update_aggregates,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("[verify/run] Pipeline failed")
        return {"status": "error", "error": str(e)}


@router.post("/verify/dry-run")
async def post_verify_dry_run(req: VerifyRunRequest = VerifyRunRequest()):
    """
    Preview verify V2 without mutating D1/model accuracy/trade performance/ARF.

    This intentionally does not invoke the LangGraph graph because the graph
    contains write nodes. It mirrors only the read + simulation portion.
    """
    logger.info(
        "[verify/dry-run] lookback_days=%s limit=%s run_date=%s",
        req.lookback_days,
        req.limit,
        req.run_date,
    )
    pending = verify_service.load_pending_predictions(req.lookback_days, req.limit, req.run_date)
    market_risk = verify_service.load_market_risk()
    prepared = verify_service.prepare_verification_updates(pending, market_risk)
    updates = prepared.get("verify_updates") or []
    summary = verify_service.summarize_verification_updates(len(pending), updates)
    return {
        "status": "ok",
        "dry_run": True,
        "run_date": req.run_date,
        **summary,
        "arf_feedback_planned": len(prepared.get("arf_feedback_items") or []),
        "errors": prepared.get("errors") or [],
        "mutations_skipped": [
            "write_verified_predictions",
            "update_model_accuracy",
            "update_trade_performance",
            "batch_update_arf",
        ],
    }


class VerifyRecord(BaseModel):
    stock_id: int
    symbol: str
    predicted_direction: str
    actual_direction: str
    actual_return_pct: float | None = None
    realized_pnl_r: float = 0.0
    forecast_pct: float = 0.0
    arf_features: list[float] = []
    prediction_id: Optional[int] = None


class VerifyRequest(BaseModel):
    date: str
    verifications: list[VerifyRecord]


@router.post("/verify")
async def post_verify(req: VerifyRequest):
    if not req.verifications:
        return {"updated": 0, "results": [], "summary": {"correct": 0, "total": 0, "accuracy": 0.0}}

    arf_payloads = [
        {
            "stock_id": v.stock_id,
            "symbol": v.symbol,
            "arf_features": v.arf_features,
            "actual_up": v.actual_direction == "up",
            "actual_return_pct": v.actual_return_pct,
            "realized_pnl_r": v.realized_pnl_r,
            "forecast_pct": v.forecast_pct,
        }
        for v in req.verifications
        if v.predicted_direction != "neutral" and v.arf_features
    ]

    results = []
    if arf_payloads:
        try:
            results = await batch_update_arf(arf_payloads)
        except Exception as e:  # noqa: BLE001
            logger.error("[verify] ARF batch update failed: %s", e)
            raise HTTPException(status_code=502, detail=f"ARF batch update failed: {e}") from e
        feedback_errors = validate_arf_feedback_results(arf_payloads, results)
        if feedback_errors:
            raise HTTPException(
                status_code=502,
                detail=f"ARF batch update incomplete: {'; '.join(feedback_errors[:5])}",
            )

    non_neutral = [v for v in req.verifications if v.predicted_direction != "neutral"]
    correct = sum(1 for v in non_neutral if v.predicted_direction == v.actual_direction)
    total = len(non_neutral)
    accuracy = round(correct / total, 4) if total > 0 else 0.0

    logger.info(
        "[verify] date=%s correct=%s/%s acc=%.2f%% arf_updated=%s",
        req.date,
        correct,
        total,
        accuracy * 100,
        len(results),
    )
    return {
        "updated": len(results),
        "results": results,
        "summary": {"date": req.date, "correct": correct, "total": total, "accuracy": accuracy},
    }
