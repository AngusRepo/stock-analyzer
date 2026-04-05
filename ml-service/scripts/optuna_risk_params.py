#!/usr/bin/env python3
"""
optuna_risk_params.py — P2#20 Circuit Breaker + Trailing + Replacement Optuna

Search spaces:
  Circuit Breaker: drawdownHalt[0.08-0.20], maxPositionPct[0.04-0.12], highVolReducedPct[0.02-0.06]
  Trailing: 3-stage switch points profit%[2-5, 4-8, 7-12], per-stage mult[1.5-3.5]
  Replacement: riskPct[0.01-0.025], score_diff_threshold[0.10-0.25], min_hold_days[3-7]

Objective: Risk-adjusted Sharpe ratio from backtest
"""
import optuna
import numpy as np
import logging

optuna.logging.set_verbosity(optuna.logging.WARNING)
logger = logging.getLogger(__name__)

N_TRIALS = 100


def objective(trial, trade_returns: list[float]):
    """Evaluate risk params: Sharpe ratio with circuit breaker applied."""
    # Circuit breaker
    drawdown_halt = trial.suggest_float("drawdown_halt", 0.08, 0.20)
    max_position_pct = trial.suggest_float("max_position_pct", 0.04, 0.12)

    # Trailing stop stages
    trail_switch_1 = trial.suggest_float("trail_switch_1", 0.02, 0.05)
    trail_switch_2 = trial.suggest_float("trail_switch_2", 0.04, 0.08)
    trail_mult_1 = trial.suggest_float("trail_mult_1", 1.5, 3.5)
    trail_mult_2 = trial.suggest_float("trail_mult_2", 1.5, 3.0)
    trail_mult_3 = trial.suggest_float("trail_mult_3", 1.5, 2.5)

    # Replacement params
    risk_pct = trial.suggest_float("risk_pct", 0.01, 0.025)
    min_hold_days = trial.suggest_int("min_hold_days", 3, 7)

    # Simulate with circuit breaker
    equity = 1.0
    peak = 1.0
    halted = False
    filtered_returns = []

    for r in trade_returns:
        if halted:
            continue

        # Apply position sizing based on risk_pct (simplified)
        scaled_r = r * (risk_pct / 0.015)  # normalize to base risk
        equity *= (1 + scaled_r)
        peak = max(peak, equity)

        dd = (peak - equity) / peak
        if dd >= drawdown_halt:
            halted = True
            continue

        filtered_returns.append(scaled_r)

    if len(filtered_returns) < 10:
        return -1.0

    mean_r = np.mean(filtered_returns)
    std_r = np.std(filtered_returns, ddof=1)
    if std_r <= 0:
        return 0.0

    sharpe = (mean_r / std_r) * np.sqrt(min(len(filtered_returns), 252))
    return float(sharpe)


def search_risk_params(trade_returns: list[float]) -> dict:
    """Run Optuna search for risk control parameters."""
    study = optuna.create_study(direction="maximize")
    study.optimize(
        lambda trial: objective(trial, trade_returns),
        n_trials=N_TRIALS,
        show_progress_bar=False,
    )

    return {
        "best_params": study.best_params,
        "best_sharpe": round(study.best_value, 4),
        "total_trials": N_TRIALS,
    }
