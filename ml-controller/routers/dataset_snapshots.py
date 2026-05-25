from __future__ import annotations

import os
import time

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services import modal_client
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
    chunk_days: int = Field(default=10, ge=1, le=30)
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
    ])
    gcs_prefix: str | None = None
    producer_run_id: str | None = None
    chunk_days: int = Field(default=10, ge=1, le=30)
    hot_window_days: int = Field(default=504, ge=30, le=1600)


class ExportColdArchiveRunRequest(ExportColdArchiveRequest):
    run_id: str | None = None
    callback_task: str = "dataset-snapshot-export"
    trigger_source: str = "controller"
    trigger_id: str | None = None
    dry_run: bool = False


def _model_dump(model: BaseModel) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def build_d1_cold_archive_modal_payload(req: ExportColdArchiveRunRequest) -> dict:
    run_id = req.run_id or req.producer_run_id or f"d1-cold-archive-{req.business_date}-{int(time.time())}"
    payload = {
        key: value
        for key, value in _model_dump(req).items()
        if value is not None and key != "dry_run"
    }
    payload["run_id"] = run_id
    payload["producer_run_id"] = run_id
    payload["executor"] = "modal"
    payload["source"] = "d1_cold_archive_export"
    payload["delete_requires_manual_approval"] = True
    return payload


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


@router.post("/export_cold_archive/run")
async def export_cold_archive_run(req: ExportColdArchiveRunRequest) -> dict:
    """Spawn D1 cold archive export on Modal; preserve the sync route as rollback."""
    payload = build_d1_cold_archive_modal_payload(req)
    executor = os.environ.get("D1_COLD_ARCHIVE_EXECUTOR", "").strip().lower()
    if req.dry_run:
        return {
            "status": "dry_run",
            "executor": executor or "not_configured",
            "payload": payload,
        }
    if executor not in {"modal", "modal_spawn"}:
        return {
            "status": "not_triggered",
            "executor": executor or "not_configured",
            "reason": "D1_COLD_ARCHIVE_EXECUTOR=modal is required before spawning Modal cold archive export",
            "payload": payload,
        }
    return await modal_client.spawn_d1_cold_archive_export(payload)
