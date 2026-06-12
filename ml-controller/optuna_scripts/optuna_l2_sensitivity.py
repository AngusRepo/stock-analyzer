"""
optuna_l2_sensitivity.py — 2026-04-20 #28 P7
NSGA-II search over L2 / circuit dims that Mode B now consumes (P2-P5 done).

Bandit dims (5) excluded by design — LinUCB runtime not simulated in Mode B.
Clarification: `adaptive_meta_policy_replay` compares LinUCB / NeuralUCB /
NeuralTS / NeuCB family-routing policies. It is not a substitute for searching
`bandit_loss_thresh_*` or `bandit_max_mult_*` constants; those are evaluated
by the separate read-only LinUCB multiplier replay until this Optuna objective
explicitly consumes that replay evidence.
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

Live push gate:
  Search completion is not enough to mutate trading:config. KV push requires
  Mode B replay candidate evidence, CSCV rank-logit PBO PASS, and attached
  walk-forward evidence PASS.

Objective (single scalar for NSGA-II dominance):
  score = sharpe - dd_penalty * max_drawdown
  with dd_penalty configurable (default 2.0).

To use NSGA-II multi-objective (future extension), swap to
`direction=["maximize","minimize"]` and return (sharpe, max_dd) tuple.
"""
from __future__ import annotations

import copy
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_CONTROLLER_DIR = Path(__file__).resolve().parent.parent
if str(_CONTROLLER_DIR) not in sys.path:
    sys.path.insert(0, str(_CONTROLLER_DIR))


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


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class OptunaL2Policy:
    """Runtime-tunable guardrails for L2 Optuna candidate selection."""

    min_trades: int = 5
    dd_penalty: float = 2.0
    pbo_max_candidates: int = 50
    pbo_min_partitions: int = 4

    @classmethod
    def from_env(cls) -> "OptunaL2Policy":
        return cls(
            min_trades=_env_int("OPTUNA_L2_MIN_TRADES", cls.min_trades),
            dd_penalty=_env_float("OPTUNA_L2_DD_PENALTY", cls.dd_penalty),
            pbo_max_candidates=_env_int("OPTUNA_L2_PBO_MAX_CANDIDATES", cls.pbo_max_candidates),
            pbo_min_partitions=_env_int("OPTUNA_L2_PBO_MIN_PARTITIONS", cls.pbo_min_partitions),
        )


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


def _strategy_returns_by_partition_from_trials(
    trials: list[Any],
    *,
    max_candidates: int | None = None,
    min_partitions: int | None = None,
) -> dict[str, list[float]]:
    """Extract equal-length candidate partition returns for CSCV rank-logit PBO."""
    policy = OptunaL2Policy.from_env()
    max_candidates = max_candidates if max_candidates is not None else policy.pbo_max_candidates
    min_partitions = min_partitions if min_partitions is not None else policy.pbo_min_partitions
    candidates: list[tuple[float, int, list[float]]] = []
    expected_len: int | None = None

    for trial in trials:
        value = getattr(trial, "value", None)
        attrs = getattr(trial, "user_attrs", {}) or {}
        raw_returns = attrs.get("partition_returns")
        if value is None or not isinstance(raw_returns, list):
            continue
        if len(raw_returns) < min_partitions:
            continue
        partition_returns = [float(v) for v in raw_returns]
        if expected_len is None:
            expected_len = len(partition_returns)
        if len(partition_returns) != expected_len:
            continue
        candidates.append((float(value), int(getattr(trial, "number", 0)), partition_returns))

    candidates.sort(key=lambda item: item[0], reverse=True)
    return {
        f"trial_{number}": partition_returns
        for _, number, partition_returns in candidates[:max_candidates]
    }


def _pbo_audit_from_strategy_returns(
    strategy_returns_by_partition: dict[str, list[float]],
) -> dict[str, Any]:
    """Run CSCV rank-logit PBO on Optuna candidate partition returns."""
    from services.pbo_service import _run_cscv_rank_logit_pbo

    result = _run_cscv_rank_logit_pbo(strategy_returns_by_partition)
    pbo_value = 1.0 if not strategy_returns_by_partition else float(result.pbo)
    return {
        "method": result.method,
        "pbo": round(pbo_value, 6),
        "go_live_verdict": result.go_live_verdict,
        "verdict_reason": result.verdict_reason,
        "n_partitions": result.n_partitions,
        "n_combinations": result.n_combinations,
        "n_candidates": len(strategy_returns_by_partition),
        "oos_mean_return": round(float(result.oos_mean_return), 6),
        "degradation": round(float(result.degradation), 6),
        "selected_strategy_counts": result.selected_strategy_counts,
    }


def _l2_push_allowed(
    *,
    push_kv: bool,
    dry_run: bool,
    best_params_nested: dict[str, Any] | None,
    pbo_audit: dict[str, Any] | None,
    walk_forward_evidence: dict[str, Any] | None = None,
    require_walk_forward: bool = True,
) -> bool:
    return not _l2_push_blockers(
        push_kv=push_kv,
        dry_run=dry_run,
        best_params_nested=best_params_nested,
        pbo_audit=pbo_audit,
        walk_forward_evidence=walk_forward_evidence,
        require_walk_forward=require_walk_forward,
    )


def _walk_forward_evidence_passed(walk_forward_evidence: dict[str, Any] | None) -> bool:
    if not isinstance(walk_forward_evidence, dict) or not walk_forward_evidence:
        return False
    decision = str(walk_forward_evidence.get("decision") or walk_forward_evidence.get("status") or "").upper()
    return bool(
        walk_forward_evidence.get("passed")
        or walk_forward_evidence.get("gate_pass")
        or decision == "PASS"
    )


def _l2_push_blockers(
    *,
    push_kv: bool,
    dry_run: bool,
    best_params_nested: dict[str, Any] | None,
    pbo_audit: dict[str, Any] | None,
    walk_forward_evidence: dict[str, Any] | None = None,
    require_walk_forward: bool = True,
) -> list[str]:
    blockers: list[str] = []
    if not push_kv or dry_run or not best_params_nested:
        if not push_kv:
            blockers.append("push_kv_disabled")
        if dry_run:
            blockers.append("dry_run")
        if not best_params_nested:
            blockers.append("best_params_missing")
        return blockers
    if str((pbo_audit or {}).get("go_live_verdict") or "").upper() != "PASS":
        blockers.append("pbo_audit_not_passed")
    if require_walk_forward and not _walk_forward_evidence_passed(walk_forward_evidence):
        blockers.append("walk_forward_evidence_not_passed")
    return blockers


def _score_l2_trial(
    *,
    sharpe: float,
    max_drawdown: float,
    n_trades: int,
    policy: OptunaL2Policy,
) -> float:
    """Score a Mode B replay trial with policy-driven guardrails."""
    if n_trades < policy.min_trades:
        return -1.0
    return sharpe - policy.dd_penalty * max_drawdown


def run_l2_sensitivity_search(
    search_space: Optional[list[dict[str, Any]]],
    start_date: str,
    end_date: str,
    baseline_config: dict,
    n_trials: int = 50,
    dd_penalty: float | None = None,
    initial_capital: float = 1_000_000.0,
    sampler_name: str = "nsga2",
    seed: int = 42,
    policy: OptunaL2Policy | None = None,
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

    policy = policy or OptunaL2Policy.from_env()
    if dd_penalty is not None:
        policy = OptunaL2Policy(
            min_trades=policy.min_trades,
            dd_penalty=float(dd_penalty),
            pbo_max_candidates=policy.pbo_max_candidates,
            pbo_min_partitions=policy.pbo_min_partitions,
        )

    space = list(search_space or DEFAULT_SEARCH_SPACE)
    if not space:
        raise ValueError("run_l2_sensitivity_search: empty search_space")

    # Mode B objective — import lazily so unit-test stubs can intercept
    from services.backtest_engine import replay_period, BacktestDataset  # type: ignore

    # Load dataset ONCE outside objective — D6 pattern. Replay loop + D1 query
    # per trial would be N+1 disaster (200+ trials × 580+ days). Module docstring
    # on replay_period_loading spells this out.
    logger.info(f"[L2 Optuna] Loading BacktestDataset {start_date}~{end_date}")
    dataset = BacktestDataset.load_from_d1(start_date=start_date, end_date=end_date)
    logger.info(f"[L2 Optuna] Dataset loaded, starting {n_trials} trials")

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
                dataset=dataset,
                start_date=start_date,
                end_date=end_date,
                params=params,
                mode="B",
                initial_capital=initial_capital,
            )
        except Exception as e:
            logger.warning(f"[L2 Optuna] trial {trial.number} replay crashed: {e}")
            return -1e9

        # replay_period returns BacktestMetrics dataclass, not dict.
        sharpe   = float(getattr(result, "sharpe", None) or 0.0)
        max_dd   = float(getattr(result, "max_drawdown", 0.0) or 0.0)
        n_trades = int(getattr(result, "total_trades", 0) or 0)
        partition_returns = getattr(result, "partition_returns", None) or []

        # Min-trade guard — avoid rewarding "no-trade high-sharpe" degenerate solutions
        if n_trades < policy.min_trades:
            logger.info(f"[L2 Optuna] trial {trial.number} only {n_trades} trades → penalized")

        score = _score_l2_trial(
            sharpe=sharpe,
            max_drawdown=max_dd,
            n_trades=n_trades,
            policy=policy,
        )
        trial.set_user_attr("partition_returns", partition_returns)
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

    strategy_returns_by_partition = _strategy_returns_by_partition_from_trials(
        study.trials,
        max_candidates=policy.pbo_max_candidates,
        min_partitions=policy.pbo_min_partitions,
    )
    pbo_audit = _pbo_audit_from_strategy_returns(strategy_returns_by_partition)

    return {
        "best_value": best.value,
        "best_params": dict(best.params),
        "best_params_nested": nested,
        "n_trials": len(study.trials),
        "strategy_returns_by_partition": strategy_returns_by_partition,
        "pbo_audit": pbo_audit,
        "policy": {
            "min_trades": policy.min_trades,
            "dd_penalty": policy.dd_penalty,
            "pbo_max_candidates": policy.pbo_max_candidates,
            "pbo_min_partitions": policy.pbo_min_partitions,
        },
        "all_trials": [
            {
                "number": t.number,
                "value": t.value,
                "params": dict(t.params),
                "partition_returns": t.user_attrs.get("partition_returns"),
            }
            for t in study.trials if t.value is not None
        ],
    }
