"""
monte_carlo_service.py — Monte Carlo MDD Simulation

Shuffle completed paper_orders trade sequence 1000x, compute equity curve + MDD
for each permutation. Output: 95th percentile worst-case MDD distribution.

Purpose: Answer "if I was unlucky with trade ordering, how bad could MDD get?"
This number decides if the strategy can go live with real money.

Data source: D1 paper_orders (real paper trading history, buy→sell FIFO paired)
"""
import os
import json
import logging
import random
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# ── D1 API Config (shared with backtest_service) ─────────────────────────────
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")

D1_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
    f"/d1/database/{CF_D1_DB_ID}/query"
)

# ── Simulation Parameters ─────────────────────────────────────────────────────
DEFAULT_N_SIMULATIONS = 1000
TW_BUY_FEE = 0.001425
TW_SELL_FEE = 0.004425


@dataclass
class MonteCarloResult:
    n_simulations: int = 0
    n_trades: int = 0
    historical_mdd: float = 0.0       # 實際歷史 MDD
    mdd_median: float = 0.0           # 模擬中位數
    mdd_mean: float = 0.0             # 模擬平均
    mdd_95th: float = 0.0             # 95% 信賴區間上限
    mdd_99th: float = 0.0             # 99% 信賴區間上限
    mdd_worst: float = 0.0            # 最差情境
    mdd_best: float = 0.0             # 最佳情境
    mdd_std: float = 0.0              # MDD 標準差
    go_live_verdict: str = ""         # "PASS" / "FAIL" / "CAUTION"
    verdict_reason: str = ""
    mdds_sorted: list = None          # sorted MDD distribution (reuse, avoid recompute)


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
    """Execute a D1 SQL statement."""
    if not CF_API_TOKEN:
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


def _pair_orders_fifo(orders: list[dict]) -> list[dict]:
    """
    Pair buy→sell orders using FIFO matching.
    One sell can consume multiple buys (partial positions).
    Returns list of completed trade dicts with per-trade P&L.
    """
    # Group orders by symbol, maintain chronological order
    by_symbol: dict[str, list[dict]] = {}
    for o in orders:
        sym = o["symbol"]
        if sym not in by_symbol:
            by_symbol[sym] = []
        by_symbol[sym].append(o)

    trades = []
    orphan_sells = 0
    excess_shares = 0

    for sym, sym_orders in by_symbol.items():
        buy_queue: list[dict] = []  # FIFO queue of buy lots

        for order in sym_orders:
            if order["side"] == "buy":
                buy_queue.append({
                    "price": order["price"],
                    "shares": order["shares"],
                    "remaining": order["shares"],
                    "date": order["created_at"],
                })
            elif order["side"] == "sell":
                if not buy_queue:
                    orphan_sells += 1
                    logger.warning(
                        f"[FIFO] Orphan sell: {sym} {order['shares']}shares "
                        f"@ {order['created_at']} — no matching buy in queue"
                    )
                    continue

                sell_price = order["price"]
                sell_date = order["created_at"]
                shares_to_sell = order["shares"]

                # FIFO: consume from earliest buy lots
                while shares_to_sell > 0 and buy_queue:
                    lot = buy_queue[0]
                    sold = min(lot["remaining"], shares_to_sell)
                    lot["remaining"] -= sold
                    shares_to_sell -= sold

                    # Per-lot P&L with real TW fees
                    buy_cost = lot["price"] * (1 + TW_BUY_FEE)
                    sell_net = sell_price * (1 - TW_SELL_FEE)
                    profit_ratio = (sell_net - buy_cost) / buy_cost

                    trades.append({
                        "symbol": sym,
                        "entry_date": lot["date"][:10],
                        "exit_date": sell_date[:10],
                        "entry_price": lot["price"],
                        "exit_price": sell_price,
                        "shares": sold,
                        "profit_ratio": profit_ratio,
                        "exit_reason": order.get("note", ""),
                    })

                    if lot["remaining"] <= 0:
                        buy_queue.pop(0)

                if shares_to_sell > 0:
                    excess_shares += shares_to_sell
                    logger.warning(
                        f"[FIFO] Excess sell: {sym} {shares_to_sell}shares "
                        f"@ {sell_date} — sell qty exceeds buy queue"
                    )

    if orphan_sells or excess_shares:
        logger.warning(
            f"[FIFO] Pairing summary: {len(trades)} trades paired, "
            f"{orphan_sells} orphan sells dropped, "
            f"{excess_shares} excess shares dropped"
        )

    return trades


def _compute_mdd(returns: list[float]) -> float:
    """Compute max drawdown from a sequence of trade returns."""
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    for r in returns:
        equity *= (1 + r)
        peak = max(peak, equity)
        dd = (peak - equity) / peak
        max_dd = max(max_dd, dd)
    return max_dd


def _run_monte_carlo(
    trade_returns: list[float],
    n_simulations: int = DEFAULT_N_SIMULATIONS,
    seed: int = 42,
) -> MonteCarloResult:
    """
    Core Monte Carlo simulation:
    Shuffle trade return sequence n times, compute MDD for each.
    """
    result = MonteCarloResult(
        n_simulations=n_simulations,
        n_trades=len(trade_returns),
    )

    if len(trade_returns) < 5:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = f"Insufficient trades ({len(trade_returns)}), need >= 5"
        return result

    # Historical MDD (actual order)
    result.historical_mdd = _compute_mdd(trade_returns)

    # Monte Carlo: shuffle and compute MDD for each permutation
    rng = random.Random(seed)
    mdds = []

    for _ in range(n_simulations):
        shuffled = trade_returns.copy()
        rng.shuffle(shuffled)
        mdds.append(_compute_mdd(shuffled))

    mdds.sort()

    result.mdd_best = mdds[0]
    result.mdd_median = mdds[len(mdds) // 2]
    result.mdd_mean = statistics.mean(mdds)
    result.mdd_std = statistics.stdev(mdds) if len(mdds) >= 2 else 0.0
    result.mdd_95th = mdds[int(len(mdds) * 0.95)]
    result.mdd_99th = mdds[min(int(len(mdds) * 0.99), len(mdds) - 1)]
    result.mdd_worst = mdds[-1]
    result.mdds_sorted = [round(m, 6) for m in mdds]  # store for reuse

    # Go-live verdict
    # 台股策略: MDD 95th < 20% = PASS, 20-30% = CAUTION, > 30% = FAIL
    if result.mdd_95th < 0.20:
        result.go_live_verdict = "PASS"
        result.verdict_reason = (
            f"95th percentile MDD = {result.mdd_95th:.1%} < 20% threshold. "
            f"Strategy MDD risk is acceptable for live trading."
        )
    elif result.mdd_95th < 0.30:
        result.go_live_verdict = "CAUTION"
        result.verdict_reason = (
            f"95th percentile MDD = {result.mdd_95th:.1%} is between 20-30%. "
            f"Consider reducing position size or adding risk controls before going live."
        )
    else:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = (
            f"95th percentile MDD = {result.mdd_95th:.1%} > 30% threshold. "
            f"Strategy risk too high for live trading. Optimize parameters first."
        )

    return result


async def run_monte_carlo_mdd(
    n_simulations: int = DEFAULT_N_SIMULATIONS,
    source: str = "paper",
) -> dict:
    """
    Full Monte Carlo MDD pipeline:
    1. Fetch completed trades (paper_orders or backtest_results)
    2. FIFO pair buy→sell
    3. Run Monte Carlo simulation
    4. Write results to D1
    """
    if not CF_API_TOKEN:
        return {"error": "CF_API_TOKEN not set", "status": "failed"}

    async with httpx.AsyncClient() as client:
        # ── Step 1: Fetch trade returns ──
        trade_returns: list[float] = []

        if source == "paper":
            logger.info("[MonteCarlo] Fetching paper_orders from D1...")
            orders = await _d1_query(
                client,
                """SELECT symbol, side, shares, price, note, created_at
                   FROM paper_orders
                   WHERE account_id = 1
                   ORDER BY created_at ASC""",
            )

            if not orders:
                return {"error": "No paper orders found", "status": "failed"}

            logger.info(f"[MonteCarlo] Found {len(orders)} orders, pairing FIFO...")
            trades = _pair_orders_fifo(orders)
            trade_returns = [t["profit_ratio"] for t in trades]

        elif source == "backtest":
            logger.info("[MonteCarlo] Fetching backtest trades from D1...")
            row = await _d1_query(
                client,
                """SELECT raw_results FROM backtest_results
                   ORDER BY run_date DESC, created_at DESC LIMIT 1""",
            )

            if not row or not row[0].get("raw_results"):
                return {"error": "No backtest results found", "status": "failed"}

            raw = json.loads(row[0]["raw_results"])
            # Prefer all_returns (complete, not truncated) over trades[:500]
            if raw.get("all_returns"):
                trade_returns = raw["all_returns"]
            else:
                trades = raw.get("trades", [])
                trade_returns = [t["profit_ratio"] for t in trades]

        else:
            return {"error": f"Unknown source: {source}", "status": "failed"}

        if len(trade_returns) < 5:
            return {
                "error": f"Only {len(trade_returns)} completed trades, need >= 5",
                "status": "failed",
            }
        logger.info(
            f"[MonteCarlo] {len(trade_returns)} trades, "
            f"running {n_simulations} simulations..."
        )

        # ── Step 3: Run Monte Carlo ──
        mc = _run_monte_carlo(trade_returns, n_simulations)

        # ── Step 4: Write to D1 ──
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # Reuse sorted MDD distribution from simulation (no recompute)
        mdds_for_dist = mc.mdds_sorted or []

        # Store histogram buckets (for frontend visualization)
        buckets = {}
        for mdd in mdds_for_dist:
            bucket = f"{int(mdd * 100)}%"
            buckets[bucket] = buckets.get(bucket, 0) + 1

        raw_json = json.dumps({
            "distribution": mdds_for_dist,
            "histogram": buckets,
            "source": source,
            "n_trades": len(trades),
        }, ensure_ascii=False)

        success = await _d1_exec(
            client,
            """INSERT OR REPLACE INTO monte_carlo_results
               (run_date, source, n_simulations, n_trades,
                historical_mdd, mdd_median, mdd_mean, mdd_std,
                mdd_95th, mdd_99th, mdd_worst, mdd_best,
                go_live_verdict, verdict_reason, raw_distribution)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                today,
                source,
                mc.n_simulations,
                mc.n_trades,
                mc.historical_mdd,
                mc.mdd_median,
                mc.mdd_mean,
                mc.mdd_std,
                mc.mdd_95th,
                mc.mdd_99th,
                mc.mdd_worst,
                mc.mdd_best,
                mc.go_live_verdict,
                mc.verdict_reason,
                raw_json[:50000],
            ],
        )

        summary = {
            "status": "success" if success else "d1_write_failed",
            "run_date": today,
            "source": source,
            "n_simulations": mc.n_simulations,
            "n_trades": mc.n_trades,
            "historical_mdd": f"{mc.historical_mdd:.2%}",
            "mdd_95th": f"{mc.mdd_95th:.2%}",
            "mdd_99th": f"{mc.mdd_99th:.2%}",
            "mdd_worst": f"{mc.mdd_worst:.2%}",
            "mdd_median": f"{mc.mdd_median:.2%}",
            "go_live_verdict": mc.go_live_verdict,
            "verdict_reason": mc.verdict_reason,
        }
        logger.info(f"[MonteCarlo] Done: {mc.go_live_verdict} — 95th MDD = {mc.mdd_95th:.2%}")
        return summary
