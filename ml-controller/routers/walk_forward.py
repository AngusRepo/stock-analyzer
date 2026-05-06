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
    # 2026-04-19 N2: per-window feature selection controls
    fs_max_rounds: int = 60          # lighter than production 100; trade speed for slight precision loss
    fs_force_refresh: bool = False   # True = re-run FS even if walk_forward/w{id}/feature_pool.json exists


@router.post("/walk_forward/dry-run")
async def walk_forward_dry_run(req: WalkForwardRequest):
    """Preview window plan + compute budget without triggering retrains."""
    from services.walk_forward_retrain import run_walk_forward, MODELS_ALL
    from services.backtest_engine import BacktestDataset
    from services.stratified_subset import select_stratified_subset

    symbols = select_stratified_subset(
        target_size=min(req.subset_size, 200), end_date=req.end_date,
    )
    if not symbols:
        raise HTTPException(status_code=400, detail="no symbols from stratified_subset")
    dataset = BacktestDataset.load_from_d1(
        start_date=req.start_date, end_date=req.end_date, symbols=symbols,
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
    """Execute full walk-forward — fire-and-forget via Modal orchestrator.

    Returns 202-style response immediately with the spawn's fn_call_id. The
    orchestrator runs inside Modal for up to 4 hours and persists the
    aggregate JSON to walk_forward/runs/{start_date}_{end_date}.json.

    Poll GET /walk_forward/report/{start}/{end} for completion.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail=(
                "walk_forward/run requires confirm=true — triggers Modal retrains "
                "(12+ windows × 5 models = 60+ GPU jobs, ~2-3 hr wall clock). "
                "Use /walk_forward/dry-run first."
            ),
        )

    from services.walk_forward_retrain import MODELS_ALL
    from services.backtest_engine import BacktestDataset, walk_forward_windows
    from services.stratified_subset import select_stratified_subset
    from services.payload_builder import load_market_env
    from services import modal_client
    from dataclasses import asdict
    from datetime import datetime, timezone, timedelta

    # Build the window index from a proper dataset (needs the trading_days list)
    symbols = select_stratified_subset(
        target_size=req.subset_size, end_date=req.end_date,
    )
    if not symbols:
        raise HTTPException(status_code=400, detail="no symbols from stratified_subset")
    dataset = BacktestDataset.load_from_d1(
        start_date=req.start_date, end_date=req.end_date, symbols=symbols,
    )

    trading_days = [d for d in dataset.trading_days if req.start_date <= d <= req.end_date]
    windows = walk_forward_windows(
        trading_days=trading_days,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
    )
    if not windows:
        raise HTTPException(
            status_code=400,
            detail=f"No windows generated. trading_days={len(trading_days)}, need >= {req.train_window_days + req.test_window_days}",
        )

    # Load market_env once — orchestrator filters per-window
    run_date = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    me, _, _, _, _ = load_market_env(run_date)
    market_env = asdict(me)

    windows_payload = [
        {
            "window_id": w.window_id,
            "train_start": w.train_start,
            "train_end":   w.train_end,
            "test_start":  w.test_start,
            "test_end":    w.test_end,
        }
        for w in windows
    ]

    # Spawn Modal orchestrator (fire-and-forget)
    try:
        fn_call = modal_client.spawn_walk_forward_orchestrator({
            "windows": windows_payload,
            "market_env": market_env,
            "batch_count": req.batch_count,
            "models": req.models or MODELS_ALL,
            "concurrent_windows": req.concurrent_windows,
            "start_date": req.start_date,
            "end_date": req.end_date,
            "train_window_days": req.train_window_days,
            "test_window_days": req.test_window_days,
            # 2026-04-19 N2: per-window FS to eliminate look-ahead bias
            "fs_max_rounds": req.fs_max_rounds,
            "fs_force_refresh": req.fs_force_refresh,
        })
        fn_call_id = getattr(fn_call, "object_id", None) or str(fn_call)
    except Exception as e:
        logger.error(f"[WalkForward] spawn failed: {e}")
        raise HTTPException(status_code=500, detail=f"Modal spawn failed: {e}")

    logger.info(
        f"[WalkForward] spawned orchestrator: {len(windows)} windows, "
        f"fn_call_id={fn_call_id}"
    )

    return {
        "status": "spawned",
        "fn_call_id": fn_call_id,
        "windows_planned": len(windows),
        "models": req.models or MODELS_ALL,
        "gcs_result_path": f"walk_forward/runs/{req.start_date}_{req.end_date}.json",
        "poll_endpoint": f"/walk_forward/report/{req.start_date}/{req.end_date}",
        "poll_hint": (
            "Orchestrator runs up to 4 hrs inside Modal. Poll the GET /walk_forward/report "
            "endpoint above; 404 = still running, 200 = done."
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
