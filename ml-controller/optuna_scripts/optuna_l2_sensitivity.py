"""
optuna_l2_sensitivity.py — 2026-04-20 #28 P7
NSGA-II search over L2 / circuit dims that Mode B now consumes (P2-P5 done).

Bandit dims (5) excluded by design — LinUCB runtime not simulated in Mode B.
Remaining 25 Mode-B-consumable dims split into:
  8 circuit + 6 L2-confidence + 6 SLTP-add + 4 night + 1 medium + 3 PF-search
  (PF 90d_weight = 1 - 30d_weight constrained, so 3 search dims cover 4 consumers)

Design citations (see task_plan.md Item #28):
  D3 NSGA-II — Deb et al. (2002) IEEE Trans. Evol. Comp
  D4 log-uniform mults — Bergstra & Bengio (2012) JMLR
  Mode B Kelly sensitivity — Pedersen 2015 "Efficiently Inefficient"

Search space source-of-truth: trading:config.optuna_l2.search_space KV.
This script accepts search_space as input (KV read is caller's responsibility).
DEFAULT_SEARCH_SPACE is seeded fallback for bootstrap — production caller
should override with KV read so Wei can retune ranges without code change.

Objective (single scalar for NSGA-II dominance):
  score = sharpe - dd_penalty * max_drawdown
  with dd_penalty configurable (default 2.0).

To use NSGA-II multi-objective (future extension), swap to
`direction=["maximize","minimize"]` and return (sharpe, max_dd) tuple.
"""
from __future__ import annotations

import copy
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


# Default search space — 28 dims. Caller (endpoint) should prefer KV override.
# Each entry: name, path (dot-notation into trading:config), type, low, high.
# Ranges sourced from task_plan.md Item #28 with Bergstra (2012) log-uniform
# for mult coefficients, uniform for threshold percentages / scores.
DEFAULT_SEARCH_SPACE: list[dict[str, Any]] = [
    # ── circuit.* (8 dims) ────────────────────────────────────────────────
    {"name": "buyConfThreshold",       "path": "circuit.buyConfThreshold",       "type": "uniform",     "low": 0.50,  "high": 0.75},
    {"name": "sellConfThreshold",      "path": "circuit.sellConfThreshold",      "type": "uniform",     "low": 0.55,  "high": 0.80},
    {"name": "lowAccuracyThreshold",   "path": "circuit.lowAccuracyThreshold",   "type": "uniform",     "low": 0.35,  "high": 0.55},
    {"name": "drawdownHalt",           "path": "circuit.drawdownHalt",           "type": "uniform",     "low": 0.08,  "high": 0.25},
    {"name": "drawdownScaleStart",     "path": "circuit.drawdownScaleStart",     "type": "uniform",     "low": 0.01,  "high": 0.08},
    {"name": "drawdownRaisedConf",     "path": "circuit.drawdownRaisedConf",     "type": "uniform",     "low": 0.65,  "high": 0.80},
    {"name": "mddMultFloor",           "path": "circuit.mddMultFloor",           "type": "log_uniform", "low": 0.10,  "high": 0.50},
    {"name": "bullAlignmentThreshold", "path": "circuit.bullAlignmentThreshold", "type": "int",         "low": 10,    "high": 40},

    # ── L2_formula confidence (6 dims) ─────────────────────────────────────
    {"name": "confidence_risk_mult",          "path": "L2_formula.confidence_risk_mult",          "type": "log_uniform", "low": 0.05,  "high": 0.40},
    {"name": "confidence_perf_mult",          "path": "L2_formula.confidence_perf_mult",          "type": "log_uniform", "low": 0.05,  "high": 0.50},
    {"name": "confidence_delta_clip_lo",      "path": "L2_formula.confidence_delta_clip_lo",      "type": "uniform",     "low": -0.20, "high": -0.05},
    {"name": "confidence_delta_clip_hi",      "path": "L2_formula.confidence_delta_clip_hi",      "type": "uniform",     "low": 0.10,  "high": 0.30},
    {"name": "confidence_effective_clip_lo",  "path": "L2_formula.confidence_effective_clip_lo",  "type": "uniform",     "low": 0.35,  "high": 0.55},
    {"name": "confidence_effective_clip_hi",  "path": "L2_formula.confidence_effective_clip_hi",  "type": "uniform",     "low": 0.65,  "high": 0.85},

    # ── L2_formula SLTP risk-level add (6 dims) ────────────────────────────
    {"name": "sltp_add_orange_sl", "path": "L2_formula.sltp_add_orange_sl", "type": "log_uniform", "low": 0.10, "high": 0.80},
    {"name": "sltp_add_orange_tp", "path": "L2_formula.sltp_add_orange_tp", "type": "log_uniform", "low": 0.10, "high": 0.80},
    {"name": "sltp_add_red_sl",    "path": "L2_formula.sltp_add_red_sl",    "type": "log_uniform", "low": 0.20, "high": 1.20},
    {"name": "sltp_add_red_tp",    "path": "L2_formula.sltp_add_red_tp",    "type": "log_uniform", "low": 0.20, "high": 1.20},
    {"name": "sltp_add_black_sl",  "path": "L2_formula.sltp_add_black_sl",  "type": "log_uniform", "low": 0.50, "high": 2.00},
    {"name": "sltp_add_black_tp",  "path": "L2_formula.sltp_add_black_tp",  "type": "log_uniform", "low": 0.20, "high": 1.20},

    # ── L2_formula night drop + medium + PF quality (8 dims, 3 PF derived) ─
    {"name": "night_drop_severe_pct",     "path": "L2_formula.night_drop_severe_pct",     "type": "uniform", "low": -0.030, "high": -0.005},
    {"name": "night_drop_mild_pct",       "path": "L2_formula.night_drop_mild_pct",       "type": "uniform", "low": -0.020, "high": -0.002},
    {"name": "night_drop_severe_adjust",  "path": "L2_formula.night_drop_severe_adjust",  "type": "uniform", "low": 0.95,   "high": 1.00},
    {"name": "night_drop_mild_adjust",    "path": "L2_formula.night_drop_mild_adjust",    "type": "uniform", "low": 0.97,   "high": 1.00},
    {"name": "medium_risk_scale",         "path": "L2_formula.medium_risk_scale",         "type": "uniform", "low": 0.30,   "high": 0.80},
    {"name": "pf_quality_30d_weight",     "path": "L2_formula.pf_quality_30d_weight",     "type": "uniform", "low": 0.40,   "high": 0.90},
    {"name": "pf_quality_clip_lo",        "path": "L2_formula.pf_quality_clip_lo",        "type": "uniform", "low": 0.20,   "high": 0.50},
    {"name": "pf_quality_clip_hi",        "path": "L2_formula.pf_quality_clip_hi",        "type": "uniform", "low": 1.30,   "high": 2.50},
]


def _set_nested(d: dict, path: str, value: Any) -> None:
    """Set d[k1][k2]...[kN] = value for dot-notation `path`; creates intermediate dicts."""
    keys = path.split(".")
    cur = d
    for k in keys[:-1]:
        if k not in cur or not isinstance(cur[k], dict):
            cur[k] = {}
        cur = cur[k]
    cur[keys[-1]] = value


def _suggest(trial: "optuna.Trial", dim: dict[str, Any]) -> Any:
    """Translate a search-space dim descriptor into an Optuna suggestion call."""
    name = dim["name"]
    dim_type = dim["type"]
    lo, hi = dim["low"], dim["high"]
    if dim_type == "uniform":
        return trial.suggest_float(name, lo, hi)
    if dim_type == "log_uniform":
        return trial.suggest_float(name, lo, hi, log=True)
    if dim_type == "int":
        return trial.suggest_int(name, int(lo), int(hi))
    if dim_type == "categorical":
        return trial.suggest_categorical(name, dim["choices"])
    raise ValueError(f"optuna_l2_sensitivity: unsupported search type '{dim_type}'")


def run_l2_sensitivity_search(
    search_space: Optional[list[dict[str, Any]]],
    start_date: str,
    end_date: str,
    baseline_config: dict,
    n_trials: int = 50,
    dd_penalty: float = 2.0,
    initial_capital: float = 1_000_000.0,
    sampler_name: str = "nsga2",
    seed: int = 42,
) -> dict[str, Any]:
    """NSGA-II (or TPE) search over L2 dims against Mode B replay.

    Args:
        search_space: list of dim descriptors; None → DEFAULT_SEARCH_SPACE.
            When production-driven, caller reads trading:config.optuna_l2.search_space
            from KV and passes it here (D4 citation — no code change to retune).
        start_date / end_date: backtest replay period (inclusive).
        baseline_config: full trading:config snapshot — trial params override
            leaves into a deep copy each iteration.
        n_trials: total trials (50 for sanity, 200-300 for full search).
        dd_penalty: single-objective weight; score = sharpe - dd_penalty * max_dd.
        sampler_name: 'nsga2' | 'tpe' — NSGA-II (Deb 2002) preferred for
            multi-objective intent even in single-obj compile (tournament
            selection + diversity preservation still helps).
        seed: deterministic trial sequence. M14 discipline.

    Returns dict:
        best_value, best_params (flat), best_params_nested (trading:config shape),
        n_trials, all_trials (audit).
    """
    import optuna  # lazy; Cloud Run image has it
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    space = list(search_space or DEFAULT_SEARCH_SPACE)
    if not space:
        raise ValueError("run_l2_sensitivity_search: empty search_space")

    # Mode B objective — import lazily so unit-test stubs can intercept
    from services.backtest_engine import replay_period  # type: ignore

    def objective(trial: "optuna.Trial") -> float:
        # Deep-copy baseline so trial overrides don't leak
        params = copy.deepcopy(baseline_config or {})
        flat: dict[str, Any] = {}
        for dim in space:
            v = _suggest(trial, dim)
            flat[dim["name"]] = v
            _set_nested(params, dim["path"], v)

        # PF 90d_weight constraint: if 30d_weight suggested, derive 90d = 1 - 30d
        if "pf_quality_30d_weight" in flat:
            _set_nested(params, "L2_formula.pf_quality_90d_weight", 1.0 - flat["pf_quality_30d_weight"])

        try:
            result = replay_period(
                start_date=start_date,
                end_date=end_date,
                params=params,
                mode="B",
                initial_capital=initial_capital,
            )
        except Exception as e:
            logger.warning(f"[L2 Optuna] trial {trial.number} replay crashed: {e}")
            return -1e9

        metrics = (result or {}).get("metrics") or {}
        sharpe = float(metrics.get("sharpe") or 0.0)
        max_dd = float(metrics.get("max_drawdown") or 0.0)
        n_trades = int(metrics.get("n_trades") or 0)

        # Min-trade guard — avoid rewarding "no-trade high-sharpe" degenerate solutions
        if n_trades < 5:
            logger.info(f"[L2 Optuna] trial {trial.number} only {n_trades} trades → penalized")
            return -1.0

        score = sharpe - dd_penalty * max_dd
        logger.info(
            f"[L2 Optuna] trial {trial.number} sharpe={sharpe:.3f} "
            f"dd={max_dd:.3f} trades={n_trades} score={score:.3f}"
        )
        return score

    if sampler_name == "tpe":
        sampler = optuna.samplers.TPESampler(seed=seed)
    else:
        sampler = optuna.samplers.NSGAIISampler(seed=seed)

    study = optuna.create_study(
        direction="maximize",
        sampler=sampler,
        study_name="l2_sensitivity",
    )
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_trial

    # Reconstruct nested form for KV push (trading:config shape)
    nested: dict[str, Any] = {}
    for dim in space:
        if dim["name"] in best.params:
            _set_nested(nested, dim["path"], best.params[dim["name"]])
    # Apply PF constraint again in nested payload
    if "pf_quality_30d_weight" in best.params:
        _set_nested(nested, "L2_formula.pf_quality_90d_weight",
                    1.0 - best.params["pf_quality_30d_weight"])

    return {
        "best_value": best.value,
        "best_params": dict(best.params),
        "best_params_nested": nested,
        "n_trials": len(study.trials),
        "all_trials": [
            {"number": t.number, "value": t.value, "params": dict(t.params)}
            for t in study.trials if t.value is not None
        ],
    }
