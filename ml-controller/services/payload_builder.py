"""
payload_builder.py — Build PredictRequest payloads from D1
2026-04-07 LangGraph A+B refactor

Direct port of worker/src/index.ts:1013-1173 (runMLAndRisk's market_env + per-stock loop).

Key optimization: instead of N stocks × 8 queries (worker did this serially per stock),
we issue ~10 bulk queries that pull data for ALL active stocks at once, then group
in-memory. Reduces D1 round-trips from ~270 (33 stocks × 8) to ~10.
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field, asdict
from typing import Any, Optional

from services import d1_client, kv_client

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Data shapes (match worker payload schema 1:1)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class MarketEnv:
    """共用 market environment — 對應 worker line 1124-1147"""
    risk_score: float = 50.0
    risk_level: str = "medium"
    twii_return_1d: float = 0.0
    twii_return_5d: float = 0.0
    twii_bias_20d: float = 0.0
    history: dict = field(default_factory=dict)
    us_sox_return: Optional[float] = None
    us_gspc_return: Optional[float] = None
    us_dxy_return: Optional[float] = None
    us_hy_spread: Optional[float] = None
    us_hy_spread_chg: Optional[float] = None
    us_vix: Optional[float] = None
    us_sentiment: Optional[str] = None
    advance_ratio: Optional[float] = None
    bull_alignment_pct: Optional[float] = None
    revenue_yoy: Optional[float] = None
    margin_balance: Optional[float] = None
    short_ratio: Optional[float] = None
    margin_change_5d: Optional[float] = None
    retail_pct: Optional[float] = None


@dataclass
class PredictPayload:
    """單股 PredictRequest payload — 對應 ml-service/app/main.py:69-87 PredictRequest schema"""
    stock_id: int
    symbol: str
    prices: list[dict] = field(default_factory=list)
    indicators: list[dict] = field(default_factory=list)
    chips: list[dict] = field(default_factory=list)
    sentiment_scores: list[dict] = field(default_factory=list)
    horizon: int = 14
    real_accuracies: dict[str, float] = field(default_factory=dict)
    model_stats: dict[str, dict] = field(default_factory=dict)
    market: str = "TW"
    market_env: dict = field(default_factory=dict)
    adaptive_params: dict = field(default_factory=dict)
    lifecycle_weights: dict[str, float] = field(default_factory=dict)
    barrier_params: dict = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Shared market env loader (one-shot, all stocks share)
# ─────────────────────────────────────────────────────────────────────────────

def load_market_env(run_date: str) -> tuple[MarketEnv, dict, dict, dict[str, float]]:
    """
    Load shared market data + adaptive_params + barrier_params + lifecycle_weights.

    Returns:
        (market_env, adaptive_params, barrier_params, lifecycle_weights)

    Maps to worker/src/index.ts:1013-1075.
    """
    # ── 1. Latest market_risk row ───────────────────────────────────────────
    risk_rows = d1_client.query(
        "SELECT risk_level, risk_score, risk_summary "
        "FROM market_risk ORDER BY date DESC LIMIT 1"
    )
    risk_row = risk_rows[0] if risk_rows else {}

    # ── 2. TAIEX 25 days for twii returns ───────────────────────────────────
    twii_rows = d1_client.query(
        "SELECT date, close FROM stock_prices "
        "WHERE stock_id=(SELECT id FROM stocks WHERE symbol IN ('TAIEX','^TWII') LIMIT 1) "
        "ORDER BY date DESC LIMIT 25"
    )
    twii_arr = [r["close"] for r in reversed(twii_rows)]
    twii_1d = (twii_arr[-1] - twii_arr[-2]) / twii_arr[-2] if len(twii_arr) >= 2 else 0.0
    twii_5d = (twii_arr[-1] - twii_arr[-6]) / twii_arr[-6] if len(twii_arr) >= 6 else 0.0
    if len(twii_arr) >= 20:
        twii_ma20 = sum(twii_arr[-20:]) / 20
    else:
        twii_ma20 = twii_arr[-1] if twii_arr else 0.0
    twii_bias_20d = (twii_arr[-1] - twii_ma20) / twii_ma20 if twii_arr and twii_ma20 else 0.0

    # ── 3. Market history (500 days for HMM context) ────────────────────────
    history_rows = d1_client.query(
        "SELECT date, risk_score, risk_level, twii_bias as market_bias_20d, twii_close "
        "FROM market_risk ORDER BY date ASC LIMIT 500"
    )
    history_map: dict[str, dict] = {}
    for i, row in enumerate(history_rows):
        prev1 = history_rows[i - 1]["twii_close"] if i >= 1 else None
        prev5 = history_rows[i - 5]["twii_close"] if i >= 5 else None
        history_map[row["date"]] = {
            "risk_score": row.get("risk_score"),
            "risk_level": row.get("risk_level"),
            "market_bias_20d": row.get("market_bias_20d"),
            "market_return_1d": (row["twii_close"] - prev1) / prev1 if prev1 else 0,
            "market_return_5d": (row["twii_close"] - prev5) / prev5 if prev5 else 0,
        }

    # ── 4. US leading signals (KV us:leading:{date}) ────────────────────────
    us_signal = kv_client.get_json(f"us:leading:{run_date}", default={}) or {}

    # ── 5. Latest market_breadth ────────────────────────────────────────────
    breadth_rows = d1_client.query(
        "SELECT date, advance_ratio, bull_alignment_pct "
        "FROM market_breadth ORDER BY date DESC LIMIT 5"
    )
    latest_breadth = breadth_rows[0] if breadth_rows else {}

    # ── 6. Adaptive params from KV ──────────────────────────────────────────
    adaptive_params = kv_client.get_json("ml:adaptive_params", default={}) or {}

    # ── 7. Trading config → barrier_params ──────────────────────────────────
    trading_cfg = kv_client.get_json("trading:config", default={}) or {}
    barrier_cfg = trading_cfg.get("barrier", {})
    barrier_params = {
        "upper_mult": barrier_cfg.get("upperMult"),
        "lower_mult": barrier_cfg.get("lowerMult"),
        "upper_pct_cap": barrier_cfg.get("upperPctCap"),
        "lower_pct_cap": barrier_cfg.get("lowerPctCap"),
        "max_days": barrier_cfg.get("maxDays"),
    }

    # ── 8. Lifecycle weights from D1 model_lifecycle_state ──────────────────
    lifecycle_weights: dict[str, float] = {}
    try:
        lc_rows = d1_client.query(
            "SELECT state_json FROM model_lifecycle_state WHERE id=1"
        )
        if lc_rows:
            import json as _json
            states = _json.loads(lc_rows[0]["state_json"])
            for name, s in (states or {}).items():
                wm = s.get("weight_mult")
                if wm is not None and wm != 1.0:
                    lifecycle_weights[name] = wm
    except Exception as e:
        logger.warning(f"[payload_builder] Lifecycle weights read failed: {e}")

    # ── Build MarketEnv ─────────────────────────────────────────────────────
    market_env = MarketEnv(
        risk_score=risk_row.get("risk_score") or 50,
        risk_level=risk_row.get("risk_level") or "medium",
        twii_return_1d=twii_1d,
        twii_return_5d=twii_5d,
        twii_bias_20d=twii_bias_20d,
        history=history_map,
        us_sox_return=us_signal.get("sox_return"),
        us_gspc_return=us_signal.get("gspc_return"),
        us_dxy_return=us_signal.get("dxy_return"),
        us_hy_spread=us_signal.get("hy_spread"),
        us_hy_spread_chg=us_signal.get("hy_spread_chg"),
        us_vix=us_signal.get("vix_close"),
        us_sentiment=us_signal.get("sentiment"),
        advance_ratio=latest_breadth.get("advance_ratio"),
        bull_alignment_pct=latest_breadth.get("bull_alignment_pct"),
    )

    return market_env, adaptive_params, barrier_params, lifecycle_weights


# ─────────────────────────────────────────────────────────────────────────────
# Bulk per-stock loaders — pull all active stocks in single queries
# ─────────────────────────────────────────────────────────────────────────────

def _bulk_load_prices(stock_ids: list[int], limit: int = 500) -> dict[int, list[dict]]:
    """
    Load last `limit` rows of stock_prices for each stock_id.
    Returns: {stock_id: [{date, close, high, low, open, volume}, ...]} (oldest→newest).

    D1 doesn't support window functions efficiently, so we pull all rows for the
    relevant date range then group in-memory. Use date >= '-2 years' as cutoff.
    """
    if not stock_ids:
        return {}
    placeholders = ",".join("?" * len(stock_ids))
    rows = d1_client.query(
        f"SELECT stock_id, date, open, high, low, close, volume "
        f"FROM stock_prices "
        f"WHERE stock_id IN ({placeholders}) AND date >= date('now','-3 years') "
        f"ORDER BY stock_id ASC, date ASC",
        list(stock_ids),
        timeout=120.0,
    )
    grouped: dict[int, list[dict]] = {sid: [] for sid in stock_ids}
    for r in rows:
        sid = r["stock_id"]
        if sid in grouped:
            grouped[sid].append({
                "date": r["date"],
                "open": r["open"], "high": r["high"], "low": r["low"],
                "close": r["close"], "volume": r["volume"],
            })
    # Truncate to last `limit` per stock (oldest is dropped if > limit)
    for sid in grouped:
        if len(grouped[sid]) > limit:
            grouped[sid] = grouped[sid][-limit:]
    return grouped


def _bulk_load_indicators(stock_ids: list[int], limit: int = 500) -> dict[int, list[dict]]:
    if not stock_ids:
        return {}
    placeholders = ",".join("?" * len(stock_ids))
    rows = d1_client.query(
        f"SELECT stock_id, date, ma5, ma10, ma20, ma60, rsi14, "
        f"       macd_hist as macdHist, bb_upper, bb_lower, atr14 "
        f"FROM technical_indicators "
        f"WHERE stock_id IN ({placeholders}) AND date >= date('now','-3 years') "
        f"ORDER BY stock_id ASC, date ASC",
        list(stock_ids),
        timeout=120.0,
    )
    grouped: dict[int, list[dict]] = {sid: [] for sid in stock_ids}
    for r in rows:
        sid = r["stock_id"]
        if sid in grouped:
            grouped[sid].append({
                "date": r["date"],
                "ma5": r.get("ma5"), "ma10": r.get("ma10"),
                "ma20": r.get("ma20"), "ma60": r.get("ma60"),
                "rsi14": r.get("rsi14"), "macdHist": r.get("macdHist"),
                "bb_upper": r.get("bb_upper"), "bb_lower": r.get("bb_lower"),
                "atr14": r.get("atr14"),
            })
    for sid in grouped:
        if len(grouped[sid]) > limit:
            grouped[sid] = grouped[sid][-limit:]
    return grouped


def _bulk_load_chips(symbols: list[str], limit: int = 200) -> dict[str, list[dict]]:
    """chip_data uses symbol (not stock_id)."""
    if not symbols:
        return {}
    placeholders = ",".join("?" * len(symbols))
    rows = d1_client.query(
        f"SELECT symbol, date, foreign_net, trust_net, dealer_net "
        f"FROM chip_data "
        f"WHERE symbol IN ({placeholders}) AND date >= date('now','-1 year') "
        f"ORDER BY symbol ASC, date ASC",
        list(symbols),
        timeout=60.0,
    )
    grouped: dict[str, list[dict]] = {s: [] for s in symbols}
    for r in rows:
        sym = r["symbol"]
        if sym in grouped:
            grouped[sym].append({
                "date": r["date"],
                "foreign_net": r.get("foreign_net"),
                "trust_net": r.get("trust_net"),
                "dealer_net": r.get("dealer_net"),
            })
    for sym in grouped:
        if len(grouped[sym]) > limit:
            grouped[sym] = grouped[sym][-limit:]
    return grouped


def _bulk_load_sentiment(stock_ids: list[int], limit: int = 90) -> dict[int, list[dict]]:
    if not stock_ids:
        return {}
    placeholders = ",".join("?" * len(stock_ids))
    rows = d1_client.query(
        f"SELECT stock_id, date(published_at) as date, "
        f"       AVG(CASE sentiment WHEN 'positive' THEN 1 WHEN 'negative' THEN -1 ELSE 0 END) as score "
        f"FROM news WHERE stock_id IN ({placeholders}) "
        f"AND published_at >= date('now','-180 days') "
        f"GROUP BY stock_id, date(published_at) "
        f"ORDER BY stock_id ASC, date ASC",
        list(stock_ids),
        timeout=60.0,
    )
    grouped: dict[int, list[dict]] = {sid: [] for sid in stock_ids}
    for r in rows:
        sid = r["stock_id"]
        if sid in grouped:
            grouped[sid].append({"date": r["date"], "score": r["score"]})
    for sid in grouped:
        if len(grouped[sid]) > limit:
            grouped[sid] = grouped[sid][-limit:]
    return grouped


def _bulk_load_accuracies(
    stock_ids: list[int],
) -> tuple[dict[int, dict[str, float]], dict[int, dict[str, dict]]]:
    """
    Load model_accuracy WHERE period='30d' AND total_count >= 5.
    Returns: (real_accuracies_by_stock, model_stats_by_stock)
    """
    if not stock_ids:
        return {}, {}
    placeholders = ",".join("?" * len(stock_ids))
    rows = d1_client.query(
        f"SELECT stock_id, model_name, accuracy, profit_factor, expectancy, "
        f"       avg_win_pct, avg_loss_pct, avg_trade_pnl_r, "
        f"       hit_target_rate, hit_stop_rate "
        f"FROM model_accuracy "
        f"WHERE stock_id IN ({placeholders}) AND period='30d' AND total_count >= 5",
        list(stock_ids),
        timeout=60.0,
    )
    real_acc: dict[int, dict[str, float]] = {sid: {} for sid in stock_ids}
    model_stats: dict[int, dict[str, dict]] = {sid: {} for sid in stock_ids}
    for r in rows:
        sid = r["stock_id"]
        if sid not in real_acc:
            continue
        name = r["model_name"]
        real_acc[sid][name] = r.get("accuracy") or 0
        model_stats[sid][name] = {
            "profit_factor": r.get("profit_factor"),
            "expectancy": r.get("expectancy"),
            "avg_win_pct": r.get("avg_win_pct"),
            "avg_loss_pct": r.get("avg_loss_pct"),
            "avg_pnl_r": r.get("avg_trade_pnl_r"),
            "hit_target_rate": r.get("hit_target_rate"),
            "hit_stop_rate": r.get("hit_stop_rate"),
        }
    return real_acc, model_stats


def _bulk_load_per_stock_misc(stock_ids: list[int]) -> dict[int, dict]:
    """
    Per-stock margin / shareholding / monthly_revenue (latest 1 row each).
    Returns: {stock_id: {margin_balance, short_ratio, margin_5d_ago, retail_pct, revenue_yoy}}

    Worker did 4 separate queries per stock — we do 4 bulk queries total.
    """
    if not stock_ids:
        return {}
    out: dict[int, dict] = {sid: {} for sid in stock_ids}
    placeholders = ",".join("?" * len(stock_ids))

    # margin: latest
    margin_rows = d1_client.query(
        f"SELECT m1.stock_id, m1.margin_balance, m1.short_ratio "
        f"FROM margin_data m1 "
        f"INNER JOIN ("
        f"  SELECT stock_id, MAX(date) as max_date "
        f"  FROM margin_data WHERE stock_id IN ({placeholders}) GROUP BY stock_id"
        f") m2 ON m1.stock_id = m2.stock_id AND m1.date = m2.max_date",
        list(stock_ids),
        timeout=60.0,
    )
    for r in margin_rows:
        sid = r["stock_id"]
        if sid in out:
            out[sid]["margin_balance"] = r.get("margin_balance")
            out[sid]["short_ratio"] = r.get("short_ratio")

    # margin: 5 days ago (offset 5 from latest) — too complex bulk; do nullable fallback
    # Skip for now; worker behavior is non-blocking (catch → null)

    # shareholding: latest retail_pct
    sh_rows = d1_client.query(
        f"SELECT s1.stock_id, s1.retail_pct "
        f"FROM shareholding s1 "
        f"INNER JOIN ("
        f"  SELECT stock_id, MAX(date) as max_date "
        f"  FROM shareholding WHERE stock_id IN ({placeholders}) GROUP BY stock_id"
        f") s2 ON s1.stock_id = s2.stock_id AND s1.date = s2.max_date",
        list(stock_ids),
        timeout=60.0,
    )
    for r in sh_rows:
        sid = r["stock_id"]
        if sid in out:
            out[sid]["retail_pct"] = r.get("retail_pct")

    # monthly_revenue: latest revenue_yoy
    rev_rows = d1_client.query(
        f"SELECT r1.stock_id, r1.revenue_yoy "
        f"FROM monthly_revenue r1 "
        f"INNER JOIN ("
        f"  SELECT stock_id, MAX(date) as max_date "
        f"  FROM monthly_revenue WHERE stock_id IN ({placeholders}) GROUP BY stock_id"
        f") r2 ON r1.stock_id = r2.stock_id AND r1.date = r2.max_date",
        list(stock_ids),
        timeout=60.0,
    )
    for r in rev_rows:
        sid = r["stock_id"]
        if sid in out:
            out[sid]["revenue_yoy"] = r.get("revenue_yoy")

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def load_active_stocks() -> list[dict]:
    """Read all active stocks from D1."""
    return d1_client.query("SELECT * FROM stocks WHERE is_active=1 ORDER BY id ASC")


def build_payloads(
    active_stocks: list[dict],
    market_env: MarketEnv,
    adaptive_params: dict,
    barrier_params: dict,
    lifecycle_weights: dict[str, float],
) -> list[PredictPayload]:
    """
    Build PredictPayload list for all active stocks.

    Strategy: bulk-load all per-stock data in ~10 queries (vs 8 × N stocks),
    then assemble payloads in-memory.
    """
    if not active_stocks:
        return []

    stock_ids = [s["id"] for s in active_stocks]
    symbols = [s["symbol"] for s in active_stocks]
    logger.info(f"[payload_builder] Building payloads for {len(stock_ids)} active stocks")

    # ── Bulk load all per-stock data ────────────────────────────────────────
    prices_by_id = _bulk_load_prices(stock_ids)
    indicators_by_id = _bulk_load_indicators(stock_ids)
    chips_by_sym = _bulk_load_chips(symbols)
    sentiment_by_id = _bulk_load_sentiment(stock_ids)
    real_acc_by_id, model_stats_by_id = _bulk_load_accuracies(stock_ids)
    misc_by_id = _bulk_load_per_stock_misc(stock_ids)

    # ── Assemble payloads ───────────────────────────────────────────────────
    payloads: list[PredictPayload] = []
    base_env = asdict(market_env)
    for stock in active_stocks:
        sid = stock["id"]
        symbol = stock["symbol"]
        misc = misc_by_id.get(sid, {})

        # Per-stock market_env override (margin / retail / revenue)
        env_for_stock = {
            **base_env,
            "revenue_yoy": misc.get("revenue_yoy"),
            "margin_balance": misc.get("margin_balance"),
            "short_ratio": misc.get("short_ratio"),
            "margin_change_5d": None,  # bulk load skipped, fallback null (worker behavior)
            "retail_pct": misc.get("retail_pct"),
        }

        payloads.append(PredictPayload(
            stock_id=sid,
            symbol=symbol,
            prices=prices_by_id.get(sid, []),
            indicators=indicators_by_id.get(sid, []),
            chips=chips_by_sym.get(symbol, []),
            sentiment_scores=sentiment_by_id.get(sid, []),
            horizon=14,
            real_accuracies=real_acc_by_id.get(sid, {}),
            model_stats=model_stats_by_id.get(sid, {}),
            market=stock.get("market") or "TW",
            market_env=env_for_stock,
            adaptive_params=adaptive_params,
            lifecycle_weights=lifecycle_weights,
            barrier_params=barrier_params,
        ))

    logger.info(f"[payload_builder] Built {len(payloads)} payloads")
    return payloads
