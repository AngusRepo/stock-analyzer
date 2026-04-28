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
from services.alpha_evidence_runner import run_alpha_candidate_evidence
from services.promotion_service import (
    evaluate_alpha_policy_evidence_gate,
    evaluate_latest_alpha_policy_gate,
    evaluate_latest_promotion_gate,
)
from services.backtest_result_store import persist_replay_backtest
from services.backtest_engine import (
    replay_period_loading,
    diagnose_replay_for_date,
    BacktestDataset,
    ScreenerParams,
    RankingParams,
)

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
    method: str = Query(default="block_bootstrap", pattern="^(block_bootstrap|regime_block_bootstrap|iid_shuffle)$",
                        description="Simulation method; regime/block bootstrap preserves clustered loss streaks"),
    block_size: int | None = Query(default=None, ge=1, le=60,
                                   description="Optional moving-block size for block bootstrap"),
):
    """
    P0#5 Monte Carlo MDD Simulation:
    1. Fetch completed trades (paper_orders FIFO paired, or backtest results)
    2. Simulate trade paths N times (block bootstrap by default; iid_shuffle kept for legacy comparison)
    3. Compute MDD for each permutation
    4. Report 95th/99th percentile worst-case MDD
    5. Go-live verdict: PASS (<20%) / CAUTION (20-30%) / FAIL (>30%)
    """
    logger.info(f"[MonteCarlo] Triggered: source={source}, n={n}, method={method}, block_size={block_size}")
    try:
        return await run_monte_carlo_mdd(
            n_simulations=n,
            source=source,
            method=method,
            block_size=block_size,
        )
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
    persist_results: bool = Field(
        default=False,
        description="Persist replay result into D1 backtest_results for promotion gates.",
    )
    persist_confirm: bool = Field(
        default=False,
        description="Required with persist_results=true to avoid accidental promotion-gate writes.",
    )
    parity_audit: Optional[dict] = Field(
        default=None,
        description="Worker/API parity audit to persist with promotion-grade replay rows. "
                    "Promotion gates fail closed unless worker_parity.decision == PASS.",
    )
    regime_label: Optional[str] = Field(
        default=None,
        description="#28b T2.4: apply params.sltp_per_regime[canonical_label] overlay "
                    "for the whole replay window. Accepts 'bull' / 'bull_market' / "
                    "'bear' / 'bear_market' / 'volatile' / 'sideways' (case-insensitive). "
                    "None = flat sltp (backward-compat).",
    )


class AlphaPromotionGateRequest(BaseModel):
    candidate: dict = Field(
        default_factory=dict,
        description="Alpha policy candidate metadata from /optuna/alpha_framework or Worker sandbox metadata.",
    )
    source: str = Field(default="backtest", pattern="^(backtest)$")
    pbo_source: Optional[str] = Field(default=None, pattern="^(backtest|optuna_l2)$")
    evidence: Optional[dict] = Field(
        default=None,
        description="Candidate-specific evidence bundle {candidate_id, backtest, monte_carlo, pbo}. "
                    "When provided, gate does not read latest global artifacts.",
    )


class AlphaEvidenceRequest(BaseModel):
    candidate: dict = Field(
        default_factory=dict,
        description="Alpha framework sandbox/challenger candidate.",
    )
    start_date: str = Field(..., description="Inclusive start 'YYYY-MM-DD'")
    end_date: str = Field(..., description="Inclusive end 'YYYY-MM-DD'")
    baseline_config: dict = Field(
        default_factory=dict,
        description="Current champion trading:config. Candidate config is deep-merged over this.",
    )
    initial_capital: float = Field(default=1_000_000)
    mode: str = Field(default="B", pattern="^(B)$")
    symbols: Optional[list[str]] = Field(default=None)
    mc_simulations: int = Field(default=1000, ge=100, le=10000)
    parity_audit: Optional[dict] = Field(
        default=None,
        description="Worker/API parity audit. Gate fails closed if worker_parity.decision is not PASS.",
    )


@router.post("/alpha-evidence")
def post_alpha_evidence(req: AlphaEvidenceRequest = Body(...)):
    """Generate candidate-specific alpha evidence. Read-only: no D1/KV/promote writes."""
    logger.info("[AlphaEvidence] Running candidate-specific replay/MC/PBO")
    try:
        return {
            "status": "ok",
            **run_alpha_candidate_evidence(
                req.candidate,
                start_date=req.start_date,
                end_date=req.end_date,
                baseline_config=req.baseline_config,
                initial_capital=req.initial_capital,
                mode=req.mode,
                symbols=req.symbols,
                mc_simulations=req.mc_simulations,
                parity_audit=req.parity_audit,
                alpha_replay_applied=True,
            ),
        }
    except Exception as e:
        logger.exception("[AlphaEvidence] Evaluation failed")
        return {"status": "error", "error": str(e)}


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
            regime_label=req.regime_label,
        )

        persist_result = None
        if req.persist_results:
            if not req.persist_confirm:
                return {
                    "status": "error",
                    "error": "persist_results=true requires persist_confirm=true",
                }
            persist_result = persist_replay_backtest(metrics, parity_audit=req.parity_audit)

        # Serialize BacktestMetrics to JSON-safe dict
        return {
            "status": "ok",
            "mode": metrics.mode,
            "persist_result": persist_result,
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
            "partition_returns": metrics.partition_returns,
            # Truncate heavy fields for HTTP response (full lists are in memory still)
            "trades_sample": [
                {
                    "symbol": t.symbol,
                    "entry": t.entry_date, "exit": t.exit_date,
                    "entry_px": round(t.entry_price, 2), "exit_px": round(t.exit_price, 2),
                    "shares": t.shares, "pnl": round(t.profit_ratio, 4),
                    "entry_regime": t.entry_regime,
                    "reason": t.exit_reason, "days": t.days_held,
                }
                for t in metrics.trades[:50]
            ],
            "equity_curve_sample": metrics.equity_curve[:: max(1, len(metrics.equity_curve) // 50)][:51],
        }
    except Exception as e:
        logger.exception("[Replay] Failed")
        return {"status": "error", "error": str(e)}


class DiagnoseRequest(BaseModel):
    """B1 regression diagnostic: funnel counters per stage of
    replay_screener_for_date. Loads BacktestDataset for a short window
    ending at `date`, then runs the instrumented clone.

    Typical smoke body:
      {"date": "2024-03-08", "lookback_calendar_days": 35,
       "params": {}, "symbols": null}
    """
    date: str = Field(..., description="Decision date 'YYYY-MM-DD' (end of window)")
    lookback_calendar_days: int = Field(
        default=35, ge=7, le=120,
        description="Calendar days of history to load before `date` (must be "
                    ">= 22 trading days for screener lookback window)"
    )
    params: dict = Field(
        default_factory=dict,
        description="trading:config shape for screener/ranking. Missing keys use defaults."
    )
    symbols: Optional[list[str]] = Field(
        default=None,
        description="Subset filter. None = full universe."
    )
    max_dropped_samples: int = Field(default=10, ge=0, le=50)


@router.post("/diagnose")
async def trigger_diagnose(req: DiagnoseRequest = Body(...)):
    """
    B1 regression diagnostic endpoint (2026-04-20).

    Funnel-counter view of `replay_screener_for_date` for a single date.
    Returns:
      - dataset_sanity: _price_np cache key type + lookup test on 2330
        (reveals Polars 1.0 tuple-key bug vs str-key)
      - funnel: count at each of the 6 pipeline stages
      - dropped_samples: up to N symbol names per drop bucket
      - passed_samples: first N symbols that made it to `scored`

    Expensive: loads BacktestDataset from D1 (same cost as /backtest/replay).
    """
    from datetime import date as _date, timedelta as _td
    try:
        end_d = _date.fromisoformat(req.date)
    except ValueError:
        return {"status": "error", "error": f"Invalid date '{req.date}'"}
    start_d = end_d - _td(days=req.lookback_calendar_days)
    start_s = start_d.isoformat()

    logger.info(
        f"[Diagnose] date={req.date} window={start_s}~{req.date} "
        f"symbols={len(req.symbols) if req.symbols else 'full'}"
    )

    try:
        dataset = BacktestDataset.load_from_d1(
            start_date=start_s,
            end_date=req.date,
            symbols=req.symbols,
        )
        screener = ScreenerParams.from_trading_config(req.params)
        ranking = RankingParams.from_trading_config(req.params)
        result = diagnose_replay_for_date(
            dataset=dataset,
            date=req.date,
            screener=screener,
            ranking=ranking,
            lookback_days=22,
            max_dropped_samples=req.max_dropped_samples,
        )
        return {"status": "ok", **result}
    except Exception as e:
        logger.exception("[Diagnose] Failed")
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


@router.get("/promotion-gate")
async def get_promotion_gate(
    source: str = Query(default="backtest", pattern="^(paper|backtest)$",
                        description="Risk source for Monte Carlo rows"),
    pbo_source: str | None = Query(default=None, pattern="^(paper|backtest|optuna_l2)$",
                                   description="PBO row source; defaults to source"),
):
    """
    Read-only production promotion gate.

    Joins latest Mode B backtest, Monte Carlo, and PBO rows, then returns a
    fail-closed PASS/FAIL decision. This endpoint never promotes by itself.
    """
    logger.info(f"[PromotionGate] Evaluating latest gate: source={source}")
    try:
        return {"status": "ok", **evaluate_latest_promotion_gate(source=source, pbo_source=pbo_source)}
    except Exception as e:
        logger.exception("[PromotionGate] Evaluation failed")
        return {"status": "error", "error": str(e)}


@router.post("/alpha-promotion-gate")
async def post_alpha_promotion_gate(req: AlphaPromotionGateRequest = Body(...)):
    """
    Read-only alpha policy promotion gate.

    Candidate must include alpha outcome provenance (sample_count/regime_counts)
    and still pass the same Mode B + Monte Carlo + PBO gates as other
    production-bound changes. This endpoint never promotes by itself.
    """
    logger.info("[AlphaPromotionGate] Evaluating alpha framework candidate")
    try:
        return {
            "status": "ok",
            **(
                evaluate_alpha_policy_evidence_gate(req.candidate, req.evidence)
                if req.evidence
                else evaluate_latest_alpha_policy_gate(
                    req.candidate,
                    source=req.source,
                    pbo_source=req.pbo_source,
                )
            ),
        }
    except Exception as e:
        logger.exception("[AlphaPromotionGate] Evaluation failed")
        return {"status": "error", "error": str(e)}
