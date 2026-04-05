"""
pbo_service.py — Probability of Backtest Overfitting (PBO)

Combinatorial Purged Cross-Validation (CPCV):
  1. Split time-series trade returns into S partitions (default 10)
  2. For each combination of C(S, S/2) train/test splits:
     - Train set: S/2 partitions → compute strategy performance
     - Test set: remaining S/2 → compute OOS performance
     - Purge: remove trades near partition boundaries to prevent leakage
  3. PBO = fraction of combinations where OOS return < 0
  4. PBO < 0.5 → alpha credible. PBO > 0.5 → likely curve-fitting

Data source: backtest trades (from backtest_results) or paper_orders
"""
import json
import logging
import math
import os
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import combinations
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# ── D1 API Config ─────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "")
CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID", "")
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "")

D1_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
    f"/d1/database/{CF_D1_DB_ID}/query"
)

# ── PBO Parameters ────────────────────────────────────────────────────────────
DEFAULT_N_PARTITIONS = 10       # S: number of time partitions
PURGE_DAYS = 5                  # days to purge at partition boundaries


@dataclass
class PBOResult:
    n_partitions: int = 0
    n_combinations: int = 0     # C(S, S/2) total combinations evaluated
    n_trades: int = 0
    pbo: float = 0.0            # Probability of Backtest Overfitting (0~1)
    n_oos_negative: int = 0     # combinations where OOS return < 0
    oos_mean_return: float = 0.0
    oos_median_return: float = 0.0
    is_mean_return: float = 0.0   # in-sample mean return
    degradation: float = 0.0    # IS return - OOS return (overfitting gap)
    go_live_verdict: str = ""   # "PASS" / "FAIL"
    verdict_reason: str = ""
    sampled: bool = False       # True if combinations were randomly sampled
    partition_details: list = field(default_factory=list)


async def _d1_query(client: httpx.AsyncClient, sql: str, params: list = None) -> list[dict]:
    """Execute a D1 SQL query via REST API."""
    if not CF_API_TOKEN:
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
        D1_API, json=body,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        timeout=30.0,
    )
    return resp.status_code == 200 and resp.json().get("success", False)


def _date_diff_days(date1: str, date2: str) -> int:
    """Calendar day difference between two YYYY-MM-DD strings."""
    try:
        d1 = datetime.strptime(date1[:10], "%Y-%m-%d")
        d2 = datetime.strptime(date2[:10], "%Y-%m-%d")
        return (d1 - d2).days
    except (ValueError, TypeError):
        return 999  # treat parse errors as far apart (no purge)


def _partition_trades(trades: list[dict], n_partitions: int) -> list[list[dict]]:
    """Split trades into n roughly equal time-ordered partitions."""
    # Sort by exit_date (or entry_date)
    sorted_trades = sorted(trades, key=lambda t: t.get("exit_date", t.get("entry_date", "")))
    chunk_size = max(1, len(sorted_trades) // n_partitions)

    partitions = []
    for i in range(n_partitions):
        start = i * chunk_size
        end = start + chunk_size if i < n_partitions - 1 else len(sorted_trades)
        partitions.append(sorted_trades[start:end])

    # Remove empty partitions
    return [p for p in partitions if p]


def _compute_partition_return(trades: list[dict]) -> float:
    """Compute total return for a set of trades (multiplicative)."""
    if not trades:
        return 0.0
    equity = 1.0
    for t in trades:
        equity *= (1 + t["profit_ratio"])
    return equity - 1.0  # total return as fraction


def _run_cpcv(
    trades: list[dict],
    n_partitions: int = DEFAULT_N_PARTITIONS,
) -> PBOResult:
    """
    Combinatorial Purged Cross-Validation.

    For each combination of S/2 partitions as train set:
      - IS return = return on train partitions
      - OOS return = return on remaining test partitions
      - PBO = fraction where OOS < 0
    """
    result = PBOResult(n_partitions=n_partitions, n_trades=len(trades))

    # Check time spread: if all trades share same date, partitioning is meaningless
    unique_dates = len(set(t.get("exit_date", "")[:10] for t in trades))
    if unique_dates < n_partitions:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = (
            f"Only {unique_dates} unique trade dates for {n_partitions} partitions. "
            f"Time-based partitioning is meaningless."
        )
        return result

    if len(trades) < n_partitions * 3:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = (
            f"Insufficient trades ({len(trades)}) for {n_partitions} partitions. "
            f"Need >= {n_partitions * 3}."
        )
        return result

    partitions = _partition_trades(trades, n_partitions)
    actual_n = len(partitions)

    if actual_n < 4:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = f"Only {actual_n} non-empty partitions, need >= 4"
        return result

    half = actual_n // 2
    partition_indices = list(range(actual_n))

    # Limit combinations — C(10,5)=252, C(16,8)=12870 OK, C(18,9)=48620+ gets sampled
    all_combos = list(combinations(partition_indices, half))
    sampled = False
    MAX_COMBOS = 15_000
    if len(all_combos) > MAX_COMBOS:
        original_count = len(all_combos)
        import random
        rng = random.Random(42)
        all_combos = rng.sample(all_combos, MAX_COMBOS)
        sampled = True
        logger.warning(f"[PBO] {original_count} combinations → sampled {MAX_COMBOS}")
    result.sampled = sampled
    result.n_combinations = len(all_combos)

    is_returns = []
    oos_returns = []

    # Pre-compute partition boundary dates for purging
    boundary_dates: list[str] = []
    for i in range(len(partitions) - 1):
        last_date = partitions[i][-1].get("exit_date", "")[:10] if partitions[i] else ""
        if last_date:
            boundary_dates.append(last_date)

    def _purge_boundary_trades(trades_list: list[dict], adjacent_indices: set[int]) -> list[dict]:
        """Remove trades within PURGE_DAYS of partition boundaries adjacent to the other set."""
        if not boundary_dates:
            return trades_list
        purge_boundaries = set()
        for idx in adjacent_indices:
            if 0 <= idx < len(boundary_dates):
                purge_boundaries.add(boundary_dates[idx])
            if 0 <= idx - 1 < len(boundary_dates):
                purge_boundaries.add(boundary_dates[idx - 1])
        if not purge_boundaries:
            return trades_list
        purged = []
        for t in trades_list:
            t_date = t.get("exit_date", t.get("entry_date", ""))[:10]
            too_close = False
            for bd in purge_boundaries:
                if abs(_date_diff_days(t_date, bd)) <= PURGE_DAYS:
                    too_close = True
                    break
            if not too_close:
                purged.append(t)
        return purged

    for train_indices in all_combos:
        test_indices = [i for i in partition_indices if i not in train_indices]

        # Collect trades for train and test
        train_trades = []
        for i in train_indices:
            train_trades.extend(partitions[i])

        test_trades = []
        for i in test_indices:
            test_trades.extend(partitions[i])

        # Purge trades near train/test boundaries to prevent leakage
        train_set = set(train_indices)
        test_set = set(test_indices)
        adjacent = {i for i in train_set if (i - 1) in test_set or (i + 1) in test_set}
        test_trades = _purge_boundary_trades(test_trades, adjacent)

        is_ret = _compute_partition_return(train_trades)
        # If purge removed all test trades, skip this combination (don't bias PBO)
        if not test_trades:
            continue
        oos_ret = _compute_partition_return(test_trades)

        is_returns.append(is_ret)
        oos_returns.append(oos_ret)

    # PBO = fraction of combos where OOS return < 0
    # n_combinations reflects actual evaluated (some may be skipped due to purge)
    result.n_combinations = len(oos_returns)
    result.n_oos_negative = sum(1 for r in oos_returns if r < 0)
    result.pbo = result.n_oos_negative / len(oos_returns) if oos_returns else 1.0

    result.oos_mean_return = statistics.mean(oos_returns) if oos_returns else 0.0
    result.oos_median_return = statistics.median(oos_returns) if oos_returns else 0.0
    result.is_mean_return = statistics.mean(is_returns) if is_returns else 0.0
    result.degradation = result.is_mean_return - result.oos_mean_return

    # Partition details for debugging
    result.partition_details = [
        {"partition": i, "n_trades": len(p), "return": round(_compute_partition_return(p), 4)}
        for i, p in enumerate(partitions)
    ]

    # Go-live verdict
    if result.pbo < 0.50:
        result.go_live_verdict = "PASS"
        result.verdict_reason = (
            f"PBO = {result.pbo:.1%} < 50%. Alpha is credible. "
            f"OOS mean return = {result.oos_mean_return:.2%}, "
            f"degradation = {result.degradation:.2%}."
        )
    else:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = (
            f"PBO = {result.pbo:.1%} >= 50%. Strategy likely curve-fitting. "
            f"{result.n_oos_negative}/{len(oos_returns)} combinations lose money OOS. "
            f"Degradation IS→OOS = {result.degradation:.2%}."
        )

    return result


async def run_pbo_analysis(
    n_partitions: int = DEFAULT_N_PARTITIONS,
    source: str = "backtest",
) -> dict:
    """
    Full PBO pipeline:
    1. Fetch trade data
    2. Run CPCV
    3. Write results to D1
    """
    if not CF_API_TOKEN:
        return {"error": "CF_API_TOKEN not set", "status": "failed"}

    async with httpx.AsyncClient() as client:
        # ── Step 1: Fetch trade data ──
        trades: list[dict] = []
        trades_truncated = False

        if source == "backtest":
            logger.info("[PBO] Fetching backtest trades from D1...")
            row = await _d1_query(
                client,
                """SELECT raw_results FROM backtest_results
                   ORDER BY run_date DESC, created_at DESC LIMIT 1""",
            )
            if not row or not row[0].get("raw_results"):
                return {"error": "No backtest results found", "status": "failed"}

            raw = json.loads(row[0]["raw_results"])
            trades = raw.get("trades", [])

            if not trades:
                return {"error": "No trade details in backtest results", "status": "failed"}

            # Warn if trades were truncated (backtest stores max 500)
            total_from_summary = raw.get("summary", {}).get("total_trades", 0)
            if total_from_summary > len(trades):
                trades_truncated = True
                logger.warning(
                    f"[PBO] Trades truncated: {len(trades)}/{total_from_summary}. "
                    f"PBO accuracy may be reduced."
                )

        elif source == "paper":
            logger.info("[PBO] Fetching paper_orders from D1...")
            orders = await _d1_query(
                client,
                """SELECT symbol, side, shares, price, note, created_at
                   FROM paper_orders WHERE account_id = 1
                   ORDER BY created_at ASC""",
            )
            if not orders:
                return {"error": "No paper orders found", "status": "failed"}

            # Reuse FIFO pairing from monte_carlo_service
            from services.monte_carlo_service import _validate_and_pair_orders
            pairing = _validate_and_pair_orders(orders)
            if pairing.data_quality == "DIRTY":
                return {
                    "error": "Paper orders data too dirty",
                    "status": "failed",
                    "data_quality": pairing.data_quality,
                }
            trades = pairing.trades

        else:
            return {"error": f"Unknown source: {source}", "status": "failed"}

        if len(trades) < n_partitions * 3:
            return {
                "error": f"Only {len(trades)} trades, need >= {n_partitions * 3} for {n_partitions} partitions",
                "status": "failed",
            }

        # ── Step 2: Run CPCV ──
        logger.info(f"[PBO] {len(trades)} trades, {n_partitions} partitions...")
        pbo = _run_cpcv(trades, n_partitions)

        # ── Step 3: Write to D1 ──
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        raw_json = json.dumps({
            "partition_details": pbo.partition_details,
            "n_combinations": pbo.n_combinations,
            "oos_mean_return": pbo.oos_mean_return,
            "is_mean_return": pbo.is_mean_return,
            "source": source,
        }, ensure_ascii=False)

        success = await _d1_exec(
            client,
            """INSERT OR REPLACE INTO pbo_results
               (run_date, source, n_partitions, n_combinations, n_trades,
                pbo, n_oos_negative, oos_mean_return, is_mean_return, degradation,
                go_live_verdict, verdict_reason, raw_details)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                today, source, pbo.n_partitions, pbo.n_combinations, pbo.n_trades,
                pbo.pbo, pbo.n_oos_negative, pbo.oos_mean_return, pbo.is_mean_return,
                pbo.degradation, pbo.go_live_verdict, pbo.verdict_reason,
                raw_json[:50000],
            ],
        )

        summary = {
            "status": "success" if success else "d1_write_failed",
            "run_date": today,
            "source": source,
            "n_partitions": pbo.n_partitions,
            "n_combinations": pbo.n_combinations,
            "n_trades": pbo.n_trades,
            "pbo": round(pbo.pbo, 4),
            "n_oos_negative": pbo.n_oos_negative,
            "oos_mean_return": f"{pbo.oos_mean_return:.2%}",
            "is_mean_return": f"{pbo.is_mean_return:.2%}",
            "degradation": f"{pbo.degradation:.2%}",
            "go_live_verdict": pbo.go_live_verdict,
            "verdict_reason": pbo.verdict_reason,
            "trades_truncated": trades_truncated,
            "sampled": pbo.sampled,
        }
        logger.info(f"[PBO] Done: {pbo.go_live_verdict} — PBO = {pbo.pbo:.1%}")
        return summary
