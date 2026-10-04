"""Permanent retirement responses; old clients cannot fit models or write registry."""
from typing import Any, Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/l4_alpha_ev", tags=["l4_alpha_ev"])

class IpoShadowFreezeReq(BaseModel):
    signal_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source_run_id: str = Field(min_length=1, max_length=300)
    dry_run: bool = False
    input_mode: Literal['native', 'frozen_stacker_prospective'] = 'native'

class L4AlphaEvRefreshReq(BaseModel):
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: Literal["weekly", "monthly", "manual"] = "weekly"
    lookback_days: int | None = Field(default=None, ge=30, le=365)
    min_samples: int | None = Field(default=None, ge=100, le=10000)
    min_dates: int | None = Field(default=None, ge=5, le=252)
    limit: int = Field(default=6000, ge=500, le=20000)
    promote: bool = False
    dry_run: bool = False
    trigger_source: str = "worker_scheduler"

@router.post('/ipo-shadow/freeze')
def freeze_ipo_shadow(req: IpoShadowFreezeReq) -> dict[str, Any]:
    raise HTTPException(status_code=410, detail='ipo_collection_retired_new_l4_distribution')

@router.post('/refresh')
async def refresh_l4_alpha_ev_artifact(req: L4AlphaEvRefreshReq) -> dict[str, Any]:
    raise HTTPException(status_code=410, detail='legacy_ev_refresh_retired_use_l4_distribution')
