"""
backtest.py — Weekly backtest + Monte Carlo + PBO + Sprint 6 replay endpoints

POST /backtest/run         → FIFO backtest pipeline (backtest_service, fixed config)
POST /backtest/monte-carlo → Monte Carlo MDD simulation
POST /backtest/pbo         → Probability of Backtest Overfitting (CPCV)
POST /backtest/replay      → Sprint 6 parameterized Mode A replay (Optuna objective)
"""
import logging
from fastapi import APIRouter, Body, Query
from pydantic import BaseModel, Field
from typing import Optional

from services.backtest_service import run_full_backtest
from services.monte_carlo_service import run_monte_carlo_mdd
from services.pbo_service import run_pbo_analysis
from services.backtest_engine import replay_period_loading

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


class ReplayRequest(BaseModel):
    """Sprint 6a POST /backtest/replay request body."""
    start_date: str = Field(..., description="Inclusive start 'YYYY-MM-DD'")
    end_date: str = Field(..., description="Inclusive end 'YYYY-MM-DD'")
    params: dict = Field(
        default_factory=dict,
        description="trading:config shape dict (screener/ranking/position/sltp/exit/fees). "
                    "Missing sections use defaults.",
    )
    initial_capital: float = Field(default=1_000_000)
    mode: str = Field(default="A", pattern="^(A|B)$")
    symbols: Optional[list[str]] = Field(
        default=None,
        description="Subset filter for smoke tests. None = full universe (~2346 stocks).",
    )
    verbose: bool = Field(default=False)


@router.post("/replay")
async def trigger_replay(req: ReplayRequest = Body(...)):
    """
    Sprint 6a Mode A parameterized backtest replay.

    ⚠️ Mode A Sharpe is unreliable as absolute production prediction.
    Check response.realism_warnings + sanity_flags before acting.
    See memory/project_backtest_engine_design_rationale.md section 3.

    Typical smoke test body:
      {
        "start_date": "2024-01-01",
        "end_date": "2024-03-31",
        "params": {},
        "symbols": ["2330", "2317", "2454", "2308", "2303"],
        "verbose": true
      }

    Full-universe Optuna objective usage (do not call via HTTP per trial —
    preload dataset once and call replay_period directly to avoid D1 re-fetch):
      {
        "start_date": "2023-01-01",
        "end_date": "2024-12-31",
        "params": {...optuna trial params...}
      }
    """
    logger.info(
        f"[Replay] {req.start_date}~{req.end_date} mode={req.mode} "
        f"symbols={len(req.symbols) if req.symbols else 'full'}"
    )
    try:
        metrics = replay_period_loading(
            start_date=req.start_date,
            end_date=req.end_date,
            params=req.params,
            initial_capital=req.initial_capital,
            mode=req.mode,
            symbols=req.symbols,
            verbose=req.verbose,
        )

        # Serialize BacktestMetrics to JSON-safe dict
        return {
            "status": "ok",
            "mode": metrics.mode,
            "timerange": f"{metrics.start_date}~{metrics.end_date}",
            "initial_capital": metrics.initial_capital,
            "final_equity": round(metrics.final_equity, 2),
            "total_return": round(metrics.total_return, 4),
            "cagr": round(metrics.cagr, 4) if metrics.cagr is not None else None,
            "sharpe": round(metrics.sharpe, 3) if metrics.sharpe is not None else None,
            "sortino": round(metrics.sortino, 3) if metrics.sortino is not None else None,
            "calmar": round(metrics.calmar, 3) if metrics.calmar is not None else None,
            "max_drawdown": round(metrics.max_drawdown, 4),
            "max_dd_date": metrics.max_dd_date,
            "total_trades": metrics.total_trades,
            "wins": metrics.wins,
            "losses": metrics.losses,
            "win_rate": round(metrics.win_rate, 4),
            "profit_factor": round(metrics.profit_factor, 3),
            "expectancy": round(metrics.expectancy, 5),
            "avg_holding_days": round(metrics.avg_holding_days, 1),
            "entry_attempts": metrics.entry_attempts,
            "entries_filled": metrics.entries_filled,
            "fill_rate": round(metrics.fill_rate, 3),
            "skip_reasons": metrics.skip_reasons,
            "exit_distribution": metrics.exit_distribution,
            "per_regime": metrics.per_regime,
            "realism_warnings": metrics.realism_warnings,
            "absolute_confidence": metrics.absolute_confidence,
            "sanity_flags": metrics.sanity_flags,
            # Truncate heavy fields for HTTP response (full lists are in memory still)
            "trades_sample": [
                {
                    "symbol": t.symbol,
                    "entry": t.entry_date, "exit": t.exit_date,
                    "entry_px": round(t.entry_price, 2), "exit_px": round(t.exit_price, 2),
                    "shares": t.shares, "pnl": round(t.profit_ratio, 4),
                    "reason": t.exit_reason, "days": t.days_held,
                }
                for t in metrics.trades[:50]
            ],
            "equity_curve_sample": metrics.equity_curve[:: max(1, len(metrics.equity_curve) // 50)][:51],
        }
    except Exception as e:
        logger.exception("[Replay] Failed")
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
