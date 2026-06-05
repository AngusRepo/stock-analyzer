from __future__ import annotations

import json
from copy import deepcopy
from typing import Any, Callable

from services.monte_carlo_service import _run_monte_carlo
from services.pbo_service import _run_cscv_rank_logit_pbo
from services.validation_governance import hansen_spa_reality_check
from services.promotion_service import (
    build_alpha_policy_evidence_bundle,
    build_parameter_candidate_evidence_bundle,
    evaluate_alpha_policy_evidence_gate,
    evaluate_parameter_candidate_evidence_gate,
)


def _candidate_id(candidate: dict[str, Any]) -> str:
    metadata = candidate.get("metadata") if isinstance(candidate.get("metadata"), dict) else {}
    return str(
        candidate.get("id")
        or candidate.get("sandbox_id")
        or candidate.get("source_id")
        or metadata.get("sandbox_id")
        or "alpha_candidate"
    )


def _candidate_config(candidate: dict[str, Any]) -> dict[str, Any]:
    cfg = candidate.get("config") if isinstance(candidate.get("config"), dict) else {}
    if cfg:
        return cfg
    alpha = candidate.get("alphaFramework") or candidate.get("alpha_framework")
    return {"alphaFramework": alpha} if isinstance(alpha, dict) else {}


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(base)
    for key, value in (overlay or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _metric_attr(metrics: Any, name: str, default: Any = None) -> Any:
    return metrics.get(name, default) if isinstance(metrics, dict) else getattr(metrics, name, default)


def _trade_returns_and_regimes(metrics: Any) -> tuple[list[float], list[str] | None]:
    trades = _metric_attr(metrics, "trades", []) or []
    returns: list[float] = []
    regimes: list[str] = []
    for trade in trades:
        value = trade.get("profit_ratio") if isinstance(trade, dict) else getattr(trade, "profit_ratio", None)
        returns.append(_as_float(value))
        regime = trade.get("entry_regime") if isinstance(trade, dict) else getattr(trade, "entry_regime", None)
        regimes.append(str(regime or "unknown"))
    return returns, regimes if len(regimes) == len(returns) and returns else None


def _per_regime_from_trades(metrics: Any) -> dict[str, dict[str, Any]]:
    returns, regimes = _trade_returns_and_regimes(metrics)
    if not returns or not regimes:
        return {}

    buckets: dict[str, list[float]] = {}
    for value, regime in zip(returns, regimes):
        buckets.setdefault(str(regime or "unknown"), []).append(_as_float(value))

    return {
        regime: {
            "trades": len(values),
            "return": round(sum(values), 8),
            "avg_return": round(sum(values) / len(values), 8),
        }
        for regime, values in buckets.items()
        if values
    }


def _backtest_row(metrics: Any, *, parity_audit: dict[str, Any] | None) -> dict[str, Any]:
    summary = {
        "total_trades": _metric_attr(metrics, "total_trades", 0),
        "sharpe": _metric_attr(metrics, "sharpe", 0.0),
        "profit_factor": _metric_attr(metrics, "profit_factor", 0.0),
        "max_drawdown": _metric_attr(metrics, "max_drawdown", 1.0),
    }
    entry_attempts = _metric_attr(metrics, "entry_attempts", 0)
    entries_filled = _metric_attr(metrics, "entries_filled", 0)
    fill_rate = _metric_attr(metrics, "fill_rate", 0.0)
    skip_reasons = _metric_attr(metrics, "skip_reasons", {}) or {}
    mode_b_prediction_diagnostics = _metric_attr(metrics, "mode_b_prediction_diagnostics", {}) or {}
    mode_b_threshold_diagnostics = _metric_attr(metrics, "mode_b_threshold_diagnostics", {}) or {}
    raw = {
        "mode": _metric_attr(metrics, "mode", "B"),
        "summary": summary,
        "entry_attempts": entry_attempts,
        "entries_filled": entries_filled,
        "fill_rate": fill_rate,
        "skip_reasons": skip_reasons,
        "mode_b_prediction_diagnostics": mode_b_prediction_diagnostics,
        "mode_b_threshold_diagnostics": mode_b_threshold_diagnostics,
        "absolute_confidence": _metric_attr(metrics, "absolute_confidence", "moderate"),
        "sanity_flags": _metric_attr(metrics, "sanity_flags", []) or [],
        "parity_audit": parity_audit or {},
        "per_regime": _metric_attr(metrics, "per_regime", None) or _per_regime_from_trades(metrics),
    }
    return {
        "run_date": _metric_attr(metrics, "end_date", None),
        "strategy": "alpha_candidate",
        "total_trades": summary["total_trades"],
        "sharpe": summary["sharpe"],
        "profit_factor": summary["profit_factor"],
        "max_drawdown": summary["max_drawdown"],
        "entry_attempts": entry_attempts,
        "entries_filled": entries_filled,
        "fill_rate": fill_rate,
        "skip_reasons": skip_reasons,
        "mode_b_prediction_diagnostics": mode_b_prediction_diagnostics,
        "mode_b_threshold_diagnostics": mode_b_threshold_diagnostics,
        "raw_results": json.dumps(raw),
    }


def _monte_carlo_row(metrics: Any, *, n_simulations: int) -> dict[str, Any]:
    returns, regimes = _trade_returns_and_regimes(metrics)
    method = "regime_block_bootstrap" if regimes else "block_bootstrap"
    mc = _run_monte_carlo(
        returns,
        n_simulations=n_simulations,
        method=method,
        trade_regimes=regimes,
    )
    return {
        "source": "backtest",
        "n_trades": mc.n_trades,
        "mdd_95th": mc.mdd_95th,
        "go_live_verdict": mc.go_live_verdict,
        "raw_distribution": json.dumps({
            "simulation_method": mc.simulation_method,
            "block_size": mc.block_size,
            "regime_counts": mc.regime_counts,
        }),
    }


def _pbo_row(champion_metrics: Any, candidate_metrics: Any) -> dict[str, Any]:
    champion_partitions = [_as_float(v) for v in (_metric_attr(champion_metrics, "partition_returns", []) or [])]
    candidate_partitions = [_as_float(v) for v in (_metric_attr(candidate_metrics, "partition_returns", []) or [])]
    pbo = _run_cscv_rank_logit_pbo({
        "champion": champion_partitions,
        "alpha_candidate": candidate_partitions,
    })
    n_trades = int(_metric_attr(candidate_metrics, "total_trades", 0) or 0)
    return {
        "source": "backtest",
        "n_trades": n_trades,
        "pbo": pbo.pbo,
        "oos_mean_return": pbo.oos_mean_return,
        "go_live_verdict": pbo.go_live_verdict,
        "raw_details": json.dumps({
            "method": pbo.method,
            "n_partitions": pbo.n_partitions,
            "n_combinations": pbo.n_combinations,
            "selected_strategy_counts": pbo.selected_strategy_counts,
        }),
    }


def _walk_forward_row(champion_metrics: Any, candidate_metrics: Any) -> dict[str, Any]:
    champion_partitions = [_as_float(v) for v in (_metric_attr(champion_metrics, "partition_returns", []) or [])]
    candidate_partitions = [_as_float(v) for v in (_metric_attr(candidate_metrics, "partition_returns", []) or [])]
    windows = min(len(champion_partitions), len(candidate_partitions))
    if windows <= 0:
        return {
            "method": "paired_partition_walk_forward",
            "passed": False,
            "reason": "missing_partition_returns",
            "windows": 0,
        }

    paired = list(zip(champion_partitions[:windows], candidate_partitions[:windows]))
    candidate_mean = sum(v for _, v in paired) / windows
    champion_mean = sum(v for v, _ in paired) / windows
    positive_ratio = sum(1 for _, v in paired if v > 0) / windows
    beats_ratio = sum(1 for champion, candidate in paired if candidate >= champion) / windows
    passed = windows >= 3 and candidate_mean > 0 and positive_ratio >= 0.5 and beats_ratio >= 0.5
    return {
        "method": "paired_partition_walk_forward",
        "passed": passed,
        "gate_pass": passed,
        "reason": "ok" if passed else "partition_walk_forward_not_stable",
        "windows": windows,
        "candidate_mean_return": round(candidate_mean, 8),
        "champion_mean_return": round(champion_mean, 8),
        "positive_ratio": round(positive_ratio, 6),
        "beats_champion_ratio": round(beats_ratio, 6),
    }


def _data_snooping_row(champion_metrics: Any, candidate_metrics: Any) -> dict[str, Any]:
    champion_partitions = [_as_float(v) for v in (_metric_attr(champion_metrics, "partition_returns", []) or [])]
    candidate_partitions = [_as_float(v) for v in (_metric_attr(candidate_metrics, "partition_returns", []) or [])]
    return hansen_spa_reality_check(
        {
            "champion": champion_partitions,
            "alpha_candidate": candidate_partitions,
        },
        benchmark="champion",
        n_bootstrap=500,
        seed=17,
    )


def run_alpha_candidate_evidence(
    candidate: dict[str, Any],
    *,
    start_date: str,
    end_date: str,
    baseline_config: dict[str, Any] | None = None,
    initial_capital: float = 1_000_000,
    mode: str = "B",
    symbols: list[str] | None = None,
    mc_simulations: int = 1000,
    parity_audit: dict[str, Any] | None = None,
    alpha_replay_applied: bool = False,
    dataset_loader: Callable[..., Any] | None = None,
    replay_fn: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    from services.backtest_engine import BacktestDataset, replay_period

    dataset_loader = dataset_loader or BacktestDataset.load_from_d1
    replay_fn = replay_fn or replay_period

    baseline = deepcopy(baseline_config or {})
    candidate_params = _deep_merge(baseline, _candidate_config(candidate))
    dataset = dataset_loader(start_date=start_date, end_date=end_date, symbols=symbols)
    replay_args = {
        "dataset": dataset,
        "start_date": start_date,
        "end_date": end_date,
        "initial_capital": initial_capital,
        "mode": mode,
    }
    champion_metrics = replay_fn(**replay_args, params=baseline)
    candidate_metrics = replay_fn(**replay_args, params=candidate_params)

    evidence = build_alpha_policy_evidence_bundle(
        candidate_id=_candidate_id(candidate),
        backtest=_backtest_row(candidate_metrics, parity_audit=parity_audit),
        monte_carlo=_monte_carlo_row(candidate_metrics, n_simulations=mc_simulations),
        pbo=_pbo_row(champion_metrics, candidate_metrics),
        data_snooping=_data_snooping_row(champion_metrics, candidate_metrics),
        walk_forward=_walk_forward_row(champion_metrics, candidate_metrics),
    )
    gate = evaluate_alpha_policy_evidence_gate(candidate, evidence)
    if not alpha_replay_applied:
        failed = list(gate.get("failed_gates") or [])
        if "alpha_replay_not_applied" not in failed:
            failed.append("alpha_replay_not_applied")
        gate.update({
            "decision": "FAIL",
            "passed": False,
            "failed_gates": failed,
        })

    return {
        **evidence,
        "gate": gate,
        "provenance": {
            "start_date": start_date,
            "end_date": end_date,
            "mode": mode,
            "baseline_replayed": True,
            "candidate_replayed": True,
            "alpha_replay_applied": alpha_replay_applied,
            "parity_audit_present": bool(parity_audit),
        },
    }


def run_parameter_candidate_evidence(
    candidate: dict[str, Any],
    *,
    start_date: str,
    end_date: str,
    baseline_config: dict[str, Any] | None = None,
    initial_capital: float = 1_000_000,
    mode: str = "B",
    symbols: list[str] | None = None,
    mc_simulations: int = 1000,
    parity_audit: dict[str, Any] | None = None,
    dataset_loader: Callable[..., Any] | None = None,
    replay_fn: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    from services.backtest_engine import BacktestDataset, replay_period

    dataset_loader = dataset_loader or BacktestDataset.load_from_d1
    replay_fn = replay_fn or replay_period

    baseline = deepcopy(baseline_config or {})
    candidate_params = _deep_merge(baseline, _candidate_config(candidate))
    dataset = dataset_loader(start_date=start_date, end_date=end_date, symbols=symbols)
    replay_args = {
        "dataset": dataset,
        "start_date": start_date,
        "end_date": end_date,
        "initial_capital": initial_capital,
        "mode": mode,
    }
    champion_metrics = replay_fn(**replay_args, params=baseline)
    candidate_metrics = replay_fn(**replay_args, params=candidate_params)

    evidence = build_parameter_candidate_evidence_bundle(
        candidate_id=_candidate_id(candidate),
        backtest=_backtest_row(candidate_metrics, parity_audit=parity_audit),
        monte_carlo=_monte_carlo_row(candidate_metrics, n_simulations=mc_simulations),
        pbo=_pbo_row(champion_metrics, candidate_metrics),
        data_snooping=_data_snooping_row(champion_metrics, candidate_metrics),
        walk_forward=_walk_forward_row(champion_metrics, candidate_metrics),
    )
    gate = evaluate_parameter_candidate_evidence_gate(candidate, evidence)
    return {
        **evidence,
        "gate": gate,
        "provenance": {
            "start_date": start_date,
            "end_date": end_date,
            "mode": mode,
            "baseline_replayed": True,
            "candidate_replayed": True,
            "candidate_specific": True,
            "parity_audit_present": bool(parity_audit),
        },
    }
