"""
pbo_service.py — Probability of Backtest Overfitting (PBO)

Combinatorial Purged Cross-Validation (CPCV):
  1. Split time-series trade returns into S partitions (default 10)
  2. For each combination of C(S, S/2) train/test splits:
     - Train set: S/2 partitions → compute strategy performance
     - Test set: remaining S/2 → compute OOS performance
     - Purge: remove trades near partition boundaries to prevent leakage
  3. PBO = fraction of combinations where OOS return < 0
  4. PBO < 0.5 → alpha credible. PBO > 0.5 → possible curve-fitting

Data source: backtest trades (from backtest_results) or paper_orders
"""
from __future__ import annotations

import json
import logging
import math
import os
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import combinations
from typing import Optional

try:
    import httpx
except ModuleNotFoundError:  # keep pure PBO math unit-testable without HTTP deps
    httpx = None

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
DEFAULT_EMBARGO_DAYS = 5        # fallback when trade/label horizon is missing


@dataclass
class PBOResult:
    method: str = "cpcv_single_strategy_non_cscv"
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
    embargo_days: int = DEFAULT_EMBARGO_DAYS
    embargo_source: str = "default"
    partition_details: list = field(default_factory=list)
    logit_values: list[float] = field(default_factory=list)
    oos_rank_percentiles: list[float] = field(default_factory=list)
    selected_strategy_counts: dict[str, int] = field(default_factory=dict)


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


def _resolve_dynamic_embargo_days(
    trades: list[dict],
    *,
    requested_days: int | None = None,
) -> tuple[int, str]:
    if requested_days is not None and requested_days >= 0:
        return int(requested_days), "request"

    raw_env = os.environ.get("PBO_EMBARGO_DAYS", "").strip()
    if raw_env:
        try:
            parsed = int(raw_env)
            if parsed >= 0:
                return parsed, "env:PBO_EMBARGO_DAYS"
        except ValueError:
            logger.warning("[PBO] invalid PBO_EMBARGO_DAYS=%s; using dynamic fallback", raw_env)

    horizons: list[int] = []
    for trade in trades or []:
        for key in (
            "label_horizon_days",
            "barrier_horizon_days",
            "horizon_days",
            "holding_period_days",
        ):
            try:
                value = int(trade.get(key))
            except (TypeError, ValueError):
                continue
            if value > 0:
                horizons.append(value)
                break
    if horizons:
        # Embargo should cover the longest observed label/holding horizon but
        # stay bounded so CPCV does not degenerate on small samples.
        return min(max(horizons), 30), "trade_horizon"
    return DEFAULT_EMBARGO_DAYS, "default"


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


def _compound_return(returns: list[float]) -> float:
    equity = 1.0
    for ret in returns:
        equity *= 1.0 + float(ret)
    return equity - 1.0


def _rank_percentile(score: float, all_scores: list[float]) -> float:
    """Return Bailey-style relative rank percentile: worst ~= 0, best ~= 1."""
    sorted_scores = sorted(float(s) for s in all_scores)
    ranks = [i + 1 for i, candidate in enumerate(sorted_scores) if candidate == float(score)]
    if not ranks:
        return 0.0
    average_rank = sum(ranks) / len(ranks)
    return average_rank / (len(sorted_scores) + 1)


def _run_cscv_rank_logit_pbo(
    strategy_returns_by_partition: dict[str, list[float]],
) -> PBOResult:
    """
    Industry-grade CSCV rank-logit PBO core.

    For each train/test partition split, select the best in-sample strategy,
    rank that same strategy out-of-sample against all candidates, then count
    how often its logit-rank falls below zero.
    """
    cleaned = {
        name: [float(v) for v in values]
        for name, values in strategy_returns_by_partition.items()
        if isinstance(values, list) and values
    }
    result = PBOResult(method="cscv_rank_logit")
    if len(cleaned) < 2:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = "CSCV PBO requires at least 2 strategy candidates"
        return result

    n_partitions = len(next(iter(cleaned.values())))
    if n_partitions < 4 or any(len(values) != n_partitions for values in cleaned.values()):
        result.n_partitions = n_partitions
        result.go_live_verdict = "FAIL"
        result.verdict_reason = "CSCV PBO requires >=4 equal-length partition returns"
        return result

    result.n_partitions = n_partitions
    partition_indices = list(range(n_partitions))
    half = n_partitions // 2
    combos = list(combinations(partition_indices, half))
    result.n_combinations = len(combos)

    selected_is_returns: list[float] = []
    selected_oos_returns: list[float] = []
    selected_counts: dict[str, int] = {}
    logits: list[float] = []
    rank_percentiles: list[float] = []

    for train_indices in combos:
        test_indices = [i for i in partition_indices if i not in train_indices]
        is_scores = {
            name: _compound_return([values[i] for i in train_indices])
            for name, values in cleaned.items()
        }
        selected_name = max(is_scores, key=is_scores.get)
        oos_scores = {
            name: _compound_return([values[i] for i in test_indices])
            for name, values in cleaned.items()
        }
        omega = _rank_percentile(oos_scores[selected_name], list(oos_scores.values()))
        omega = min(max(omega, 1e-9), 1 - 1e-9)
        logits.append(math.log(omega / (1.0 - omega)))
        rank_percentiles.append(omega)
        selected_is_returns.append(is_scores[selected_name])
        selected_oos_returns.append(oos_scores[selected_name])
        selected_counts[selected_name] = selected_counts.get(selected_name, 0) + 1

    result.logit_values = [round(v, 6) for v in logits]
    result.oos_rank_percentiles = [round(v, 6) for v in rank_percentiles]
    result.selected_strategy_counts = selected_counts
    result.n_oos_negative = sum(1 for value in logits if value <= 0.0)
    result.pbo = result.n_oos_negative / len(logits) if logits else 1.0
    result.is_mean_return = statistics.mean(selected_is_returns) if selected_is_returns else 0.0
    result.oos_mean_return = statistics.mean(selected_oos_returns) if selected_oos_returns else 0.0
    result.oos_median_return = statistics.median(selected_oos_returns) if selected_oos_returns else 0.0
    result.degradation = result.is_mean_return - result.oos_mean_return

    if result.pbo < 0.50 and result.oos_mean_return > 0.0:
        result.go_live_verdict = "PASS"
        result.verdict_reason = (
            f"CSCV rank-logit PBO = {result.pbo:.1%} < 50%; "
            f"selected OOS mean return = {result.oos_mean_return:.2%}."
        )
    else:
        result.go_live_verdict = "FAIL"
        result.verdict_reason = (
            f"CSCV rank-logit PBO = {result.pbo:.1%}; "
            f"selected OOS mean return = {result.oos_mean_return:.2%}."
        )
    return result


def _extract_strategy_partition_returns(raw: dict) -> dict[str, list[float]]:
    candidates = raw.get("strategy_returns_by_partition") or raw.get("candidate_partition_returns")
    if isinstance(candidates, dict):
        return {
            str(name): [float(v) for v in values]
            for name, values in candidates.items()
            if isinstance(values, list)
        }
    if isinstance(candidates, list):
        extracted = {}
        for item in candidates:
            if not isinstance(item, dict):
                continue
            name = item.get("name") or item.get("strategy") or item.get("trial_id")
            values = item.get("partition_returns") or item.get("returns")
            if name is not None and isinstance(values, list):
                extracted[str(name)] = [float(v) for v in values]
        return extracted
    return {}


def _run_cpcv(
    trades: list[dict],
    n_partitions: int = DEFAULT_N_PARTITIONS,
    embargo_days: int | None = None,
) -> PBOResult:
    """
    Combinatorial Purged Cross-Validation.

    For each combination of S/2 partitions as train set:
      - IS return = return on train partitions
      - OOS return = return on remaining test partitions
      - PBO = fraction where OOS < 0
    """
    resolved_embargo_days, embargo_source = _resolve_dynamic_embargo_days(
        trades,
        requested_days=embargo_days,
    )
    result = PBOResult(
        n_partitions=n_partitions,
        n_trades=len(trades),
        embargo_days=resolved_embargo_days,
        embargo_source=embargo_source,
    )

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
        """Remove trades within dynamic embargo days near train/test boundaries."""
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
                if abs(_date_diff_days(t_date, bd)) <= resolved_embargo_days:
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
            f"PBO = {result.pbo:.1%} >= 50%. Strategy possible curve-fitting. "
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
    if httpx is None:
        return {"error": "httpx not installed", "status": "failed"}

    async with httpx.AsyncClient() as client:
        # ── Step 1: Fetch trade data ──
        trades: list[dict] = []
        trades_truncated = False
        strategy_partition_returns: dict[str, list[float]] = {}

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
            strategy_partition_returns = _extract_strategy_partition_returns(raw)
            trades = [] if strategy_partition_returns else raw.get("trades", [])

            if not trades and not strategy_partition_returns:
                return {"error": "No trade details in backtest results", "status": "failed"}

            # Warn if trades were truncated (backtest stores max 500)
            total_from_summary = raw.get("summary", {}).get("total_trades", 0)
            if trades and total_from_summary > len(trades):
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

        if strategy_partition_returns:
            logger.info(
                f"[PBO] Running CSCV rank-logit on {len(strategy_partition_returns)} candidates..."
            )
            pbo = _run_cscv_rank_logit_pbo(strategy_partition_returns)
        elif len(trades) < n_partitions * 3:
            return {
                "error": f"Only {len(trades)} trades, need >= {n_partitions * 3} for {n_partitions} partitions",
                "status": "failed",
            }

        # ── Step 2: Run CPCV ──
        if not strategy_partition_returns:
            logger.info(f"[PBO] {len(trades)} trades, {n_partitions} partitions...")
            pbo = _run_cpcv(trades, n_partitions)

        # ── Step 3: Write to D1 ──
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        raw_json = json.dumps({
            "method": pbo.method,
            "partition_details": pbo.partition_details,
            "n_combinations": pbo.n_combinations,
            "oos_mean_return": pbo.oos_mean_return,
            "is_mean_return": pbo.is_mean_return,
            "embargo_days": pbo.embargo_days,
            "embargo_source": pbo.embargo_source,
            "logit_values": pbo.logit_values,
            "oos_rank_percentiles": pbo.oos_rank_percentiles,
            "selected_strategy_counts": pbo.selected_strategy_counts,
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
            "method": pbo.method,
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
            "embargo_days": pbo.embargo_days,
            "embargo_source": pbo.embargo_source,
        }
        logger.info(f"[PBO] Done: {pbo.go_live_verdict} — PBO = {pbo.pbo:.1%}")
        return summary
