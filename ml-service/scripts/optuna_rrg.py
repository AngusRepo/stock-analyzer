#!/usr/bin/env python3
"""
optuna_rrg.py — P2#19 RRG Full Parameter Grid Search

Search 125 combinations: rsWindow[10-30] x emaSpan[5-15] x momLookback[5-15]
Evaluate: Leading quadrant stocks 5-day excess return
Plateau detection: neighbor |delta| < 0.5% = robust zone → take center
"""
import optuna
import numpy as np
import json
import logging

optuna.logging.set_verbosity(optuna.logging.WARNING)
logger = logging.getLogger(__name__)

N_TRIALS = 125


def objective(trial, prices_by_stock: dict, benchmark_returns: list[float]):
    """Evaluate RRG params: Leading quadrant stocks' 5d excess return."""
    rs_window = trial.suggest_int("rs_window", 10, 30, step=5)
    ema_span = trial.suggest_int("ema_span", 5, 15, step=5)
    mom_lookback = trial.suggest_int("mom_lookback", 5, 15, step=5)

    excess_returns = []
    for symbol, closes in prices_by_stock.items():
        if len(closes) < rs_window + ema_span + 10:
            continue

        closes = np.array(closes, dtype=float)
        # Relative strength vs benchmark
        bench = np.array(benchmark_returns[:len(closes)], dtype=float)
        if len(bench) < len(closes):
            continue

        rs = closes / bench
        # EMA of RS
        alpha = 2.0 / (ema_span + 1)
        ema = np.zeros_like(rs)
        ema[0] = rs[0]
        for i in range(1, len(rs)):
            ema[i] = alpha * rs[i] + (1 - alpha) * ema[i - 1]

        # RS-Ratio (normalized EMA) and RS-Momentum
        ema_mean = np.mean(ema[:rs_window])
        if ema_mean <= 0:
            continue  # skip stock with invalid EMA
        rs_ratio = ema / ema_mean * 100
        rs_mom = np.zeros_like(rs_ratio)
        for i in range(mom_lookback, len(rs_ratio)):
            rs_mom[i] = rs_ratio[i] - rs_ratio[i - mom_lookback]

        # Check if stock is in "Leading" quadrant at latest bar
        # Leading: rs_ratio > 100 AND rs_mom > 0
        if len(rs_ratio) > 5 and rs_ratio[-6] > 100 and rs_mom[-6] > 0:
            # 5-day forward return
            fwd_return = (closes[-1] - closes[-6]) / closes[-6]
            bench_return = (bench[-1] - bench[-6]) / bench[-6] if len(bench) > 5 else 0
            excess_returns.append(fwd_return - bench_return)

    if not excess_returns:
        return 0.0

    return float(np.mean(excess_returns))


def search_rrg_params(prices_by_stock: dict, benchmark_returns: list[float]) -> dict:
    """Run Optuna search for RRG parameters."""
    study = optuna.create_study(direction="maximize")
    study.optimize(
        lambda trial: objective(trial, prices_by_stock, benchmark_returns),
        n_trials=N_TRIALS,
        show_progress_bar=False,
    )

    best = study.best_params
    best_value = study.best_value

    # Plateau detection: find neighbors within 0.5% of best
    all_trials = [(t.params, t.value) for t in study.trials if t.value is not None]
    plateau = [p for p, v in all_trials if abs(v - best_value) < 0.005]

    # Take center of plateau
    if plateau:
        center = {
            "rs_window": int(np.median([p["rs_window"] for p in plateau])),
            "ema_span": int(np.median([p["ema_span"] for p in plateau])),
            "mom_lookback": int(np.median([p["mom_lookback"] for p in plateau])),
        }
    else:
        center = best

    return {
        "best_params": best,
        "best_excess_return": round(best_value, 4),
        "plateau_center": center,
        "plateau_size": len(plateau),
        "total_trials": N_TRIALS,
    }
