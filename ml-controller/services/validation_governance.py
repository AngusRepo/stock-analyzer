"""Unified validation packet for P4/P9 governance.

This module is read-only. It joins backtest, Monte Carlo, CSCV/PBO,
walk-forward, slippage, and metric explanations into one packet so
promotion and Strategy Lab do not grow separate validation owners.
"""

from __future__ import annotations

import math
import random
from statistics import NormalDist
from datetime import datetime, timezone
from typing import Any


VALIDATION_PACKET_SCHEMA_VERSION = "validation-governance-packet-v1"
VALIDATION_LADDER_PACKET_SCHEMA_VERSION = "validation-ladder-packet-v1"
STRATEGY_REPLAY_CONTRACT_VERSION = "strategy-replay-contract-v1"
STRATEGY_LAB_RECORD_VERSION = "strategy-lab-record-v1"


VALIDATION_SCOPE = {
    "purged_cv": "required",
    "dynamic_embargo": "required",
    "cpcv_cscv": "required",
    "pbo_method": "cscv_rank_logit",
    "deflated_sharpe": "exact_bailey_lopez_de_prado_required_for_promotion",
    "monte_carlo": "block_or_regime_bootstrap_required",
    "walk_forward": "required_before_final_promotion",
    "train_serve_parity": "required",
    "slippage_fee_liquidity": "required",
    "data_snooping": "white_reality_check_or_hansen_spa",
    "model_family_validation_owners_are_declared_in_training_metadata": "required",
    "known_gaps": [
        "replay_without_return_series_uses_advisory_lower_bound_only",
    ],
}


DSR_ADVISORY_MISSING_INPUTS = [
    "skew",
    "kurtosis",
    "return_series",
    "effective_trials",
    "benchmark_sharpe_distribution",
]


VALIDATION_LADDER_LEVELS = [
    "L0_backtest",
    "L1_walk_forward",
    "L2_mcpt",
    "L3_block_bootstrap",
    "L4_bonferroni_selection_bias",
    "L5_oos",
    "L6_regime_split",
    "L7_combinatorial_purged_cv",
    "L8_probabilistic_sharpe",
    "L9_reality_check",
    "L10_paper_trading",
]


def _as_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return default
    try:
        if text.endswith("%"):
            return float(text[:-1]) / 100.0
        return float(text)
    except ValueError:
        return default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _policy_dict(policy: Any) -> dict[str, Any]:
    if isinstance(policy, dict):
        return policy
    to_dict = getattr(policy, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return {}


def _requires_promotion_grade_evidence(source: str, external_risk_required: bool) -> bool:
    if not external_risk_required:
        return False
    normalized = str(source or "").lower()
    return normalized in {
        "promotion_gate",
        "alpha_policy_latest_gate",
        "alpha_policy_evidence_gate",
        "parameter_candidate_evidence_gate",
        "model_artifact_candidate_evidence_gate",
    }


def _pct(value: Any) -> str:
    return f"{_as_float(value) * 100:.1f}%"


def _gate(
    name: str,
    passed: bool,
    *,
    status: str | None = None,
    severity: str = "blocking",
    reason: str = "",
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved = status or ("PASS" if passed else "FAIL")
    return {
        "name": name,
        "status": resolved,
        "passed": resolved in {"PASS", "WARN"},
        "severity": severity,
        "reason": reason,
        "evidence": evidence or {},
    }


def _sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, value))))


def _float_series(values: Any) -> list[float]:
    if not isinstance(values, list):
        return []
    out: list[float] = []
    for value in values:
        parsed = _as_float(value, math.nan)
        if math.isfinite(parsed):
            out.append(parsed)
    return out


def _sample_moments(values: list[float]) -> tuple[float, float, float]:
    n = len(values)
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / max(n - 1, 1)
    std = math.sqrt(variance)
    if std <= 0:
        return mean, 0.0, 3.0
    centered = [(v - mean) / std for v in values]
    skew = sum(v**3 for v in centered) / n
    kurtosis = sum(v**4 for v in centered) / n
    return mean, skew, kurtosis


def deflated_sharpe_advisory_lower_bound(
    sharpe: Any,
    sample_count: Any,
    *,
    trials: int = 20,
    min_adjusted_sharpe: float = 0.25,
) -> dict[str, Any]:
    """Conservative replay-only lower bound when full DSR inputs are missing.

    Production promotion uses deflated_sharpe_exact. This helper exists only
    for replay packets that do not carry raw return_series.
    """

    raw_sharpe = _as_float(sharpe, 0.0)
    n = max(0, _as_int(sample_count, 0))
    t = max(1, _as_int(trials, 20))
    common = {
        "method": "deflated_sharpe_advisory_lower_bound",
        "exact_formula": False,
        "promotion_eligible": False,
        "missing_inputs": DSR_ADVISORY_MISSING_INPUTS,
        "raw_sharpe": raw_sharpe,
        "sample_count": n,
        "trials": t,
    }
    if n < 2:
        return {
            **common,
            "status": "FAIL",
            "passed": False,
            "adjusted_sharpe": 0.0,
            "probability": 0.0,
            "reason": "sample_count_lt_2",
        }

    sampling_penalty = math.sqrt((1.0 + 0.5 * raw_sharpe * raw_sharpe) / max(n - 1, 1))
    multiple_test_penalty = math.sqrt(2.0 * math.log(t)) * sampling_penalty if t > 1 else 0.0
    adjusted = raw_sharpe - multiple_test_penalty
    probability = _sigmoid(adjusted * math.sqrt(max(n - 1, 1)))
    passed = adjusted >= min_adjusted_sharpe and probability >= 0.70
    return {
        **common,
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "raw_sharpe": round(raw_sharpe, 6),
        "adjusted_sharpe": round(adjusted, 6),
        "probability": round(probability, 6),
        "min_adjusted_sharpe": min_adjusted_sharpe,
        "reason": "ok" if passed else "adjusted_sharpe_or_probability_below_threshold",
    }


def deflated_sharpe_exact(
    return_series: Any,
    *,
    trials: int = 20,
    min_probability: float = 0.70,
) -> dict[str, Any]:
    """Bailey/Lopez de Prado style DSR when raw returns are available."""

    returns = _float_series(return_series)
    n = len(returns)
    t = max(1, _as_int(trials, 20))
    if n < 5:
        return {
            "method": "deflated_sharpe_bailey_lopez_de_prado",
            "exact_formula": True,
            "status": "FAIL",
            "passed": False,
            "reason": "return_series_lt_5",
            "sample_count": n,
            "trials": t,
            "skew": None,
            "kurtosis": None,
            "probability": 0.0,
        }

    mean, skew, kurtosis = _sample_moments(returns)
    variance = sum((v - mean) ** 2 for v in returns) / max(n - 1, 1)
    std = math.sqrt(variance)
    if std <= 0:
        return {
            "method": "deflated_sharpe_bailey_lopez_de_prado",
            "exact_formula": True,
            "status": "FAIL",
            "passed": False,
            "reason": "zero_return_variance",
            "sample_count": n,
            "trials": t,
            "skew": round(skew, 6),
            "kurtosis": round(kurtosis, 6),
            "probability": 0.0,
        }

    sharpe = mean / std
    normal = NormalDist()
    gamma = 0.5772156649015329
    # Expected maximum Sharpe under multiple trials from Bailey/Lopez de Prado.
    # Clamp quantile inputs to avoid numerical extremes.
    p1 = min(max(1.0 - 1.0 / t, 1e-6), 1 - 1e-6)
    p2 = min(max(1.0 - 1.0 / (t * math.e), 1e-6), 1 - 1e-6)
    variance_sr = max(1e-12, (1.0 - skew * sharpe + ((kurtosis - 1.0) / 4.0) * sharpe * sharpe) / max(n - 1, 1))
    benchmark_sr = math.sqrt(variance_sr) * ((1.0 - gamma) * normal.inv_cdf(p1) + gamma * normal.inv_cdf(p2))
    denominator = math.sqrt(max(1e-12, 1.0 - skew * sharpe + ((kurtosis - 1.0) / 4.0) * sharpe * sharpe))
    z_score = ((sharpe - benchmark_sr) * math.sqrt(n - 1)) / denominator
    probability = normal.cdf(z_score)
    passed = probability >= min_probability and sharpe > benchmark_sr
    return {
        "method": "deflated_sharpe_bailey_lopez_de_prado",
        "exact_formula": True,
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "reason": "ok" if passed else "deflated_sharpe_probability_below_threshold",
        "sample_count": n,
        "trials": t,
        "raw_sharpe": round(sharpe, 6),
        "benchmark_sharpe": round(benchmark_sr, 6),
        "probability": round(probability, 6),
        "min_probability": min_probability,
        "skew": round(skew, 6),
        "kurtosis": round(kurtosis, 6),
    }


def deflated_sharpe_evidence(
    backtest: dict[str, Any],
    *,
    trials: int = 20,
    min_adjusted_sharpe: float = 0.25,
    min_probability: float = 0.70,
) -> dict[str, Any]:
    return_series = _float_series(backtest.get("return_series"))
    if return_series:
        return deflated_sharpe_exact(
            return_series,
            trials=trials,
            min_probability=min_probability,
        )
    return deflated_sharpe_advisory_lower_bound(
        backtest.get("sharpe"),
        backtest.get("total_trades"),
        trials=trials,
        min_adjusted_sharpe=min_adjusted_sharpe,
    )


def data_snooping_reality_check(
    strategy_returns_by_partition: dict[str, list[float]],
    *,
    n_bootstrap: int = 1000,
    seed: int = 42,
    alpha: float = 0.20,
) -> dict[str, Any]:
    """White Reality Check style max-stat bootstrap across candidates.

    This guards against picking the best-looking candidate from many Optuna/GA
    trials or model variants. It uses centered returns and a deterministic
    bootstrap seed so gate results are reproducible.
    """

    cleaned = {
        str(name): _float_series(values)
        for name, values in (strategy_returns_by_partition or {}).items()
        if isinstance(values, list)
    }
    cleaned = {name: values for name, values in cleaned.items() if len(values) >= 4}
    if len(cleaned) < 2:
        return {
            "method": "white_reality_check",
            "status": "FAIL",
            "passed": False,
            "go_live_verdict": "FAIL",
            "reason": "requires_at_least_two_candidates_with_four_partitions",
            "candidate_count": len(cleaned),
            "p_value": 1.0,
        }

    n = min(len(values) for values in cleaned.values())
    aligned = {name: values[:n] for name, values in cleaned.items()}
    means = {name: sum(values) / n for name, values in aligned.items()}
    best_candidate = max(means, key=means.get)
    best_mean = means[best_candidate]
    observed = math.sqrt(n) * max(0.0, best_mean)
    centered = {
        name: [value - means[name] for value in values]
        for name, values in aligned.items()
    }
    rng = random.Random(seed)
    sims = max(1, _as_int(n_bootstrap, 1000))
    exceed = 0
    for _ in range(sims):
        indices = [rng.randrange(n) for _ in range(n)]
        boot_best = max(
            sum(values[i] for i in indices) / n
            for values in centered.values()
        )
        if math.sqrt(n) * boot_best >= observed:
            exceed += 1
    p_value = (exceed + 1) / (sims + 1)
    passed = p_value <= alpha and best_mean > 0.0
    return {
        "method": "white_reality_check",
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "go_live_verdict": "PASS" if passed else "FAIL",
        "reason": "ok" if passed else "data_snooping_p_value_above_threshold",
        "candidate_count": len(aligned),
        "partition_count": n,
        "best_candidate": best_candidate,
        "best_mean_return": round(best_mean, 6),
        "p_value": round(p_value, 6),
        "alpha": alpha,
        "n_bootstrap": sims,
        "seed": seed,
    }


def hansen_spa_reality_check(
    strategy_returns_by_partition: dict[str, list[float]],
    *,
    benchmark: str = "champion",
    n_bootstrap: int = 1000,
    seed: int = 42,
    alpha: float = 0.20,
) -> dict[str, Any]:
    """Hansen SPA-style bootstrap versus a benchmark return series.

    This is intentionally conservative: candidates must beat the benchmark
    on mean excess return and pass a max-stat bootstrap across candidates.
    """

    cleaned = {
        str(name): _float_series(values)
        for name, values in (strategy_returns_by_partition or {}).items()
        if isinstance(values, list)
    }
    cleaned = {name: values for name, values in cleaned.items() if len(values) >= 4}
    if benchmark not in cleaned or len(cleaned) < 2:
        return {
            "method": "hansen_spa",
            "status": "FAIL",
            "passed": False,
            "go_live_verdict": "FAIL",
            "reason": "requires_benchmark_and_at_least_one_candidate",
            "benchmark": benchmark,
            "candidate_count": max(0, len(cleaned) - (1 if benchmark in cleaned else 0)),
            "p_value": 1.0,
        }

    n = min(len(values) for values in cleaned.values())
    benchmark_returns = cleaned[benchmark][:n]
    excess_by_candidate = {
        name: [values[i] - benchmark_returns[i] for i in range(n)]
        for name, values in cleaned.items()
        if name != benchmark
    }
    excess_by_candidate = {
        name: values for name, values in excess_by_candidate.items()
        if len(values) >= 4
    }
    if not excess_by_candidate:
        return {
            "method": "hansen_spa",
            "status": "FAIL",
            "passed": False,
            "go_live_verdict": "FAIL",
            "reason": "no_candidate_excess_series",
            "benchmark": benchmark,
            "candidate_count": 0,
            "p_value": 1.0,
        }

    means = {name: sum(values) / n for name, values in excess_by_candidate.items()}
    best_candidate = max(means, key=means.get)
    best_mean = means[best_candidate]
    observed = math.sqrt(n) * max(0.0, best_mean)
    centered = {
        name: [value - means[name] for value in values]
        for name, values in excess_by_candidate.items()
    }
    rng = random.Random(seed)
    sims = max(1, _as_int(n_bootstrap, 1000))
    exceed = 0
    for _ in range(sims):
        indices = [rng.randrange(n) for _ in range(n)]
        boot_best = max(
            sum(values[i] for i in indices) / n
            for values in centered.values()
        )
        if math.sqrt(n) * boot_best >= observed:
            exceed += 1
    p_value = (exceed + 1) / (sims + 1)
    passed = best_mean > 0.0 and p_value <= alpha
    return {
        "method": "hansen_spa",
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "go_live_verdict": "PASS" if passed else "FAIL",
        "reason": "ok" if passed else "spa_p_value_or_excess_return_failed",
        "benchmark": benchmark,
        "candidate_count": len(excess_by_candidate),
        "partition_count": n,
        "best_candidate": best_candidate,
        "best_mean_excess_return": round(best_mean, 6),
        "p_value": round(p_value, 6),
        "alpha": alpha,
        "n_bootstrap": sims,
        "seed": seed,
    }


def explain_backtest_metrics(backtest: dict[str, Any]) -> list[dict[str, Any]]:
    """Human-readable metric explanations for Strategy Lab/OBS drilldown."""

    total_trades = _as_int(backtest.get("total_trades"), 0)
    sharpe = _as_float(backtest.get("sharpe"), 0.0)
    max_drawdown = _as_float(backtest.get("max_drawdown"), 0.0)
    profit_factor = _as_float(backtest.get("profit_factor"), 0.0)
    win_rate = _as_float(backtest.get("win_rate"), 0.0)
    expectancy = _as_float(backtest.get("expectancy"), 0.0)
    fill_rate = _as_float(backtest.get("fill_rate"), 0.0)
    return [
        {
            "metric": "total_trades",
            "value": total_trades,
            "meaning_zh": "交易次數，代表這次回測真正完成的樣本量。",
            "interpretation_zh": "樣本太少時 Sharpe、最大回撤、勝率都容易失真；production gate 會要求足夠交易數。",
        },
        {
            "metric": "sharpe",
            "value": round(sharpe, 3),
            "meaning_zh": "風險調整後報酬，衡量每承擔一單位波動換到多少報酬。",
            "interpretation_zh": "不能只看原始 Sharpe，還要搭配 Deflated Sharpe、PBO、Monte Carlo 與 regime split。",
        },
        {
            "metric": "max_drawdown",
            "value": round(max_drawdown, 4),
            "display": _pct(max_drawdown),
            "meaning_zh": "最大回撤，代表資產曲線從高點到低點的最大跌幅。",
            "interpretation_zh": "這是最直覺的尾端風險；需要搭配 Monte Carlo 95% tail-risk 看壓力情境。",
        },
        {
            "metric": "profit_factor",
            "value": round(profit_factor, 3),
            "meaning_zh": "獲利交易總額除以虧損交易總額；大於 1 代表總獲利高於總虧損。",
            "interpretation_zh": "若只略高於 1，代表優勢可能很薄，需再檢查交易成本與不同 regime 的穩定度。",
        },
        {
            "metric": "win_rate",
            "value": round(win_rate, 4),
            "display": _pct(win_rate),
            "meaning_zh": "勝率，代表交易中賺錢的比例。",
            "interpretation_zh": "勝率不能單獨看；低勝率高賺賠比也可能有效，高勝率低賺賠比也可能很脆弱。",
        },
        {
            "metric": "expectancy",
            "value": round(expectancy, 5),
            "meaning_zh": "每筆交易的平均期望報酬。",
            "interpretation_zh": "用來判斷策略長期是否有正期望；若接近 0，容易被滑價與手續費吃掉。",
        },
        {
            "metric": "fill_rate",
            "value": round(fill_rate, 4),
            "display": _pct(fill_rate),
            "meaning_zh": "成交率，代表進場嘗試中實際成交的比例。",
            "interpretation_zh": "可檢查限價、流動性、追高/接刀 gate 是否讓策略難以真正成交。",
        },
    ]


def backtest_metrics_to_dict(metrics: Any, *, parity_audit: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "mode": str(getattr(metrics, "mode", "") or "").upper(),
        "total_trades": _as_int(getattr(metrics, "total_trades", 0), 0),
        "win_rate": _as_float(getattr(metrics, "win_rate", 0.0), 0.0),
        "sharpe": _as_float(getattr(metrics, "sharpe", 0.0), 0.0),
        "sortino": _as_float(getattr(metrics, "sortino", 0.0), 0.0),
        "calmar": _as_float(getattr(metrics, "calmar", 0.0), 0.0),
        "max_drawdown": _as_float(getattr(metrics, "max_drawdown", 1.0), 1.0),
        "profit_factor": _as_float(getattr(metrics, "profit_factor", 0.0), 0.0),
        "expectancy": _as_float(getattr(metrics, "expectancy", 0.0), 0.0),
        "fill_rate": _as_float(getattr(metrics, "fill_rate", 0.0), 0.0),
        "entry_attempts": _as_int(getattr(metrics, "entry_attempts", 0), 0),
        "absolute_confidence": getattr(metrics, "absolute_confidence", None),
        "sanity_flags": getattr(metrics, "sanity_flags", []) or [],
        "realism_warnings": getattr(metrics, "realism_warnings", []) or [],
        "per_regime": getattr(metrics, "per_regime", {}) or {},
        "return_series": [
            _as_float(getattr(trade, "profit_ratio", None))
            for trade in (getattr(metrics, "trades", []) or [])
            if getattr(trade, "profit_ratio", None) is not None
        ],
        "parity_audit": parity_audit or {},
    }


def build_strategy_replay_contract(
    *,
    mode: str,
    start_date: str,
    end_date: str,
    persisted: bool,
    symbols_count: int | None,
    regime_label: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": STRATEGY_REPLAY_CONTRACT_VERSION,
        "owner": "ml-controller.backtest.replay",
        "mode": str(mode or "").upper(),
        "timerange": {"start_date": start_date, "end_date": end_date},
        "persisted_to_promotion_store": bool(persisted),
        "symbols_count": symbols_count,
        "regime_label": regime_label,
        "mutation_scope": "read_only" if not persisted else "backtest_results_only",
        "production_promotion_allowed": False,
        "promotion_requires": [
            "Mode B replay",
            "Purged CV / dynamic embargo",
            "worker/API parity PASS",
            "Monte Carlo block or regime bootstrap PASS",
            "CPCV/CSCV rank-logit PBO PASS",
            "validation packet PASS",
        ],
    }


def build_strategy_lab_record(
    *,
    hypothesis: str | None,
    data_slice: dict[str, Any] | None,
    metrics: dict[str, Any],
    validation_packet: dict[str, Any] | None,
    strategy_replay_contract: dict[str, Any] | None,
    dataset_snapshot: dict[str, Any] | None = None,
    model_versions: dict[str, Any] | None = None,
    verdict: str | None = None,
    follow_up: list[str] | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """Create a Strategy Lab evidence record without becoming a promote owner."""

    gates = [
        _gate(
            "hypothesis_present",
            bool(str(hypothesis or "").strip()),
            reason="Strategy Lab records must explain what idea is being tested.",
        ),
        _gate(
            "data_slice_present",
            bool(data_slice),
            reason="Strategy Lab records must declare the replay universe/date slice.",
            evidence=data_slice or {},
        ),
        _gate(
            "dataset_snapshot_present",
            bool(dataset_snapshot),
            reason="Dataset snapshot is required for reproducible backtests.",
            evidence=dataset_snapshot or {},
        ),
        _gate(
            "strategy_replay_contract_present",
            bool(strategy_replay_contract),
            reason="Replay contract is required to avoid Strategy Lab/backtest split-brain.",
            evidence=strategy_replay_contract or {},
        ),
        _gate(
            "validation_packet_present",
            bool(validation_packet),
            reason="Validation packet is required before any promotion discussion.",
            evidence={
                "decision": (validation_packet or {}).get("decision"),
                "failed_gates": (validation_packet or {}).get("failed_gates"),
            },
        ),
    ]
    failed = [gate for gate in gates if gate["status"] == "FAIL"]
    validation_decision = str((validation_packet or {}).get("decision") or "MISSING").upper()
    resolved_verdict = (verdict or ("candidate" if validation_decision == "PASS" and not failed else "needs_review")).lower()
    return {
        "schema_version": STRATEGY_LAB_RECORD_VERSION,
        "owner": "ml-controller.validation_governance",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "hypothesis": str(hypothesis or "").strip(),
        "data_slice": data_slice or {},
        "dataset_snapshot": dataset_snapshot or {},
        "model_versions": model_versions or {},
        "metrics": metrics,
        "validation_packet": validation_packet or {},
        "strategy_replay_contract": strategy_replay_contract or {},
        "verdict": resolved_verdict,
        "follow_up": follow_up or [],
        "tags": tags or [],
        "production_promotion_allowed": False,
        "promotion_owner": "model_artifact_registry/confirm_promotion",
        "decision": "PASS" if not failed and validation_decision == "PASS" else "FAIL",
        "failed_gates": [gate["name"] for gate in failed],
        "gates": gates,
        "summary_zh": (
            "策略實驗證據完整，可進入人工 review；promotion 仍必須走 model_pool/promote_check。"
            if not failed and validation_decision == "PASS"
            else "策略實驗證據不足或驗證未通過；不可直接推 production。"
        ),
    }


def _walk_forward_gate(walk_forward: dict[str, Any] | None, *, required: bool) -> dict[str, Any]:
    if not walk_forward:
        status = "FAIL" if required else "WARN"
        return _gate(
            "walk_forward",
            False if required else True,
            status=status,
            severity="blocking" if required else "advisory",
            reason="walk_forward_evidence_not_attached_to_latest_gate",
            evidence={"required_before_final_promotion": True},
        )
    passed = bool(walk_forward.get("passed") or walk_forward.get("gate_pass"))
    return _gate(
        "walk_forward",
        passed,
        reason="walk-forward must confirm OOS behavior across windows",
        evidence=walk_forward,
    )


def _ladder_result(
    *,
    level: str,
    index: int,
    passed: bool,
    missing_evidence: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "level": level,
        "index": index,
        "passed": passed,
        "missing_evidence": missing_evidence or [],
        "evidence": evidence or {},
    }


def _ladder_backtest(backtest: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    total_trades = _as_int(backtest.get("total_trades"), 0)
    sharpe = _as_float(backtest.get("sharpe"), 0.0)
    passed = bool(backtest) and total_trades > 0
    missing = [] if passed else ["backtest_result_missing_or_empty"]
    return passed, missing, {"total_trades": total_trades, "sharpe": sharpe, "mode": backtest.get("mode")}


def _ladder_walk_forward(walk_forward: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    windows = _as_int(walk_forward.get("windows"), 0)
    passed = bool(walk_forward.get("passed") or walk_forward.get("gate_pass")) and windows >= 4
    missing = [] if passed else ["walk_forward_4_windows_required"]
    return passed, missing, {"windows": windows, "passed": bool(walk_forward.get("passed") or walk_forward.get("gate_pass"))}


def _ladder_monte_carlo(monte_carlo: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    verdict = str(monte_carlo.get("go_live_verdict") or monte_carlo.get("verdict") or "").upper()
    passed = bool(monte_carlo.get("passed")) or verdict == "PASS"
    missing = [] if passed else ["monte_carlo_mcpt_missing_or_failed"]
    return passed, missing, {"verdict": verdict or None, "method": monte_carlo.get("simulation_method")}


def _ladder_block_bootstrap(monte_carlo: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    method = str(monte_carlo.get("simulation_method") or "").lower()
    verdict = str(monte_carlo.get("go_live_verdict") or monte_carlo.get("verdict") or "").upper()
    passed = (bool(monte_carlo.get("passed")) or verdict == "PASS") and method in {
        "block_bootstrap",
        "regime_block_bootstrap",
    }
    missing = [] if passed else ["block_or_regime_bootstrap_required"]
    return passed, missing, {"method": method or None, "mdd_95th": _as_float(monte_carlo.get("mdd_95th"), 1.0)}


def _ladder_selection_bias(selection_bias: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    method = str(selection_bias.get("method") or "").lower()
    adjusted_p = _as_float(selection_bias.get("adjusted_p_value"), 1.0)
    passed = bool(selection_bias.get("passed")) and method == "bonferroni" and adjusted_p <= 0.05
    missing = [] if passed else ["bonferroni_selection_bias_missing_or_failed"]
    return passed, missing, {
        "method": method or None,
        "candidate_count": _as_int(selection_bias.get("candidate_count"), 0),
        "adjusted_p_value": adjusted_p,
    }


def _ladder_oos(oos: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    samples = _as_int(oos.get("samples") or oos.get("test_rows"), 0)
    oos_return = _as_float(oos.get("oos_mean_return") or oos.get("mean_return"), 0.0)
    passed = bool(oos.get("passed")) or (samples > 0 and oos_return >= 0.0)
    missing = [] if passed else ["oos_sample_missing_or_negative"]
    return passed, missing, {"samples": samples, "oos_mean_return": oos_return, "oos_sharpe": oos.get("oos_sharpe")}


def _ladder_regime_split(backtest: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    gate = _regime_split_gate(backtest, policy={}, required=True)
    passed = gate["status"] == "PASS"
    missing = [] if passed else ["regime_split_missing_or_weak"]
    return passed, missing, gate.get("evidence", {})


def _ladder_cpcv(cpcv: dict[str, Any], pbo: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    cpcv_method = str(cpcv.get("method") or "").lower()
    pbo_method = str(pbo.get("method") or "").lower()
    cpcv_pass = bool(cpcv.get("passed")) and cpcv_method in {
        "combinatorial_purged_cv",
        "purged_cpcv",
        "cpcv",
    }
    pbo_pass = (
        bool(pbo.get("passed"))
        or str(pbo.get("go_live_verdict") or "").upper() == "PASS"
    ) and pbo_method == "cscv_rank_logit"
    passed = cpcv_pass and pbo_pass and _as_int(cpcv.get("folds"), 0) >= 5 and _as_int(cpcv.get("embargo_days"), 0) > 0
    missing = [] if passed else ["cpcv_purged_cv_and_cscv_pbo_required"]
    return passed, missing, {
        "cpcv_method": cpcv_method or None,
        "folds": _as_int(cpcv.get("folds"), 0),
        "embargo_days": _as_int(cpcv.get("embargo_days"), 0),
        "pbo_method": pbo_method or None,
        "pbo": _as_float(pbo.get("pbo"), 1.0),
    }


def _ladder_probabilistic_sharpe(probabilistic_sharpe: dict[str, Any], backtest: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    if probabilistic_sharpe:
        probability = _as_float(probabilistic_sharpe.get("probability"), 0.0)
        passed = bool(probabilistic_sharpe.get("passed")) and probability >= 0.70
        missing = [] if passed else ["probabilistic_sharpe_probability_below_threshold"]
        return passed, missing, {"method": probabilistic_sharpe.get("method"), "probability": probability}
    dsr = deflated_sharpe_evidence(backtest)
    passed = bool(dsr.get("passed"))
    missing = [] if passed else ["probabilistic_or_deflated_sharpe_required"]
    return passed, missing, dsr


def _ladder_reality_check(data_snooping: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    method = str(data_snooping.get("method") or "").lower()
    verdict = str(data_snooping.get("go_live_verdict") or data_snooping.get("verdict") or "").upper()
    p_value = _as_float(data_snooping.get("p_value"), 1.0)
    passed = verdict == "PASS" and method in {"white_reality_check", "hansen_spa"} and p_value <= 0.20
    missing = [] if passed else ["white_reality_check_or_hansen_spa_required"]
    return passed, missing, {"method": method or None, "p_value": p_value, "verdict": verdict or None}


def _ladder_paper_trading(paper_trading: dict[str, Any]) -> tuple[bool, list[str], dict[str, Any]]:
    paper_days = _as_int(paper_trading.get("paper_days") or paper_trading.get("days"), 0)
    execution_parity = str(paper_trading.get("execution_parity") or "").upper()
    slippage_ok = bool(paper_trading.get("slippage_within_policy", False))
    missing: list[str] = []
    if paper_days < 180:
        missing.append("paper_trading_180_days_required")
    if execution_parity != "PASS":
        missing.append("paper_execution_parity_required")
    if not slippage_ok:
        missing.append("paper_slippage_within_policy_required")
    if not bool(paper_trading.get("passed")):
        missing.append("paper_trading_gate_not_passed")
    return not missing, missing, {
        "paper_days": paper_days,
        "execution_parity": execution_parity or None,
        "slippage_within_policy": slippage_ok,
    }


def build_validation_ladder_packet(
    *,
    candidate_id: str,
    candidate_type: str,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Map research evidence onto the L0-L10 adoption ladder.

    This is read-only. Passing L10 means the candidate is ready for Wei review,
    not that production allocation can be mutated automatically.
    """

    evidence = evidence if isinstance(evidence, dict) else {}
    backtest = evidence.get("backtest") if isinstance(evidence.get("backtest"), dict) else {}
    walk_forward = evidence.get("walk_forward") if isinstance(evidence.get("walk_forward"), dict) else {}
    monte_carlo = evidence.get("monte_carlo") if isinstance(evidence.get("monte_carlo"), dict) else {}
    selection_bias = evidence.get("selection_bias") if isinstance(evidence.get("selection_bias"), dict) else {}
    oos = evidence.get("oos") if isinstance(evidence.get("oos"), dict) else {}
    cpcv = evidence.get("cpcv") if isinstance(evidence.get("cpcv"), dict) else {}
    pbo = evidence.get("pbo") if isinstance(evidence.get("pbo"), dict) else {}
    probabilistic_sharpe = (
        evidence.get("probabilistic_sharpe") if isinstance(evidence.get("probabilistic_sharpe"), dict) else {}
    )
    data_snooping = evidence.get("data_snooping") if isinstance(evidence.get("data_snooping"), dict) else {}
    paper_trading = evidence.get("paper_trading") if isinstance(evidence.get("paper_trading"), dict) else {}

    checks = [
        _ladder_backtest(backtest),
        _ladder_walk_forward(walk_forward),
        _ladder_monte_carlo(monte_carlo),
        _ladder_block_bootstrap(monte_carlo),
        _ladder_selection_bias(selection_bias),
        _ladder_oos(oos),
        _ladder_regime_split(backtest),
        _ladder_cpcv(cpcv, pbo),
        _ladder_probabilistic_sharpe(probabilistic_sharpe, backtest),
        _ladder_reality_check(data_snooping),
        _ladder_paper_trading(paper_trading),
    ]
    level_results = [
        _ladder_result(
            level=VALIDATION_LADDER_LEVELS[idx],
            index=idx,
            passed=passed,
            missing_evidence=missing,
            evidence=summary,
        )
        for idx, (passed, missing, summary) in enumerate(checks)
    ]

    current_idx = -1
    next_required = None
    for result in level_results:
        if result["passed"]:
            current_idx = result["index"]
            continue
        next_required = {
            "level": result["level"],
            "index": result["index"],
            "missing_evidence": result["missing_evidence"],
        }
        break
    current_level = VALIDATION_LADDER_LEVELS[current_idx] if current_idx >= 0 else "NONE"
    reached_l9 = current_idx >= 9
    reached_l10 = current_idx >= 10
    return {
        "schema_version": VALIDATION_LADDER_PACKET_SCHEMA_VERSION,
        "decision_effect": "validation_ladder_only",
        "owner": "ml-controller.validation_governance",
        "candidate_id": str(candidate_id or "").strip(),
        "candidate_type": str(candidate_type or "unknown").strip() or "unknown",
        "current_level": current_level,
        "current_level_index": current_idx,
        "next_required": next_required,
        "level_results": level_results,
        "decision": {
            "ready_for_wei_review": reached_l10,
            "eligible_for_research_promotion_review": reached_l9,
            "eligible_for_production_allocation_review": reached_l10,
            "production_mutation_allowed": False,
            "reason": (
                "l10_ready_for_manual_review"
                if reached_l10
                else f"blocked_at_{next_required['level']}" if next_required else "no_ladder_evidence"
            ),
        },
    }


def _regime_split_gate(
    backtest: dict[str, Any],
    *,
    policy: dict[str, Any],
    required: bool,
) -> dict[str, Any]:
    per_regime = backtest.get("per_regime") if isinstance(backtest.get("per_regime"), dict) else {}
    min_regime_trades = _as_int(policy.get("min_regime_trades"), 10)
    min_regime_return = _as_float(policy.get("min_regime_return"), -0.02)
    min_regime_buckets = _as_int(policy.get("min_regime_buckets"), 2)
    buckets: dict[str, dict[str, Any]] = {}
    weak_regimes: list[str] = []
    for regime, raw in per_regime.items():
        if not isinstance(raw, dict):
            continue
        trades = _as_int(raw.get("trades") or raw.get("total_trades"), 0)
        ret = _as_float(raw.get("return") or raw.get("total_return") or raw.get("oos_return"), 0.0)
        if trades <= 0:
            continue
        buckets[str(regime)] = {"trades": trades, "return": ret}
        if trades >= min_regime_trades and ret < min_regime_return:
            weak_regimes.append(str(regime))

    enough_buckets = len(buckets) >= min_regime_buckets
    passed = enough_buckets and not weak_regimes
    if not required and not per_regime:
        return _gate(
            "regime_split_validation",
            True,
            status="WARN",
            severity="advisory",
            reason="regime_split_evidence_not_attached_to_replay",
            evidence={
                "required_before_final_promotion": True,
                "min_regime_buckets": min_regime_buckets,
            },
        )
    return _gate(
        "regime_split_validation",
        passed,
        reason="promotion-grade validation must include OOS evidence across multiple regimes",
        evidence={
            "regime_count": len(buckets),
            "min_regime_buckets": min_regime_buckets,
            "min_regime_trades": min_regime_trades,
            "min_regime_return": min_regime_return,
            "weak_regimes": weak_regimes,
            "per_regime": buckets,
        },
    )


def build_validation_packet(
    *,
    source: str,
    backtest: dict[str, Any],
    monte_carlo: dict[str, Any] | None = None,
    pbo: dict[str, Any] | None = None,
    data_snooping: dict[str, Any] | None = None,
    walk_forward: dict[str, Any] | None = None,
    policy: Any | None = None,
    external_risk_required: bool = True,
) -> dict[str, Any]:
    p = _policy_dict(policy)
    promotion_required = _requires_promotion_grade_evidence(source, external_risk_required)
    min_trades = _as_int(p.get("min_trades"), 60)
    min_sharpe = _as_float(p.get("min_sharpe"), 0.5)
    min_profit_factor = _as_float(p.get("min_profit_factor"), 1.05)
    max_backtest_mdd = _as_float(p.get("max_backtest_mdd"), 0.25)
    max_mc_mdd_95th = _as_float(p.get("max_mc_mdd_95th"), 0.20)
    max_pbo = _as_float(p.get("max_pbo"), 0.50)
    max_data_snooping_p = _as_float(p.get("max_data_snooping_p"), 0.20)

    total_trades = _as_int(backtest.get("total_trades"), 0)
    mode = str(backtest.get("mode") or "").upper()
    sanity_flags = backtest.get("sanity_flags") if isinstance(backtest.get("sanity_flags"), list) else []
    realism_warnings = (
        backtest.get("realism_warnings") if isinstance(backtest.get("realism_warnings"), list) else []
    )
    parity_audit = backtest.get("parity_audit") if isinstance(backtest.get("parity_audit"), dict) else {}
    worker_parity = parity_audit.get("worker_parity") if isinstance(parity_audit.get("worker_parity"), dict) else {}
    confidence = str(backtest.get("absolute_confidence") or "").lower()

    gates: list[dict[str, Any]] = [
        _gate(
            "backtest_mode_b",
            mode == "B",
            reason="promotion-grade replay must use Mode B with historical ML confidence",
            evidence={"mode": mode or "unknown"},
        ),
        _gate(
            "backtest_sample_size",
            total_trades >= min_trades,
            reason=f"total_trades must be >= {min_trades}",
            evidence={"total_trades": total_trades},
        ),
        _gate(
            "backtest_confidence",
            confidence not in {"", "low", "relative_only"},
            reason="backtest confidence must not be low or relative-only",
            evidence={"absolute_confidence": confidence or "missing"},
        ),
        _gate(
            "backtest_return_quality",
            _as_float(backtest.get("sharpe")) >= min_sharpe
            and _as_float(backtest.get("profit_factor")) >= min_profit_factor
            and _as_float(backtest.get("max_drawdown"), 1.0) <= max_backtest_mdd,
            reason="Sharpe, profit factor, and max drawdown must pass together",
            evidence={
                "sharpe": _as_float(backtest.get("sharpe")),
                "profit_factor": _as_float(backtest.get("profit_factor")),
                "max_drawdown": _as_float(backtest.get("max_drawdown"), 1.0),
            },
        ),
        _gate(
            "worker_parity",
            str(worker_parity.get("decision") or "").upper() == "PASS",
            reason="paper/live path parity must pass before promotion",
            evidence=worker_parity,
        ),
        _gate(
            "sanity_flags",
            not sanity_flags,
            reason="backtest engine must not emit overfit/realism sanity flags",
            evidence={"sanity_flags": sanity_flags, "realism_warning_count": len(realism_warnings)},
        ),
    ]

    dsr = deflated_sharpe_evidence(
        {**backtest, "total_trades": total_trades},
        trials=_as_int(p.get("deflated_sharpe_trials"), 20),
        min_adjusted_sharpe=_as_float(p.get("min_deflated_sharpe"), 0.25),
        min_probability=_as_float(p.get("min_deflated_sharpe_probability"), 0.70),
    )
    dsr_exact = bool(dsr.get("exact_formula"))
    dsr_passed = bool(dsr["passed"]) and (dsr_exact or not promotion_required)
    dsr_reason = (
        dsr["reason"]
        if dsr_passed or dsr_exact or not promotion_required
        else "exact_deflated_sharpe_return_series_required"
    )
    gates.append(_gate("deflated_sharpe", dsr_passed, reason=dsr_reason, evidence=dsr))

    if monte_carlo:
        mc_method = str(monte_carlo.get("simulation_method") or "").lower()
        gates.append(
            _gate(
                "monte_carlo_tail_risk",
                str(monte_carlo.get("go_live_verdict") or "").upper() == "PASS"
                and mc_method in {"block_bootstrap", "regime_block_bootstrap"}
                and _as_float(monte_carlo.get("mdd_95th"), 1.0) <= max_mc_mdd_95th,
                reason="MC must use block/regime bootstrap and keep 95% MDD below policy",
                evidence={
                    "method": mc_method,
                    "mdd_95th": _as_float(monte_carlo.get("mdd_95th"), 1.0),
                    "verdict": monte_carlo.get("go_live_verdict"),
                },
            )
        )
    else:
        gates.append(
            _gate(
                "monte_carlo_tail_risk",
                not external_risk_required,
                status="WARN" if not external_risk_required else "FAIL",
                severity="advisory" if not external_risk_required else "blocking",
                reason="missing_monte_carlo_evidence",
            )
        )

    if pbo:
        gates.append(
            _gate(
                "pbo_overfit_risk",
                str(pbo.get("go_live_verdict") or "").upper() == "PASS"
                and str(pbo.get("method") or "").lower() == "cscv_rank_logit"
                and _as_float(pbo.get("pbo"), 1.0) < max_pbo
                and _as_float(pbo.get("oos_mean_return"), -1.0)
                >= _as_float(p.get("min_oos_mean_return"), 0.0),
                reason="PBO must use CSCV rank-logit and show positive OOS mean return",
                evidence={
                    "method": pbo.get("method"),
                    "pbo": _as_float(pbo.get("pbo"), 1.0),
                    "oos_mean_return": _as_float(pbo.get("oos_mean_return"), -1.0),
                    "verdict": pbo.get("go_live_verdict"),
                },
            )
        )
    else:
        gates.append(
            _gate(
                "pbo_overfit_risk",
                not external_risk_required,
                status="WARN" if not external_risk_required else "FAIL",
                severity="advisory" if not external_risk_required else "blocking",
                reason="missing_pbo_evidence",
            )
        )

    if data_snooping:
        gates.append(
            _gate(
                "data_snooping_overfit_guard",
                str(data_snooping.get("go_live_verdict") or "").upper() == "PASS"
                and str(data_snooping.get("method") or "").lower() in {"white_reality_check", "hansen_spa"}
                and _as_float(data_snooping.get("p_value"), 1.0) <= max_data_snooping_p,
                reason="White Reality Check / Hansen SPA guard must reject data-snooped winners",
                evidence={
                    "method": data_snooping.get("method"),
                    "p_value": _as_float(data_snooping.get("p_value"), 1.0),
                    "max_p_value": max_data_snooping_p,
                    "candidate_count": _as_int(data_snooping.get("candidate_count"), 0),
                    "verdict": data_snooping.get("go_live_verdict"),
                },
            )
        )
    else:
        gates.append(
            _gate(
                "data_snooping_overfit_guard",
                True,
                status="WARN",
                severity="advisory",
                reason="missing_white_reality_check_or_hansen_spa_evidence",
            )
        )

    gates.append(_walk_forward_gate(walk_forward, required=promotion_required))
    gates.append(_regime_split_gate(backtest, policy=p, required=promotion_required))
    gates.append(
        _gate(
            "slippage_fee_liquidity",
            _as_float(backtest.get("fill_rate"), 0.0) >= 0.10 or total_trades >= min_trades,
            reason="Replay must include TW fees/tax, tick slippage, and enough fills to be meaningful",
            evidence={
                "fee_model": "tw_commission_tax_min_fee",
                "slippage_model": "tick_slippage_one_tick",
                "fill_rate": _as_float(backtest.get("fill_rate"), 0.0),
                "entry_attempts": _as_int(backtest.get("entry_attempts"), 0),
            },
        )
    )

    failed = [gate for gate in gates if gate["status"] == "FAIL"]
    warnings = [gate for gate in gates if gate["status"] == "WARN"]
    decision = "PASS" if not failed else "FAIL"
    return {
        "schema_version": VALIDATION_PACKET_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": source,
        "decision": decision,
        "passed": decision == "PASS",
        "validation_scope": dict(VALIDATION_SCOPE),
        "gate_count": len(gates),
        "failed_gates": [gate["name"] for gate in failed],
        "warnings": [gate["name"] for gate in warnings],
        "gates": gates,
        "metric_explanations": explain_backtest_metrics(backtest),
        "summary_zh": (
            "驗證封包通過；仍需確認 walk-forward、parity 與 live smoke 後才能進 production。"
            if decision == "PASS"
            else "驗證封包未通過；請先處理 failed_gates，避免把過擬合或資料不足的策略推進 production。"
        ),
    }
