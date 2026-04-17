"""
walk_forward.py — Sprint 6b walk-forward real orchestrator endpoints

POST /walk_forward/dry-run   preview plan
POST /walk_forward/run       execute full pipeline (requires confirm=true)
POST /walk_forward/analyze   aggregate latest run, produce markdown report
GET  /walk_forward/report/{start}/{end}  fetch persisted run

All endpoints require X-Controller-Token via main.py verify_token dependency.
"""
from __future__ import annotations
import logging
import os
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

logger = logging.getLogger("walk_forward")
router = APIRouter()


class WalkForwardRequest(BaseModel):
    start_date: str
    end_date: str
    train_window_days: int = 60
    test_window_days: int = 30
    models: list[str] | None = None
    confirm: bool = False
    concurrent_windows: int = 2
    batch_count: int = 5
    subset_size: int = 500


@router.post("/walk_forward/dry-run")
async def walk_forward_dry_run(req: WalkForwardRequest):
    """Preview window plan + compute budget without triggering retrains."""
    from services.walk_forward_retrain import run_walk_forward, MODELS_ALL
    from services.backtest_engine import BacktestDataset
    from services.stratified_subset import select_stratified_subset

    symbols = select_stratified_subset(size=min(req.subset_size, 200), as_of=req.end_date)
    if not symbols:
        raise HTTPException(status_code=400, detail="no symbols from stratified_subset")
    dataset = BacktestDataset.load_from_d1(
        symbols=symbols, start=req.start_date, end=req.end_date,
    )
    run = await run_walk_forward(
        dataset=dataset,
        start_date=req.start_date,
        end_date=req.end_date,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
        models=req.models or MODELS_ALL,
        batch_count=req.batch_count,
        dry_run=True,
        concurrent_windows=req.concurrent_windows,
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
    """Execute full walk-forward. Requires confirm=true.

    For each window: train HMM snapshot + 5 ML models via Modal.
    Writes artifacts to walk_forward/w{id}/* and the aggregate run JSON to
    walk_forward/runs/{start}_{end}.json.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail=(
                "walk_forward/run requires confirm=true — this triggers Modal retrains "
                f"(12+ windows × 5 models = 60+ GPU jobs, ~2-3 hr wall clock). "
                "Use /walk_forward/dry-run first to validate plan, then re-POST with confirm=true."
            ),
        )

    from services.walk_forward_retrain import (
        run_walk_forward,
        MODELS_ALL,
        persist_run_to_gcs,
        load_current_universal_ic,
        build_report,
    )
    from services.backtest_engine import BacktestDataset
    from services.stratified_subset import select_stratified_subset

    symbols = select_stratified_subset(size=req.subset_size, as_of=req.end_date)
    if not symbols:
        raise HTTPException(status_code=400, detail="no symbols from stratified_subset")
    dataset = BacktestDataset.load_from_d1(
        symbols=symbols, start=req.start_date, end=req.end_date,
    )

    logger.info(
        f"[WalkForward] starting full run: {req.start_date}..{req.end_date} "
        f"concurrent={req.concurrent_windows} subset={len(symbols)}"
    )

    run = await run_walk_forward(
        dataset=dataset,
        start_date=req.start_date,
        end_date=req.end_date,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
        models=req.models or MODELS_ALL,
        batch_count=req.batch_count,
        dry_run=False,
        concurrent_windows=req.concurrent_windows,
    )

    # Persist to GCS + include current universal comparison
    current_ic = load_current_universal_ic()
    gcs_path = persist_run_to_gcs(
        run,
        extra={
            "subset_size": len(symbols),
            "universal_ic_anchor": current_ic,
        },
    )

    # Build report inline (also stored with the run)
    report_md = build_report(run, current_universal_ic=current_ic)

    return {
        "status": "done",
        "windows_run": len(run.windows),
        "aggregate": run.aggregate,
        "persisted_gcs": gcs_path,
        "report_preview": report_md[:2000],
        "next_step": (
            "Review aggregate metrics. If mean_ic shows stable >0.08 across windows and "
            "consistent with universal IC, consider feeding per-window metrics into "
            "Champion-Challenger pool (ML_POOL_ARCHITECTURE.md)."
        ),
    }


class AnalyzeRequest(BaseModel):
    start_date: str
    end_date: str


@router.post("/walk_forward/analyze")
async def walk_forward_analyze(req: AnalyzeRequest):
    """Rebuild report for an already-persisted run (no retrain)."""
    from services.walk_forward_retrain import (
        WalkForwardRun,
        WalkForwardWindowResult,
        load_current_universal_ic,
        build_report,
        _get_bucket,
    )
    import json

    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    blob = bucket.blob(f"walk_forward/runs/{req.start_date}_{req.end_date}.json")
    if not blob.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No persisted run at walk_forward/runs/{req.start_date}_{req.end_date}.json",
        )

    data = json.loads(blob.download_as_text())
    run = WalkForwardRun(
        start_date=data["start_date"],
        end_date=data["end_date"],
        train_window_days=data.get("train_window_days", 60),
        test_window_days=data.get("test_window_days", 30),
    )
    for w in data.get("windows", []):
        tr = w.get("train_range") or [None, None]
        te = w.get("test_range") or [None, None]
        run.windows.append(WalkForwardWindowResult(
            window_id=w.get("window_id"),
            train_range=(tr[0], tr[1]),
            test_range=(te[0], te[1]),
            model_metrics=w.get("model_metrics", {}),
            error=w.get("error"),
        ))
    run.aggregate = data.get("aggregate", {})

    report = build_report(run, current_universal_ic=load_current_universal_ic())
    return Response(content=report, media_type="text/markdown")


@router.get("/walk_forward/report/{start_date}/{end_date}")
async def walk_forward_report(start_date: str, end_date: str):
    """Fetch the raw JSON for a persisted run."""
    from services.walk_forward_retrain import _get_bucket
    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    blob = bucket.blob(f"walk_forward/runs/{start_date}_{end_date}.json")
    if not blob.exists():
        raise HTTPException(status_code=404, detail="run not found")
    import json
    return json.loads(blob.download_as_text())
