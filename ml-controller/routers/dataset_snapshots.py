from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.dataset_snapshot_exporter import (
    DatasetSnapshotExportRequest,
    export_backtest_dataset_snapshot,
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
    chunk_days: int = Field(default=10, ge=1, le=30)
    include_signals: bool = True


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
