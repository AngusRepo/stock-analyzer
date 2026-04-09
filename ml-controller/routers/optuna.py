"""
optuna.py — Optuna 自動化 endpoint (Cloud Run 版)
2026-04-07 Phase 1.6: 從 Modal 移到 Cloud Run

7 個 endpoint，對應 7 支 ml-controller/optuna_scripts/optuna_*.py
每個 endpoint:
1. 從 D1 直接抓最新資料 (CF REST API)
2. 呼叫 optuna search function
3. push 結果到 Worker KV (/api/admin/optuna-push)
4. 同步回傳結果

取代 Modal 路徑，避免：
- Modal 150s response timeout (web function 限制)
- 每次改 requirements.txt 都 rebuild image
- 額外的 Modal secret 管理

Worker monthly cron `0 16 1-7 * 6` 將 call 這個路徑（不再 call Modal）
"""
from __future__ import annotations
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel

from services.d1_client import query as d1_query
from services.kv_pusher import push_optuna_result

# 把 optuna_scripts/ 加到 sys.path 讓 import 可以 work
_SCRIPTS_DIR = Path(__file__).parent.parent / "optuna_scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/optuna", tags=["optuna"])


class OptunaReq(BaseModel):
    n_trials: int = 200
    push_kv: bool = True
    dry_run: bool = False
    # Sprint 5.1: sltp-specific (ignored by other sources)
    subset_size: int = 250
    start_date: str | None = None  # defaults to end_date - 90 days
    end_date: str | None = None    # defaults to today (TW)


# ─── Helpers: D1 loaders ─────────────────────────────────────────────────────

def _load_top_active_stocks_with_prices(min_rows: int = 200, top_n: int = 10) -> list[dict]:
    """For barrier search."""
    stocks = d1_query("""
        SELECT s.id, s.symbol, COUNT(*) as cnt
        FROM stocks s JOIN stock_prices sp ON sp.stock_id = s.id
        WHERE s.is_active = 1
        GROUP BY s.id HAVING cnt >= ?
        ORDER BY cnt DESC LIMIT ?
    """, [min_rows, top_n])
    if not stocks:
        return []
    out = []
    for s in stocks:
        rows = d1_query(
            "SELECT date, open, high, low, close, volume FROM stock_prices WHERE stock_id = ? ORDER BY date ASC",
            [s["id"]],
        )
        if len(rows) >= min_rows:
            out.append({"symbol": s["symbol"], "rows": rows})
    return out


def _load_paper_orders(limit: int = 500) -> list[dict]:
    """For sltp / signal search.
    paper_orders 沒 realized_pnl 欄位，這裡只抓 sell orders 給 sltp/signal scripts，
    它們內部會自己計算 pnl proxy。
    Phase 後續：應該 JOIN buy/sell pairs 算精確 per-trade pnl_pct。
    """
    return d1_query(
        "SELECT * FROM paper_orders WHERE side='sell' ORDER BY created_at DESC LIMIT ?",
        [limit],
    )


def _load_predictions(limit: int = 2000) -> list[dict]:
    """For signal search."""
    return d1_query(
        """SELECT stock_id, generated_at, direction_accuracy as confidence,
           signal_raw, forecast_data FROM predictions
           WHERE model_name='ensemble' ORDER BY generated_at DESC LIMIT ?""",
        [limit],
    )


def _load_daily_pnl(limit: int = 200) -> list[dict]:
    """For risk_params search: paper_daily_snapshots 的 pnl_pct 序列"""
    return d1_query(
        "SELECT date, pnl_pct, total_value, max_drawdown_to_date FROM paper_daily_snapshots WHERE pnl_pct IS NOT NULL ORDER BY date DESC LIMIT ?",
        [limit],
    )


def _load_twii_history(limit: int = 500) -> list[dict]:
    """For rrg/feature_window: TWII benchmark from market_risk (not stocks table)"""
    return d1_query(
        "SELECT date, twii_close FROM market_risk WHERE twii_close IS NOT NULL ORDER BY date ASC LIMIT ?",
        [limit],
    )


# ─── /optuna/barrier ─────────────────────────────────────────────────────────

@router.post("/barrier")
def run_barrier(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #1: Triple Barrier (upper_mult / lower_mult / pct_caps / max_days)"""
    try:
        from optuna_barrier import run_optuna_search  # type: ignore
        import pandas as pd
    except ImportError as e:
        raise HTTPException(500, f"optuna_barrier import failed: {e}")

    stocks_data = _load_top_active_stocks_with_prices(min_rows=200, top_n=10)
    if not stocks_data:
        raise HTTPException(400, "No active stocks with >= 200 price rows")

    all_data = {}
    for s in stocks_data:
        df = pd.DataFrame(s["rows"])
        df["date"] = pd.to_datetime(df["date"])
        all_data[s["symbol"]] = df

    logger.info(f"[Optuna/barrier] {len(all_data)} stocks, {req.n_trials} trials")
    result = run_optuna_search(all_data, n_trials=req.n_trials)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="barrier",
            params=best,
            meta={"n_trials": req.n_trials, "best_score": result.get("best_score"),
                  "stock_count": len(all_data)},
        )

    return {
        "status": "completed",
        "source": "barrier",
        "best_params": best,
        "best_score": result.get("best_score"),
        "n_trials": req.n_trials,
        "push": push_response,
    }


# ─── /optuna/signal ──────────────────────────────────────────────────────────

@router.post("/signal")
def run_signal(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #2: Signal thresholds"""
    try:
        from optuna_signal import run_search  # type: ignore
        import pandas as pd
    except ImportError as e:
        raise HTTPException(500, f"optuna_signal import failed: {e}")

    orders_rows = _load_paper_orders(limit=500)
    pred_rows = _load_predictions(limit=2000)
    if len(orders_rows) < 20 or len(pred_rows) < 50:
        raise HTTPException(400, f"Insufficient data: orders={len(orders_rows)}, predictions={len(pred_rows)}")

    orders = pd.DataFrame(orders_rows)
    predictions = pd.DataFrame(pred_rows)

    logger.info(f"[Optuna/signal] {len(orders)} orders, {len(predictions)} predictions, {req.n_trials} trials")
    result = run_search(predictions, orders, n_trials=req.n_trials)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="signal", params=best,
            meta={"n_trials": req.n_trials, "n_orders": len(orders), "n_predictions": len(predictions)},
        )

    return {"status": "completed", "source": "signal", "best_params": best,
            "n_trials": req.n_trials, "push": push_response}


# ─── /optuna/sltp ────────────────────────────────────────────────────────────

@router.post("/sltp")
def run_sltp(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #3: SL/TP + Trailing (Sprint 5.1: via backtest_engine replay)"""
    try:
        from optuna_sltp import run_search  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_sltp import failed: {e}")

    # Sprint 5.1: 讀當前 trading:config 當 baseline (其他 section 鎖定，只搜 sltp/exit)
    from services.kv_client import get_json as kv_get_json
    baseline_params = kv_get_json("trading:config", default=None)
    if baseline_params is None:
        logger.warning("[Optuna/sltp] trading:config KV missing, using script defaults")

    logger.info(
        f"[Optuna/sltp] Sprint 5.1 run: n_trials={req.n_trials} "
        f"subset={req.subset_size} window={req.start_date}~{req.end_date}"
    )
    try:
        result = run_search(
            n_trials=req.n_trials,
            subset_size=req.subset_size,
            start_date=req.start_date,
            end_date=req.end_date,
            baseline_params=baseline_params,
        )
    except RuntimeError as e:
        raise HTTPException(400, f"Optuna sltp failed: {e}")
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="sltp", params=best,
            meta={
                "n_trials": req.n_trials,
                "subset_size": result.get("subset_size"),
                "date_window": result.get("date_window"),
                "data_source": result.get("data_source"),
                "mode": result.get("mode"),
                "best_sharpe": result.get("best_sharpe"),
                "best_max_dd": result.get("best_max_dd"),
                "best_n_trades": result.get("best_n_trades"),
                "best_win_rate": result.get("best_win_rate"),
                "best_profit_factor": result.get("best_profit_factor"),
                "pareto_size": result.get("pareto_size"),
                "realism_note": result.get("realism_note"),
            },
        )

    return {
        "status": "completed", "source": "sltp", "best_params": best,
        "n_trials": req.n_trials, "push": push_response,
        "pareto_front": result.get("pareto_front", []),
        "best_sharpe": result.get("best_sharpe"),
        "best_max_dd": result.get("best_max_dd"),
        "best_n_trades": result.get("best_n_trades"),
        "pareto_size": result.get("pareto_size"),
        "subset_size": result.get("subset_size"),
        "date_window": result.get("date_window"),
        "mode": result.get("mode"),
        "realism_note": result.get("realism_note"),
    }


# ─── /optuna/conformal ───────────────────────────────────────────────────────

@router.post("/conformal")
def run_conformal(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna conformal: coverage / min_cal_size / max_residuals"""
    try:
        from optuna_conformal import search_conformal_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_conformal import failed: {e}")

    rows = d1_query("""
        SELECT direction_accuracy as confidence, direction_correct
        FROM predictions
        WHERE direction_correct IS NOT NULL AND direction_accuracy IS NOT NULL
        ORDER BY generated_at DESC LIMIT 2000
    """)
    if len(rows) < 50:
        raise HTTPException(400, f"Insufficient labeled predictions: {len(rows)}")

    confidences = [float(r["confidence"]) for r in rows]
    actuals = [int(r["direction_correct"]) for r in rows]

    logger.info(f"[Optuna/conformal] {len(confidences)} samples")
    result = search_conformal_params(confidences, actuals)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="conformal", params=best,
            meta={"n_samples": len(confidences), "best_ece": result.get("best_ece")},
        )

    return {"status": "completed", "source": "conformal", "best_params": best,
            "best_ece": result.get("best_ece"), "push": push_response}


# ─── /optuna/risk_params ─────────────────────────────────────────────────────

@router.post("/risk_params")
def run_risk_params(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna risk_params: drawdown / position pct / trail switches"""
    try:
        from optuna_risk_params import search_risk_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_risk_params import failed: {e}")

    # Phase 1.5: 改用 paper_daily_snapshots.pnl_pct 作為 daily returns
    rows = _load_daily_pnl(limit=200)
    if len(rows) < 20:
        raise HTTPException(400, f"Insufficient daily snapshots: {len(rows)}")

    trade_returns = [float(r["pnl_pct"]) for r in rows if r.get("pnl_pct") is not None]
    if len(trade_returns) < 20:
        raise HTTPException(400, f"Insufficient daily returns: {len(trade_returns)}")

    logger.info(f"[Optuna/risk_params] {len(trade_returns)} daily returns")
    result = search_risk_params(trade_returns)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="risk_params", params=best,
            meta={"n_returns": len(trade_returns)},
        )

    return {"status": "completed", "source": "risk_params", "best_params": best,
            "push": push_response}


# ─── /optuna/rrg ─────────────────────────────────────────────────────────────

@router.post("/rrg")
def run_rrg(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna rrg: rs_window / ema_span / mom_lookback"""
    try:
        from optuna_rrg import search_rrg_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_rrg import failed: {e}")

    # Benchmark from market_risk.twii_close
    twii_rows = _load_twii_history(limit=500)
    if len(twii_rows) < 60:
        raise HTTPException(400, f"Insufficient TWII benchmark: {len(twii_rows)}")

    closes = [float(r["twii_close"]) for r in twii_rows]
    benchmark_returns = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes))]

    # Top 10 stocks by price count
    top_stocks = d1_query("""
        SELECT s.id, s.symbol, COUNT(*) as cnt
        FROM stocks s JOIN stock_prices sp ON sp.stock_id = s.id
        WHERE s.is_active = 1
        GROUP BY s.id HAVING cnt >= 100
        ORDER BY cnt DESC LIMIT 10
    """)
    prices_by_stock: dict[str, list[float]] = {}
    for s in top_stocks:
        rows = d1_query(
            "SELECT close FROM stock_prices WHERE stock_id = ? ORDER BY date ASC LIMIT 500",
            [s["id"]],
        )
        if len(rows) >= 100:
            prices_by_stock[s["symbol"]] = [float(r["close"]) for r in rows]

    if not prices_by_stock:
        raise HTTPException(400, "No top stocks with sufficient prices")

    logger.info(f"[Optuna/rrg] {len(prices_by_stock)} stocks, benchmark {len(benchmark_returns)} returns")
    result = search_rrg_params(prices_by_stock, benchmark_returns)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="rrg", params=best,
            meta={"n_stocks": len(prices_by_stock)},
        )

    return {"status": "completed", "source": "rrg", "best_params": best,
            "push": push_response}


# ─── /optuna/feature_window ──────────────────────────────────────────────────

@router.post("/feature_window")
def run_feature_window(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna feature_window: vol/ma/return windows"""
    try:
        from optuna_feature_window import search_feature_windows  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_feature_window import failed: {e}")

    # TWII as benchmark for feature window search
    twii_rows = _load_twii_history(limit=1000)
    if len(twii_rows) < 100:
        raise HTTPException(400, f"Insufficient TWII data: {len(twii_rows)}")

    closes = [float(r["twii_close"]) for r in twii_rows]
    # market_risk 沒 volume，用 close 數列充當（feature_window 主要看 closes）
    volumes = [1.0] * len(closes)

    logger.info(f"[Optuna/feature_window] {len(closes)} bars (TWII)")
    result = search_feature_windows(closes, volumes)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        # source='feature_window' 在 Worker 是 501 deferred，這次只回 push response
        push_response = push_optuna_result(
            source="feature_window", params=best,
            meta={"n_bars": len(closes)},
        )

    return {"status": "completed", "source": "feature_window", "best_params": best,
            "push": push_response}
