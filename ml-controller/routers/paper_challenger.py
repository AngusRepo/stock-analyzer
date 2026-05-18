from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.paper_challenger_promotion import build_paper_challenger_postmarket_report


router = APIRouter(prefix="/paper_challenger", tags=["paper_challenger"])


class PaperChallengerPostmarketRequest(BaseModel):
    run_date: str | None = None
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    baseline_metrics_by_candidate: dict[str, dict[str, Any]] = Field(default_factory=dict)
    challenger_metrics_by_candidate: dict[str, dict[str, Any]] = Field(default_factory=dict)
    generated_at: str | None = None
    policy: dict[str, Any] | None = None


def _default_generated_at(run_date: str | None) -> str:
    if run_date:
        return f"{run_date}T13:45:00+08:00"
    return datetime.now(timezone.utc).isoformat()


@router.post("/postmarket_report")
async def build_postmarket_report(req: PaperChallengerPostmarketRequest) -> dict[str, Any]:
    return build_paper_challenger_postmarket_report(
        candidates=req.candidates,
        baseline_metrics_by_candidate=req.baseline_metrics_by_candidate,
        challenger_metrics_by_candidate=req.challenger_metrics_by_candidate,
        generated_at=req.generated_at or _default_generated_at(req.run_date),
        policy=req.policy,
    )
