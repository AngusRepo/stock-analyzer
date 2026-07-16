"""
walk_forward.py — Sprint 6b walk-forward real orchestrator endpoints

POST /walk_forward/dry-run   preview plan
POST /walk_forward/run       execute full pipeline (requires confirm=true)
POST /walk_forward/analyze   aggregate latest run, produce markdown report
GET  /walk_forward/report/{start}/{end}  fetch persisted run

All endpoints require X-Controller-Token via main.py verify_token dependency.
"""
from __future__ import annotations
import asyncio
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
    from services.walk_forward_retrain import MODELS_ALL, run_walk_forward, walk_forward_model_coverage
    from services.backtest_engine import BacktestDataset
    from services.stratified_subset import select_stratified_subset

    symbols = select_stratified_subset(
        target_size=min(req.subset_size, 200), end_date=req.end_date,
    )
    if not symbols:
        raise HTTPException(status_code=400, detail="no symbols from stratified_subset")
    dataset, data_access = BacktestDataset.load_for_research(
        lane="walk_forward.dry_run",
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
        "planned_model_evaluations": run.aggregate.get("planned_model_evaluations"),
        "estimated_tree_wall_clock_hours": run.aggregate.get("estimated_tree_wall_clock_hours"),
        "model_coverage": run.aggregate.get("model_coverage") or walk_forward_model_coverage(req.models or MODELS_ALL),
        "data_access": data_access,
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
                "walk_forward/run requires confirm=true — triggers Modal walk-forward jobs "
                "(active-8 coverage: tree native retrain + non-tree artifact lifecycle evidence). "
                "Use /walk_forward/dry-run first."
            ),
        )

    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage
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
    dataset, data_access = BacktestDataset.load_for_research(
        lane="walk_forward.run",
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
        "model_coverage": walk_forward_model_coverage(req.models or MODELS_ALL),
        "data_access": data_access,
        "gcs_result_path": f"walk_forward/oof_cohorts/active8-oof-{req.start_date}-{req.end_date}/manifest.json",
        "poll_endpoint": f"/walk_forward/report/{req.start_date}/{req.end_date}",
        "poll_hint": (
            "Orchestrator runs up to 4 hrs inside Modal. Poll the GET /walk_forward/report "
            "endpoint above; 404 = still running, 200 = done."
        ),
    }


class AnalyzeRequest(BaseModel):
    start_date: str
    end_date: str


class OofMaterializeRequest(BaseModel):
    cohort_id: str
    knowledge_cutoff_date: str
    manifest_path: str | None = None
    dry_run: bool = True
    confirm: bool = False
    promote: bool = True


@router.post("/walk_forward/oof/materialize")
async def materialize_walk_forward_oof(req: OofMaterializeRequest):
    """Verify one OOF manifest and build the L4/Fusion offline evidence chain."""

    if not req.dry_run and not req.confirm:
        raise HTTPException(status_code=400, detail="non-dry OOF materialization requires confirm=true")
    from services.walk_forward_retrain import _get_bucket
    from services.active8_oof_cohort_materializer import (
        build_oof_snapshot_rows,
        build_fusion_oof_rows,
        archive_ev_candidate_artifacts,
        load_native_pit_component_rows,
        load_oof_prediction_rows,
        load_verified_oof_manifest,
        persist_oof_cohort,
    )
    from services.l4_alpha_ev_artifact_builder import (
        build_l4_alpha_ev_artifact_from_rows,
        build_l4_chronological_oof_predictions,
    )
    from services.allocator_ev_fusion_artifact_builder import (
        build_allocator_ev_fusion_artifact_from_rows,
    )
    from services import d1_client

    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    path = req.manifest_path or f"walk_forward/oof_cohorts/{req.cohort_id}/manifest.json"
    try:
        manifest, _raw = load_verified_oof_manifest(path, bucket=bucket)
        if manifest["cohort_id"] != req.cohort_id:
            raise ValueError("requested_cohort_manifest_mismatch")
        prediction_rows = load_oof_prediction_rows(manifest, bucket=bucket)
        native_rows = load_native_pit_component_rows(prediction_rows)
        snapshot_rows, snapshot_evidence = build_oof_snapshot_rows(
            prediction_rows,
            native_rows,
            cohort_id=req.cohort_id,
            source_manifest_checksum=manifest["manifest_checksum"],
        )
        l4_result = build_l4_alpha_ev_artifact_from_rows(
            snapshot_rows,
            trained_until=req.knowledge_cutoff_date,
            generation_mode="purged_oof",
            cohort_id=req.cohort_id,
        )
        l4_predictions, l4_prediction_evidence = build_l4_chronological_oof_predictions(
            snapshot_rows,
            cohort_id=req.cohort_id,
        )
        fusion_rows = build_fusion_oof_rows(
            snapshot_rows,
            l4_predictions,
            knowledge_cutoff_date=req.knowledge_cutoff_date,
        )
        fusion_result = build_allocator_ev_fusion_artifact_from_rows(
            fusion_rows,
            trained_until=req.knowledge_cutoff_date,
            knowledge_cutoff_date=req.knowledge_cutoff_date,
            generation_mode="purged_oof",
            cohort_id=req.cohort_id,
        )
        persistence = persist_oof_cohort(
            manifest=manifest,
            prediction_rows=prediction_rows,
            snapshot_rows=snapshot_rows,
            l4_predictions=l4_predictions,
            dry_run=req.dry_run,
        )
        parity = None
        promoted = False
        promotion_error = None
        candidate_artifacts = None
        promotion_receipts = None
        promotion_receipt_error = None
        notification_sent = False
        l4_artifact = l4_result.get("artifact") if isinstance(l4_result, dict) else None
        fusion_artifact = fusion_result.get("artifact") if isinstance(fusion_result, dict) else None
        l4_decision = str((l4_result.get("validation_packet") or {}).get("decision") or "")
        fusion_decision = str((fusion_result.get("validation_packet") or {}).get("decision") or "")
        fusion_tier = str(
            ((fusion_result.get("validation_packet") or {}).get("promotion") or {}).get("tier")
            or (fusion_artifact or {}).get("promotion_tier")
            or ""
        )
        if (
            not req.dry_run
            and l4_decision == "PASS"
            and fusion_decision == "PASS"
            and fusion_tier == "primary"
        ):
            from services.ev_operational_parity import assess_ev_operational_parity
            from services.worker_config_client import worker_fetch

            latest = d1_client.query(
                """
                SELECT MAX(date) prediction_date
                FROM daily_recommendations
                WHERE json_extract(score_components, '$.semanticVersion') = ?
                """,
                ["score-v2-active8-components-v3"],
            )
            latest_date = str((latest[0] if latest else {}).get("prediction_date") or "")
            parity_rows = load_native_pit_component_rows([{"prediction_date": latest_date}]) if latest_date else []
            parity = assess_ev_operational_parity(
                l4_artifact=l4_artifact,
                fusion_artifact=fusion_artifact,
                native_rows=parity_rows,
            )
            candidate_artifacts = archive_ev_candidate_artifacts(
                bucket=bucket,
                cohort_id=req.cohort_id,
                source_run_date=req.knowledge_cutoff_date,
                manifest_path=path,
                l4_result=l4_result,
                fusion_result=fusion_result,
                parity=parity,
                promoted=False,
            )
            if req.promote and parity.get("decision") == "PASS":
                serving_l4 = {
                    **l4_artifact,
                    "promotion_state": "production_approved",
                    "approval_state": "production_approved",
                    "operational_parity": parity,
                }
                serving_fusion = {
                    **fusion_artifact,
                    "promotion_state": "production_primary",
                    "promotion_tier": "primary",
                    "primary_expected_return_allowed": True,
                    "operational_parity_required": False,
                    "operational_parity": parity,
                }
                try:
                    await worker_fetch(
                        "/api/admin/config",
                        method="PUT",
                        json_body={
                            "ensemble_v2": {
                                "l4AlphaEv": serving_l4,
                                "l4_alpha_ev": serving_l4,
                                "allocatorEvFusion": serving_fusion,
                                "allocator_ev_fusion": serving_fusion,
                            },
                            "meta": {
                                "source": "active8_oof_automatic_promotion",
                                "push_id": f"active8_oof:{req.cohort_id}:{req.knowledge_cutoff_date}",
                                "promotion_reason": "offline_oof_quality_pass_and_native_operational_parity_pass",
                            },
                        },
                        timeout=30.0,
                    )
                    promoted = True
                    try:
                        from services.discord_alert import alert_lifecycle

                        notification_sent = await asyncio.to_thread(
                            alert_lifecycle,
                            event="promote",
                            model_name="L4+Fusion OOF",
                            from_status="offline_candidate",
                            to_status="production",
                            reason="purged OOF quality PASS and native operational parity PASS",
                            metrics={
                                "cohort_id": req.cohort_id,
                                "knowledge_cutoff_date": req.knowledge_cutoff_date,
                                "l4_serving_coverage": parity.get("l4_serving_coverage"),
                                "fusion_serving_coverage": parity.get("fusion_serving_coverage"),
                                "feature_mismatch_count": parity.get("feature_mismatch_count"),
                            },
                        )
                    except Exception:  # noqa: BLE001 - alert is non-blocking after durable promotion evidence.
                        notification_sent = False
                except Exception as exc:  # noqa: BLE001
                    promotion_error = str(exc)
            if promoted:
                try:
                    promotion_receipts = archive_ev_candidate_artifacts(
                        bucket=bucket,
                        cohort_id=req.cohort_id,
                        source_run_date=req.knowledge_cutoff_date,
                        manifest_path=path,
                        l4_result=l4_result,
                        fusion_result=fusion_result,
                        parity=parity,
                        promoted=True,
                    )
                except Exception as exc:  # noqa: BLE001 - config mutation already has Worker audit snapshot.
                    promotion_receipt_error = str(exc)
        if not req.dry_run and candidate_artifacts is None:
            candidate_artifacts = archive_ev_candidate_artifacts(
                bucket=bucket,
                cohort_id=req.cohort_id,
                source_run_date=req.knowledge_cutoff_date,
                manifest_path=path,
                l4_result=l4_result,
                fusion_result=fusion_result,
                parity=parity,
                promoted=False,
            )
        return {
            "status": "dry_run" if req.dry_run else "materialized",
            "cohort_id": req.cohort_id,
            "prediction_rows": len(prediction_rows),
            "native_pit_rows": len(native_rows),
            "snapshot_evidence": snapshot_evidence,
            "l4_result": l4_result,
            "l4_prediction_evidence": l4_prediction_evidence,
            "fusion_result": fusion_result,
            "fusion_rows": len(fusion_rows),
            "persistence": persistence,
            "operational_parity": parity,
            "promoted": promoted,
            "promotion_error": promotion_error,
            "candidate_artifacts": candidate_artifacts,
            "promotion_receipts": promotion_receipts,
            "promotion_receipt_error": promotion_receipt_error,
            "notification_sent": notification_sent,
            "promotion_allowed": bool(parity and parity.get("decision") == "PASS"),
            "fusion_promotion_tier": fusion_tier,
            "promotion_reason": (
                "offline_oof_quality_pass_and_native_operational_parity_pass"
                if promoted
                else "quality_or_operational_parity_not_passed"
            ),
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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
    cohort_id = f"active8-oof-{req.start_date}-{req.end_date}"
    blob = bucket.blob(f"walk_forward/oof_cohorts/{cohort_id}/manifest.json")
    if not blob.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No persisted OOF cohort manifest for {cohort_id}",
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
    cohort_id = f"active8-oof-{start_date}-{end_date}"
    blob = bucket.blob(f"walk_forward/oof_cohorts/{cohort_id}/manifest.json")
    if not blob.exists():
        raise HTTPException(status_code=404, detail="run not found")
    import json
    return json.loads(blob.download_as_text())
