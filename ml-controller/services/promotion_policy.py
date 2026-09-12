"""Promotion gate for Optuna/adaptive candidates.

The gate is intentionally stricter than a single backtest metric: production
promotion must survive Mode B replay, tail-risk Monte Carlo, and PBO checks.
"""

from __future__ import annotations

import os
import math
from dataclasses import asdict, dataclass
from typing import Any


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f'promotion_policy_invalid_integer:{name}') from exc


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f'promotion_policy_invalid_number:{name}') from exc
    if not math.isfinite(value):
        raise ValueError(f'promotion_policy_nonfinite:{name}')
    return value


def _as_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    try:
        if text.endswith("%"):
            parsed = float(text[:-1]) / 100.0
        else:
            parsed = float(text)
        return parsed if math.isfinite(parsed) else default
    except ValueError:
        return default


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
        if not math.isfinite(number) or not number.is_integer():
            return default
        return int(number)
    except (TypeError, ValueError, OverflowError):
        return default


def risk_metric_within(value: Any, maximum: float, *, inclusive: bool = True) -> bool:
    """Risk fields are nonnegative magnitudes/probabilities, never signed P&L."""
    observed = _as_float(value, math.nan)
    return (type(maximum) in (int, float) and math.isfinite(maximum) and 0 <= maximum <= 1
            and math.isfinite(observed) and 0 <= observed <= maximum and (inclusive or observed < maximum))


def optional_metric(value: Any) -> float | None:
    observed = _as_float(value, math.nan)
    return observed if math.isfinite(observed) else None


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

    def __post_init__(self) -> None:
        # Reject malformed configuration rather than silently installing a
        # different gate. Defaults and legitimate overrides remain unchanged.
        for name in ('min_trades', 'min_regime_trades', 'alpha_min_outcomes', 'alpha_min_regime_outcomes'):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ValueError('promotion_policy_invalid_count:' + name)
        for name in ('min_sharpe', 'min_profit_factor', 'max_backtest_mdd',
                     'max_mc_mdd_95th', 'max_pbo', 'min_oos_mean_return', 'min_regime_return'):
            value = getattr(self, name)
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError('promotion_policy_nonfinite:' + name)
        for name in ('max_backtest_mdd', 'max_mc_mdd_95th', 'max_pbo'):
            if not 0 < getattr(self, name) <= 1:
                raise ValueError('promotion_policy_invalid_probability:' + name)
        if self.min_profit_factor <= 0:
            raise ValueError('promotion_policy_invalid_profit_factor')

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


def parse_regime_evidence(per_regime: Any) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """One numeric/source parser for the promotion owner and its UI packet."""
    rows, failures = {}, []
    if not isinstance(per_regime, dict):
        return rows, ['regime_evidence_invalid']
    for regime, raw in (per_regime or {}).items():
        if not isinstance(raw, dict):
            failures.append(f'regime_evidence_invalid:{regime}')
            continue
        trades = _as_int(next((raw[key] for key in ('trades', 'total_trades', 'n_trades')
                              if raw.get(key) is not None), None), -1)
        if trades < 0:
            failures.append(f'regime_count_invalid:{regime}')
            continue
        ret = optional_metric(
            next((raw[key] for key in ('return', 'total_return', 'oos_return', 'avg_return')
                  if raw.get(key) is not None), None),
        )
        rows[str(regime)] = {'trades': trades, 'return': ret}
    return rows, failures


def _regime_failures(per_regime: dict[str, Any], policy: PromotionPolicy) -> list[str]:
    rows, failures = parse_regime_evidence(per_regime)
    for regime, evidence in rows.items():
        trades, ret = evidence['trades'], evidence['return']
        if trades >= policy.min_regime_trades:
            if ret is None:
                failures.append(f"regime_return_missing:{regime}")
            elif ret < policy.min_regime_return:
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

    if not risk_metric_within(backtest.get('max_drawdown'), policy.max_backtest_mdd):
        failed.append("backtest_max_drawdown")

    if str(monte_carlo.get("go_live_verdict") or "").upper() not in {"PASS"}:
        failed.append("monte_carlo_verdict")

    mc_method = str(monte_carlo.get("simulation_method") or "").lower()
    if mc_method not in {"block_bootstrap", "regime_block_bootstrap"}:
        failed.append("monte_carlo_method")

    if not risk_metric_within(monte_carlo.get('mdd_95th'), policy.max_mc_mdd_95th):
        failed.append("monte_carlo_mdd_95th")

    if str(pbo.get("go_live_verdict") or "").upper() not in {"PASS"}:
        failed.append("pbo_verdict")

    if str(pbo.get("method") or "").lower() != "cscv_rank_logit":
        failed.append("pbo_method")

    if not risk_metric_within(pbo.get('pbo'), policy.max_pbo, inclusive=False):
        failed.append("pbo_probability")

    if _as_float(pbo.get("oos_mean_return"), -1.0) < policy.min_oos_mean_return:
        failed.append("pbo_oos_mean_return")

    failed.extend(_regime_failures(backtest.get('per_regime', {}), policy))

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
            "backtest_mdd": optional_metric(backtest.get('max_drawdown')),
            "mc_method": str(monte_carlo.get("simulation_method") or ""),
            "mc_block_size": monte_carlo.get("block_size"),
            "mc_mdd_95th": optional_metric(monte_carlo.get('mdd_95th')),
            "pbo_method": str(pbo.get("method") or ""),
            "pbo": optional_metric(pbo.get('pbo')),
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
