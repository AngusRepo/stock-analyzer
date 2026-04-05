#!/usr/bin/env python3
"""
optuna_conformal.py — P2#24 Conformal Prediction Auto-Calibration

Search: coverage[0.80-0.95] x min_calibration_size[15-30] x max_residuals[300-700]
Objective: minimize gap between calibrated_confidence and actual accuracy
"""
import optuna
import numpy as np
import logging

optuna.logging.set_verbosity(optuna.logging.WARNING)
logger = logging.getLogger(__name__)

N_TRIALS = 50


def objective(trial, confidences: list[float], actuals: list[int]):
    """Find conformal params that make confidence = actual accuracy."""
    coverage = trial.suggest_float("coverage", 0.80, 0.95)
    min_cal_size = trial.suggest_int("min_calibration_size", 15, 30)
    max_residuals = trial.suggest_int("max_residuals", 300, 700, step=50)

    if len(confidences) < min_cal_size:
        return 1.0  # worst possible

    # Calibrate: use first max_residuals as calibration set
    cal_size = min(max_residuals, len(confidences) - min_cal_size)
    cal_conf = np.array(confidences[:cal_size])
    cal_actual = np.array(actuals[:cal_size])

    # Compute nonconformity scores
    scores = np.abs(cal_conf - cal_actual)
    threshold = np.quantile(scores, coverage)

    # Apply to remaining (test set)
    test_conf = np.array(confidences[cal_size:])
    test_actual = np.array(actuals[cal_size:])

    if len(test_conf) < 10:
        return 1.0

    # Calibrated confidence: clamp within threshold
    calibrated = np.clip(test_conf, test_conf - threshold, test_conf + threshold)
    calibrated = np.clip(calibrated, 0, 1)

    # Gap: |calibrated_confidence - actual_accuracy|
    # Group into bins and measure calibration error (ECE)
    n_bins = 5
    bin_edges = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        mask = (calibrated >= bin_edges[i]) & (calibrated < bin_edges[i + 1])
        if mask.sum() == 0:
            continue
        bin_conf = calibrated[mask].mean()
        bin_acc = test_actual[mask].mean()
        ece += mask.sum() / len(calibrated) * abs(bin_conf - bin_acc)

    return float(ece)


def search_conformal_params(confidences: list[float], actuals: list[int]) -> dict:
    """Run Optuna search for conformal calibration parameters."""
    study = optuna.create_study(direction="minimize")
    study.optimize(
        lambda trial: objective(trial, confidences, actuals),
        n_trials=N_TRIALS,
        show_progress_bar=False,
    )

    return {
        "best_params": study.best_params,
        "best_ece": round(study.best_value, 6),
        "total_trials": N_TRIALS,
    }
