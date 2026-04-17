"""
optuna_per_regime_robust.py — Sprint 7+ per-regime robust parameter search

Roadmap: #33 "Sprint 7+ per-regime robust Optuna (min(sharpe across 4 regimes)
              + D7 Pareto ml-service sync)"
Source: project_roadmap_merged_2026_04_08.md (5-7 hr)

────────────────────────────────────────────────────────────────────────────
STATUS: SCAFFOLD ONLY — depends on #30 (regime pipeline) and #32 (walk-forward)
────────────────────────────────────────────────────────────────────────────

Concept — why "robust" search?
  Current Optuna scripts (sltp, signal, rrg, etc) maximize overall sharpe on
  the full backtest window. The winning params can be regime-specialized:
  e.g., params that are excellent in bull_market but catastrophic in bear_market
  can win the average because bull_market has more data.

  In PRODUCTION, bear_market traders get killed. We want params that give
  decent returns in ALL regimes, not peak returns in one.

Approach — minimax robust optimization:
  1. Classify each trading day into {bull_market, volatile, sideways, bear_market}
     using predict_regime_at_date() from walk_forward_retrain.py
  2. Run replay_period on each regime's dates separately → per-regime sharpe
  3. Objective = min(sharpe across 4 regimes)
  4. Keep traditional Pareto (sharpe, max_dd, sortino) as secondary Pareto front

Also addresses D7 Pareto ml-service sync:
  `project_session_2026_04_10_part5.md` D7 = Pareto front sync from backtest
  search → ml-service ensemble weights. This script's Pareto output feeds
  per-regime model weights into ml-service REGIME_CONFIG override via
  push_optuna_result(source='regime', params={weight_multipliers: {...}}).

Runnable status:
  - Requires predict_regime_at_date() real implementation (walk_forward_retrain.py
    currently uses Mode A risk_level stub)
  - Requires sufficient per-regime data (>30 days per regime in backtest window)
  - If bear_market dates are sparse, robust objective will ring false alarms

Blocked on:
  - #32 Sprint 6b walk-forward (needs per-window regime replay)
  - #30 Regime pipeline fully deployed (scaffold done 2026-04-17, awaiting deploy)

Usage when unblocked:
    python optuna_per_regime_robust.py --target=sltp --n-trials=200 --window-days=365
"""
from __future__ import annotations
import argparse
import logging
import sys
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    import optuna
    from optuna.samplers import NSGAIISampler
    optuna.logging.set_verbosity(optuna.logging.WARNING)
except ImportError:
    print("ERROR: pip install optuna")
    sys.exit(1)

from services.backtest_engine import (  # noqa: E402
    replay_period,
    BacktestDataset,
    BacktestMetrics,
    Trade,
)
from services.stratified_subset import select_stratified_subset  # noqa: E402
from services.walk_forward_retrain import predict_regime_at_date  # noqa: E402
from services.kv_pusher import push_optuna_result  # noqa: E402

logger = logging.getLogger(__name__)

REGIMES = ("bull_market", "volatile", "sideways", "bear_market")
PENALTY_ROBUST = -1e9


@dataclass
class PerRegimeMetrics:
    sharpe_per_regime: dict[str, float]    # regime_label → sharpe
    max_dd_per_regime: dict[str, float]
    n_trades_per_regime: dict[str, int]
    robust_sharpe: float                   # min(sharpe)
    weighted_sharpe: float                 # time-weighted average


def _partition_trades_by_regime(
    trades: list[Trade],
    dataset: BacktestDataset,
) -> dict[str, list[Trade]]:
    """Group trades by the regime at their entry date."""
    buckets: dict[str, list[Trade]] = {r: [] for r in REGIMES}
    for t in trades:
        entry_date = t.entry_date
        regime = predict_regime_at_date(dataset, entry_date)
        if regime not in buckets:
            regime = "sideways"
        buckets[regime].append(t)
    return buckets


def _sharpe_from_trades(trades: list[Trade]) -> Optional[float]:
    """Compute annualized Sharpe from a trade list's per-trade returns."""
    if len(trades) < 5:
        return None
    import numpy as np
    rets = np.array([float(t.net_return_pct or 0) for t in trades])
    if rets.std() == 0:
        return None
    # Approximate annualization: avg trades/year ~ 60 (assuming ~5d hold)
    return float(rets.mean() / rets.std() * (60 ** 0.5))


def _max_drawdown_from_trades(trades: list[Trade]) -> float:
    """Max drawdown of cumulative equity from trade-level returns."""
    if not trades:
        return 0.0
    import numpy as np
    rets = np.array([1 + float(t.net_return_pct or 0) for t in trades])
    equity = np.cumprod(rets)
    peak = np.maximum.accumulate(equity)
    dd = (peak - equity) / peak
    return float(dd.max()) if len(dd) else 0.0


def _compute_per_regime_metrics(
    metrics: BacktestMetrics,
    dataset: BacktestDataset,
) -> PerRegimeMetrics:
    """Split BacktestMetrics.trades by regime and compute per-regime sharpe."""
    buckets = _partition_trades_by_regime(metrics.trades, dataset)

    sharpe_per_regime = {}
    max_dd_per_regime = {}
    n_trades_per_regime = {}
    for regime, ts in buckets.items():
        sharpe_per_regime[regime] = _sharpe_from_trades(ts) or -1.0
        max_dd_per_regime[regime] = _max_drawdown_from_trades(ts)
        n_trades_per_regime[regime] = len(ts)

    # Robust objective: minimum sharpe across regimes WITH enough data (>=5 trades)
    regimes_with_data = [r for r, n in n_trades_per_regime.items() if n >= 5]
    if not regimes_with_data:
        robust_sharpe = PENALTY_ROBUST
    else:
        robust_sharpe = min(sharpe_per_regime[r] for r in regimes_with_data)

    # Weighted sharpe: by trade count
    total = sum(n_trades_per_regime.values())
    if total > 0:
        weighted_sharpe = sum(
            sharpe_per_regime[r] * (n_trades_per_regime[r] / total)
            for r in REGIMES if n_trades_per_regime[r] > 0
        )
    else:
        weighted_sharpe = 0.0

    return PerRegimeMetrics(
        sharpe_per_regime=sharpe_per_regime,
        max_dd_per_regime=max_dd_per_regime,
        n_trades_per_regime=n_trades_per_regime,
        robust_sharpe=robust_sharpe,
        weighted_sharpe=weighted_sharpe,
    )


# ── Search space (reuse sltp params for demonstration) ───────────────────────
# When unblocked, caller specifies --target to swap search subspace.

def _build_sltp_params(trial: optuna.Trial, baseline: dict) -> dict:
    """Mirror optuna_sltp search space but simplified."""
    params = deepcopy(baseline)
    params.setdefault("sltp", {}).update({
        "slMultBase":      trial.suggest_float("sl_mult", 1.0, 3.0, step=0.25),
        "tpMultBase":      trial.suggest_float("tp_mult", 1.0, 3.0, step=0.25),
        "slMultLow":       trial.suggest_float("slMultLow",  0.50, 1.00, step=0.05),
        "tpMultLow":       trial.suggest_float("tpMultLow",  0.50, 1.00, step=0.05),
        "slMultHigh":      trial.suggest_float("slMultHigh", 1.00, 1.50, step=0.05),
        "tpMultHigh":      trial.suggest_float("tpMultHigh", 1.00, 1.50, step=0.05),
    })
    return params


def _default_sltp_baseline() -> dict:
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


def create_robust_objective(
    dataset: BacktestDataset,
    start_date: str,
    end_date: str,
    baseline: dict,
    target: str = "sltp",
):
    """Build per-regime robust objective.

    Returns a 3-objective tuple:
      (robust_sharpe ↑, max_dd_weighted ↓, weighted_sharpe ↑)
    """
    def objective(trial: optuna.Trial):
        if target == "sltp":
            params = _build_sltp_params(trial, baseline)
        else:
            raise ValueError(f"target '{target}' not yet supported in robust search")

        try:
            metrics = replay_period(
                dataset, start_date=start_date, end_date=end_date, params=params,
            )
        except Exception as e:
            logger.warning(f"[per-regime-robust] trial {trial.number} replay failed: {e}")
            return (PENALTY_ROBUST, 1.0, -1e9)

        per_reg = _compute_per_regime_metrics(metrics, dataset)
        # Weighted max_dd by trade count
        total = sum(per_reg.n_trades_per_regime.values())
        if total > 0:
            weighted_max_dd = sum(
                per_reg.max_dd_per_regime[r] * (per_reg.n_trades_per_regime[r] / total)
                for r in REGIMES
            )
        else:
            weighted_max_dd = 1.0

        trial.set_user_attr("sharpe_per_regime",  per_reg.sharpe_per_regime)
        trial.set_user_attr("n_trades_per_regime", per_reg.n_trades_per_regime)

        return (
            float(per_reg.robust_sharpe),
            float(weighted_max_dd),
            float(per_reg.weighted_sharpe),
        )
    return objective


def run_search(
    target: str = "sltp",
    n_trials: int = 200,
    subset_size: int = 400,
    window_days: int = 365,
    push_kv: bool = False,
) -> dict:
    """Execute per-regime robust search."""
    today = datetime.now(timezone(timedelta(hours=8))).date()
    end_date = today.strftime("%Y-%m-%d")
    start_date = (today - timedelta(days=window_days)).strftime("%Y-%m-%d")

    symbols = select_stratified_subset(size=subset_size, as_of=end_date)
    dataset = BacktestDataset.load_from_d1(symbols=symbols, start=start_date, end=end_date)

    baseline = _default_sltp_baseline() if target == "sltp" else {}
    objective = create_robust_objective(dataset, start_date, end_date, baseline, target)

    study = optuna.create_study(
        sampler=NSGAIISampler(seed=42, population_size=40),
        directions=["maximize", "minimize", "maximize"],
        study_name=f"per_regime_robust_{target}",
    )
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    # Pick trial maximizing robust_sharpe among Pareto
    pareto = [t for t in study.best_trials if t.values[0] > PENALTY_ROBUST / 2]
    if not pareto:
        raise RuntimeError("No feasible trials — regime split may be too sparse. "
                           "Increase --window-days or enlarge subset.")
    best = max(pareto, key=lambda t: t.values[0])

    result = {
        "target": target,
        "best_trial": best.number,
        "robust_sharpe": best.values[0],
        "weighted_max_dd": best.values[1],
        "weighted_sharpe": best.values[2],
        "best_params": best.params,
        "sharpe_per_regime": best.user_attrs.get("sharpe_per_regime", {}),
        "n_trades_per_regime": best.user_attrs.get("n_trades_per_regime", {}),
        "n_trials_completed": len(study.trials),
        "n_pareto": len(pareto),
        "window": {"start": start_date, "end": end_date},
    }

    logger.info(f"[per-regime-robust] best #{best.number}: robust_sharpe={best.values[0]:.3f} "
                f"weighted_dd={best.values[1]:.2%} weighted_sharpe={best.values[2]:.3f}")
    logger.info(f"[per-regime-robust] sharpe_per_regime: {result['sharpe_per_regime']}")

    if push_kv:
        try:
            if target == "sltp":
                push_optuna_result(
                    source="sltp",
                    params=best.params,
                    meta={
                        "optuna_source": "per_regime_robust",
                        "robust_sharpe": result["robust_sharpe"],
                        "sharpe_per_regime": result["sharpe_per_regime"],
                    },
                )
                result["kv_push_ok"] = True
        except Exception as e:
            logger.error(f"[per-regime-robust] KV push failed: {e}")
            result["kv_push_ok"] = False

    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="sltp", choices=["sltp"])
    parser.add_argument("--n-trials", type=int, default=200)
    parser.add_argument("--subset-size", type=int, default=400)
    parser.add_argument("--window-days", type=int, default=365)
    parser.add_argument("--push-kv", action="store_true")
    args = parser.parse_args()

    r = run_search(
        target=args.target,
        n_trials=args.n_trials,
        subset_size=args.subset_size,
        window_days=args.window_days,
        push_kv=args.push_kv,
    )
    import json
    print(json.dumps(r, indent=2, ensure_ascii=False))
