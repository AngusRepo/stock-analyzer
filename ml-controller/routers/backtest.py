"""
backtest.py — Weekly automated backtest + Monte Carlo MDD endpoints

POST /backtest/run         → FIFO backtest pipeline (週日 06:00 TW)
POST /backtest/monte-carlo → Monte Carlo MDD simulation (週日 06:05 TW)
"""
import logging
from fastapi import APIRouter, Query

from services.backtest_service import run_full_backtest
from services.monte_carlo_service import run_monte_carlo_mdd

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/backtest", tags=["backtest"])


@router.post("/run")
async def trigger_backtest():
    """
    Run full backtest pipeline:
    1. Fetch OHLCV + ML signals from D1
    2. FIFO in-memory backtest per stock (7-layer cascade)
    3. Aggregate metrics (Sharpe, MDD, Win Rate, Profit Factor, Expectancy)
    4. Write results to D1 backtest_results table
    """
    logger.info("[Backtest] Triggered via API")
    try:
        return await run_full_backtest()
    except Exception as e:
        logger.exception("[Backtest] Pipeline failed")
        return {"status": "error", "error": str(e)}


@router.post("/monte-carlo")
async def trigger_monte_carlo(
    n: int = Query(default=1000, ge=100, le=10000, description="Number of simulations"),
    source: str = Query(default="paper", pattern="^(paper|backtest)$",
                        description="Data source: paper (real trades) or backtest"),
):
    """
    P0#5 Monte Carlo MDD Simulation:
    1. Fetch completed trades (paper_orders FIFO paired, or backtest results)
    2. Shuffle trade sequence N times
    3. Compute MDD for each permutation
    4. Report 95th/99th percentile worst-case MDD
    5. Go-live verdict: PASS (<20%) / CAUTION (20-30%) / FAIL (>30%)
    """
    logger.info(f"[MonteCarlo] Triggered: source={source}, n={n}")
    try:
        return await run_monte_carlo_mdd(n_simulations=n, source=source)
    except Exception as e:
        logger.exception("[MonteCarlo] Pipeline failed")
        return {"status": "error", "error": str(e)}
