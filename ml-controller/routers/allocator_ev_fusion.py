from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import d1_client
from services.allocator_ev_fusion_artifact_builder import (
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.allocator_ev_feature_snapshot_backfill import backfill_allocator_ev_feature_snapshots
from services.worker_config_client import worker_fetch


router = APIRouter(prefix="/allocator_ev_fusion", tags=["allocator_ev_fusion"])


class AllocatorEvFusionRefreshReq(BaseModel):
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: Literal["weekly", "monthly", "manual"] = "weekly"
    lookback_days: int | None = Field(default=None, ge=30, le=365)
    min_samples: int | None = Field(default=None, ge=100, le=10000)
    min_dates: int | None = Field(default=None, ge=5, le=252)
    limit: int = Field(default=6000, ge=500, le=20000)
    promote: bool = True
    dry_run: bool = False
    trigger_source: str = "worker_scheduler"


class AllocatorEvFeatureSnapshotBackfillReq(BaseModel):
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    dry_run: bool = True
    candidate_limit: int = Field(default=1000, ge=1, le=5000)
    l4_lookback_days: int = Field(default=90, ge=30, le=365)
    l4_min_samples: int = Field(default=500, ge=50, le=10000)
    l4_min_dates: int = Field(default=20, ge=5, le=252)
    l4_training_limit: int = Field(default=6000, ge=500, le=20000)
    s12_lookback_days: int = Field(default=120, ge=30, le=365)
    s12_limit: int = Field(default=5000, ge=500, le=20000)
    s12_min_samples: int = Field(default=30, ge=5, le=1000)
    s12_min_sample_dates: int = Field(default=8, ge=2, le=252)


def _latest_verified_end_date(max_date: str | None) -> str:
    where = ""
    params: list[Any] = []
    if max_date:
        where = "AND date(prediction_date) <= date(?)"
        params.append(max_date)
    rows = d1_client.query(
        f"""
        SELECT MAX(date(prediction_date)) AS end_date
        FROM predictions
        WHERE model_name = 'ensemble'
          AND verified_at IS NOT NULL
          AND (actual_return_pct IS NOT NULL OR trade_pnl_pct IS NOT NULL)
          {where}
        """,
        params,
    )
    end_date = str((rows[0] if rows else {}).get("end_date") or "").strip()
    if not end_date:
        raise HTTPException(status_code=409, detail="allocator_ev_fusion_no_verified_outcomes")
    return end_date


def _defaults_for_cadence(cadence: str) -> dict[str, int]:
    if cadence == "monthly":
        return {"lookback_days": 180, "min_samples": 1000, "min_dates": 35}
    return {"lookback_days": 90, "min_samples": 500, "min_dates": 20}


@router.post("/refresh")
async def refresh_allocator_ev_fusion_artifact(req: AllocatorEvFusionRefreshReq) -> dict[str, Any]:
    """Build and optionally promote the allocator EV fusion artifact.

    This artifact is the production allocator expected-return owner that combines
    L4 selection alpha EV and S12 execution trade EV. Promotion is fail-closed:
    only a PASS validation packet with a production-approved artifact mutates
    Worker trading:config.
    """

    defaults = _defaults_for_cadence(req.cadence)
    end_date = _latest_verified_end_date(req.end_date)
    lookback_days = req.lookback_days or defaults["lookback_days"]
    min_samples = req.min_samples or defaults["min_samples"]
    min_dates = req.min_dates or defaults["min_dates"]

    rows = load_allocator_ev_fusion_training_rows(
        d1_client.query,
        end_date=end_date,
        lookback_days=lookback_days,
        limit=req.limit,
    )
    result = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until=end_date,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
    )
    artifact = result.get("artifact") if isinstance(result, dict) else None
    validation = result.get("validation_packet") if isinstance(result, dict) else None
    decision = str((validation or {}).get("decision") or "").upper()
    promotion_state = str((artifact or {}).get("promotion_state") or "")

    promoted = False
    promotion_error: str | None = None
    if req.promote and not req.dry_run:
        if not isinstance(artifact, dict) or promotion_state != "production_approved" or decision != "PASS":
            return {
                **result,
                "status": "failed_validation",
                "promoted": False,
                "production_mutation_allowed": False,
                "summary": (
                    "allocator_ev_fusion_refresh failed_validation "
                    f"cadence={req.cadence} end_date={end_date} decision={decision or 'UNKNOWN'}"
                ),
            }
        try:
            await worker_fetch(
                "/api/admin/config",
                method="PUT",
                json_body={
                    "ensemble_v2": {
                        "allocatorEvFusion": artifact,
                        "allocator_ev_fusion": artifact,
                    }
                },
                timeout=30.0,
            )
            promoted = True
        except Exception as exc:  # noqa: BLE001 - surface Worker details to scheduler.
            promotion_error = str(exc)

    status = "promoted" if promoted else ("validated" if decision == "PASS" else "failed_validation")
    if promotion_error:
        status = "promotion_failed"

    return {
        **result,
        "status": status,
        "cadence": req.cadence,
        "end_date": end_date,
        "lookback_days": lookback_days,
        "min_samples": min_samples,
        "min_dates": min_dates,
        "rows_loaded": len(rows),
        "promoted": promoted,
        "promotion_error": promotion_error,
        "production_mutation_allowed": bool(req.promote and not req.dry_run and decision == "PASS"),
        "summary": (
            f"allocator_ev_fusion_refresh status={status} cadence={req.cadence} "
            f"end_date={end_date} model_version={(artifact or {}).get('model_version', 'unknown')} "
            f"decision={decision or 'UNKNOWN'} promoted={1 if promoted else 0}"
        ),
    }


@router.post("/feature_snapshots/backfill")
async def backfill_allocator_ev_feature_snapshots_route(req: AllocatorEvFeatureSnapshotBackfillReq) -> dict[str, Any]:
    """Build no-leakage as-of L4/S12 feature snapshots for fusion training.

    This route writes an independent training snapshot table only. It never
    mutates historical daily_recommendations rows.
    """

    result = backfill_allocator_ev_feature_snapshots(
        start_date=req.start_date,
        end_date=req.end_date,
        dry_run=req.dry_run,
        candidate_limit=req.candidate_limit,
        l4_lookback_days=req.l4_lookback_days,
        l4_min_samples=req.l4_min_samples,
        l4_min_dates=req.l4_min_dates,
        l4_training_limit=req.l4_training_limit,
        s12_lookback_days=req.s12_lookback_days,
        s12_limit=req.s12_limit,
        s12_min_samples=req.s12_min_samples,
        s12_min_sample_dates=req.s12_min_sample_dates,
    )
    return {
        **result,
        "summary": (
            "allocator_ev_feature_snapshot_backfill "
            f"status={result.get('status')} dry_run={1 if req.dry_run else 0} "
            f"range={req.start_date}..{req.end_date} built={result.get('snapshots_built')} "
            f"written={result.get('written')}"
        ),
    }
