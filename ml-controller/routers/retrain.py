"""
routers/retrain.py — POST /batch-retrain
"""
import time
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

from services.modal_client import batch_retrain

logger = logging.getLogger(__name__)
router = APIRouter()


class BatchRetrainRequest(BaseModel):
    stocks: list[dict[str, Any]]


@router.post("/batch-retrain")
async def post_batch_retrain(req: BatchRetrainRequest):
    if not req.stocks:
        return {"results": [], "total": 0, "retrained": 0}

    n = len(req.stocks)
    logger.info(f"[batch-retrain] Starting {n} stocks")
    t0 = time.time()

    results = await batch_retrain(req.stocks)

    elapsed   = round(time.time() - t0, 2)
    retrained = sum(1 for r in results if not r.get("error"))

    logger.info(f"[batch-retrain] Done: {retrained}/{n} in {elapsed}s")
    return {"results": results, "total": n, "retrained": retrained, "elapsed_s": elapsed}
