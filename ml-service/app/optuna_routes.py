"""
optuna_routes.py — Optuna endpoint 統一介面
2026-04-07 added (Phase 1)

7 個 endpoint，對應 7 支 Optuna script。每個 endpoint:
1. 從 D1 抓最新資料（直接透過 CF D1 REST API，非 Worker proxy）
2. 呼叫 optuna search function
3. 直接 push 結果到 Worker KV (透過 /api/admin/optuna-push)
4. 同步回傳結果（不寫 local file）

取代「dump CSV → 跑 script → 手動 push」流程

Worker monthly cron `0 16 1-7 * 6` 會呼叫這些 endpoint。
"""
from __future__ import annotations
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel

from app.d1_client import query as d1_query
from app.kv_pusher import push_optuna_result


def _ensure_scripts_in_path():
    """Idempotent: 把 scripts/ 加到 sys.path（每次 endpoint 呼叫前確保）"""
    candidates = [
        "/root/scripts",                                # Modal container
        str(Path(__file__).parent.parent / "scripts"), # local dev
    ]
    for p in candidates:
        if p not in sys.path:
            sys.path.insert(0, p)


# 模組載入時也跑一次（cold path）
_ensure_scripts_in_path()

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/optuna", tags=["optuna"])


class OptunaReq(BaseModel):
    n_trials: int = 200
    push_kv: bool = True
    dry_run: bool = False  # 跑完不 push 也不回完整結果，只回 best_params


# ─── Helper: 從 D1 載入資料 ───────────────────────────────────────────────────

def _load_top_active_stocks_with_prices(min_rows: int = 200, top_n: int = 10) -> list[dict]:
    """For barrier search: 找資料最多的 active 股票們，回傳 [{symbol, prices: [...]}, ...]"""
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
    paper_orders 沒 realized_pnl 欄位，改抓所有 sell orders + 用 paper_daily_snapshots 的 pnl_pct 作 proxy。
    Phase 1.5+ refinement: 應該 JOIN buy/sell pairs 算 per-trade pnl_pct。
    """
    return d1_query(
        "SELECT * FROM paper_orders WHERE side='sell' ORDER BY created_at DESC LIMIT ?",
        [limit],
    )


def _load_daily_pnl(limit: int = 200) -> list[dict]:
    """For risk_params search: 從 paper_daily_snapshots 抓日收益率序列"""
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


def _load_predictions(limit: int = 2000) -> list[dict]:
    """For signal search."""
    return d1_query(
        """SELECT stock_id, generated_at, direction_accuracy as confidence,
           signal_raw, forecast_data FROM predictions
           WHERE model_name='ensemble' ORDER BY generated_at DESC LIMIT ?""",
        [limit],
    )


# ─── Endpoint: /optuna/barrier ────────────────────────────────────────────────

@router.post("/barrier")
def run_barrier_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #1: Triple Barrier (upper_mult / lower_mult / pct_caps / max_days)"""
    _ensure_scripts_in_path()
    try:
        from optuna_barrier import run_optuna_search  # type: ignore
        import pandas as pd
    except ImportError as e:
        # Debug: show sys.path + /root/scripts existence
        import os
        debug_info = {
            "sys_path": sys.path[:5],
            "root_scripts_exists": Path("/root/scripts").exists(),
            "root_scripts_files": (
                [p.name for p in Path("/root/scripts").iterdir()][:20]
                if Path("/root/scripts").exists() else []
            ),
            "cwd": os.getcwd(),
        }
        raise HTTPException(500, f"optuna_barrier import failed: {e}; debug={debug_info}")

    stocks_data = _load_top_active_stocks_with_prices(min_rows=200, top_n=10)
    if not stocks_data:
        raise HTTPException(400, "No active stocks with >= 200 price rows")

    all_data = {}
    for s in stocks_data:
        df = pd.DataFrame(s["rows"])
        df["date"] = pd.to_datetime(df["date"])
        all_data[s["symbol"]] = df

    logger.info(f"[Optuna/barrier] Running on {len(all_data)} stocks, {req.n_trials} trials")
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


# ─── Endpoint: /optuna/signal ─────────────────────────────────────────────────

@router.post("/signal")
def run_signal_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #2: Signal thresholds (strong/buy/hold/consensus/confidence)"""
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

    logger.info(f"[Optuna/signal] Running on {len(orders)} orders, {len(predictions)} predictions, {req.n_trials} trials")
    result = run_search(predictions, orders, n_trials=req.n_trials)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="signal",
            params=best,
            meta={"n_trials": req.n_trials, "n_orders": len(orders), "n_predictions": len(predictions)},
        )

    return {
        "status": "completed",
        "source": "signal",
        "best_params": best,
        "n_trials": req.n_trials,
        "push": push_response,
    }


# ─── Endpoint: /optuna/sltp ───────────────────────────────────────────────────

@router.post("/sltp")
def run_sltp_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #3: SL/TP + Trailing (sl_mult / tp_mult / trailMult* / trail_switch_*)"""
    try:
        from optuna_sltp import run_search  # type: ignore
        import pandas as pd
    except ImportError as e:
        raise HTTPException(500, f"optuna_sltp import failed: {e}")

    orders_rows = _load_paper_orders(limit=500)
    if len(orders_rows) < 20:
        raise HTTPException(400, f"Insufficient orders: {len(orders_rows)}")

    orders = pd.DataFrame(orders_rows)

    logger.info(f"[Optuna/sltp] Running on {len(orders)} orders, {req.n_trials} trials")
    result = run_search(orders, n_trials=req.n_trials)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="sltp",
            params=best,
            meta={"n_trials": req.n_trials, "n_orders": len(orders),
                  "best_pf": result.get("best_profit_factor")},
        )

    return {
        "status": "completed",
        "source": "sltp",
        "best_params": best,
        "n_trials": req.n_trials,
        "push": push_response,
    }


# ─── Endpoint: /optuna/conformal (orphan, Phase 1.3) ──────────────────────────

@router.post("/conformal")
def run_conformal_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna conformal: coverage / min_cal_size / max_residuals"""
    try:
        from optuna_conformal import search_conformal_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_conformal import failed: {e}")

    # Load (confidence, direction_correct) pairs from predictions
    rows = d1_query("""
        SELECT direction_accuracy as confidence, direction_correct
        FROM predictions
        WHERE direction_correct IS NOT NULL AND direction_accuracy IS NOT NULL
        ORDER BY generated_at DESC LIMIT 2000
    """)
    if len(rows) < 50:
        raise HTTPException(400, f"Insufficient labeled predictions: {len(rows)}")

    confidences = [float(r["confidence"]) for r in rows]
    actuals     = [int(r["direction_correct"]) for r in rows]

    logger.info(f"[Optuna/conformal] {len(confidences)} samples, n_trials=50")
    result = search_conformal_params(confidences, actuals)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="conformal",
            params=best,
            meta={"n_samples": len(confidences), "best_ece": result.get("best_ece")},
        )

    return {
        "status": "completed",
        "source": "conformal",
        "best_params": best,
        "best_ece": result.get("best_ece"),
        "push": push_response,
    }


# ─── Endpoint: /optuna/risk_params (orphan, Phase 1.3) ────────────────────────

@router.post("/risk_params")
def run_risk_params_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna risk_params: drawdown_halt / max_pos_pct / trail_switches / trail_mults / risk_pct"""
    try:
        from optuna_risk_params import search_risk_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_risk_params import failed: {e}")

    # Phase 1.5: 改用 paper_daily_snapshots.pnl_pct 作為 daily returns
    # （paper_orders 沒 realized_pnl 欄位，paired buy/sell JOIN 留下次優化）
    rows = _load_daily_pnl(limit=200)
    if len(rows) < 20:
        raise HTTPException(400, f"Insufficient daily snapshots: {len(rows)}")

    trade_returns = [float(r["pnl_pct"]) for r in rows if r.get("pnl_pct") is not None]
    if len(trade_returns) < 20:
        raise HTTPException(400, f"Insufficient valid daily returns: {len(trade_returns)}")

    logger.info(f"[Optuna/risk_params] {len(trade_returns)} trades")
    result = search_risk_params(trade_returns)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="risk_params",
            params=best,
            meta={"n_trades": len(trade_returns)},
        )

    return {
        "status": "completed",
        "source": "risk_params",
        "best_params": best,
        "push": push_response,
    }


# ─── Endpoint: /optuna/rrg (orphan, Phase 1.3) ────────────────────────────────

@router.post("/rrg")
def run_rrg_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna rrg: rs_window / ema_span / mom_lookback"""
    try:
        from optuna_rrg import search_rrg_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_rrg import failed: {e}")

    # Load benchmark (TAIEX) prices + top stock prices
    bench_rows = d1_query("""
        SELECT date, close FROM stock_prices
        WHERE stock_id = (SELECT id FROM stocks WHERE symbol IN ('TAIEX','^TWII') LIMIT 1)
        ORDER BY date ASC LIMIT 500
    """)
    if len(bench_rows) < 60:
        raise HTTPException(400, f"Insufficient benchmark data: {len(bench_rows)}")

    closes = [float(r["close"]) for r in bench_rows]
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
            source="rrg",
            params=best,
            meta={"n_stocks": len(prices_by_stock)},
        )

    return {
        "status": "completed",
        "source": "rrg",
        "best_params": best,
        "push": push_response,
    }


# ─── Endpoint: /optuna/feature_window (orphan, Phase 1.3) ─────────────────────

@router.post("/feature_window")
def run_feature_window_search(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna feature_window: vol/ma/return windows for indicator construction"""
    try:
        from optuna_feature_window import search_feature_windows  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_feature_window import failed: {e}")

    # Use TAIEX prices for window search
    rows = d1_query("""
        SELECT close, volume FROM stock_prices
        WHERE stock_id = (SELECT id FROM stocks WHERE symbol IN ('TAIEX','^TWII') LIMIT 1)
        ORDER BY date ASC LIMIT 1000
    """)
    if len(rows) < 100:
        raise HTTPException(400, f"Insufficient benchmark data: {len(rows)}")

    closes = [float(r["close"]) for r in rows]
    volumes = [float(r["volume"] or 0) for r in rows]

    logger.info(f"[Optuna/feature_window] {len(closes)} bars")
    result = search_feature_windows(closes, volumes)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        # feature_window 寫進 trading:config.L2_formula 還沒 wired，先標 deferred
        logger.warning("[Optuna/feature_window] KV push not yet wired (Worker source='feature_window' returns 501)")
        push_response = push_optuna_result(source="feature_window", params=best,
                                            meta={"n_bars": len(closes)})

    return {
        "status": "completed",
        "source": "feature_window",
        "best_params": best,
        "push": push_response,
    }
