"""
backtest.py — Weekly automated backtest endpoint

POST /backtest/run → full pipeline: D1 export → backtest → D1 import
Triggered by Worker Sunday cron (0 20 * * 0 = 04:00 TW)
"""
import logging
from fastapi import APIRouter

from services.backtest_service import run_full_backtest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/backtest", tags=["backtest"])


@router.post("/run")
async def trigger_backtest():
    """
    Run full backtest pipeline:
    1. Fetch OHLCV + ML signals from D1
    2. In-memory backtest per stock (mirrors StockVisionStrategy 7-layer cascade)
    3. Aggregate metrics (Sharpe, MDD, Win Rate, Profit Factor, Expectancy)
    4. Write results to D1 backtest_results table
    """
    logger.info("[Backtest] Triggered via API")
    try:
        result = await run_full_backtest()
        return result
    except Exception as e:
        logger.exception("[Backtest] Pipeline failed")
        return {"status": "error", "error": str(e)}
