"""
profile_replay.py — Sprint 6a.8 profile helper

從 D1 拉 subset=250 + 90 day window，對 `replay_period` 跑 cProfile + wall-clock
per-section timing，找 hot spot。

Usage:
  cd ml-controller
  source .venv/Scripts/activate
  python scripts/profile_replay.py

Output:
  - Top 30 function by cumulative time (cProfile)
  - Per-section wall-clock: dataset load / per-day loop breakdown
  - Scaling projection: 250 → 2288 stocks for Sprint 5.2
"""
from __future__ import annotations

import cProfile
import io
import logging
import pstats
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from services.backtest_engine import (  # noqa: E402
    BacktestDataset,
    replay_period,
    replay_screener_for_date,
    simulate_entries_for_date,
    step_all_positions,
    _mark_to_market,
    ScreenerParams,
    RankingParams,
    PositionSizeParams,
    SLTPParams,
    ExitParams,
    FeeParams,
    AccountState,
)
from services.stratified_subset import select_stratified_subset  # noqa: E402

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(message)s")


def _default_params() -> dict:
    return {
        "sltp": {
            "slMultBase": 1.75, "tpMultBase": 2.5,
            "slMultLow": 0.75, "tpMultLow": 0.95,
            "slMultHigh": 1.15, "tpMultHigh": 1.5,
            "volThresholdLow": 0.015, "volThresholdHigh": 0.03,
            "volSkipThreshold": 0.005,
            "trailSwitch3pct": 0.02, "trailSwitch8pct": 0.12,
        },
        "exit": {
            "trailMultDefault": 3.25, "trailMultAt3pct": 1.5, "trailMultAt8pct": 1.25,
            "tp1SellRatio": 0.7, "timeStopDays": 15, "hardStopPct": -0.08,
        },
    }


def instrumented_replay(dataset: BacktestDataset, start_date: str, end_date: str, params: dict):
    """Replay with per-section wall-clock timers."""
    screener_p = ScreenerParams.from_trading_config(params)
    ranking_p = RankingParams.from_trading_config(params)
    pos_p = PositionSizeParams.from_trading_config(params)
    sltp_p = SLTPParams.from_trading_config(params)
    exit_p = ExitParams.from_trading_config(params)
    fees_p = FeeParams.from_trading_config(params)

    replay_days = [d for d in dataset.trading_days if start_date <= d <= end_date]

    account = AccountState(cash=1_000_000, initial_capital=1_000_000)

    timings = {
        "step_all_positions": 0.0,
        "simulate_entries": 0.0,
        "mark_to_market": 0.0,
        "screener": 0.0,
    }
    counters = {
        "screener_calls": 0,
        "screener_candidates": 0,
        "entry_attempts": 0,
        "exits": 0,
    }

    prev_decision_date = None
    prev_candidates = []

    for i, day in enumerate(replay_days):
        t0 = time.perf_counter()
        trades_today = step_all_positions(account, dataset, day, exit_p, fees_p)
        timings["step_all_positions"] += time.perf_counter() - t0
        counters["exits"] += len(trades_today)

        if prev_candidates and prev_decision_date:
            t0 = time.perf_counter()
            attempts = simulate_entries_for_date(
                dataset=dataset,
                decision_date=prev_decision_date,
                entry_date=day,
                candidates=prev_candidates,
                account=account,
                pos=pos_p,
                sltp=sltp_p,
                fees=fees_p,
            )
            timings["simulate_entries"] += time.perf_counter() - t0
            counters["entry_attempts"] += len(attempts)

        t0 = time.perf_counter()
        _mark_to_market(account, dataset, day)
        timings["mark_to_market"] += time.perf_counter() - t0

        if i < len(replay_days) - 1:
            t0 = time.perf_counter()
            prev_candidates = replay_screener_for_date(
                dataset=dataset, date=day, screener=screener_p, ranking=ranking_p,
            )
            timings["screener"] += time.perf_counter() - t0
            counters["screener_calls"] += 1
            counters["screener_candidates"] += len(prev_candidates)
            prev_decision_date = day

    return timings, counters, len(replay_days)


def main():
    # Date window: 90 days ending today TW
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    end_date = tw_now.date().isoformat()
    start_date = (datetime.fromisoformat(end_date) - timedelta(days=90)).date().isoformat()

    print(f"\n{'=' * 60}")
    print(f"Sprint 6a.8 profile: subset=250, {start_date} ~ {end_date}")
    print(f"{'=' * 60}\n")

    # ── Step 1: Stratified subset ──────────────────────────────────────────
    t0 = time.perf_counter()
    symbols = select_stratified_subset(target_size=250, end_date=end_date, lookback_days=30)
    t_subset = time.perf_counter() - t0
    print(f"[1/4] stratified_subset: {len(symbols)} symbols in {t_subset:.2f}s")

    # ── Step 2: Dataset load ───────────────────────────────────────────────
    t0 = time.perf_counter()
    dataset = BacktestDataset.load_from_d1(start_date=start_date, end_date=end_date, symbols=symbols)
    t_load = time.perf_counter() - t0
    print(f"[2/4] BacktestDataset.load_from_d1: {t_load:.2f}s")
    print(f"      prices: {len(dataset.prices)} rows")
    print(f"      indicators: {len(dataset.indicators)} rows")
    print(f"      chips: {len(dataset.chips)} rows")
    print(f"      trading_days: {len(dataset.trading_days)}")

    params = _default_params()

    # ── Step 3: Instrumented replay (wall-clock per section) ───────────────
    print(f"\n[3/4] Instrumented replay (per-section timing)...")
    t0 = time.perf_counter()
    timings, counters, n_days = instrumented_replay(dataset, start_date, end_date, params)
    t_instrumented = time.perf_counter() - t0

    print(f"      Total wall-clock: {t_instrumented:.2f}s over {n_days} days")
    print(f"      Per-day average:  {t_instrumented / n_days * 1000:.1f}ms\n")

    total_inner = sum(timings.values())
    print(f"      Section breakdown (of {total_inner:.2f}s inner loop):")
    for section, t in sorted(timings.items(), key=lambda x: -x[1]):
        pct = (t / total_inner * 100) if total_inner else 0
        per_day_ms = t / n_days * 1000
        print(f"        {section:20s}: {t:6.2f}s ({pct:5.1f}%)  {per_day_ms:6.1f}ms/day")

    print(f"\n      Counters:")
    for k, v in counters.items():
        print(f"        {k}: {v}")

    avg_candidates = counters["screener_candidates"] / max(1, counters["screener_calls"])
    print(f"        avg candidates per screener call: {avg_candidates:.1f}")

    # ── Step 4: cProfile full replay ───────────────────────────────────────
    print(f"\n[4/4] cProfile full replay_period (top 30 by cumulative)...")
    pr = cProfile.Profile()
    pr.enable()
    replay_period(dataset, start_date, end_date, params, mode="A", verbose=False)
    pr.disable()

    s = io.StringIO()
    ps = pstats.Stats(pr, stream=s).sort_stats("cumulative")
    ps.print_stats(30)
    print(s.getvalue())

    # ── Scaling projection for Sprint 5.2 full universe ───────────────────
    print(f"\n{'=' * 60}")
    print(f"Sprint 5.2 scaling projection (250 → 2288 full universe)")
    print(f"{'=' * 60}")
    scale = 2288 / 250
    print(f"  scale factor: {scale:.2f}×")
    print(f"  Screener scales ~linearly with universe size")
    print(f"  Est. per-trial:  {t_instrumented * scale:.1f}s")
    print(f"  Est. 100 trials: {t_instrumented * scale * 100 / 60:.1f} min")
    print(f"  Est. 200 trials: {t_instrumented * scale * 200 / 60:.1f} min")


if __name__ == "__main__":
    main()
