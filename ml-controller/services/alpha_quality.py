from __future__ import annotations

from statistics import mean
from typing import Any

from services.alpha_framework import AlphaBucket
from services.alpha_policy_search import AlphaOutcome, extract_alpha_outcomes


def _stat(values: list[AlphaOutcome]) -> dict[str, Any]:
    count = len(values)
    selected_count = sum(1 for item in values if item.selected)
    skipped_count = sum(1 for item in values if item.skipped)
    pnl_values = [item.pnl_r for item in values]
    wins = sum(1 for value in pnl_values if value > 0)
    return {
        "count": count,
        "selected_count": selected_count,
        "skipped_count": skipped_count,
        "hit_rate": round(wins / count, 4) if count else 0.0,
        "avg_pnl_r": round(mean(pnl_values), 4) if pnl_values else 0.0,
        "total_pnl_r": round(sum(pnl_values), 4),
    }


def _group_stats(outcomes: list[AlphaOutcome], key_fn) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[AlphaOutcome]] = {}
    for outcome in outcomes:
        key = str(key_fn(outcome))
        grouped.setdefault(key, []).append(outcome)
    return {key: _stat(values) for key, values in sorted(grouped.items())}


def _alerts(
    bucket_stats: dict[str, dict[str, Any]],
    regime_bucket_stats: dict[str, dict[str, Any]],
    min_bucket_samples: int,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key, stat in bucket_stats.items():
        if stat["count"] >= min_bucket_samples and stat["avg_pnl_r"] < 0:
            out.append({
                "level": "warning",
                "scope": "bucket",
                "key": key,
                "reason": "negative_avg_pnl_r",
                "avg_pnl_r": stat["avg_pnl_r"],
                "count": stat["count"],
            })
    for key, stat in regime_bucket_stats.items():
        if stat["count"] >= min_bucket_samples and stat["avg_pnl_r"] < 0:
            out.append({
                "level": "warning",
                "scope": "regime_bucket",
                "key": key,
                "reason": "negative_avg_pnl_r",
                "avg_pnl_r": stat["avg_pnl_r"],
                "count": stat["count"],
            })
    return out


def evaluate_alpha_quality(
    rows: list[dict],
    *,
    min_samples: int = 30,
    min_bucket_samples: int = 8,
    return_pct_per_r: float = 0.02,
    direction_correct_fallback_r: float = 0.25,
) -> dict[str, Any]:
    """Summarize realized alpha bucket quality from verified outcomes."""
    outcomes = extract_alpha_outcomes(
        rows,
        return_pct_per_r=return_pct_per_r,
        direction_correct_fallback_r=direction_correct_fallback_r,
    )
    if len(outcomes) < min_samples:
        return {
            "status": "skipped",
            "reason": "insufficient_alpha_outcomes",
            "sample_count": len(outcomes),
            "required_samples": min_samples,
        }

    bucket_stats = {
        bucket.value: _stat([outcome for outcome in outcomes if outcome.bucket == bucket.value])
        for bucket in AlphaBucket
    }
    regime_stats = _group_stats(outcomes, lambda outcome: outcome.regime)
    regime_bucket_stats = _group_stats(
        outcomes,
        lambda outcome: f"{outcome.regime}:{outcome.bucket}",
    )
    volatility_stats = _group_stats(
        [outcome for outcome in outcomes if outcome.volatility_level],
        lambda outcome: outcome.volatility_level,
    )
    liquidity_stats = _group_stats(
        [outcome for outcome in outcomes if outcome.liquidity_level],
        lambda outcome: outcome.liquidity_level,
    )
    return {
        "status": "completed",
        "sample_count": len(outcomes),
        "bucket_stats": bucket_stats,
        "regime_stats": regime_stats,
        "regime_bucket_stats": regime_bucket_stats,
        "volatility_stats": volatility_stats,
        "liquidity_stats": liquidity_stats,
        "alerts": _alerts(bucket_stats, regime_bucket_stats, min_bucket_samples),
    }
