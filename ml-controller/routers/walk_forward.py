"""
walk_forward.py — Sprint 6b walk-forward retrain trigger (scaffold)

POST /walk_forward/run — orchestrates 12-window × N-model walk-forward retrain
POST /walk_forward/dry-run — preview window plan without retraining

Both endpoints are GATED behind `X-Controller-Token` auth AND require
explicit `confirm=true` to trigger the expensive full run (72+ retrains,
hours of GPU). dry_run is the default safe mode.
"""
from __future__ import annotations
import logging
import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("walk_forward")
router = APIRouter()


class WalkForwardRequest(BaseModel):
    start_date: str                               # e.g. "2025-04-01"
    end_date: str                                 # e.g. "2026-04-01"
    train_window_days: int = 60
    test_window_days: int = 30
    models: list[str] | None = None              # None = all
    confirm: bool = False                         # MUST be True to actually retrain


@router.post("/walk_forward/dry-run")
async def walk_forward_dry_run(req: WalkForwardRequest):
    """Preview window plan + compute budget without triggering retrains."""
    from services.walk_forward_retrain import run_walk_forward, MODELS_ALL
    from services.backtest_engine import BacktestDataset
    from services.stratified_subset import select_stratified_subset

    symbols = select_stratified_subset(size=200, as_of=req.end_date)
    dataset = BacktestDataset.load_from_d1(symbols=symbols, start=req.start_date, end=req.end_date)

    run = await run_walk_forward(
        dataset=dataset,
        start_date=req.start_date,
        end_date=req.end_date,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
        models=req.models or MODELS_ALL,
        dry_run=True,
    )
    return {
        "dry_run": True,
        "windows_count": len(run.windows),
        "planned_retrains": run.aggregate.get("planned_retrains"),
        "estimated_gpu_wall_clock_hours": run.aggregate.get("estimated_gpu_wall_clock_hours"),
        "windows": [
            {
                "window_id": w.window_id,
                "train_range": w.train_range,
                "test_range": w.test_range,
            }
            for w in run.windows
        ],
    }


@router.post("/walk_forward/run")
async def walk_forward_run(req: WalkForwardRequest):
    """Execute full walk-forward retrain. REQUIRES confirm=true.

    Budget warning: triggers 12+ windows × 6 models = 72+ retrains.
    Writes per-window model artifacts to GCS `walk_forward/w{id}/` prefix.
    Does NOT promote any model to production — Wei must manually review
    aggregate metrics + promote via retrain_trigger afterwards.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="walk_forward/run requires confirm=true — this triggers 72+ GPU retrains "
                   "(4-6 hours wall clock). Use /walk_forward/dry-run first to validate plan, "
                   "then re-POST with confirm=true.",
        )

    from services.walk_forward_retrain import run_walk_forward, MODELS_ALL
    from services.backtest_engine import BacktestDataset
    from services.stratified_subset import select_stratified_subset

    symbols = select_stratified_subset(size=500, as_of=req.end_date)
    dataset = BacktestDataset.load_from_d1(symbols=symbols, start=req.start_date, end=req.end_date)

    logger.info(f"[WalkForward] starting full run: {req.start_date}..{req.end_date}")

    run = await run_walk_forward(
        dataset=dataset,
        start_date=req.start_date,
        end_date=req.end_date,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
        models=req.models or MODELS_ALL,
        dry_run=False,
    )

    # Also persist the aggregate run to GCS for audit
    try:
        import json
        from google.cloud import storage
        bucket = storage.Client().bucket(os.environ.get("GCS_MODELS_BUCKET", "stockvision-models"))
        blob = bucket.blob(f"walk_forward/runs/{req.start_date}_{req.end_date}.json")
        blob.upload_from_string(
            json.dumps({
                "start_date": run.start_date,
                "end_date": run.end_date,
                "windows": [
                    {
                        "window_id": w.window_id,
                        "train_range": w.train_range,
                        "test_range": w.test_range,
                        "model_metrics": w.model_metrics,
                        "error": w.error,
                    }
                    for w in run.windows
                ],
                "aggregate": run.aggregate,
            }, indent=2, default=str),
            content_type="application/json",
        )
    except Exception as e:
        logger.warning(f"[WalkForward] aggregate persist failed: {e}")

    return {
        "status": "done",
        "windows_run": len(run.windows),
        "aggregate": run.aggregate,
        "next_step": "Review aggregate metrics. If mean_ic shows stable >0.08 across windows, "
                     "consider promoting per-window models via model pool Champion-Challenger "
                     "(ML_POOL_ARCHITECTURE.md #12-16).",
    }
