"""
optuna_adaptive_l2.py — Search adaptive.py Layer 2 formula constants

Roadmap: #28 "adaptive.py 18 constants into Optuna Layer 2"
Sources: project_kv_architecture_repair.md
         project_sprint_5_1_l2_sensitivity_deferred.md

These 18+ constants live in KV `trading:config.L2_formula` and are read by
ml-controller/services/adaptive.py (compute_* functions). They turn market
state (risk_score / accuracy_30d / losses_5d) into T+1 deltas applied by
paper.ts. Today all are hardcoded defaults with no empirical search.

────────────────────────────────────────────────────────────────────────────
WARNING: This script is partially blocked on Sprint 6b (Mode B walk-forward)
────────────────────────────────────────────────────────────────────────────
The backtest_engine Mode A currently used by optuna_sltp/rrg/etc has these
docs:
  - NO ML confidence hook (memory/project_sprint_5_1_l2_sensitivity_deferred.md)
  - NO per-trade bandit feedback simulation
  - NO per-model vote weighting beyond static ensemble

Consequences per group:
  A. `sltp_add_*` (6 constants) — backtest_engine DOES apply SL/TP multipliers
     to ATR-based exits. Search them TODAY with Mode A and they have signal.
  B. `confidence_*` (6 constants) — require Mode B (Sprint 6b walk-forward
     ML) to exercise confidence_delta path. Mode A search = noise.
  C. `pf_quality_*` (4 constants) — same as B.
  D. `bandit_*` (5 constants) — require LinUCB feedback loop simulation.
     No current backtest supports this. Defer to after Sprint 7 (ARF/bandit
     replay harness).

Usage:
    # Group A (Mode A, runnable today):
    python optuna_adaptive_l2.py --group=sltp_add --n-trials=80

    # Groups B/C (blocked on Sprint 6b):
    python optuna_adaptive_l2.py --group=confidence --n-trials=100  # errors out
    python optuna_adaptive_l2.py --group=pf_quality --n-trials=100  # errors out

    # Group D (blocked on Sprint 7+):
    python optuna_adaptive_l2.py --group=bandit --n-trials=100  # errors out

Objective: Pareto (sharpe↑, max_dd↓, sortino↑) — same as optuna_sltp.

Output: push_optuna_result(source='risk_params', params={L2_formula: {...}})
        or explicitly to a new source='adaptive_l2' handler in worker if Wei prefers.
"""
from __future__ import annotations
import argparse
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

from services.backtest_engine import replay_period, BacktestDataset  # noqa: E402
from services.stratified_subset import select_stratified_subset  # noqa: E402
from services.kv_pusher import push_optuna_result  # noqa: E402

logger = logging.getLogger(__name__)

# Pareto penalty for infeasible trials (same convention as optuna_sltp)
PENALTY = (-1e9, 1.0, -1e9)


# ── 18 L2_formula constants grouped by backtest support ──────────────────────
GROUP_DEFS = {
    "sltp_add": {
        "runnable_today": True,
        "constants": [
            # orange market risk buffer additions (applied to SL/TP as ATR mult +delta)
            ("sltp_add_orange_sl", 0.1, 0.6, 0.05),
            ("sltp_add_orange_tp", 0.1, 0.6, 0.05),
            ("sltp_add_red_sl",    0.2, 0.9, 0.05),
            ("sltp_add_red_tp",    0.2, 0.9, 0.05),
            ("sltp_add_black_sl",  0.4, 1.5, 0.10),
            ("sltp_add_black_tp",  0.2, 0.9, 0.05),
        ],
        "block_reason": None,
    },
    "confidence": {
        "runnable_today": False,
        "constants": [
            ("confidence_risk_mult",        0.05, 0.35, 0.01),
            ("confidence_perf_mult",        0.10, 0.40, 0.02),
            ("confidence_delta_clip_lo",   -0.25, -0.05, 0.01),
            ("confidence_delta_clip_hi",    0.05, 0.35, 0.01),
            ("confidence_effective_clip_lo", 0.35, 0.55, 0.01),
            ("confidence_effective_clip_hi", 0.65, 0.85, 0.01),
        ],
        "block_reason": "backtest_engine Mode A has no ML confidence hook. "
                        "See project_sprint_5_1_l2_sensitivity_deferred.md. "
                        "Unblocks after Sprint 6b (Mode B walk-forward).",
    },
    "pf_quality": {
        "runnable_today": False,
        "constants": [
            ("pf_quality_30d_weight", 0.4,  0.9,  0.05),
            ("pf_quality_90d_weight", 0.1,  0.6,  0.05),
            ("pf_quality_clip_lo",    0.1,  0.5,  0.05),
            ("pf_quality_clip_hi",    1.2,  2.5,  0.1),
        ],
        "block_reason": "Per-model vote weighting requires Mode B walk-forward ML. "
                        "Mode A uses static ensemble weights.",
    },
    "bandit": {
        "runnable_today": False,
        "constants": [
            ("bandit_loss_thresh_high", 0.45, 0.75, 0.02),
            ("bandit_loss_thresh_med",  0.25, 0.50, 0.02),
            ("bandit_max_mult_high",    1.0,  2.0,  0.1),
            ("bandit_max_mult_med",     1.5,  2.5,  0.1),
            ("bandit_max_mult_low",     2.0,  3.0,  0.1),
        ],
        "block_reason": "LinUCB bandit feedback loop has no backtest simulation. "
                        "Defer to Sprint 7+ (ARF/bandit replay harness).",
    },
}


def _default_baseline() -> dict:
    """Minimal baseline matching adaptive.py hardcoded defaults."""
    return {
        "L2_formula": {
            # confidence
            "confidence_risk_mult": 0.15,
            "confidence_perf_mult": 0.20,
            "confidence_delta_clip_lo": -0.10,
            "confidence_delta_clip_hi": 0.20,
            "confidence_effective_clip_lo": 0.45,
            "confidence_effective_clip_hi": 0.75,
            # pf_quality
            "pf_quality_30d_weight": 0.7,
            "pf_quality_90d_weight": 0.3,
            "pf_quality_clip_lo": 0.3,
            "pf_quality_clip_hi": 1.8,
            # sltp_add
            "sltp_add_orange_sl": 0.3,
            "sltp_add_orange_tp": 0.3,
            "sltp_add_red_sl": 0.5,
            "sltp_add_red_tp": 0.5,
            "sltp_add_black_sl": 1.0,
            "sltp_add_black_tp": 0.5,
            # bandit
            "bandit_loss_thresh_high": 0.6,
            "bandit_loss_thresh_med": 0.4,
            "bandit_max_mult_high": 1.5,
            "bandit_max_mult_med": 2.0,
            "bandit_max_mult_low": 2.5,
        },
    }


def _build_trial_params(trial: optuna.Trial, group: str, baseline: dict) -> dict:
    """Suggest group-specific constants + keep rest at baseline."""
    spec = GROUP_DEFS[group]
    params = deepcopy(baseline)
    L2 = params.setdefault("L2_formula", {})
    for name, lo, hi, step in spec["constants"]:
        L2[name] = trial.suggest_float(name, lo, hi, step=step)
    return params


def _check_constraints(params: dict, group: str) -> Optional[str]:
    """Hard sanity constraints (Pareto-penalize if violated)."""
    L2 = params["L2_formula"]
    if group == "sltp_add":
        # buffer additions must increase with market risk severity
        if L2["sltp_add_orange_sl"] > L2["sltp_add_red_sl"]:
            return "orange_sl > red_sl (severity order broken)"
        if L2["sltp_add_red_sl"] > L2["sltp_add_black_sl"]:
            return "red_sl > black_sl (severity order broken)"
    if group == "confidence":
        if L2["confidence_delta_clip_lo"] >= 0:
            return "confidence_delta_clip_lo must be negative"
        if L2["confidence_delta_clip_hi"] <= 0:
            return "confidence_delta_clip_hi must be positive"
        if L2["confidence_effective_clip_lo"] >= L2["confidence_effective_clip_hi"]:
            return "effective_clip_lo >= effective_clip_hi"
    if group == "pf_quality":
        if L2["pf_quality_clip_lo"] >= L2["pf_quality_clip_hi"]:
            return "pf_quality_clip_lo >= pf_quality_clip_hi"
        if abs((L2["pf_quality_30d_weight"] + L2["pf_quality_90d_weight"]) - 1.0) > 0.15:
            return "pf_quality weights should sum ~1.0"
    if group == "bandit":
        if L2["bandit_loss_thresh_high"] <= L2["bandit_loss_thresh_med"]:
            return "bandit_loss_thresh_high <= bandit_loss_thresh_med"
        # fewer losses → more exploration headroom (mult_low > mult_med > mult_high)
        if not (L2["bandit_max_mult_low"] >= L2["bandit_max_mult_med"] >= L2["bandit_max_mult_high"]):
            return "bandit_max_mult ordering broken"
    return None


def create_objective(dataset: BacktestDataset, start_date: str, end_date: str,
                     baseline: dict, group: str):
    """Objective closure — Pareto (sharpe↑, max_dd↓, sortino↑)."""
    def objective(trial: optuna.Trial):
        params = _build_trial_params(trial, group, baseline)
        violation = _check_constraints(params, group)
        if violation:
            logger.debug(f"[optuna_adaptive_l2] trial {trial.number} rejected: {violation}")
            return PENALTY
        try:
            metrics = replay_period(
                dataset, start_date=start_date, end_date=end_date,
                params=params,
            )
            return (
                float(metrics.sharpe),
                float(metrics.max_drawdown),
                float(metrics.sortino or 0.0),
            )
        except Exception as e:
            logger.warning(f"[optuna_adaptive_l2] trial {trial.number} replay failed: {e}")
            return PENALTY
    return objective


def run_search(group: str, n_trials: int = 80, subset_size: int = 250,
               window_days: int = 120, push_kv: bool = False) -> dict:
    """Run Optuna NSGA-II for the specified group.

    Blocks with error if group is not runnable_today.
    """
    spec = GROUP_DEFS.get(group)
    if not spec:
        raise ValueError(f"Unknown group: {group}. Available: {list(GROUP_DEFS.keys())}")
    if not spec["runnable_today"]:
        raise RuntimeError(
            f"Group '{group}' is BLOCKED: {spec['block_reason']}\n"
            f"This research benchmark is blocked until the backtest "
            f"engine gains the required hook. See Sprint 6b / Sprint 7+ runtime gates."
        )

    # Build subset + dataset
    today = datetime.now(timezone(timedelta(hours=8))).date()
    end_date = today.strftime("%Y-%m-%d")
    start_date = (today - timedelta(days=window_days)).strftime("%Y-%m-%d")

    symbols = select_stratified_subset(size=subset_size, as_of=end_date)
    logger.info(f"[optuna_adaptive_l2] loaded {len(symbols)} symbols, window={start_date}..{end_date}")

    dataset = BacktestDataset.load_from_d1(symbols=symbols, start=start_date, end=end_date)
    baseline = _default_baseline()
    objective = create_objective(dataset, start_date, end_date, baseline, group)

    study = optuna.create_study(
        sampler=NSGAIISampler(seed=42, population_size=30),
        directions=["maximize", "minimize", "maximize"],
        study_name=f"adaptive_l2_{group}",
    )
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    # Pick trial with best sharpe from Pareto front (simple selector)
    pareto = [t for t in study.best_trials if t.values[0] > -1e8]
    if not pareto:
        raise RuntimeError("No feasible trials")
    best = max(pareto, key=lambda t: t.values[0])

    # Assemble L2_formula dict with best values + baseline rest
    merged = deepcopy(baseline)
    for k, v in best.params.items():
        merged["L2_formula"][k] = v

    logger.info(f"[optuna_adaptive_l2] best trial #{best.number}: "
                f"sharpe={best.values[0]:.3f} max_dd={best.values[1]:.2%} sortino={best.values[2]:.3f}")

    result = {
        "group": group,
        "best_trial": best.number,
        "metrics": {
            "sharpe": best.values[0],
            "max_drawdown": best.values[1],
            "sortino": best.values[2],
        },
        "L2_formula": merged["L2_formula"],
        "n_trials_completed": len(study.trials),
        "n_pareto_trials": len(pareto),
        "window": {"start": start_date, "end": end_date, "n_symbols": len(symbols)},
    }

    if push_kv:
        # Push to source='risk_params' which merges into L2_formula fields
        try:
            push_optuna_result(
                source="risk_params",
                params={k: v for k, v in merged["L2_formula"].items() if k.startswith(tuple(
                    n for n, _, _, _ in spec["constants"]
                ))},
                meta={"optuna_source": "adaptive_l2", "group": group, **result["metrics"]},
            )
            result["kv_push_ok"] = True
        except Exception as e:
            logger.error(f"[optuna_adaptive_l2] KV push failed: {e}")
            result["kv_push_ok"] = False

    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--group", required=True,
                        choices=list(GROUP_DEFS.keys()),
                        help="Constant group to search")
    parser.add_argument("--n-trials", type=int, default=80)
    parser.add_argument("--subset-size", type=int, default=250)
    parser.add_argument("--window-days", type=int, default=120)
    parser.add_argument("--push-kv", action="store_true",
                        help="Push best result to Worker KV via optuna-push")
    args = parser.parse_args()

    r = run_search(
        group=args.group,
        n_trials=args.n_trials,
        subset_size=args.subset_size,
        window_days=args.window_days,
        push_kv=args.push_kv,
    )
    import json
    print(json.dumps(r, indent=2, ensure_ascii=False))
