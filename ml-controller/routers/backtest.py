"""
backtest.py — Weekly backtest + Monte Carlo + PBO endpoints

POST /backtest/run         → FIFO backtest pipeline
POST /backtest/monte-carlo → Monte Carlo MDD simulation
POST /backtest/pbo         → Probability of Backtest Overfitting (CPCV)
"""
import logging
from fastapi import APIRouter, Query

from services.backtest_service import run_full_backtest
from services.monte_carlo_service import run_monte_carlo_mdd
from services.pbo_service import run_pbo_analysis

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


@router.post("/pbo")
async def trigger_pbo(
    partitions: int = Query(default=10, ge=4, le=20, description="Number of time partitions"),
    source: str = Query(default="backtest", pattern="^(paper|backtest)$",
                        description="Data source: backtest or paper"),
):
    """
    P0#6 Probability of Backtest Overfitting (CPCV):
    1. Split trades into S time partitions
    2. C(S, S/2) train/test combinations
    3. PBO = fraction where OOS return < 0
    4. Go-live verdict: PASS (PBO < 0.5) / FAIL (PBO >= 0.5)
    """
    logger.info(f"[PBO] Triggered: source={source}, partitions={partitions}")
    try:
        return await run_pbo_analysis(n_partitions=partitions, source=source)
    except Exception as e:
        logger.exception("[PBO] Pipeline failed")
        return {"status": "error", "error": str(e)}
