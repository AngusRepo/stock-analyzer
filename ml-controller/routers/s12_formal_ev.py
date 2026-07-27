"""Authenticated S12 formal-EV materialization endpoint."""
from __future__ import annotations

import time
import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from services.s12_formal_ev_continuation import materialize_s12_formal_ev_decisions

router = APIRouter(prefix="/s12-formal-ev", tags=["s12-formal-ev"])


class FormalEvRunRequest(BaseModel):
    observation_date: str
    producer_run_id: str | None = None


@router.post("/run")
def run_formal_ev(req: FormalEvRunRequest):
    run_id = req.producer_run_id or f"s12-formal-ev-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    return materialize_s12_formal_ev_decisions(
        observation_date=req.observation_date[:10],
        producer_run_id=run_id,
    )
