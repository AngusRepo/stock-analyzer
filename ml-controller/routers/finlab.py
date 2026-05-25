from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import modal_client

router = APIRouter(prefix="/finlab", tags=["finlab"])


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
    dry_run: bool = False


def _model_dump(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


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
