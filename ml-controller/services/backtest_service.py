"""
backtest_service.py — Python backtester mirroring StockVisionStrategy 7-layer cascade

Pipeline: D1 export → in-memory backtest (FIFO order matching) → D1 import
No Freqtrade binary needed — runs entirely on Cloud Run.

FIFO Order Matching:
  - Each stock maintains a queue of BuyLot(s)
  - Sells consume lots from the earliest buy first (FIFO)
  - TP1 partial exit: sell 50% of position (earliest lots first)
  - TP2/stop/time: sell all remaining lots
  - Each lot produces its own trade record with true per-lot P&L

Entry: ML BUY/STRONG_BUY + confidence >= threshold
Exit 7-layer cascade (mirrors StockVisionStrategy.py):
  1. Hard stop (-12%)
  2+4. ATR trailing stop (profit-tiered: 3.0x / 2.5x / 2.0x)
  3. ML SELL signal
  5. TP2: entry × 1.06 (full exit)  — checked before TP1
  6. TP1: entry × 1.03 (sell 50%)
  7. Time stop: 20 days + profit > 0.5%
"""
import os
import json
import logging
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx
import polars as pl
from services.research_data_access import resolve_research_data_access
from services.snapshot_parquet import read_snapshot_component

logger = logging.getLogger(__name__)

# ── D1 API Config ────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")

D1_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
    f"/d1/database/{CF_D1_DB_ID}/query"
)

# ── Strategy Parameters (mirror Worker tradingConfig + paper.ts) ──────────────
CONFIDENCE_THRESHOLD = 0.60
HARD_STOP_PCT = -0.12
TP1_ATR_MULT = 1.5    # H9 fix: ATR-relative (was fixed 1.03)
TP2_ATR_MULT = 3.0    # H9 fix: ATR-relative (was fixed 1.06)
TP1_SELL_RATIO = 0.50  # TP1 賣出比例（50%）
TIME_STOP_DAYS = 20
TRAIL_MULT_DEFAULT = 3.0
TRAIL_MULT_3PCT = 2.5
TRAIL_MULT_8PCT = 2.0
MAX_OPEN_TRADES = 5
STAKE_AMOUNT = 200_000
BACKTEST_D1_READ_CHUNK_SIZE = max(10, min(int(os.environ.get("BACKTEST_D1_READ_CHUNK_SIZE", "80")), 200))
TW_BUY_FEE = 0.001425       # 買入手續費 0.1425%
TW_SELL_FEE = 0.004425       # 賣出手續費 0.1425% + 證交稅 0.3%


# ── Data Classes ──────────────────────────────────────────────────────────────

@dataclass
class BuyLot:
    """Single buy order — FIFO queue element."""
    symbol: str
    date: str
    price: float
    shares: int
    entry_regime: str = "unknown"
    remaining: int = 0

    def __post_init__(self):
        if self.remaining == 0:
            self.remaining = self.shares


@dataclass
class Position:
    """Open position for a stock — may contain multiple buy lots (FIFO)."""
    symbol: str
    lots: list[BuyLot] = field(default_factory=list)
    highest_since_entry: float = 0.0
    tp1_hit: bool = False

    @property
    def total_shares(self) -> int:
        return sum(lot.remaining for lot in self.lots)

    @property
    def avg_cost(self) -> float:
        total_cost = sum(lot.price * lot.remaining for lot in self.lots)
        total_shares = self.total_shares
        return total_cost / total_shares if total_shares > 0 else 0.0

    @property
    def entry_date(self) -> str:
        return self.lots[0].date if self.lots else ""

    @property
    def entry_price(self) -> float:
        """First lot price (for stop/TP threshold calculation)."""
        return self.lots[0].price if self.lots else 0.0

    def sell_fifo(self, shares_to_sell: int, sell_date: str, sell_price: float,
                  exit_reason: str) -> list[dict]:
        """
        Sell shares using FIFO matching. Returns list of completed trade dicts.
        Each lot consumed produces a separate trade record with true per-lot P&L.
        """
        trades = []
        remaining_to_sell = shares_to_sell

        for lot in self.lots:
            if remaining_to_sell <= 0:
                break
            if lot.remaining <= 0:
                continue

            sold = min(lot.remaining, remaining_to_sell)
            lot.remaining -= sold
            remaining_to_sell -= sold

            # Per-lot P&L with real TW fees
            buy_cost = lot.price * (1 + TW_BUY_FEE)
            sell_net = sell_price * (1 - TW_SELL_FEE)
            profit_ratio = (sell_net - buy_cost) / buy_cost

            trades.append({
                "symbol": self.symbol,
                "entry_date": lot.date,
                "exit_date": sell_date,
                "entry_price": lot.price,
                "exit_price": sell_price,
                "shares": sold,
                "profit_ratio": profit_ratio,
                "entry_regime": lot.entry_regime or "unknown",
                "exit_reason": exit_reason,
                "days_held": _date_diff(lot.date, sell_date),
            })

        # Remove exhausted lots
        self.lots = [lot for lot in self.lots if lot.remaining > 0]
        return trades


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
    calmar: Optional[float] = None
    max_drawdown: float = 0.0
    cagr: Optional[float] = None
    trades: list = field(default_factory=list)


# ── D1 Helpers ────────────────────────────────────────────────────────────────

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


# ── Backtest Engine ───────────────────────────────────────────────────────────

def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _snapshot_frame_with_stock_id(df: pl.DataFrame, stocks: pl.DataFrame) -> pl.DataFrame:
    if df.is_empty() or "stock_id" in df.columns:
        return df
    if "symbol" not in df.columns or not {"id", "symbol"}.issubset(set(stocks.columns)):
        raise RuntimeError("backtest_snapshot_stock_id_missing")
    return df.join(
        stocks.select([pl.col("id").alias("stock_id"), "symbol"]),
        on="symbol",
        how="inner",
    )


def _group_snapshot_rows_by_stock_id(df: pl.DataFrame) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = defaultdict(list)
    if df.is_empty():
        return grouped
    for row in df.sort(["stock_id", "date"] if "date" in df.columns else ["stock_id"]).to_dicts():
        grouped[int(row["stock_id"])].append(row)
    return grouped


def _load_backtest_inputs_from_snapshot(manifest: dict) -> tuple[list[dict], dict[int, list[dict]], dict[int, list[dict]]]:
    stocks_df = read_snapshot_component(manifest, "stocks")
    prices_df = read_snapshot_component(manifest, "prices")
    signals_df = read_snapshot_component(manifest, "signals", required=False)
    if signals_df is None:
        signals_df = read_snapshot_component(manifest, "predictions", required=False)
    if stocks_df is None or stocks_df.is_empty() or prices_df is None or prices_df.is_empty():
        raise RuntimeError("backtest_snapshot_stocks_or_prices_missing")
    if signals_df is None or signals_df.is_empty():
        raise RuntimeError("backtest_snapshot_signals_missing")

    if {"delisted_date", "listed_date"}.issubset(set(stocks_df.columns)):
        stocks_df = stocks_df.with_columns([
            pl.col("listed_date").cast(pl.Utf8),
            pl.col("delisted_date").cast(pl.Utf8),
        ]).filter(
            ((pl.col("delisted_date").is_null()) | (pl.col("delisted_date") >= "2023-01-01"))
            & ((pl.col("listed_date").is_null()) | (pl.col("listed_date") <= datetime.now(timezone.utc).strftime("%Y-%m-%d")))
        )
    if not {"id", "symbol"}.issubset(set(stocks_df.columns)):
        raise RuntimeError("backtest_snapshot_stocks_schema_invalid")

    prices_df = _snapshot_frame_with_stock_id(prices_df, stocks_df)
    signals_df = _snapshot_frame_with_stock_id(signals_df, stocks_df)
    stocks = stocks_df.select([col for col in ["id", "symbol", "name"] if col in stocks_df.columns]).to_dicts()
    return (
        stocks,
        _group_snapshot_rows_by_stock_id(prices_df),
        _group_snapshot_rows_by_stock_id(signals_df),
    )


async def _bulk_load_prices_by_stock(
    client: httpx.AsyncClient,
    stock_ids: list[int],
    *,
    chunk_size: int = BACKTEST_D1_READ_CHUNK_SIZE,
) -> tuple[dict[int, list[dict]], int]:
    """Load OHLCV in stock-id chunks instead of one D1 query per stock."""
    grouped: dict[int, list[dict]] = defaultdict(list)
    query_count = 0
    for ids in _chunks(stock_ids, chunk_size):
        placeholders = ",".join(["?"] * len(ids))
        rows = await _d1_query(
            client,
            f"""
            SELECT stock_id, date, open, high, low, close, volume
            FROM stock_prices
            WHERE stock_id IN ({placeholders})
            ORDER BY stock_id, date ASC
            """,
            ids,
        )
        query_count += 1
        for row in rows:
            grouped[int(row["stock_id"])].append(row)
    return grouped, query_count


async def _bulk_load_ensemble_signals_by_stock(
    client: httpx.AsyncClient,
    stock_ids: list[int],
    *,
    chunk_size: int = BACKTEST_D1_READ_CHUNK_SIZE,
) -> tuple[dict[int, list[dict]], int]:
    """Load recent ensemble predictions in stock-id chunks for research/backtest lanes."""
    grouped: dict[int, list[dict]] = defaultdict(list)
    query_count = 0
    for ids in _chunks(stock_ids, chunk_size):
        placeholders = ",".join(["?"] * len(ids))
        rows = await _d1_query(
            client,
            f"""
            SELECT stock_id, generated_at, trade_signal, direction_accuracy,
                   entry_price, stop_loss, target1, target2, forecast_data,
                   market_risk_level
            FROM predictions
            WHERE stock_id IN ({placeholders})
              AND model_name = 'ensemble'
              AND generated_at >= date('now', '-730 days')
            ORDER BY stock_id, generated_at
            """,
            ids,
        )
        query_count += 1
        for row in rows:
            grouped[int(row["stock_id"])].append(row)
    return grouped, query_count


def _tick_size(price: float) -> float:
    """Taiwan stock tick size by price level."""
    if price < 10: return 0.01
    if price < 50: return 0.05
    if price < 100: return 0.1
    if price < 500: return 0.5
    if price < 1000: return 1.0
    return 5.0


def _apply_slippage(price: float, side: str, ticks: int = 1) -> float:
    """C4 fix: apply tick-based slippage to backtest fills."""
    tick = _tick_size(price)
    slip = tick * ticks
    if side == "buy":
        return price + slip
    return max(price - slip, tick)


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


def _date_diff(date1: str, date2: str) -> int:
    """Calculate calendar-day difference between two date strings."""
    try:
        d1 = datetime.strptime(date1[:10], "%Y-%m-%d")
        d2 = datetime.strptime(date2[:10], "%Y-%m-%d")
        return (d2 - d1).days
    except (ValueError, TypeError):
        return 0


def _run_backtest_for_stock(
    prices: list[dict],
    signals: list[dict],
) -> list[dict]:
    """
    Run backtest for a single stock with FIFO order matching.
    Returns list of completed trade dicts (one per lot consumed).
    """
    if len(prices) < 30:
        return []

    sig_map = {s["date"]: s for s in signals if s.get("date")}

    completed_trades: list[dict] = []
    position: Optional[Position] = None

    for idx, bar in enumerate(prices):
        date_str = bar["date"]
        close = float(bar["close"])
        high = float(bar.get("high") or close)
        low = float(bar.get("low") or close)
        sig = sig_map.get(date_str, {})
        signal = sig.get("signal", "HOLD")
        confidence = float(sig.get("confidence") or 0)

        # ── Check exit conditions for open position ──
        if position is not None and position.total_shares > 0:
            entry = position.entry_price  # first lot price for threshold calc
            if close <= 0 or entry <= 0:
                continue  # skip bars with invalid price data
            position.highest_since_entry = max(position.highest_since_entry, high)
            profit_ratio = (close - entry) / entry
            days_held = _date_diff(position.entry_date, date_str)
            atr = _compute_atr14(prices, idx)

            exit_reason = None
            sell_all = False  # True = exit entire position; False = check partial

            # Layer 1: Hard stop (-12%)
            if profit_ratio <= HARD_STOP_PCT:
                exit_reason = f"HardStop ({profit_ratio * 100:.1f}%)"
                sell_all = True

            # Layer 2+4: ATR trailing stop (mirrors custom_stoploss)
            elif atr > 0:
                if profit_ratio > 0.08:
                    mult = TRAIL_MULT_8PCT
                elif profit_ratio > 0.03:
                    mult = TRAIL_MULT_3PCT
                else:
                    mult = TRAIL_MULT_DEFAULT
                trail_distance = (atr * mult) / close
                effective_stop_pct = max(-trail_distance, HARD_STOP_PCT)
                if profit_ratio <= effective_stop_pct:
                    exit_reason = f"ATR_TrailStop ({close:.1f}, mult={mult})"
                    sell_all = True

            # Layer 3: ML SELL signal
            if exit_reason is None and signal in ("SELL", "STRONG_SELL"):
                exit_reason = f"ML_SELL ({signal})"
                sell_all = True

            # Layer 5: TP2 full exit — ATR-relative (H9 fix, matches Worker)
            tp2_price = entry + atr * TP2_ATR_MULT if atr > 0 else entry * 1.06
            if exit_reason is None and close >= tp2_price:
                exit_reason = f"TP2 @ {close:.1f} (+{profit_ratio * 100:.1f}%)"
                sell_all = True

            # Layer 6: TP1 partial exit — ATR-relative (H9 fix, matches Worker)
            tp1_price = entry + atr * TP1_ATR_MULT if atr > 0 else entry * 1.03
            if exit_reason is None and not position.tp1_hit and close >= tp1_price:
                position.tp1_hit = True
                shares_to_sell = max(1, int(position.total_shares * TP1_SELL_RATIO))
                reason = f"TP1 @ {close:.1f} (+{profit_ratio * 100:.1f}%)"
                sell_px = _apply_slippage(close, "sell")  # C4: slippage on TP1
                trades = position.sell_fifo(shares_to_sell, date_str, sell_px, reason)
                completed_trades.extend(trades)
                # Don't set sell_all — remaining shares stay open

            # Layer 7: Time stop
            if exit_reason is None and days_held >= TIME_STOP_DAYS and profit_ratio > 0.005:
                exit_reason = f"TimeStop ({days_held}d, +{profit_ratio * 100:.1f}%)"
                sell_all = True

            # Execute full exit if triggered
            if sell_all and exit_reason and position.total_shares > 0:
                sell_px = _apply_slippage(close, "sell")  # C4: slippage on exit
                trades = position.sell_fifo(
                    position.total_shares, date_str, sell_px, exit_reason
                )
                completed_trades.extend(trades)

            # Clean up if position fully closed
            if position is not None and position.total_shares <= 0:
                position = None

        # ── Check entry conditions ──
        if position is None and signal in ("BUY", "STRONG_BUY") and confidence >= CONFIDENCE_THRESHOLD:
            fill_price = _apply_slippage(close, "buy")  # C4: slippage on entry
            shares = int(STAKE_AMOUNT / fill_price) if fill_price > 0 else 0
            if shares > 0:
                entry_regime = str(
                    sig.get("entry_regime")
                    or sig.get("market_regime")
                    or sig.get("regime")
                    or sig.get("regime_label")
                    or sig.get("regime_family")
                    or "unknown"
                )
                lot = BuyLot(
                    symbol=bar.get("symbol", ""),
                    date=date_str,
                    price=fill_price,  # C4: use slippage-adjusted price
                    shares=shares,
                    entry_regime=entry_regime,
                )
                position = Position(
                    symbol=bar.get("symbol", ""),
                    lots=[lot],
                    highest_since_entry=fill_price,
                )

    return completed_trades


# ── Metrics ───────────────────────────────────────────────────────────────────

def _compute_metrics(all_trades: list[dict], first_date: str, last_date: str) -> BacktestResult:
    """Compute aggregate backtest metrics from all completed trades."""
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

    # Sharpe / Sortino (annualized from trade returns)
    returns = [t["profit_ratio"] for t in all_trades]
    if len(returns) >= 2:
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

    # Max Drawdown (cumulative equity curve)
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    for t in sorted(all_trades, key=lambda x: x["exit_date"]):
        equity *= (1 + t["profit_ratio"])
        peak = max(peak, equity)
        dd = (peak - equity) / peak
        max_dd = max(max_dd, dd)
    result.max_drawdown = max_dd

    # CAGR + Calmar
    try:
        d1 = datetime.strptime(first_date[:10], "%Y-%m-%d")
        d2 = datetime.strptime(last_date[:10], "%Y-%m-%d")
        years = max((d2 - d1).days / 365.25, 0.1)
        if equity > 0:
            result.cagr = (equity ** (1 / years)) - 1
            if max_dd > 0:
                result.calmar = result.cagr / max_dd
    except (ValueError, TypeError):
        pass

    return result


# ── Pipeline ──────────────────────────────────────────────────────────────────

async def run_full_backtest() -> dict:
    """
    Full backtest pipeline:
    1. Fetch stock list + OHLCV + ML signals from D1
    2. Run FIFO in-memory backtest per stock
    3. Aggregate metrics
    4. Write results back to D1 backtest_results table
    """
    if not CF_API_TOKEN:
        return {"error": "CF_API_TOKEN not set", "status": "failed"}

    async with httpx.AsyncClient() as client:
        backtest_start_date = "2023-01-01"
        backtest_end_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        data_access = resolve_research_data_access(
            lane="backtest_service.run_full_backtest",
            kind="backtest_dataset",
            required_start_date=backtest_start_date,
            required_end_date=backtest_end_date,
        )
        if data_access.source == "snapshot" and data_access.snapshot:
            try:
                stocks, prices_by_stock, signals_by_stock = _load_backtest_inputs_from_snapshot(data_access.snapshot)
            except RuntimeError as exc:
                return {
                    "status": "error",
                    "error": str(exc),
                    "data_access": data_access.to_dict(),
                }
            price_query_count = 0
            signal_query_count = 0
        else:
            # ── Step 1: Fetch stocks (point-in-time tradable universe) ──
            # D2 fix: aligned with backtest_engine._load_stocks — no in_current_watchlist filter.
            # Include all non-delisted + delisted-after-2023 stocks (same as backtest_engine).
            logger.info("[Backtest] Fetching tradable universe from D1...")
            stocks = await _d1_query(client, """
                SELECT DISTINCT s.id, s.symbol, s.name
                FROM stocks s
                WHERE (s.delisted_date IS NULL OR s.delisted_date >= '2023-01-01')
                  AND (s.listed_date IS NULL OR s.listed_date <= date('now'))
            """)

            if not stocks:
                return {"error": "No stocks found in D1", "status": "failed"}

            logger.info(f"[Backtest] Found {len(stocks)} stocks")
            stock_ids = [int(stock["id"]) for stock in stocks]
            prices_by_stock, price_query_count = await _bulk_load_prices_by_stock(client, stock_ids)
            signals_by_stock, signal_query_count = await _bulk_load_ensemble_signals_by_stock(client, stock_ids)
        logger.info(
            "[Backtest] Bulk loaded research data: price_groups=%s signal_groups=%s d1_queries=%s",
            len(prices_by_stock),
            len(signals_by_stock),
            1 + price_query_count + signal_query_count,
        )

        all_trades: list[dict] = []
        first_date = "9999-12-31"
        last_date = "0000-01-01"
        stocks_processed = 0
        stocks_skipped = 0

        for stock in stocks:
            symbol = stock["symbol"]
            stock_id = stock["id"]

            prices = prices_by_stock.get(int(stock_id), [])

            if len(prices) < 30:
                stocks_skipped += 1
                continue

            raw_signals = signals_by_stock.get(int(stock_id), [])

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
                    "market_regime": (
                        fd.get("entry_regime")
                        or fd.get("market_regime")
                        or fd.get("regime")
                        or fd.get("regime_label")
                        or fd.get("regime_family")
                        or p.get("market_risk_level")
                    ),
                })

            # Tag price bars with symbol
            for bar in prices:
                bar["symbol"] = symbol

            # Run backtest with FIFO matching
            trades = _run_backtest_for_stock(prices, signals)
            all_trades.extend(trades)
            stocks_processed += 1

            if prices:
                first_date = min(first_date, prices[0]["date"])
                last_date = max(last_date, prices[-1]["date"])

        # ── Step 2: Compute metrics ──
        logger.info(
            f"[Backtest] {stocks_processed} stocks processed, "
            f"{stocks_skipped} skipped, {len(all_trades)} trades"
        )
        result = _compute_metrics(all_trades, first_date, last_date)

        # ── Step 3: Exit distribution summary ──
        exit_dist: dict[str, int] = {}
        for t in all_trades:
            # Normalize exit reason to category
            reason = t.get("exit_reason", "Unknown")
            if "TP1" in reason:
                cat = "TP1"
            elif "TP2" in reason:
                cat = "TP2"
            elif "HardStop" in reason:
                cat = "HardStop"
            elif "ATR_TrailStop" in reason:
                cat = "TrailStop"
            elif "ML_SELL" in reason:
                cat = "ML_SELL"
            elif "TimeStop" in reason:
                cat = "TimeStop"
            else:
                cat = "Other"
            exit_dist[cat] = exit_dist.get(cat, 0) + 1

        # ── Step 4: Write to D1 ──
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        # Store full profit_ratio list for Monte Carlo (compact), trades truncated for display
        all_returns = [t["profit_ratio"] for t in all_trades]
        all_regimes = [str(t.get("entry_regime") or "unknown") for t in all_trades]
        raw_json = json.dumps({
            "trades": all_trades[:500],
            "all_returns": all_returns,  # full list for Monte Carlo source=backtest
            "all_regimes": all_regimes,
            "exit_distribution": exit_dist,
            "summary": {
                "total_trades": result.total_trades,
                "win_rate": result.win_rate,
                "sharpe": result.sharpe,
                "sortino": result.sortino,
                "calmar": result.calmar,
                "max_drawdown": result.max_drawdown,
                "profit_factor": result.profit_factor,
                "expectancy": result.expectancy,
                "cagr": result.cagr,
                "stocks_processed": stocks_processed,
                "stocks_skipped": stocks_skipped,
                "data_access": data_access.to_dict(),
                "d1_read_queries": 1 + price_query_count + signal_query_count,
                "d1_read_chunk_size": BACKTEST_D1_READ_CHUNK_SIZE,
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
                result.calmar,
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
            "stocks_skipped": stocks_skipped,
            "total_trades": result.total_trades,
            "win_rate": round(result.win_rate, 4),
            "sharpe": round(result.sharpe, 2) if result.sharpe else None,
            "sortino": round(result.sortino, 2) if result.sortino else None,
            "calmar": round(result.calmar, 2) if result.calmar else None,
            "max_drawdown": round(result.max_drawdown, 4),
            "profit_factor": round(result.profit_factor, 2),
            "expectancy": round(result.expectancy, 4),
            "cagr": round(result.cagr, 4) if result.cagr else None,
            "exit_distribution": exit_dist,
            "data_access": {
                **data_access.to_dict(),
                "read_path": "snapshot" if data_access.source == "snapshot" else "d1_chunked_bulk_fallback",
                "d1_read_queries": 1 + price_query_count + signal_query_count,
                "d1_read_chunk_size": BACKTEST_D1_READ_CHUNK_SIZE,
                "price_groups": len(prices_by_stock),
                "signal_groups": len(signals_by_stock),
            },
        }
        logger.info(f"[Backtest] Done: {summary}")
        return summary
