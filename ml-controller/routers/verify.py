"""
routers/verify.py — POST /verify
"""
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from services.modal_client import batch_update_arf

logger = logging.getLogger(__name__)
router = APIRouter()


class VerifyRecord(BaseModel):
    stock_id: int
    symbol: str
    predicted_direction: str
    actual_direction: str
    realized_pnl_r: float = 0.0
    arf_features: list[float] = []
    prediction_id: Optional[int] = None


class VerifyRequest(BaseModel):
    date: str
    verifications: list[VerifyRecord]


@router.post("/verify")
async def post_verify(req: VerifyRequest):
    if not req.verifications:
        return {"updated": 0, "results": [], "summary": {"correct": 0, "total": 0, "accuracy": 0.0}}

    arf_payloads = [
        {
            "stock_id":         v.stock_id,
            "symbol":           v.symbol,
            "arf_features":     v.arf_features,
            "actual_up":        v.actual_direction == "up",
            "actual_return":    v.realized_pnl_r,
            "forecast_pct":     0.0,  # verify 階段無預測值，用 default
        }
        for v in req.verifications
        if v.predicted_direction != "neutral" and v.arf_features
    ]

    results = []
    if arf_payloads:
        try:
            results = await batch_update_arf(arf_payloads)
        except Exception as e:
            logger.error(f"[verify] ARF batch update failed: {e}")

    non_neutral = [v for v in req.verifications if v.predicted_direction != "neutral"]
    correct     = sum(1 for v in non_neutral if v.predicted_direction == v.actual_direction)
    total       = len(non_neutral)
    accuracy    = round(correct / total, 4) if total > 0 else 0.0

    logger.info(f"[verify] date={req.date} correct={correct}/{total} acc={accuracy:.2%} arf_updated={len(results)}")
    return {
        "updated": len(results),
        "results": results,
        "summary": {"date": req.date, "correct": correct, "total": total, "accuracy": accuracy},
    }
