from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/breeze2", tags=["breeze2"])


class Breeze2FactCheckRequest(BaseModel):
    symbol: str
    stock_name: str | None = None
    trigger: str = "morning_debate"
    reason: str = "semantic_fact_check"
    theme: dict[str, Any] = Field(default_factory=dict)
    news: dict[str, Any] | list[dict[str, Any]] = Field(default_factory=dict)
    evidence_items: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    execute_modal: bool = False
    generated_at: str | None = None
    mutation_allowed: bool = False
    real_trading_allowed: bool = False


@router.post("/fact_check")
async def breeze2_fact_check(req: Breeze2FactCheckRequest) -> dict[str, Any]:
    if req.mutation_allowed or req.real_trading_allowed:
        raise HTTPException(status_code=400, detail="Breeze2 cannot mutate trading state or request real-trading scope")

    # Retired for every caller, including old execute_modal=true clients.
    raise HTTPException(status_code=410, detail="breeze2_retired")
