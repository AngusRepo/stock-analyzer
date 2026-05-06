"""Promotion gate for Optuna/adaptive candidates.

The gate is intentionally stricter than a single backtest metric: production
promotion must survive Mode B replay, tail-risk Monte Carlo, and PBO checks.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Any


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


@dataclass(frozen=True)
class PromotionPolicy:
    min_trades: int = 60
    min_sharpe: float = 0.5
    min_profit_factor: float = 1.05
    max_backtest_mdd: float = 0.25
    max_mc_mdd_95th: float = 0.20
    max_pbo: float = 0.50
    min_oos_mean_return: float = 0.0
    min_regime_trades: int = 10
    min_regime_return: float = -0.02
    alpha_min_outcomes: int = 60
    alpha_min_regime_outcomes: int = 10

    @classmethod
    def from_env(cls) -> "PromotionPolicy":
        return cls(
            min_trades=_env_int("PROMOTION_MIN_TRADES", cls.min_trades),
            min_sharpe=_env_float("PROMOTION_MIN_SHARPE", cls.min_sharpe),
            min_profit_factor=_env_float("PROMOTION_MIN_PROFIT_FACTOR", cls.min_profit_factor),
            max_backtest_mdd=_env_float("PROMOTION_MAX_BACKTEST_MDD", cls.max_backtest_mdd),
            max_mc_mdd_95th=_env_float("PROMOTION_MAX_MC_MDD_95TH", cls.max_mc_mdd_95th),
            max_pbo=_env_float("PROMOTION_MAX_PBO", cls.max_pbo),
            min_oos_mean_return=_env_float("PROMOTION_MIN_OOS_MEAN_RETURN", cls.min_oos_mean_return),
            min_regime_trades=_env_int("PROMOTION_MIN_REGIME_TRADES", cls.min_regime_trades),
            min_regime_return=_env_float("PROMOTION_MIN_REGIME_RETURN", cls.min_regime_return),
            alpha_min_outcomes=_env_int("PROMOTION_ALPHA_MIN_OUTCOMES", cls.alpha_min_outcomes),
            alpha_min_regime_outcomes=_env_int("PROMOTION_ALPHA_MIN_REGIME_OUTCOMES", cls.alpha_min_regime_outcomes),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _regime_failures(per_regime: dict[str, Any], policy: PromotionPolicy) -> list[str]:
    failures: list[str] = []
    for regime, raw in (per_regime or {}).items():
        if not isinstance(raw, dict):
            continue
        trades = _as_int(raw.get("trades") or raw.get("total_trades"), 0)
        ret = _as_float(raw.get("return") or raw.get("total_return") or raw.get("oos_return"), 0.0)
        if trades >= policy.min_regime_trades and ret < policy.min_regime_return:
            failures.append(f"regime_return:{regime}")
    return failures


def evaluate_promotion_candidate(
    backtest: dict[str, Any],
    monte_carlo: dict[str, Any],
    pbo: dict[str, Any],
    *,
    policy: PromotionPolicy | None = None,
) -> dict[str, Any]:
    policy = policy or PromotionPolicy.from_env()
    failed: list[str] = []
    warnings: list[str] = []

    mode = str(backtest.get("mode") or "").upper()
    if mode != "B":
        failed.append("backtest_mode_b_required")

    if backtest.get("sanity_flags"):
        failed.append("backtest_sanity_flags")

    if str(backtest.get("absolute_confidence") or "").lower() in {"relative_only", "low"}:
        failed.append("backtest_confidence")

    parity_audit = backtest.get("parity_audit") if isinstance(backtest.get("parity_audit"), dict) else {}
    worker_parity = parity_audit.get("worker_parity") if isinstance(parity_audit.get("worker_parity"), dict) else {}
    worker_parity_decision = str(worker_parity.get("decision") or "").upper()
    if worker_parity_decision != "PASS":
        failed.append("backtest_worker_parity")

    total_trades = _as_int(backtest.get("total_trades"), 0)
    if total_trades < policy.min_trades:
        failed.append("backtest_min_trades")

    if _as_float(backtest.get("sharpe"), 0.0) < policy.min_sharpe:
        failed.append("backtest_sharpe")

    if _as_float(backtest.get("profit_factor"), 0.0) < policy.min_profit_factor:
        failed.append("backtest_profit_factor")

    if _as_float(backtest.get("max_drawdown"), 1.0) > policy.max_backtest_mdd:
        failed.append("backtest_max_drawdown")

    if str(monte_carlo.get("go_live_verdict") or "").upper() not in {"PASS"}:
        failed.append("monte_carlo_verdict")

    mc_method = str(monte_carlo.get("simulation_method") or "").lower()
    if mc_method not in {"block_bootstrap", "regime_block_bootstrap"}:
        failed.append("monte_carlo_method")

    if _as_float(monte_carlo.get("mdd_95th"), 1.0) > policy.max_mc_mdd_95th:
        failed.append("monte_carlo_mdd_95th")

    if str(pbo.get("go_live_verdict") or "").upper() not in {"PASS"}:
        failed.append("pbo_verdict")

    if str(pbo.get("method") or "").lower() != "cscv_rank_logit":
        failed.append("pbo_method")

    if _as_float(pbo.get("pbo"), 1.0) >= policy.max_pbo:
        failed.append("pbo_probability")

    if _as_float(pbo.get("oos_mean_return"), -1.0) < policy.min_oos_mean_return:
        failed.append("pbo_oos_mean_return")

    failed.extend(_regime_failures(backtest.get("per_regime") or {}, policy))

    if str(monte_carlo.get("source") or "").lower() != "backtest":
        warnings.append("monte_carlo_source_not_backtest")
    if str(pbo.get("source") or "").lower() != "backtest":
        warnings.append("pbo_source_not_backtest")

    decision = "PASS" if not failed else "FAIL"
    return {
        "decision": decision,
        "passed": decision == "PASS",
        "failed_gates": failed,
        "warnings": warnings,
        "policy": policy.to_dict(),
        "metrics": {
            "mode": mode,
            "total_trades": total_trades,
            "worker_parity_decision": worker_parity_decision,
            "sharpe": _as_float(backtest.get("sharpe"), 0.0),
            "profit_factor": _as_float(backtest.get("profit_factor"), 0.0),
            "backtest_mdd": _as_float(backtest.get("max_drawdown"), 0.0),
            "mc_method": str(monte_carlo.get("simulation_method") or ""),
            "mc_block_size": monte_carlo.get("block_size"),
            "mc_mdd_95th": _as_float(monte_carlo.get("mdd_95th"), 0.0),
            "pbo_method": str(pbo.get("method") or ""),
            "pbo": _as_float(pbo.get("pbo"), 1.0),
            "oos_mean_return": _as_float(pbo.get("oos_mean_return"), 0.0),
        },
    }


def evaluate_alpha_policy_candidate(
    candidate: dict[str, Any],
    backtest: dict[str, Any],
    monte_carlo: dict[str, Any],
    pbo: dict[str, Any],
    *,
    policy: PromotionPolicy | None = None,
) -> dict[str, Any]:
    policy = policy or PromotionPolicy.from_env()
    metadata = candidate.get("metadata") if isinstance(candidate.get("metadata"), dict) else {}
    config = candidate.get("config") if isinstance(candidate.get("config"), dict) else {}
    candidate_status = candidate.get("status") or metadata.get("status")
    candidate_target = candidate.get("target") or candidate.get("stage") or metadata.get("target") or metadata.get("stage")
    alpha_policy = candidate.get("alphaFramework") or candidate.get("alpha_framework") or config.get("alphaFramework") or config.get("alpha_framework")
    sample_count = _as_int(candidate.get("sample_count", metadata.get("sample_count")), 0)
    regime_counts = candidate.get("regime_counts", metadata.get("regime_counts"))
    regime_counts = regime_counts if isinstance(regime_counts, dict) else {}
    skipped_count = _as_int(candidate.get("skipped_count", metadata.get("skipped_count")), 0)

    base = evaluate_promotion_candidate(backtest, monte_carlo, pbo, policy=policy)
    failed = list(base.get("failed_gates") or [])
    warnings = list(base.get("warnings") or [])

    if str(candidate_status or "").lower() != "completed":
        failed.append("alpha_candidate_not_completed")
    if str(candidate_target or "").lower() not in {"sandbox", "challenger"}:
        failed.append("alpha_candidate_stage")
    if not isinstance(alpha_policy, dict):
        failed.append("alpha_policy_missing")

    if sample_count < policy.alpha_min_outcomes:
        failed.append("alpha_min_outcomes")

    for regime in ("bull", "bear", "volatile", "sideways"):
        if _as_int(regime_counts.get(regime), 0) < policy.alpha_min_regime_outcomes:
            failed.append(f"alpha_min_regime_outcomes:{regime}")

    if sample_count > 0 and skipped_count / sample_count > 0.5:
        warnings.append("alpha_high_skip_ratio")

    decision = "PASS" if not failed else "FAIL"
    return {
        **base,
        "decision": decision,
        "passed": decision == "PASS",
        "failed_gates": failed,
        "warnings": warnings,
        "candidate": {
            "status": candidate_status,
            "target": candidate_target,
            "sample_count": sample_count,
            "regime_counts": regime_counts,
            "skipped_count": skipped_count,
        },
    }
