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

GCP Scheduler monthly groc `first saturday of month 16:00` 會 call 這個路徑（不再 call Modal）
"""
from __future__ import annotations
import logging
import sys
from pathlib import Path
from typing import Any

import polars as pl
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field

from services.d1_client import query as d1_query
from services.alpha_quality_policy import alpha_quality_policy
from services.alpha_policy_search import build_alpha_policy_candidate, load_alpha_outcome_rows
from services.ga_optimizer_service import GAOptimizerRequest, run_ga_optimizer as run_ga_optimizer_service
from services.kv_pusher import push_optuna_result
from services.optuna_route_policy import OptunaRoutePolicy
from services.optuna_script_contracts import get_optuna_script_contract
from services.research_data_access import resolve_research_data_access
from services.snapshot_parquet import read_snapshot_component

# 把 optuna_scripts/ 加到 sys.path 讓 import 可以 work
_SCRIPTS_DIR = Path(__file__).parent.parent / "optuna_scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/optuna", tags=["optuna"])
OPTUNA_D1_READ_CHUNK_SIZE = 80


class OptunaReq(BaseModel):
    n_trials: int = 200
    push_kv: bool = True
    dry_run: bool = False
    # Sprint 5.1: sltp-specific (ignored by other sources)
    subset_size: int = 250
    start_date: str | None = None  # defaults to end_date - 90 days
    end_date: str | None = None    # defaults to today (TW)


class AlphaFrameworkOptunaReq(BaseModel):
    n_trials: int = 200
    push_kv: bool = True
    dry_run: bool = False
    subset_size: int | None = Field(default=None, ge=100, le=5000)


class GAOptimizerReq(BaseModel):
    population_size: int = Field(default=24, ge=6, le=200)
    generations: int = Field(default=8, ge=1, le=50)
    mutation_rate: float = Field(default=0.25, ge=0.0, le=1.0)
    crossover_rate: float = Field(default=0.70, ge=0.0, le=1.0)
    elite_count: int = Field(default=4, ge=1, le=50)
    seed: int = 42
    top_k: int = Field(default=5, ge=1, le=20)
    push_kv: bool = True
    dry_run: bool = False


def _push_live(req) -> bool:
    return bool(req.push_kv and not req.dry_run)


def _contract_meta(
    *,
    source: str,
    scope: str,
    sample_scope: str,
    applies_to_production: bool,
    push_target: str,
    effective_fields: list[str] | None = None,
    excluded_fields: list[str] | None = None,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    script_contract = get_optuna_script_contract(source).to_dict()
    return {
        "source": source,
        "scope": scope,
        "sample_scope": sample_scope,
        "script_contract": script_contract,
        "applies_to_production": applies_to_production,
        "push_target": push_target,
        "effective_fields": effective_fields or [],
        "excluded_fields": excluded_fields or [],
        "notes": notes or [],
    }


# ─── Helpers: D1 loaders ─────────────────────────────────────────────────────


def _load_top_active_stocks_with_prices(min_rows: int = 200, top_n: int = 10) -> list[dict]:
    """For barrier search — D10 fix: use tradable universe, not just watchlist."""
    data_access = resolve_research_data_access(lane="optuna.barrier", kind="price_history")
    if data_access.source == "snapshot":
        if not data_access.snapshot:
            raise RuntimeError(f"price_snapshot_missing:{data_access.to_dict()}")
        return _load_top_active_stocks_with_prices_from_snapshot(
            data_access.snapshot,
            min_rows=min_rows,
            top_n=top_n,
        )
    stocks = d1_query("""
        SELECT s.id, s.symbol, COUNT(*) as cnt
        FROM stocks s JOIN stock_prices sp ON sp.stock_id = s.id
        WHERE s.delisted_date IS NULL
        GROUP BY s.id HAVING cnt >= ?
        ORDER BY cnt DESC LIMIT ?
    """, [min_rows, top_n])
    if not stocks:
        return []
    price_rows = _load_price_rows_by_stock_ids([int(s["id"]) for s in stocks])
    out = []
    for s in stocks:
        rows = price_rows.get(int(s["id"]), [])
        if len(rows) >= min_rows:
            out.append({"symbol": s["symbol"], "rows": rows})
    return out


def _prices_with_symbol_from_snapshot(manifest: dict[str, Any]) -> pl.DataFrame:
    prices = read_snapshot_component(manifest, "prices")
    if prices is None or prices.is_empty():
        return pl.DataFrame()

    stocks = read_snapshot_component(manifest, "stocks", required=False)
    if "symbol" not in prices.columns and stocks is not None and not stocks.is_empty():
        if {"id", "symbol"}.issubset(set(stocks.columns)) and "stock_id" in prices.columns:
            prices = prices.join(
                stocks.select([pl.col("id").alias("stock_id"), "symbol"]),
                on="stock_id",
                how="inner",
            )
    if "symbol" not in prices.columns:
        raise RuntimeError("price_snapshot_symbol_missing")
    if stocks is not None and not stocks.is_empty() and {"symbol", "delisted_date"}.issubset(set(stocks.columns)):
        active_symbols = (
            stocks
            .filter(pl.col("delisted_date").is_null())
            .get_column("symbol")
            .to_list()
        )
        prices = prices.filter(pl.col("symbol").is_in(set(active_symbols)))
    return prices.with_columns(pl.col("date").cast(pl.Utf8)).sort(["symbol", "date"])


def _load_top_active_stocks_with_prices_from_snapshot(
    manifest: dict[str, Any],
    *,
    min_rows: int,
    top_n: int,
) -> list[dict]:
    prices = _prices_with_symbol_from_snapshot(manifest)
    if prices.is_empty():
        return []
    counts = (
        prices
        .group_by("symbol")
        .len()
        .rename({"len": "cnt"})
        .filter(pl.col("cnt") >= min_rows)
        .sort("cnt", descending=True)
        .head(top_n)
    )
    out: list[dict] = []
    for symbol in counts.get_column("symbol").to_list():
        rows = (
            prices
            .filter(pl.col("symbol") == symbol)
            .select([col for col in ["date", "open", "high", "low", "close", "volume"] if col in prices.columns])
            .to_dicts()
        )
        if len(rows) >= min_rows:
            out.append({"symbol": symbol, "rows": rows})
    return out


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _load_price_rows_by_stock_ids(stock_ids: list[int], limit_per_stock: int | None = None) -> dict[int, list[dict]]:
    """Load stock price rows in D1 chunks for Optuna sandbox loaders."""
    grouped: dict[int, list[dict]] = {int(stock_id): [] for stock_id in stock_ids}
    if not stock_ids:
        return grouped
    for ids in _chunks(stock_ids, OPTUNA_D1_READ_CHUNK_SIZE):
        placeholders = ",".join(["?"] * len(ids))
        limit_clause = ""
        params: list[Any] = list(ids)
        if limit_per_stock is not None:
            # SQLite window function keeps one query per chunk while preserving per-stock caps.
            limit_clause = "WHERE rn <= ?"
            params.append(int(limit_per_stock))
        rows = d1_query(
            f"""
            SELECT stock_id, date, open, high, low, close, volume
            FROM (
              SELECT stock_id, date, open, high, low, close, volume,
                     ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date ASC) AS rn
              FROM stock_prices
              WHERE stock_id IN ({placeholders})
            )
            {limit_clause}
            ORDER BY stock_id, date ASC
            """,
            params,
        )
        for row in rows:
            grouped.setdefault(int(row["stock_id"]), []).append(row)
    return grouped


def _optuna_data_access_meta(lane: str, kind: str) -> dict[str, Any]:
    return resolve_research_data_access(lane=lane, kind=kind).to_dict()


def _load_rrg_inputs_from_snapshot(
    manifest: dict[str, Any],
    *,
    twii_limit: int,
    min_twii_rows: int,
    min_stock_rows: int,
    top_stock_count: int,
    stock_price_limit: int,
) -> tuple[list[float], dict[str, list[float]]]:
    market_risk = read_snapshot_component(manifest, "market_risk", required=False)
    if market_risk is None or market_risk.is_empty() or "twii_close" not in market_risk.columns:
        raise HTTPException(400, "Snapshot missing market_risk.twii_close for RRG benchmark")
    twii_rows = market_risk.sort("date").tail(twii_limit).to_dicts()
    if len(twii_rows) < min_twii_rows:
        raise HTTPException(400, f"Insufficient TWII benchmark in snapshot: {len(twii_rows)}")
    closes = [float(r["twii_close"]) for r in twii_rows]
    benchmark_returns = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes))]

    prices = _prices_with_symbol_from_snapshot(manifest)
    counts = (
        prices
        .group_by("symbol")
        .len()
        .rename({"len": "cnt"})
        .filter(pl.col("cnt") >= min_stock_rows)
        .sort("cnt", descending=True)
        .head(top_stock_count)
    )
    prices_by_stock: dict[str, list[float]] = {}
    for symbol in counts.get_column("symbol").to_list():
        closes = (
            prices
            .filter(pl.col("symbol") == symbol)
            .sort("date")
            .tail(stock_price_limit)
            .get_column("close")
            .cast(pl.Float64)
            .to_list()
        )
        if len(closes) >= min_stock_rows:
            prices_by_stock[symbol] = closes
    return benchmark_returns, prices_by_stock


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
        import polars as pl
    except ImportError as e:
        raise HTTPException(500, f"optuna_barrier import failed: {e}")

    policy = OptunaRoutePolicy.from_env()
    stocks_data = _load_top_active_stocks_with_prices(
        min_rows=policy.barrier_min_price_rows,
        top_n=policy.barrier_top_n,
    )
    if not stocks_data:
        raise HTTPException(400, f"No active stocks with >= {policy.barrier_min_price_rows} price rows")

    all_data = {}
    for s in stocks_data:
        df = pl.DataFrame(s["rows"]).with_columns(
            pl.col("date").cast(pl.Utf8),
        )
        all_data[s["symbol"]] = df

    logger.info(f"[Optuna/barrier] {len(all_data)} stocks, {req.n_trials} trials")
    result = run_optuna_search(all_data, n_trials=req.n_trials)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="barrier",
            params=best,
            meta={
                "n_trials": req.n_trials,
                "best_score": result.get("best_score"),
                "stock_count": len(all_data),
                "policy": policy.to_dict(),
                "data_access": _optuna_data_access_meta("optuna.barrier", "price_history"),
            },
        )

    contract = _contract_meta(
        source="barrier",
        scope="production_bound",
        sample_scope=f"top_{policy.barrier_top_n}_active_stocks_with_>={policy.barrier_min_price_rows}_price_rows",
        applies_to_production=_push_live(req) and bool(best),
        push_target="worker_kv_live",
        effective_fields=list(best.keys()),
        notes=[
            "Barrier Optuna currently optimizes on a top-10 active-stock sample, not the full trading universe.",
            "If pushed live, these params can affect production barrier behavior immediately.",
        ],
    )

    return {
        "status": "completed",
        "source": "barrier",
        "best_params": best,
        "best_score": result.get("best_score"),
        "n_trials": req.n_trials,
        "push": push_response,
        "data_access": _optuna_data_access_meta("optuna.barrier", "price_history"),
        "contract": contract,
    }


# ─── /optuna/signal ──────────────────────────────────────────────────────────

@router.post("/signal")
def run_signal(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #2: Signal thresholds"""
    try:
        from optuna_signal import run_search  # type: ignore
        import polars as pl
    except ImportError as e:
        raise HTTPException(500, f"optuna_signal import failed: {e}")

    policy = OptunaRoutePolicy.from_env()
    orders_rows = _load_paper_orders(limit=policy.signal_order_limit)
    pred_rows = _load_predictions(limit=policy.signal_prediction_limit)
    if len(orders_rows) < policy.signal_min_orders or len(pred_rows) < policy.signal_min_predictions:
        raise HTTPException(400, f"Insufficient data: orders={len(orders_rows)}, predictions={len(pred_rows)}")

    orders = pl.DataFrame(orders_rows)
    predictions = pl.DataFrame(pred_rows)

    logger.info(f"[Optuna/signal] {len(orders)} orders, {len(predictions)} predictions, {req.n_trials} trials")
    result = run_search(predictions, orders, n_trials=req.n_trials)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="signal", params=best,
            meta={
                "n_trials": req.n_trials,
                "n_orders": len(orders),
                "n_predictions": len(predictions),
                "policy": policy.to_dict(),
            },
        )
    contract = _contract_meta(
        source="signal",
        scope="production_bound",
        sample_scope="recent_sell_orders_plus_recent_ensemble_predictions",
        applies_to_production=_push_live(req) and bool(best),
        push_target="worker_kv_live",
        effective_fields=list(best.keys()),
        notes=[
            "Signal search uses recent paper-order outcomes plus recent ensemble predictions, not a point-in-time full backtest.",
            "If pushed live, signal thresholds can affect production immediately.",
        ],
    )

    return {"status": "completed", "source": "signal", "best_params": best,
            "n_trials": req.n_trials, "push": push_response, "contract": contract}


# ─── /optuna/sltp ────────────────────────────────────────────────────────────

@router.post("/sltp")
def run_sltp(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna #3: SL/TP + Trailing (Sprint 5.1: via backtest_engine replay)"""
    try:
        from optuna_sltp import run_search  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_sltp import failed: {e}")

    # Sprint 5.1: 讀當前 trading:config 當 baseline (其他 section 鎖定，只搜 sltp/exit)
    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    baseline_params = cfg_result.config
    if cfg_result.contract.degraded:
        logger.warning("[Optuna/sltp] trading:config degraded: %s", cfg_result.contract.to_dict())

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

    contract = _contract_meta(
        source="sltp",
        scope="production_bound",
        sample_scope="paper_backtest_replay_subset",
        applies_to_production=_push_live(req) and bool(best),
        push_target="worker_kv_live",
        effective_fields=list(best.keys()),
        notes=[
            "SLTP search replays a subset/window, so results are sensitive to subset_size and date_window.",
            "If pushed live, these params affect production exits immediately.",
        ],
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
        "contract": contract,
    }


# ─── /optuna/screener ────────────────────────────────────────────────────────

@router.post("/screener")
def run_screener(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna Sprint 5.2→6b: Screener factor weights + ranking weights (via backtest_engine replay)

    Searches 15+ dims inside score_multi_factor: chip / tech / momentum tiers
    plus liquidity filter bounds + ranking alpha/beta/gamma.
    NSGA-II Pareto over (sharpe↑, max_dd↓).

    Sprint 6b: Mode A hardcodes reverted — ranking weights now searchable,
    fill_rate/n_trades thresholds now KV-driven (trading:config.optuna.*).
    """
    try:
        from optuna_screener import run_search  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_screener import failed: {e}")

    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    baseline_params = cfg_result.config
    if cfg_result.contract.degraded:
        logger.warning("[Optuna/screener] trading:config degraded: %s", cfg_result.contract.to_dict())

    logger.info(
        f"[Optuna/screener] Sprint 5.2 run: n_trials={req.n_trials} "
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
        raise HTTPException(400, f"Optuna screener failed: {e}")

    # Push payload: the resolved screener dict (fully expanded, ready for worker merge).
    # Intentionally NOT including ranking.* — Mode A hardcode override must not leak
    # to production KV. See memory/project_sprint_5_2_hardcode_overrides.md Override #3.
    push_payload = result.get("resolved_screener", {})
    raw_best = result.get("best_params", {})
    excluded_fields = [k for k in raw_best.keys() if k.startswith("ranking.")]

    push_response = None
    if req.push_kv and not req.dry_run and push_payload:
        push_response = push_optuna_result(
            source="screener", params=push_payload,
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
                "best_fill_rate": result.get("best_fill_rate"),
                "best_profit_factor": result.get("best_profit_factor"),
                "pareto_size": result.get("pareto_size"),
                "raw_suggest_params": result.get("best_params"),
                "realism_note": result.get("realism_note"),
            },
        )

    contract = _contract_meta(
        source="screener",
        scope="production_partial",
        sample_scope="paper_backtest_replay_subset",
        applies_to_production=_push_live(req) and bool(push_payload),
        push_target="worker_kv_live_partial",
        effective_fields=list(push_payload.keys()),
        excluded_fields=excluded_fields,
        notes=[
            "Screener Optuna may search ranking.* internally, but ranking.* is intentionally excluded from live KV push.",
            "A successful screener search does not mean ranking weights were promoted to production.",
        ],
    )

    return {
        "status": "completed", "source": "screener",
        "best_params": raw_best,
        "resolved_screener": push_payload,
        "n_trials": req.n_trials, "push": push_response,
        "pareto_front": result.get("pareto_front", []),
        "best_sharpe": result.get("best_sharpe"),
        "best_max_dd": result.get("best_max_dd"),
        "best_n_trades": result.get("best_n_trades"),
        "best_fill_rate": result.get("best_fill_rate"),
        "pareto_size": result.get("pareto_size"),
        "reject_summary": result.get("reject_summary"),
        "reject_details": result.get("reject_details"),
        "subset_size": result.get("subset_size"),
        "date_window": result.get("date_window"),
        "mode": result.get("mode"),
        "realism_note": result.get("realism_note"),
        "contract": contract,
    }


# ─── /optuna/conformal ───────────────────────────────────────────────────────

@router.post("/conformal")
def run_conformal(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna conformal: coverage / min_cal_size / max_residuals"""
    try:
        from optuna_conformal import search_conformal_params  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_conformal import failed: {e}")

    policy = OptunaRoutePolicy.from_env()
    rows = d1_query("""
        SELECT direction_accuracy as confidence, direction_correct
        FROM predictions
        WHERE direction_correct IS NOT NULL AND direction_accuracy IS NOT NULL
        ORDER BY generated_at DESC LIMIT ?
    """, [policy.conformal_prediction_limit])
    if len(rows) < policy.conformal_min_labeled_predictions:
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
            meta={
                "n_samples": len(confidences),
                "best_ece": result.get("best_ece"),
                "policy": policy.to_dict(),
            },
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
    policy = OptunaRoutePolicy.from_env()
    rows = _load_daily_pnl(limit=policy.risk_daily_pnl_limit)
    if len(rows) < policy.risk_min_daily_snapshots:
        raise HTTPException(400, f"Insufficient daily snapshots: {len(rows)}")

    trade_returns = [float(r["pnl_pct"]) for r in rows if r.get("pnl_pct") is not None]
    if len(trade_returns) < policy.risk_min_daily_returns:
        raise HTTPException(400, f"Insufficient daily returns: {len(trade_returns)}")

    logger.info(f"[Optuna/risk_params] {len(trade_returns)} daily returns")
    result = search_risk_params(trade_returns)
    best = result.get("best_params", {})

    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="risk_params", params=best,
            meta={"n_returns": len(trade_returns), "policy": policy.to_dict()},
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
    policy = OptunaRoutePolicy.from_env()
    data_access_decision = resolve_research_data_access(lane="optuna.rrg", kind="price_history")
    data_access = data_access_decision.to_dict()
    if data_access_decision.source == "snapshot" and data_access_decision.snapshot:
        benchmark_returns, prices_by_stock = _load_rrg_inputs_from_snapshot(
            data_access_decision.snapshot,
            twii_limit=policy.rrg_twii_limit,
            min_twii_rows=policy.rrg_min_twii_rows,
            min_stock_rows=policy.rrg_top_stock_min_rows,
            top_stock_count=policy.rrg_top_stock_count,
            stock_price_limit=policy.rrg_stock_price_limit,
        )
    else:
        twii_rows = _load_twii_history(limit=policy.rrg_twii_limit)
        if len(twii_rows) < policy.rrg_min_twii_rows:
            raise HTTPException(400, f"Insufficient TWII benchmark: {len(twii_rows)}")

        closes = [float(r["twii_close"]) for r in twii_rows]
        benchmark_returns = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes))]

        top_stocks = d1_query("""
            SELECT s.id, s.symbol, COUNT(*) as cnt
            FROM stocks s JOIN stock_prices sp ON sp.stock_id = s.id
            WHERE s.delisted_date IS NULL
            GROUP BY s.id HAVING cnt >= ?
            ORDER BY cnt DESC LIMIT ?
        """, [policy.rrg_top_stock_min_rows, policy.rrg_top_stock_count])
        prices_by_stock = {}
        stock_price_rows = _load_price_rows_by_stock_ids(
            [int(s["id"]) for s in top_stocks],
            limit_per_stock=policy.rrg_stock_price_limit,
        )
        for s in top_stocks:
            rows = stock_price_rows.get(int(s["id"]), [])
            if len(rows) >= policy.rrg_top_stock_min_rows:
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
            meta={"n_stocks": len(prices_by_stock), "policy": policy.to_dict(), "data_access": data_access},
        )

    return {"status": "completed", "source": "rrg", "best_params": best,
            "push": push_response, "data_access": data_access}


# ─── /optuna/feature_window ──────────────────────────────────────────────────

@router.post("/alpha_framework")
def run_alpha_framework(req: AlphaFrameworkOptunaReq = Body(default=AlphaFrameworkOptunaReq())):
    """Alpha framework posterior search from verified alpha_context outcomes."""
    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    if cfg_result.contract.degraded:
        logger.warning("[Optuna/alpha_framework] trading:config degraded: %s", cfg_result.contract.to_dict())
    policy = alpha_quality_policy(cfg_result.config)
    quality_policy = policy.to_dict()
    limit = max(100, min(int(req.subset_size or policy.outcome_limit), 5000))
    rows = load_alpha_outcome_rows(limit=limit)
    result = build_alpha_policy_candidate(
        rows,
        **policy.to_builder_kwargs(),
    )
    contract = _contract_meta(
        source="alpha_framework",
        scope="sandbox_challenger",
        sample_scope=f"latest_{limit}_verified_predictions_with_alpha_context",
        applies_to_production=False,
        push_target="worker_kv_sandbox_by_default",
        effective_fields=["alphaFramework.allocation.weights", "alphaFramework.riskOverlay"],
        notes=[
            "Sample and bucket gates default to trading:config.alphaFramework.quality.",
            "Uses only predictions with alpha_context and verified outcome columns.",
            "Skips with HTTP 200 when samples are insufficient instead of inventing a policy.",
            "Worker optuna-push writes sandbox unless explicitly forced to prod with the double gate.",
        ],
    )

    if result.get("status") == "skipped":
        return {
            **result,
            "source": "alpha_framework",
            "n_trials": req.n_trials,
            "quality_policy": quality_policy,
            "push": None,
            "contract": contract,
        }

    best = result["alphaFramework"]
    push_response = None
    if req.push_kv and not req.dry_run:
        push_response = push_optuna_result(
            source="alpha_framework",
            params=best,
            meta={
                "status": "completed",
                "target": "sandbox",
                "n_trials": req.n_trials,
                "sample_count": result.get("sample_count"),
                "regime_counts": result.get("regime_counts"),
                "bucket_counts": result.get("bucket_counts"),
                "skipped_count": result.get("skipped_count"),
                "quality_policy": quality_policy,
                "risk_overlay_evidence": result.get("risk_overlay_evidence"),
                "note": "alpha framework posterior policy candidate",
            },
        )

    return {
        "status": "completed",
        "source": "alpha_framework",
        "best_params": best,
        "sample_count": result.get("sample_count"),
        "regime_counts": result.get("regime_counts"),
        "bucket_counts": result.get("bucket_counts"),
        "skipped_count": result.get("skipped_count"),
        "quality_policy": quality_policy,
        "risk_overlay_evidence": result.get("risk_overlay_evidence"),
        "n_trials": req.n_trials,
        "push": push_response,
        "contract": contract,
    }


@router.post("/ga_optimizer")
def run_ga_optimizer(req: GAOptimizerReq = Body(default=GAOptimizerReq())):
    """GA meta optimizer direct learning endpoint."""
    contract = _contract_meta(
        source="ga_optimizer",
        scope="production_meta_optimizer_learning",
        sample_scope="generated_policy_population_plus_gate_metrics",
        applies_to_production="learning_state_only_until_gated_promotion",
        push_target="worker_kv_ga_optimizer_state",
        effective_fields=[
            "alphaFramework.allocation.weights",
            "alphaFramework.riskOverlay",
            "alphaFramework.scoring",
        ],
        notes=[
            "GAOptimizer evolves meta policy parameters; it is not a stock prediction model.",
            "This endpoint persists production learning state directly; trading:config changes require promotion gates and Wei approval at L3/L4.",
        ],
    )
    result = run_ga_optimizer_service(
        GAOptimizerRequest(
            population_size=req.population_size,
            generations=req.generations,
            mutation_rate=req.mutation_rate,
            crossover_rate=req.crossover_rate,
            elite_count=req.elite_count,
            seed=req.seed,
            top_k=req.top_k,
        )
    )
    best = ((result.get("best") or {}).get("candidate") or {}).get("params", {}).get("alphaFramework")
    learning_state = {
        "optimizer": "GAOptimizer",
        "status": "learning",
        "population_size": result.get("population_size"),
        "generations": result.get("generations"),
        "history": result.get("history") or [],
        "best": result.get("best"),
        "ranked": result.get("ranked") or [],
        "best_alphaFramework": best,
        "contract": result.get("contract"),
    }
    push_response = None
    if req.push_kv and not req.dry_run and best:
        push_response = push_optuna_result(
            source="ga_optimizer",
            params=learning_state,
            meta={
                "status": "completed",
                "target": "production_meta_optimizer_learning_state",
                "optimizer": "GAOptimizer",
                "population_size": result.get("population_size"),
                "generations": result.get("generations"),
                "best_score": (result.get("best") or {}).get("score"),
                "gate": (result.get("best") or {}).get("gate"),
                "plateau": (result.get("best") or {}).get("plateau"),
                "note": "GA production meta optimizer learning state; does not mutate trading:config without gated promotion",
            },
        )

    return {
        **result,
        "source": "ga_optimizer",
        "best_params": best,
        "learning_state": learning_state,
        "push": push_response,
        "contract": contract,
    }


class FtArchReq(BaseModel):
    """FT-T architecture Optuna request (#29)."""
    n_trials: int = 20
    subset_size: int | None = None  # None = full ~681K, int = subsample for coarse
    gcs_prefix: str = "universal"


@router.post("/ft_arch")
async def run_ft_arch(req: FtArchReq = Body(default=FtArchReq())):
    """FT-T architecture search — GPU Modal. Result saved to GCS audit trail.

    LOCKED constraints (see feedback_ft_transformer_tuning.md): no warmup, no
    cosine decay, PATIENCE production stays 16. Search only varies
    d_model / n_heads / n_layers / dropout with shorter in-trial patience.

    Result is NOT auto-pushed to KV — Wei manually applies winning config to
    main.py FTTransformer + re-runs production retrain to produce challenger.
    """
    from services.modal_client import _modal_ft_arch_search
    logger.info(
        f"[Optuna/ft_arch] start n_trials={req.n_trials} "
        f"subset_size={req.subset_size} gcs_prefix={req.gcs_prefix}"
    )
    result = await _modal_ft_arch_search({
        "n_trials":    req.n_trials,
        "subset_size": req.subset_size,
        "gcs_prefix":  req.gcs_prefix,
    })
    if isinstance(result, dict) and result.get("error"):
        raise HTTPException(502, f"Modal ft_arch_search failed: {result['error']}")

    return {
        "status": "completed",
        "source": "ft_arch",
        "best_ic":       result.get("best_ic"),
        "best_params":   result.get("best_params"),
        "n_trials":      result.get("n_trials"),
        "gcs_audit_path": result.get("gcs_audit_path"),
        "contract": _contract_meta(
            source="ft_arch",
            scope="research_only",
            sample_scope=f"gcs_prefix={req.gcs_prefix}, subset_size={req.subset_size or 'full'}",
            applies_to_production=False,
            push_target="none_manual_apply_only",
            effective_fields=[],
            excluded_fields=list((result.get("best_params") or {}).keys()),
            notes=[
                "FT architecture search does not auto-push to production.",
                "Winning params still require manual code/application plus retrain before any production effect.",
            ],
        ),
    }


class L2SensitivityReq(BaseModel):
    """L2 sensitivity search request (#28 P7)."""
    n_trials: int = 50
    start_date: str | None = None   # default: end_date - 90 days
    end_date: str | None = None     # default: today (TW)
    push_kv: bool = True
    dry_run: bool = False
    dd_penalty: float | None = None
    sampler: str = "nsga2"          # 'nsga2' | 'tpe'


@router.post("/l2_sensitivity")
def run_l2_sensitivity(req: L2SensitivityReq = Body(default=L2SensitivityReq())):
    """25-dim (minus 5 bandit defer) L2/circuit Optuna search against Mode B replay.

    Search space source-of-truth:
      trading:config.optuna_l2.search_space.dims (KV-driven, D4 citation)

    Falls back to DEFAULT_SEARCH_SPACE when KV key missing so smoke-test
    bootstrapping doesn't block on Wei seeding KV first.

    Results push (source='l2_sensitivity') writes nested params into
    trading:config.circuit + trading:config.L2_formula on the Worker.
    """
    try:
        from optuna_l2_sensitivity import (  # type: ignore
            run_l2_sensitivity_search, DEFAULT_SEARCH_SPACE, _l2_push_allowed,
        )
    except ImportError as e:
        raise HTTPException(500, f"optuna_l2_sensitivity import failed: {e}")

    # ── Load search space + baseline from KV ────────────────────────────────
    from services import kv_client
    from datetime import datetime, timezone, timedelta
    TW = timezone(timedelta(hours=8))

    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    baseline_config = cfg_result.config
    if cfg_result.contract.degraded:
        logger.warning("[Optuna/l2_sensitivity] trading:config degraded: %s", cfg_result.contract.to_dict())
    kv_space = (baseline_config.get("optuna_l2") or {}).get("search_space")
    search_space = (kv_space or {}).get("dims") if isinstance(kv_space, dict) else None
    used_source = "KV" if search_space else "DEFAULT_SEARCH_SPACE"
    if not search_space:
        search_space = DEFAULT_SEARCH_SPACE

    # ── Resolve date range ──────────────────────────────────────────────────
    end_date = req.end_date or datetime.now(TW).strftime("%Y-%m-%d")
    start_date = req.start_date or (
        datetime.fromisoformat(end_date) - timedelta(days=90)
    ).strftime("%Y-%m-%d")

    logger.info(
        f"[Optuna/l2_sensitivity] n_trials={req.n_trials} "
        f"range={start_date}~{end_date} dims={len(search_space)} "
        f"source={used_source} sampler={req.sampler}"
    )

    # ── Run search ──────────────────────────────────────────────────────────
    result = run_l2_sensitivity_search(
        search_space=search_space,
        start_date=start_date,
        end_date=end_date,
        baseline_config=baseline_config,
        n_trials=req.n_trials,
        dd_penalty=req.dd_penalty,
        sampler_name=req.sampler,
    )
    pbo_persist_response = None
    if not req.dry_run and result.get("pbo_audit"):
        from services.pbo_audit_store import persist_pbo_audit

        audit_to_persist = {
            **(result.get("pbo_audit") or {}),
            "date_range": [start_date, end_date],
            "best_value": result.get("best_value"),
            "search_space_source": used_source,
        }
        pbo_persist_response = persist_pbo_audit(
            run_date=datetime.now(TW).strftime("%Y-%m-%d"),
            source="optuna_l2",
            audit=audit_to_persist,
        )

    # ── KV push (nested form matches trading:config shape) ──────────────────
    push_response = None
    push_skipped_reason = None
    if _l2_push_allowed(
        push_kv=req.push_kv,
        dry_run=req.dry_run,
        best_params_nested=result.get("best_params_nested"),
        pbo_audit=result.get("pbo_audit"),
    ):
        push_response = push_optuna_result(
            source="l2_sensitivity",
            params=result["best_params_nested"],
            meta={
                "n_trials": req.n_trials,
                "best_value": result.get("best_value"),
                "pbo_candidate_count": len(result.get("strategy_returns_by_partition") or {}),
                "pbo_audit": result.get("pbo_audit"),
                "start_date": start_date,
                "end_date": end_date,
                "sampler": req.sampler,
                "dd_penalty": (result.get("policy") or {}).get("dd_penalty"),
                "search_space_source": used_source,
            },
        )
    elif req.push_kv and not req.dry_run:
        push_skipped_reason = "pbo_audit_not_passed"

    return {
        "status": "completed",
        "source": "l2_sensitivity",
        "best_value": result.get("best_value"),
        "best_params": result.get("best_params"),
        "n_trials": result.get("n_trials"),
        "pbo_candidate_count": len(result.get("strategy_returns_by_partition") or {}),
        "pbo_audit": result.get("pbo_audit"),
        "policy": result.get("policy"),
        "strategy_returns_by_partition": result.get("strategy_returns_by_partition"),
        "search_space_source": used_source,
        "date_range": [start_date, end_date],
        "pbo_persist": pbo_persist_response,
        "push": push_response,
        "push_skipped_reason": push_skipped_reason,
    }


@router.post("/feature_window")
def run_feature_window(req: OptunaReq = Body(default=OptunaReq())):
    """Optuna feature_window: vol/ma/return windows"""
    try:
        from optuna_feature_window import search_feature_windows  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_feature_window import failed: {e}")

    # TWII as benchmark for feature window search
    policy = OptunaRoutePolicy.from_env()
    twii_rows = _load_twii_history(limit=policy.feature_window_twii_limit)
    if len(twii_rows) < policy.feature_window_min_twii_rows:
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
            meta={"n_bars": len(closes), "policy": policy.to_dict()},
        )

    return {"status": "completed", "source": "feature_window", "best_params": best,
            "push": push_response}


# ─── /optuna/per_regime (#28b T2.1, 2026-04-21) ──────────────────────────────

class PerRegimeReq(BaseModel):
    """Per-regime robust Optuna request (#28b T2.1)."""
    target: str = Field(default="sltp", pattern="^(sltp)$",
                        description="Target param family. Only 'sltp' supported initially.")
    n_trials: int = Field(default=50, ge=5, le=500)
    subset_size: int = Field(default=400, ge=50, le=2000)
    window_days: int = Field(default=365, ge=90, le=730)
    push_kv: bool = Field(default=False,
                          description="If true, push winning params to KV via "
                                      "writeSandbox (secure-by-default through T3.3).")
    dry_run: bool = Field(default=True,
                          description="Default true — set false to actually push "
                                      "via push_optuna_result (which now routes to "
                                      "sandbox unless ?prod=1 header).")


@router.post("/per_regime")
def run_per_regime(req: PerRegimeReq = Body(default=PerRegimeReq())):
    """Per-regime robust Optuna search — maximizes min(sharpe across 4 regimes)
    to avoid regime-specialized overfits. See optuna_per_regime_robust.py
    docstring for full design rationale.

    Writes winning params to sandbox (via push_optuna_result default path) —
    Wei then promotes to challenger slot via POST /api/admin/config/challenger
    and the T3.5 weekly_eval cron compares vs champion before promote.

    Expensive: runs replay_period 50×200 = ~10000 times on 400-stock subset
    × 365-day window. Typical wall-clock 8-15 min on ml-controller Cloud Run.
    """
    try:
        # optuna_scripts/ must be on PYTHONPATH — already set for sibling scripts
        import sys as _sys, os as _os
        _p = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "optuna_scripts")
        if _p not in _sys.path:
            _sys.path.insert(0, _p)
        from optuna_per_regime_robust import run_search  # type: ignore
    except ImportError as e:
        raise HTTPException(500, f"optuna_per_regime_robust import failed: {e}")

    logger.info(
        f"[Optuna/per_regime] target={req.target} n_trials={req.n_trials} "
        f"subset={req.subset_size} window={req.window_days}d "
        f"push_kv={req.push_kv} dry_run={req.dry_run}"
    )

    try:
        result = run_search(
            target=req.target,
            n_trials=req.n_trials,
            subset_size=req.subset_size,
            window_days=req.window_days,
            push_kv=req.push_kv and not req.dry_run,
        )
    except RuntimeError as e:
        # e.g. "No feasible trials — regime split too sparse"
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("[Optuna/per_regime] unexpected failure")
        raise HTTPException(500, f"per_regime search failed: {type(e).__name__}: {e}")

    contract = _contract_meta(
        source="per_regime_robust",
        scope="sandbox_challenger",
        sample_scope=f"subset_{req.subset_size}_window_{req.window_days}d_regime_robust_replay",
        applies_to_production=bool(req.push_kv and not req.dry_run and result.get("push")),
        push_target="sandbox_or_challenger_only",
        effective_fields=list((result.get("best_params") or {}).keys()),
        notes=[
            "Per-regime Optuna is intended for sandbox/challenger promotion, not direct production overwrite.",
            "Even when pushed, it should flow through challenger evaluation before champion promotion.",
        ],
    )

    return {
        "status": "completed",
        "source": "per_regime_robust",
        "dry_run": req.dry_run,
        "contract": contract,
        **result,
    }
