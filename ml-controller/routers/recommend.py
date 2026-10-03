"""POST /recommend.

This registered route accepts lightweight candidate dictionaries and returns
Score V2 recommendations. The scalar ``score`` is canonical finalScore.
``chip_score``, ``tech_score``, and ``ml_score`` are storage projections kept
for older D1 columns only; they are not the ranking source.
"""

import json
import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.recommend_score_v2_projection import rank_score_v2_route_candidates

logger = logging.getLogger(__name__)
router = APIRouter()


class RecommendRequest(BaseModel):
    date: str
    stocks: list[dict[str, Any]]
    sectors: list[dict[str, Any]] = Field(default_factory=list)
    top_n: int = 5


@router.post("/recommend")
def post_recommend(req: RecommendRequest):
    if not req.stocks:
        return {"recommendations": [], "sectors": req.sectors}

    # 1. Build Score V2 candidates and rank by canonical finalScore.
    scored = rank_score_v2_route_candidates(req.stocks)
    top = scored[: req.top_n]
    score_components_by_symbol = {candidate.symbol: candidate.score_components for candidate in top}

    if not top:
        logger.info("[recommend] date=%s: no stocks passed finalScore threshold", req.date)
        return {"recommendations": [], "sectors": req.sectors}

    # 2. Preserve the existing deterministic fallback without provider calls.
    reasons = [{"reason": "Score V2 context available; LLM reason not generated.", "watch_points": []}
               for _ in top]

    # 3. Return Score V2 response plus storage projection fields.
    recommendations = []
    for rank, (candidate, reason_payload) in enumerate(zip(top, reasons), start=1):
        score_components = score_components_by_symbol[candidate.symbol]
        recommendations.append({
            "rank": rank,
            "stock_id": candidate.stock_id,
            "symbol": candidate.symbol,
            "name": candidate.name,
            "sector": candidate.sector,
            "score": candidate.final_score,
            "chip_score": candidate.chip_score,
            "tech_score": candidate.tech_score,
            "ml_score": candidate.ml_score,
            "score_components": score_components,
            "current_price": candidate.current_price,
            "foreign_net_5d": candidate.foreign_net_5d / 1e8,
            "trust_net_5d": candidate.trust_net_5d / 1e8,
            "rsi14": candidate.rsi14,
            "macd_hist": candidate.macd_hist,
            "ml_signal": candidate.ml_signal,
            "ml_confidence": candidate.ml_confidence,
            "has_buy_signal": 1 if (candidate.ml_signal and "BUY" in candidate.ml_signal) else 0,
            "reason": reason_payload.get("reason", "")[:500],
            "watch_points": json.dumps(reason_payload.get("watch_points", [])[:3], ensure_ascii=False),
        })

    logger.info("[recommend] date=%s top=%s", req.date, [row["symbol"] for row in recommendations])
    return {"recommendations": recommendations, "sectors": req.sectors}
