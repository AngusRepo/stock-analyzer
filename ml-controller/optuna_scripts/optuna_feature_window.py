#!/usr/bin/env python3
"""
optuna_feature_window.py — P2#27 Feature Window Optuna

Search: volatility[3-10, 10-30] x vol_ratio[3-10, 10-30] x MA_bias[10-30, 40-80]
Also: return windows [1,3,5,10,20]
Objective: Highest IC (Spearman correlation with 5d forward return)
"""
import optuna
import numpy as np
from scipy import stats
import logging

optuna.logging.set_verbosity(optuna.logging.WARNING)
logger = logging.getLogger(__name__)

N_TRIALS = 80


def objective(trial, closes: np.ndarray, volumes: np.ndarray):
    """Evaluate feature windows by IC with forward return."""
    # Window params
    vol_short = trial.suggest_int("volatility_short", 3, 10)
    vol_long = trial.suggest_int("volatility_long", 10, 30)
    vr_short = trial.suggest_int("vol_ratio_short", 3, 10)
    vr_long = trial.suggest_int("vol_ratio_long", 10, 30)
    ma_short = trial.suggest_int("ma_bias_short", 10, 30)
    ma_long = trial.suggest_int("ma_bias_long", 40, 80)
    ret_window = trial.suggest_categorical("return_window", [1, 3, 5, 10, 20])

    n = len(closes)
    if n < ma_long + ret_window + 10:
        return 0.0

    # Compute features with searched windows
    returns = np.diff(np.log(closes))
    vol_s = np.array([np.std(returns[max(0, i - vol_short):i]) for i in range(vol_short, n)])
    vol_l = np.array([np.std(returns[max(0, i - vol_long):i]) for i in range(vol_long, n)])

    # Volume ratio
    vr = np.array([
        np.mean(volumes[max(0, i - vr_short):i]) / max(np.mean(volumes[max(0, i - vr_long):i]), 1)
        for i in range(vr_long, n)
    ])

    # MA bias
    ma_s = np.array([np.mean(closes[max(0, i - ma_short):i]) for i in range(ma_short, n)])
    ma_l = np.array([np.mean(closes[max(0, i - ma_long):i]) for i in range(ma_long, n)])

    # Align lengths
    min_len = min(len(vol_s), len(vol_l), len(vr), len(ma_s), len(ma_l))
    if min_len < 50:
        return 0.0

    vol_s = vol_s[-min_len:]
    vol_l = vol_l[-min_len:]
    vr = vr[-min_len:]
    ma_bias = (closes[-min_len:] - ma_l[-min_len:]) / np.maximum(ma_l[-min_len:], 0.01)

    # Forward return (target)
    fwd = np.array([
        (closes[min(i + ret_window, n - 1)] - closes[i]) / closes[i]
        for i in range(n - min_len, n)
    ])

    # IC: Spearman correlation of each feature with forward return
    ics = []
    for feat in [vol_s, vol_l, vr, ma_bias]:
        if len(feat) == len(fwd) and len(feat) > 30:
            ic, _ = stats.spearmanr(feat[-len(fwd):], fwd)
            if not np.isnan(ic):
                ics.append(abs(ic))

    return float(np.mean(ics)) if ics else 0.0


def search_feature_windows(closes: list[float], volumes: list[float]) -> dict:
    """Run Optuna search for optimal feature window sizes."""
    closes_arr = np.array(closes, dtype=float)
    volumes_arr = np.array(volumes, dtype=float)

    study = optuna.create_study(direction="maximize")
    study.optimize(
        lambda trial: objective(trial, closes_arr, volumes_arr),
        n_trials=N_TRIALS,
        show_progress_bar=False,
    )

    return {
        "best_params": study.best_params,
        "best_mean_ic": round(study.best_value, 6),
        "total_trials": N_TRIALS,
    }
