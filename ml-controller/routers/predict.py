"""
routers/predict.py — POST /batch-predict

Worker 傳入 N 支股票的完整資料 → Controller 並行呼叫 ML Service
→ 回傳所有預測結果 → Worker 寫入 D1 predictions + KV。
"""
import time
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

from services.modal_client import batch_predict

logger = logging.getLogger(__name__)
router = APIRouter()


class BatchPredictRequest(BaseModel):
    stocks: list[dict[str, Any]]


@router.post("/batch-predict")
async def post_batch_predict(req: BatchPredictRequest):
    if not req.stocks:
        return {"results": [], "total": 0, "errors": 0}

    n = len(req.stocks)
    logger.info(f"[batch-predict] Starting {n} stocks")
    t0 = time.time()

    results = await batch_predict(req.stocks)

    elapsed = round(time.time() - t0, 2)
    errors  = sum(1 for r in results if r.get("error") or r.get("signal") == "NO_SIGNAL")

    logger.info(f"[batch-predict] Done: {n} stocks in {elapsed}s, {errors} errors")
    return {"results": results, "total": n, "errors": errors, "elapsed_s": elapsed}
