from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.dataset_snapshot_exporter import (
    D1ColdArchiveExportRequest,
    DatasetSnapshotExportRequest,
    export_backtest_dataset_snapshot,
    export_d1_cold_archive_snapshot,
    export_price_history_snapshot,
)

router = APIRouter(prefix="/datasets", tags=["datasets"])


class ExportSnapshotRequest(BaseModel):
    business_date: str = Field(description="Pipeline business date, YYYY-MM-DD.")
    start_date: str = Field(description="Inclusive dataset start date, YYYY-MM-DD.")
    end_date: str = Field(description="Inclusive dataset end date, YYYY-MM-DD.")
    kind: str = Field(default="backtest_dataset")
    gcs_prefix: str | None = None
    producer_run_id: str | None = None
    chunk_days: int = Field(default=1, ge=1, le=30)
    include_signals: bool = True


class ExportColdArchiveRequest(BaseModel):
    business_date: str = Field(description="Pipeline business date, YYYY-MM-DD.")
    start_date: str = Field(description="Inclusive D1 cold archive start date, YYYY-MM-DD.")
    end_date: str = Field(description="Inclusive D1 cold archive end date, YYYY-MM-DD.")
    tables: list[str] = Field(default_factory=lambda: [
        "stock_prices",
        "technical_indicators",
        "chip_data",
        "margin_data",
        "predictions",
        "canonical_fundamental_features",
    ])
    gcs_prefix: str | None = None
    producer_run_id: str | None = None
    chunk_days: int = Field(default=1, ge=1, le=30)
    hot_window_days: int = Field(default=504, ge=30, le=1600)


@router.post("/export_snapshot")
def export_snapshot(req: ExportSnapshotRequest):
    """Build a GCS compute snapshot and register it in D1 dataset_snapshots."""
    supported = {"backtest_dataset", "price_history"}
    if req.kind not in supported:
        return {
            "status": "rejected",
            "error": "unsupported_snapshot_kind",
            "kind": req.kind,
            "supported": sorted(supported),
        }
    export_req = DatasetSnapshotExportRequest(
        business_date=req.business_date,
        start_date=req.start_date,
        end_date=req.end_date,
        kind=req.kind,
        gcs_prefix=req.gcs_prefix,
        producer_run_id=req.producer_run_id,
        chunk_days=req.chunk_days,
        include_signals=req.include_signals,
    )
    if req.kind == "price_history":
        return export_price_history_snapshot(export_req)
    return export_backtest_dataset_snapshot(export_req)


@router.post("/export_cold_archive")
def export_cold_archive(req: ExportColdArchiveRequest):
    """Build a GCS archive snapshot for exact D1 cold rows. This does not delete D1."""
    export_req = D1ColdArchiveExportRequest(
        business_date=req.business_date,
        start_date=req.start_date,
        end_date=req.end_date,
        tables=tuple(req.tables),
        gcs_prefix=req.gcs_prefix,
        producer_run_id=req.producer_run_id,
        chunk_days=req.chunk_days,
        hot_window_days=req.hot_window_days,
    )
    return export_d1_cold_archive_snapshot(export_req)


class CorporateHistoryWeeklyRequest(BaseModel):
    run_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    run_id: str = Field(min_length=44, max_length=72,
                        pattern=r"^corporate-history-weekly-\d{4}-\d{2}-\d{2}-[a-f0-9]{8,32}$")
    dry_run: bool = False


@router.post("/corporate-history/weekly")
async def trigger_corporate_history_weekly(req: CorporateHistoryWeeklyRequest):
    """Hand the Saturday research corporate-history export to the dataset snapshot Job."""
    import asyncio
    import logging
    import os
    from fastapi import HTTPException
    from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError

    if not req.run_id.startswith(f"corporate-history-weekly-{req.run_date}-"):
        raise HTTPException(status_code=422, detail={"error": "corporate_history_weekly_run_id_date_mismatch",
                                                     "run_date": req.run_date})
    if req.dry_run:
        return {"status": "not_triggered", "reason": "dry_run", "run_date": req.run_date, "run_id": req.run_id}
    job_name = os.environ.get("DATASET_SNAPSHOT_JOB_NAME", "").strip()
    if not job_name:
        raise HTTPException(status_code=503, detail={"error": "dataset_snapshot_job_not_configured"})
    env_overrides = {"DATASET_SNAPSHOT_MODE": "corporate_history_weekly",
                     "DATASET_SNAPSHOT_RUN_DATE": req.run_date,
                     "DATASET_SNAPSHOT_PRODUCER_RUN_ID": req.run_id}
    try:
        execution = await asyncio.to_thread(
            CloudRunJobsClient(job_name=job_name, require_source_alignment=True).run_job,
            env_overrides=env_overrides, reject_if_running=True)
    except JobAlreadyRunningError as exc:
        raise HTTPException(status_code=409, detail={
            "error": "corporate_history_weekly_execution_already_running",
            "execution_id": exc.execution.execution_id}) from exc
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).exception("[CorporateHistoryWeekly] Job dispatch failed")
        raise HTTPException(status_code=502, detail={"error": "corporate_history_weekly_dispatch_failed",
                                                     "message": f"{type(exc).__name__}: {exc}"[:300]}) from exc
    return {"status": "dispatched", "execution_id": execution.execution_id,
            "run_date": req.run_date, "run_id": req.run_id}
