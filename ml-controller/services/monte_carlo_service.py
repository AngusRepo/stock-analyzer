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

try:
    import httpx
except ImportError:  # pragma: no cover - only hit in slim unit-test envs
    httpx = None

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
    simulation_method: str = "iid_shuffle"
    block_size: Optional[int] = None
    regime_counts: dict[str, int] = None


async def _d1_query(client, sql: str, params: list = None) -> list[dict]:
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


async def _d1_exec(client, sql: str, params: list = None) -> bool:
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


@dataclass
class PairingResult:
    """FIFO pairing output with data quality metrics."""
    trades: list[dict]
    # Data quality
    total_orders: int = 0
    paired_trades: int = 0
    orphan_sells: int = 0           # sell 沒有對應 buy
    excess_shares: int = 0          # sell 股數 > buy 餘量
    open_positions: int = 0         # 未平倉 buy（正常：目前持有中）
    dirty_symbols: list[str] = None # 有資料問題的股票
    data_quality: str = "CLEAN"     # "CLEAN" | "USABLE" | "DIRTY"
    quality_detail: str = ""


def _validate_and_pair_orders(orders: list[dict]) -> PairingResult:
    """
    Pre-validate data integrity then FIFO pair.
    Returns trades + data quality report so caller can decide whether to proceed.
    """
    result = PairingResult(trades=[], total_orders=len(orders), dirty_symbols=[])

    # Group orders by symbol
    by_symbol: dict[str, list[dict]] = {}
    for o in orders:
        sym = o["symbol"]
        if sym not in by_symbol:
            by_symbol[sym] = []
        by_symbol[sym].append(o)

    # ── Pre-validation: per-symbol integrity check ──
    for sym, sym_orders in by_symbol.items():
        buy_shares = sum(o["shares"] for o in sym_orders if o["side"] == "buy")
        sell_shares = sum(o["shares"] for o in sym_orders if o["side"] == "sell")
        first_order = sym_orders[0]["side"] if sym_orders else None

        issues = []
        if first_order == "sell":
            issues.append("first order is sell (missing earlier buy)")
        if sell_shares > buy_shares:
            issues.append(f"sell({sell_shares}) > buy({buy_shares})")

        if issues:
            result.dirty_symbols.append(f"{sym}: {'; '.join(issues)}")

    # ── FIFO pairing ──
    for sym, sym_orders in by_symbol.items():
        buy_queue: list[dict] = []

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
                    result.orphan_sells += 1
                    continue

                sell_price = order["price"]
                sell_date = order["created_at"]
                shares_to_sell = order["shares"]

                while shares_to_sell > 0 and buy_queue:
                    lot = buy_queue[0]
                    sold = min(lot["remaining"], shares_to_sell)
                    lot["remaining"] -= sold
                    shares_to_sell -= sold

                    buy_cost = lot["price"] * (1 + TW_BUY_FEE)
                    sell_net = sell_price * (1 - TW_SELL_FEE)
                    profit_ratio = (sell_net - buy_cost) / buy_cost

                    result.trades.append({
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
                    result.excess_shares += shares_to_sell

        # Remaining buy lots = open positions (normal)
        result.open_positions += len(buy_queue)

    result.paired_trades = len(result.trades)

    # ── Data quality verdict ──
    dirty_count = len(result.dirty_symbols)
    total_symbols = len(by_symbol)

    if dirty_count == 0:
        result.data_quality = "CLEAN"
        result.quality_detail = f"{total_symbols} symbols, all clean"
    elif dirty_count / max(total_symbols, 1) < 0.1:
        result.data_quality = "USABLE"
        result.quality_detail = (
            f"{dirty_count}/{total_symbols} symbols have issues: "
            + ", ".join(result.dirty_symbols[:5])
        )
        logger.warning(f"[FIFO] Data quality USABLE — {result.quality_detail}")
    else:
        result.data_quality = "DIRTY"
        result.quality_detail = (
            f"{dirty_count}/{total_symbols} symbols have issues (>{10}%). "
            "Results unreliable. Fix paper_orders data first. "
            + ", ".join(result.dirty_symbols[:10])
        )
        logger.error(f"[FIFO] Data quality DIRTY — {result.quality_detail}")

    return result


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


def _default_block_size(n_returns: int) -> int:
    """Conservative moving-block size for trade-level bootstrap."""
    if n_returns <= 1:
        return 1
    return max(2, min(20, int(n_returns ** 0.5)))


def _sample_block_bootstrap_path(
    trade_returns: list[float],
    *,
    rng: random.Random,
    block_size: int,
) -> list[float]:
    n = len(trade_returns)
    if n == 0:
        return []
    block_size = max(1, min(block_size, n))
    path: list[float] = []
    max_start = max(0, n - block_size)
    while len(path) < n:
        start = rng.randint(0, max_start) if max_start > 0 else 0
        path.extend(trade_returns[start:start + block_size])
    return path[:n]


def _regime_counts(regimes: list[str] | None) -> dict[str, int]:
    counts: dict[str, int] = {}
    for regime in regimes or []:
        key = str(regime or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return counts


def _regime_segments(regimes: list[str]) -> list[tuple[str, int]]:
    if not regimes:
        return []
    segments: list[tuple[str, int]] = []
    current = regimes[0]
    length = 1
    for regime in regimes[1:]:
        if regime == current:
            length += 1
        else:
            segments.append((current, length))
            current = regime
            length = 1
    segments.append((current, length))
    return segments


def _sample_regime_block_bootstrap_path(
    trade_returns: list[float],
    trade_regimes: list[str],
    *,
    rng: random.Random,
    block_size: int,
) -> list[float]:
    by_regime: dict[str, list[float]] = {}
    for ret, regime in zip(trade_returns, trade_regimes):
        by_regime.setdefault(str(regime or "unknown"), []).append(ret)

    path: list[float] = []
    for regime, segment_len in _regime_segments(trade_regimes):
        pool = by_regime.get(str(regime or "unknown")) or trade_returns
        segment: list[float] = []
        while len(segment) < segment_len:
            segment.extend(_sample_block_bootstrap_path(pool, rng=rng, block_size=block_size))
        path.extend(segment[:segment_len])
    return path[:len(trade_returns)]


def _extract_backtest_returns_and_regimes(raw: dict) -> tuple[list[float], list[str] | None]:
    returns = [_r for _r in raw.get("all_returns") or [] if _as_number(_r) is not None]
    regimes = raw.get("all_regimes")
    if not returns:
        trades = raw.get("trades", []) or []
        returns = [
            float(t["profit_ratio"])
            for t in trades
            if isinstance(t, dict) and _as_number(t.get("profit_ratio")) is not None
        ]
        trade_regimes = [
            str(t.get("entry_regime") or t.get("regime") or "unknown")
            for t in trades
            if isinstance(t, dict) and _as_number(t.get("profit_ratio")) is not None
        ]
        regimes = trade_regimes if len(trade_regimes) == len(returns) and returns else None
    else:
        returns = [float(x) for x in returns]

    if isinstance(regimes, list) and len(regimes) == len(returns):
        return returns, [str(r or "unknown") for r in regimes]
    return returns, None


def _as_number(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _run_monte_carlo(
    trade_returns: list[float],
    n_simulations: int = DEFAULT_N_SIMULATIONS,
    seed: int = 42,
    method: str = "block_bootstrap",
    block_size: Optional[int] = None,
    trade_regimes: list[str] | None = None,
) -> MonteCarloResult:
    """
    Core Monte Carlo simulation:
    Shuffle trade return sequence n times, compute MDD for each.
    """
    result = MonteCarloResult(
        n_simulations=n_simulations,
        n_trades=len(trade_returns),
        simulation_method=method,
        block_size=block_size,
        regime_counts=_regime_counts(trade_regimes),
    )

    if len(trade_returns) < 5:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = f"Insufficient trades ({len(trade_returns)}), need >= 5"
        return result

    if method not in {"block_bootstrap", "regime_block_bootstrap", "iid_shuffle"}:
        raise ValueError(f"Unsupported Monte Carlo method: {method}")

    if method == "regime_block_bootstrap":
        if not trade_regimes or len(trade_regimes) != len(trade_returns):
            raise ValueError("trade_regimes must match trade_returns for regime_block_bootstrap")
        result.block_size = block_size or _default_block_size(len(trade_returns))
    elif method == "block_bootstrap":
        result.block_size = block_size or _default_block_size(len(trade_returns))
    else:
        result.block_size = None

    # Historical MDD (actual order)
    result.historical_mdd = _compute_mdd(trade_returns)

    # Monte Carlo: shuffle and compute MDD for each permutation
    rng = random.Random(seed)
    mdds = []

    for _ in range(n_simulations):
        if method == "regime_block_bootstrap":
            path = _sample_regime_block_bootstrap_path(
                trade_returns,
                trade_regimes or [],
                rng=rng,
                block_size=result.block_size or 1,
            )
        elif method == "block_bootstrap":
            path = _sample_block_bootstrap_path(
                trade_returns,
                rng=rng,
                block_size=result.block_size or 1,
            )
        else:
            path = trade_returns.copy()
            rng.shuffle(path)
        mdds.append(_compute_mdd(path))

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
    method: str | None = None,
    block_size: int | None = None,
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
    if httpx is None:
        return {"error": "httpx not installed", "status": "failed"}

    async with httpx.AsyncClient() as client:
        # ── Step 1: Fetch trade returns ──
        trade_returns: list[float] = []
        trade_regimes: list[str] | None = None

        data_quality_info: dict = {}

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

            logger.info(f"[MonteCarlo] Found {len(orders)} orders, validating + pairing...")
            pairing = _validate_and_pair_orders(orders)

            # Reject if data is too dirty
            if pairing.data_quality == "DIRTY":
                return {
                    "error": "Paper orders data too dirty for reliable Monte Carlo",
                    "status": "failed",
                    "data_quality": pairing.data_quality,
                    "detail": pairing.quality_detail,
                    "orphan_sells": pairing.orphan_sells,
                    "excess_shares": pairing.excess_shares,
                    "dirty_symbols": pairing.dirty_symbols[:20],
                }

            trade_returns = [t["profit_ratio"] for t in pairing.trades]
            data_quality_info = {
                "data_quality": pairing.data_quality,
                "total_orders": pairing.total_orders,
                "paired_trades": pairing.paired_trades,
                "orphan_sells": pairing.orphan_sells,
                "excess_shares": pairing.excess_shares,
                "open_positions": pairing.open_positions,
                "dirty_symbols": pairing.dirty_symbols[:10],
                "quality_detail": pairing.quality_detail,
            }

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
            trade_returns, trade_regimes = _extract_backtest_returns_and_regimes(raw)

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
        simulation_method = method or os.environ.get("MONTE_CARLO_METHOD", "").strip()
        if not simulation_method:
            simulation_method = "regime_block_bootstrap" if trade_regimes else "block_bootstrap"
        mc = _run_monte_carlo(
            trade_returns,
            n_simulations,
            method=simulation_method,
            block_size=block_size,
            trade_regimes=trade_regimes,
        )

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
            "n_trades": len(trade_returns),
            "simulation_method": mc.simulation_method,
            "block_size": mc.block_size,
            "regime_counts": mc.regime_counts,
            "data_quality": data_quality_info or None,
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
            "simulation_method": mc.simulation_method,
            "block_size": mc.block_size,
            "regime_counts": mc.regime_counts,
            "data_quality": data_quality_info or None,
        }
        logger.info(f"[MonteCarlo] Done: {mc.go_live_verdict} — 95th MDD = {mc.mdd_95th:.2%}")
        return summary
