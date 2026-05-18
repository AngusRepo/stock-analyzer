from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.breeze2_research_context import (
    build_breeze2_modal_payload,
    build_breeze2_research_context_report,
    validate_breeze2_research_context_report,
)


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


def _request_payload(req: Breeze2FactCheckRequest) -> dict[str, Any]:
    return {
        "symbol": req.symbol,
        "stock_name": req.stock_name,
        "trigger": req.trigger,
        "reason": req.reason,
        "theme": req.theme,
        "news": req.news,
        "evidence_items": req.evidence_items,
        "metadata": req.metadata,
    }


@router.post("/fact_check")
async def breeze2_fact_check(req: Breeze2FactCheckRequest) -> dict[str, Any]:
    if req.mutation_allowed or req.real_trading_allowed:
        raise HTTPException(status_code=400, detail="Breeze2 cannot mutate trading state or request real-trading scope")

    payload = _request_payload(req)
    if req.execute_modal:
        from services import modal_client

        result = await modal_client.breeze2_research_context(build_breeze2_modal_payload(payload))
        if not isinstance(result, dict):
            raise HTTPException(status_code=502, detail="Breeze2 Modal returned non-dict response")
        errors = validate_breeze2_research_context_report(result)
        if errors:
            raise HTTPException(status_code=502, detail={"breeze2_validation_errors": errors})
        return result

    return build_breeze2_research_context_report(
        payload,
        generated_at=req.generated_at,
        executor="controller_local_contract",
    )
