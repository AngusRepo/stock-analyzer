"""
optuna_sltp.py — Sprint 5.1 version: L2/SLTP Optuna search via backtest_engine

搜尋空間（Sprint 3 P0-3 + Sprint 5.1 Phase 7 Layer B）:
  Base multipliers (ensemble.py):
    sl_mult                  [1.0, 3.0]   SL × ATR 倍數 baseline
    tp_mult                  [1.0, 3.0]   TP × ATR 倍數 baseline

  Phase 7 Layer B: per-vol-branch multipliers (原本 hardcode 0.75/0.67/1.25/1.33):
    slMultLow                [0.50, 1.00] 低波動 SL 相對 base
    tpMultLow                [0.50, 1.00] 低波動 TP 相對 base
    slMultHigh               [1.00, 1.50] 高波動 SL 相對 base
    tpMultHigh               [1.00, 1.50] 高波動 TP 相對 base

  Trailing (tradingConfig.ts exit):
    trailMultDefault         [2.0, 4.0]
    trailMultAt3pct          [1.5, 3.0]
    trailMultAt8pct          [1.0, 2.5]
    tp1SellRatio             [0.3, 0.7]
    timeStopDays             [10, 30]
    hardStopPct              [-0.15, -0.06]

  Trailing switches:
    trail_switch_3pct        [0.02, 0.05]
    trail_switch_8pct        [0.05, 0.12]

Objective (Sprint 3 P0-3: Multi-Objective Pareto via NSGA-II):
  Obj 1: BacktestMetrics.sharpe       (maximize)
  Obj 2: BacktestMetrics.max_drawdown (minimize)

Key change from Sprint 3 version (2026-04-09):
  原本 objective 讀 D1 `paper_orders` + simulate_trades_with_exit() — 因為 paper
  trading 只 3 筆 sell 而永遠無 feasible trial → RuntimeError。改用 Sprint 6a 的
  backtest_engine.replay_period() 在歷史窗口上重播 → 每 trial 產生 real synthetic
  trades（~30-80 筆／trial）→ 可做真實 Sharpe / MaxDD 量測。

Realism caveat: backtest_engine Mode A 有 15 個 documented deviation (Sharpe ±0.3~0.8)，
  Optuna 結果「只能做相對比較」，不能當 absolute production prediction。
  詳見 memory/project_backtest_engine_design_rationale.md
"""
from __future__ import annotations
import logging
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    import optuna
    from optuna.samplers import NSGAIISampler
    optuna.logging.set_verbosity(optuna.logging.WARNING)
except ImportError:
    print("ERROR: pip install optuna")
    sys.exit(1)

# backtest_engine + stratified_subset 位於 services/，sys.path 已含 ml-controller root
from services.backtest_engine import replay_period, BacktestDataset  # noqa: E402
from services.stratified_subset import select_stratified_subset  # noqa: E402

logger = logging.getLogger(__name__)

# Sprint 3 P0-3: PENALTY tuple for infeasible trials (Pareto "worst corner")
PENALTY = (-1e9, 1.0)

# Sanity flag substrings that trigger trial rejection
_REJECT_FLAG_KEYWORDS = ("overfit", "unrealistically", "No trading days")


def _default_baseline_params() -> dict:
    """Minimal baseline matching tradingConfig.ts defaults (fallback only)."""
    return {
        "sltp": {
            "slMultBase": 2.0, "tpMultBase": 1.5,
            "slMultLow": 0.75, "tpMultLow": 0.67,
            "slMultHigh": 1.25, "tpMultHigh": 1.33,
            "volThresholdLow": 0.015, "volThresholdHigh": 0.03,
            "volSkipThreshold": 0.005,
            "trailSwitch3pct": 0.03, "trailSwitch8pct": 0.08,
        },
        "exit": {
            "trailMultDefault": 3.0, "trailMultAt3pct": 2.5, "trailMultAt8pct": 2.0,
            "tp1SellRatio": 0.5, "timeStopDays": 20, "hardStopPct": -0.10,
        },
    }


def _build_trial_params(trial: optuna.Trial, baseline: dict) -> dict:
    """Build a params override dict matching trading:config shape for this trial."""
    # Existing Sprint 3 search space
    sl_mult      = trial.suggest_float("sl_mult", 1.0, 3.0, step=0.25)
    tp_mult      = trial.suggest_float("tp_mult", 1.0, 3.0, step=0.25)
    trail_def    = trial.suggest_float("trailMultDefault", 2.0, 4.0, step=0.25)
    trail_3      = trial.suggest_float("trailMultAt3pct", 1.5, 3.0, step=0.25)
    trail_8      = trial.suggest_float("trailMultAt8pct", 1.0, 2.5, step=0.25)
    tp1_ratio    = trial.suggest_float("tp1SellRatio", 0.3, 0.7, step=0.1)
    time_stop    = trial.suggest_int("timeStopDays", 10, 30, step=5)
    hard_stop    = trial.suggest_float("hardStopPct", -0.15, -0.06, step=0.01)
    switch_3     = trial.suggest_float("trail_switch_3pct", 0.02, 0.05, step=0.005)
    switch_8     = trial.suggest_float("trail_switch_8pct", 0.05, 0.12, step=0.01)

    # Sprint 5.1 Phase 7 Layer B: per-vol-branch multipliers
    sl_mult_low  = trial.suggest_float("slMultLow",  0.50, 1.00, step=0.05)
    tp_mult_low  = trial.suggest_float("tpMultLow",  0.50, 1.00, step=0.05)
    sl_mult_high = trial.suggest_float("slMultHigh", 1.00, 1.50, step=0.05)
    tp_mult_high = trial.suggest_float("tpMultHigh", 1.00, 1.50, step=0.05)

    params = deepcopy(baseline)
    params.setdefault("sltp", {}).update({
        "slMultBase": sl_mult,
        "tpMultBase": tp_mult,
        "slMultLow": sl_mult_low,
        "tpMultLow": tp_mult_low,
        "slMultHigh": sl_mult_high,
        "tpMultHigh": tp_mult_high,
        "trailSwitch3pct": switch_3,
        "trailSwitch8pct": switch_8,
    })
    params.setdefault("exit", {}).update({
        "trailMultDefault": trail_def,
        "trailMultAt3pct": trail_3,
        "trailMultAt8pct": trail_8,
        "tp1SellRatio": tp1_ratio,
        "timeStopDays": time_stop,
        "hardStopPct": hard_stop,
    })
    return params


def _check_constraints(trial_params: dict) -> Optional[str]:
    """Hard constraints (return reason if violated, else None)."""
    exit_p = trial_params.get("exit", {})
    sltp = trial_params.get("sltp", {})
    # trailing must tighten as profit grows
    if exit_p["trailMultDefault"] <= exit_p["trailMultAt3pct"]:
        return "trailMultDefault <= trailMultAt3pct"
    if exit_p["trailMultAt3pct"] <= exit_p["trailMultAt8pct"]:
        return "trailMultAt3pct <= trailMultAt8pct"
    # switch points must be ordered
    if sltp["trailSwitch8pct"] <= sltp["trailSwitch3pct"]:
        return "trailSwitch8pct <= trailSwitch3pct"
    # Layer B ordering: low branch tightens, high branch loosens
    if sltp["slMultLow"] >= 1.0 or sltp["slMultHigh"] <= 1.0:
        return "slMultLow >= 1.0 or slMultHigh <= 1.0"
    if sltp["tpMultLow"] >= 1.0 or sltp["tpMultHigh"] <= 1.0:
        return "tpMultLow >= 1.0 or tpMultHigh <= 1.0"
    # R:R sanity: tpMultLow shouldn't crash to near-zero
    if sltp["tpMultLow"] < 0.5 * sltp["slMultLow"]:
        return "tpMultLow too low vs slMultLow (R:R broken)"
    return None


def create_objective(dataset: BacktestDataset, start_date: str, end_date: str, baseline: dict):
    """
    Build Optuna objective fn closured over a pre-loaded BacktestDataset.
    Dataset is loaded once in run_search; each trial just calls replay_period.
    """
    def objective(trial: optuna.Trial):
        params = _build_trial_params(trial, baseline)

        constraint_violation = _check_constraints(params)
        if constraint_violation:
            logger.debug(f"[optuna_sltp] trial {trial.number} rejected: {constraint_violation}")
            return PENALTY

        try:
            metrics = replay_period(
                dataset,
                start_date,
                end_date,
                params,
                initial_capital=1_000_000,
                mode="A",
                verbose=False,
            )
        except Exception as e:
            logger.warning(f"[optuna_sltp] trial {trial.number} replay error: {e}")
            return PENALTY

        # Sanity reject: overfit / unrealistic / no-trades flags
        for flag in metrics.sanity_flags:
            for kw in _REJECT_FLAG_KEYWORDS:
                if kw in flag:
                    logger.debug(
                        f"[optuna_sltp] trial {trial.number} rejected (sanity): {flag}"
                    )
                    return PENALTY

        # Also hard reject tiny sample
        if metrics.total_trades < 30:
            logger.debug(
                f"[optuna_sltp] trial {trial.number} n_trades={metrics.total_trades} < 30, rejected"
            )
            return PENALTY

        # Valid trial — report to Optuna
        sharpe = float(metrics.sharpe or 0.0)
        max_dd = float(metrics.max_drawdown or 1.0)
        trial.set_user_attr("n_trades", metrics.total_trades)
        trial.set_user_attr("win_rate", float(metrics.win_rate or 0.0))
        trial.set_user_attr("profit_factor", float(metrics.profit_factor or 0.0))
        trial.set_user_attr("fill_rate", float(metrics.fill_rate or 0.0))
        return sharpe, max_dd

    return objective


def run_search(
    n_trials: int = 200,
    subset_size: int = 250,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    baseline_params: Optional[dict] = None,
) -> dict:
    """
    Sprint 5.1 entry point. Loads stratified subset + BacktestDataset, runs NSGA-II
    Pareto optimization, returns best-sharpe Pareto trial.
    """
    # ── Date defaults: 90 day window ending today (TW) ──────────────────────
    if end_date is None:
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        end_date = tw_now.date().isoformat()
    if start_date is None:
        start_date = (
            datetime.fromisoformat(end_date) - timedelta(days=90)
        ).date().isoformat()

    if baseline_params is None:
        baseline_params = _default_baseline_params()

    logger.info(
        f"[optuna_sltp] Sprint 5.1 search: n_trials={n_trials} "
        f"subset_size={subset_size} window={start_date}~{end_date}"
    )

    # ── Step 1: stratified subset ───────────────────────────────────────────
    symbols = select_stratified_subset(
        target_size=subset_size,
        end_date=end_date,
        lookback_days=30,
    )
    if not symbols:
        raise RuntimeError(
            "stratified_subset returned empty — check D1 stocks/stock_prices state"
        )
    logger.info(f"[optuna_sltp] subset picked: {len(symbols)} symbols")

    # ── Step 2: pre-load dataset once ───────────────────────────────────────
    dataset = BacktestDataset.load_from_d1(
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
    )

    # ── Step 3: Optuna NSGA-II Pareto search ────────────────────────────────
    study = optuna.create_study(
        directions=["maximize", "minimize"],  # sharpe↑, max_dd↓
        sampler=NSGAIISampler(seed=42),
        study_name="sltp_trailing_pareto_s51",
    )
    study.optimize(create_objective(dataset, start_date, end_date, baseline_params), n_trials=n_trials)

    # ── Step 4: extract Pareto front ────────────────────────────────────────
    pareto_trials = [t for t in study.best_trials if t.values and t.values[0] > -1e8]
    if not pareto_trials:
        raise RuntimeError(
            f"Optuna sltp: no feasible Pareto trials out of {n_trials}; "
            "check dataset quality / sanity constraints / search space bounds"
        )

    chosen = max(pareto_trials, key=lambda t: t.values[0])
    best_sharpe, best_max_dd = chosen.values

    logger.info("=" * 60)
    logger.info(f"[optuna_sltp] Pareto front size: {len(pareto_trials)}/{n_trials}")
    logger.info(
        f"[optuna_sltp] chosen trial #{chosen.number}: "
        f"sharpe={best_sharpe:.3f} max_dd={best_max_dd:.3%} "
        f"n_trades={chosen.user_attrs.get('n_trades')} "
        f"win_rate={chosen.user_attrs.get('win_rate', 0):.1%} "
        f"pf={chosen.user_attrs.get('profit_factor', 0):.2f}"
    )
    for k, v in chosen.params.items():
        logger.info(f"  {k}: {v}")
    logger.info("=" * 60)

    # Pareto front listing (for Wei to inspect tradeoffs)
    pareto_front = sorted(
        [
            {
                "trial_number": t.number,
                "sharpe": float(t.values[0]),
                "max_dd": float(t.values[1]),
                "n_trades": t.user_attrs.get("n_trades"),
                "win_rate": t.user_attrs.get("win_rate"),
                "profit_factor": t.user_attrs.get("profit_factor"),
                "params": t.params,
            }
            for t in pareto_trials
        ],
        key=lambda x: x["sharpe"],
        reverse=True,
    )

    return {
        "best_params": chosen.params,
        "best_sharpe": float(best_sharpe),
        "best_max_dd": float(best_max_dd),
        "best_n_trades": chosen.user_attrs.get("n_trades"),
        "best_win_rate": chosen.user_attrs.get("win_rate"),
        "best_profit_factor": chosen.user_attrs.get("profit_factor"),
        "pareto_front": pareto_front,
        "pareto_size": len(pareto_trials),
        "mode": "A",
        "data_source": "backtest_engine.replay_period",
        "subset_size": len(symbols),
        "date_window": f"{start_date}~{end_date}",
        "realism_note": (
            "Mode A has 15 documented deviations from production (Sharpe ±0.3~0.8). "
            "Use results for RELATIVE parameter ranking only, not absolute prediction. "
            "See memory/project_backtest_engine_design_rationale.md"
        ),
    }
