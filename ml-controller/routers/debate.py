"""
debate.py — Multi-round Bull/Bear debate HTTP endpoints (P2 #39)

POST /debate/buy        — single-stock debate
POST /debate/buy_batch  — parallel debate for multiple candidates (Worker calls
                           this from setupMorningPendingBuys to parallelize
                           what was previously a sequential for-loop)
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Optional

from services.debate_service import (
    run_buy_debate_cached,
    run_buy_debate_batch,
    StockProfile,
)

logger = logging.getLogger("debate")
router = APIRouter()


class StockProfileIn(BaseModel):
    business_desc: Optional[str] = None
    key_customers: Optional[str] = None
    key_suppliers: Optional[str] = None


class BuyDebateRequest(BaseModel):
    symbol: str
    stock_name: str
    signal: str = "BUY"
    confidence: float = 0.6
    reasoning: str = "ML ensemble signal"
    us_context: Optional[str] = None
    taifex_context: Optional[str] = None
    stock_profile: Optional[StockProfileIn] = None
    breeze2_context: Optional[dict[str, Any]] = None
    cache_key_date: Optional[str] = None


@router.post("/debate/buy")
async def debate_buy_single(req: BuyDebateRequest):
    """Single-stock buy debate — returns verdict + conviction + summary."""
    try:
        profile = None
        if req.stock_profile:
            profile = StockProfile(
                business_desc=req.stock_profile.business_desc,
                key_customers=req.stock_profile.key_customers,
                key_suppliers=req.stock_profile.key_suppliers,
            )
        result = await run_buy_debate_cached(
            symbol=req.symbol,
            stock_name=req.stock_name,
            signal=req.signal,
            confidence=req.confidence,
            reasoning=req.reasoning,
            us_context=req.us_context,
            stock_profile=profile,
            taifex_context=req.taifex_context,
            breeze2_context=req.breeze2_context,
            cache_key_date=req.cache_key_date,
        )
        return {
            "symbol": req.symbol,
            "verdict": result.verdict,
            "rounds": result.rounds,
            "summary": result.summary,
            "llm_source": result.llm_source,
            "conviction_score": result.conviction_score,
            "agent_turns": result.agent_turns,
        }
    except Exception as e:
        logger.error(f"[Debate] {req.symbol} crashed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class BuyDebateBatchRequest(BaseModel):
    candidates: list[BuyDebateRequest]
    concurrent: int = 5


@router.post("/debate/buy_batch")
async def debate_buy_batch(req: BuyDebateBatchRequest):
    """Batch debate for Worker morning setup.

    Typical use: setupMorningPendingBuys has 3-5 candidates, calls this endpoint
    once instead of running 3-5 sequential debates in Worker (which hit the
    waitUntil 30s budget).

    Modal Gemini rate limit ~60/min → default concurrent=5 is safe for 5 stocks.
    """
    if not req.candidates:
        return {"results": [], "count": 0}
    if len(req.candidates) > 50:
        raise HTTPException(status_code=400, detail="batch too large (max 50)")

    cand_dicts = []
    for c in req.candidates:
        d = c.model_dump()
        if d.get("stock_profile"):
            # Keep stock_profile as dict for run_buy_debate_batch
            pass
        cand_dicts.append(d)

    results = await run_buy_debate_batch(cand_dicts, concurrent=req.concurrent)
    return {
        "results": results,
        "count": len(results),
        "batch_size": len(req.candidates),
    }
