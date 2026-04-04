"""
backtest_service.py — Python backtester mirroring StockVisionStrategy 7-layer cascade

Pipeline: D1 export → in-memory backtest → D1 import
No Freqtrade binary needed — runs entirely on Cloud Run.

Entry: ML BUY/STRONG_BUY + confidence >= threshold
Exit 7-layer cascade:
  1. Hard stop (-12%)
  2. ATR initial stop
  3. ML SELL signal
  4. Chandelier trailing stop (ATR-based, tightens with profit)
  5. TP1: entry × 1.03 (sell 50%)
  6. TP2: entry × 1.06 (sell remaining)
  7. Time stop: 20 days + profit > 0.5%
"""
import os
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# ── D1 API Config ────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "619a83ac9f20847d9e2f2920823b727d")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "6401a5f6-5767-4fa8-a1a7-ec8d4739ac79")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")
D1_API = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query"

# ── Strategy Parameters (mirror StockVisionStrategy defaults) ─────────────────
CONFIDENCE_THRESHOLD = 0.60
HARD_STOP_PCT = -0.12
TP1_MULT = 1.03
TP2_MULT = 1.06
TIME_STOP_DAYS = 20
TRAIL_MULT_DEFAULT = 3.0
TRAIL_MULT_3PCT = 2.5
TRAIL_MULT_8PCT = 2.0
MAX_OPEN_TRADES = 5
STAKE_AMOUNT = 200_000
TW_BUY_FEE = 0.001425
TW_SELL_FEE = 0.004425  # 手續費 + 證交稅


@dataclass
class Trade:
    symbol: str
    entry_date: str
    entry_price: float
    shares: int
    highest_since_entry: float = 0.0
    exit_date: Optional[str] = None
    exit_price: Optional[float] = None
    exit_reason: Optional[str] = None
    profit_ratio: Optional[float] = None

    def __post_init__(self):
        self.highest_since_entry = self.entry_price


@dataclass
class BacktestResult:
    strategy: str = "StockVisionStrategy"
    timerange: str = ""
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    gross_profit: float = 0.0
    gross_loss: float = 0.0
    profit_factor: float = 0.0
    expectancy: float = 0.0
    sharpe: Optional[float] = None
    sortino: Optional[float] = None
    max_drawdown: float = 0.0
    cagr: Optional[float] = None
    trades: list = field(default_factory=list)


async def _d1_query(client: httpx.AsyncClient, sql: str, params: list = None) -> list[dict]:
    """Execute a D1 SQL query via REST API."""
    if not CF_API_TOKEN:
        logger.error("CF_API_TOKEN not set")
        return []

    body = {"sql": sql}
    if params:
        body["params"] = params

    resp = await client.post(
        D1_API,
        json=body,
        headers={
            "Authorization": f"Bearer {CF_API_TOKEN}",
            "Content-Type": "application/json",
        },
        timeout=30.0,
    )

    if resp.status_code != 200:
        logger.error(f"D1 API error {resp.status_code}: {resp.text[:200]}")
        return []

    data = resp.json()
    if not data.get("success"):
        logger.error(f"D1 query failed: {data.get('errors', [])}")
        return []

    results = data.get("result", [])
    if results and isinstance(results, list) and "results" in results[0]:
        return results[0]["results"]
    return []


async def _d1_exec(client: httpx.AsyncClient, sql: str, params: list = None) -> bool:
    """Execute a D1 SQL statement (INSERT/UPDATE)."""
    if not CF_API_TOKEN:
        logger.error("CF_API_TOKEN not set")
        return False

    body = {"sql": sql}
    if params:
        body["params"] = params

    resp = await client.post(
        D1_API,
        json=body,
        headers={
            "Authorization": f"Bearer {CF_API_TOKEN}",
            "Content-Type": "application/json",
        },
        timeout=30.0,
    )

    if resp.status_code != 200:
        logger.error(f"D1 exec error {resp.status_code}: {resp.text[:200]}")
        return False

    data = resp.json()
    return data.get("success", False)


def _compute_atr14(prices: list[dict], idx: int) -> float:
    """Compute ATR(14) at given index."""
    if idx < 14:
        return 0.0

    trs = []
    for i in range(idx - 13, idx + 1):
        h = float(prices[i].get("high") or prices[i]["close"])
        l = float(prices[i].get("low") or prices[i]["close"])
        c_prev = float(prices[i - 1]["close"]) if i > 0 else float(prices[i]["close"])
        tr = max(h - l, abs(h - c_prev), abs(l - c_prev))
        trs.append(tr)

    return sum(trs) / len(trs) if trs else 0.0


def _run_backtest_for_stock(
    prices: list[dict],
    signals: list[dict],
) -> list[dict]:
    """Run backtest for a single stock. Returns list of completed trade dicts."""
    if len(prices) < 30:
        return []

    # Build signal lookup: date → signal dict
    sig_map = {s["date"]: s for s in signals if s.get("date")}

    completed_trades: list[dict] = []
    open_trade: Optional[Trade] = None

    for idx, bar in enumerate(prices):
        date_str = bar["date"]
        close = float(bar["close"])
        high = float(bar.get("high") or close)
        low = float(bar.get("low") or close)
        sig = sig_map.get(date_str, {})
        signal = sig.get("signal", "HOLD")
        confidence = float(sig.get("confidence") or 0)

        # ── Check exit conditions for open trade ──
        if open_trade is not None:
            open_trade.highest_since_entry = max(open_trade.highest_since_entry, high)
            entry = open_trade.entry_price
            profit_ratio = (close - entry) / entry
            days_held = _date_diff(open_trade.entry_date, date_str)
            atr = _compute_atr14(prices, idx)

            exit_reason = None

            # Layer 1: Hard stop
            if profit_ratio <= HARD_STOP_PCT:
                exit_reason = f"HardStop ({profit_ratio*100:.1f}%)"

            # Layer 2+4 unified: ATR trailing stop (mirrors StockVisionStrategy.custom_stoploss)
            # Freqtrade evaluates custom_stoploss every bar — profit-tiered ATR distance from current price
            elif atr > 0:
                if profit_ratio > 0.08:
                    mult = TRAIL_MULT_8PCT
                elif profit_ratio > 0.03:
                    mult = TRAIL_MULT_3PCT
                else:
                    mult = TRAIL_MULT_DEFAULT
                trail_distance = (atr * mult) / close
                # Stop triggers if price drops below current_price * (1 - trail_distance)
                # But don't widen beyond hard stop
                effective_stop_pct = max(-trail_distance, HARD_STOP_PCT)
                if profit_ratio <= effective_stop_pct:
                    exit_reason = f"ATR_TrailStop ({close:.1f}, mult={mult})"

            # Layer 3: ML SELL signal
            if exit_reason is None and signal in ("SELL", "STRONG_SELL"):
                exit_reason = f"ML_SELL ({signal})"

            # Layer 5: TP2 checked first (mirrors StockVisionStrategy.custom_exit order)
            # In Freqtrade, TP2 is checked before TP1 — if price jumps above both, exit at TP2
            if exit_reason is None and close >= entry * TP2_MULT:
                exit_reason = f"TP2 @ {close:.1f} (+{profit_ratio*100:.1f}%)"

            # Layer 6: TP1 full exit (matches Freqtrade: no partial sell support)
            if exit_reason is None and close >= entry * TP1_MULT:
                exit_reason = f"TP1 @ {close:.1f} (+{profit_ratio*100:.1f}%)"

            # Layer 7: Time stop
            if exit_reason is None and days_held >= TIME_STOP_DAYS and profit_ratio > 0.005:
                exit_reason = f"TimeStop ({days_held}d, +{profit_ratio*100:.1f}%)"

            if exit_reason:
                open_trade.exit_date = date_str
                open_trade.exit_price = close
                open_trade.exit_reason = exit_reason
                # Net profit after fees
                buy_cost = entry * (1 + TW_BUY_FEE)
                sell_net = close * (1 - TW_SELL_FEE)
                open_trade.profit_ratio = (sell_net - buy_cost) / buy_cost
                completed_trades.append({
                    "symbol": open_trade.symbol,
                    "entry_date": open_trade.entry_date,
                    "exit_date": date_str,
                    "entry_price": entry,
                    "exit_price": close,
                    "profit_ratio": open_trade.profit_ratio,
                    "exit_reason": exit_reason,
                    "days_held": days_held,
                })
                open_trade = None

        # ── Check entry conditions (only if no open trade for this stock) ──
        if open_trade is None and signal in ("BUY", "STRONG_BUY") and confidence >= CONFIDENCE_THRESHOLD:
            shares = int(STAKE_AMOUNT / close) if close > 0 else 0
            if shares > 0:
                open_trade = Trade(
                    symbol=bar.get("symbol", ""),
                    entry_date=date_str,
                    entry_price=close,
                    shares=shares,
                )

    return completed_trades


def _date_diff(date1: str, date2: str) -> int:
    """Calculate calendar-day difference between two date strings."""
    try:
        d1 = datetime.strptime(date1[:10], "%Y-%m-%d")
        d2 = datetime.strptime(date2[:10], "%Y-%m-%d")
        return (d2 - d1).days
    except (ValueError, TypeError):
        return 0


def _compute_metrics(all_trades: list[dict], first_date: str, last_date: str) -> BacktestResult:
    """Compute aggregate backtest metrics from all trades."""
    result = BacktestResult(timerange=f"{first_date}~{last_date}")
    result.total_trades = len(all_trades)
    result.trades = all_trades

    if not all_trades:
        return result

    wins = [t for t in all_trades if t["profit_ratio"] > 0]
    losses = [t for t in all_trades if t["profit_ratio"] <= 0]
    result.wins = len(wins)
    result.losses = len(losses)
    result.win_rate = len(wins) / len(all_trades)

    result.gross_profit = sum(t["profit_ratio"] for t in wins) if wins else 0
    result.gross_loss = abs(sum(t["profit_ratio"] for t in losses)) if losses else 0.001
    result.profit_factor = result.gross_profit / result.gross_loss if result.gross_loss > 0 else 0

    avg_win = result.gross_profit / len(wins) if wins else 0
    avg_loss = result.gross_loss / len(losses) if losses else 0
    result.expectancy = avg_win * result.win_rate - avg_loss * (1 - result.win_rate)

    # Sharpe / Sortino (approximate from trade returns)
    returns = [t["profit_ratio"] for t in all_trades]
    if len(returns) >= 2:
        import statistics
        mean_r = statistics.mean(returns)
        std_r = statistics.stdev(returns)
        trades_per_year = min(len(returns), 250)
        if std_r > 0:
            result.sharpe = (mean_r / std_r) * (trades_per_year ** 0.5)

        # Sortino: only downside deviation
        downside = [r for r in returns if r < 0]
        if downside:
            downside_std = statistics.stdev(downside) if len(downside) >= 2 else abs(downside[0])
            if downside_std > 0:
                result.sortino = (mean_r / downside_std) * (trades_per_year ** 0.5)

    # Max Drawdown (from cumulative equity curve)
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    for t in sorted(all_trades, key=lambda x: x["exit_date"]):
        equity *= (1 + t["profit_ratio"])
        peak = max(peak, equity)
        dd = (peak - equity) / peak
        max_dd = max(max_dd, dd)
    result.max_drawdown = max_dd

    # CAGR
    try:
        d1 = datetime.strptime(first_date[:10], "%Y-%m-%d")
        d2 = datetime.strptime(last_date[:10], "%Y-%m-%d")
        years = max((d2 - d1).days / 365.25, 0.1)
        if equity > 0:
            result.cagr = (equity ** (1 / years)) - 1
    except (ValueError, TypeError):
        pass

    return result


async def run_full_backtest() -> dict:
    """
    Full backtest pipeline:
    1. Fetch stock list + OHLCV + ML signals from D1
    2. Run in-memory backtest per stock
    3. Aggregate metrics
    4. Write results back to D1 backtest_results table
    """
    if not CF_API_TOKEN:
        return {"error": "CF_API_TOKEN not set", "status": "failed"}

    async with httpx.AsyncClient() as client:
        # ── Step 1: Fetch stocks ──
        logger.info("[Backtest] Fetching stock list from D1...")
        stocks = await _d1_query(client, """
            SELECT DISTINCT s.id, s.symbol, s.name
            FROM stocks s
            WHERE s.is_active = 1
            UNION
            SELECT DISTINCT s.id, s.symbol, s.name
            FROM stocks s
            JOIN watchlist w ON w.stock_id = s.id
        """)

        if not stocks:
            return {"error": "No stocks found in D1", "status": "failed"}

        logger.info(f"[Backtest] Found {len(stocks)} stocks")

        all_trades: list[dict] = []
        first_date = "9999-12-31"
        last_date = "0000-01-01"
        stocks_processed = 0

        for stock in stocks:
            symbol = stock["symbol"]
            stock_id = stock["id"]

            # Fetch OHLCV
            prices = await _d1_query(
                client,
                "SELECT date, open, high, low, close, volume FROM stock_prices "
                "WHERE stock_id = ? ORDER BY date ASC",
                [stock_id],
            )

            if len(prices) < 30:
                continue

            # Fetch ML signals (ensemble predictions, last 2 years)
            raw_signals = await _d1_query(
                client,
                """SELECT generated_at, trade_signal, direction_accuracy,
                          entry_price, stop_loss, target1, target2, forecast_data
                   FROM predictions
                   WHERE stock_id = ? AND model_name = 'ensemble'
                     AND generated_at >= date('now', '-730 days')
                   ORDER BY generated_at""",
                [stock_id],
            )

            # Parse signals
            signals = []
            for p in raw_signals:
                fd = {}
                try:
                    fd = json.loads(p.get("forecast_data") or "{}")
                except (json.JSONDecodeError, TypeError):
                    pass
                signals.append({
                    "date": (p.get("generated_at") or "")[:10],
                    "signal": fd.get("signal") or p.get("trade_signal") or "HOLD",
                    "confidence": p.get("direction_accuracy") or 0,
                    "entry_price": p.get("entry_price"),
                    "stop_loss": p.get("stop_loss"),
                    "target1": p.get("target1"),
                    "target2": p.get("target2"),
                })

            # Add symbol to price bars for trade tracking
            for bar in prices:
                bar["symbol"] = symbol

            # Run backtest
            trades = _run_backtest_for_stock(prices, signals)
            all_trades.extend(trades)
            stocks_processed += 1

            if prices:
                first_date = min(first_date, prices[0]["date"])
                last_date = max(last_date, prices[-1]["date"])

        # ── Step 2: Compute metrics ──
        logger.info(f"[Backtest] {stocks_processed} stocks processed, {len(all_trades)} trades")
        result = _compute_metrics(all_trades, first_date, last_date)

        # ── Step 3: Write to D1 ──
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        raw_json = json.dumps({
            "trades": all_trades[:500],  # Truncate to top 500 trades for storage
            "summary": {
                "total_trades": result.total_trades,
                "win_rate": result.win_rate,
                "sharpe": result.sharpe,
                "sortino": result.sortino,
                "max_drawdown": result.max_drawdown,
                "profit_factor": result.profit_factor,
                "expectancy": result.expectancy,
                "stocks_processed": stocks_processed,
            },
        }, ensure_ascii=False)

        success = await _d1_exec(
            client,
            """INSERT OR REPLACE INTO backtest_results
               (run_date, strategy, timerange, total_trades, win_rate,
                sharpe, sortino, calmar, max_drawdown, cagr,
                profit_factor, expectancy, raw_results)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                today,
                result.strategy,
                result.timerange,
                result.total_trades,
                result.win_rate,
                result.sharpe,
                result.sortino,
                None,  # calmar (not computed yet)
                result.max_drawdown,
                result.cagr,
                result.profit_factor,
                result.expectancy,
                raw_json[:50000],
            ],
        )

        summary = {
            "status": "success" if success else "d1_write_failed",
            "run_date": today,
            "stocks_processed": stocks_processed,
            "total_trades": result.total_trades,
            "win_rate": round(result.win_rate, 4),
            "sharpe": round(result.sharpe, 2) if result.sharpe else None,
            "sortino": round(result.sortino, 2) if result.sortino else None,
            "max_drawdown": round(result.max_drawdown, 4),
            "profit_factor": round(result.profit_factor, 2),
            "expectancy": round(result.expectancy, 4),
            "cagr": round(result.cagr, 4) if result.cagr else None,
        }
        logger.info(f"[Backtest] Done: {summary}")
        return summary
