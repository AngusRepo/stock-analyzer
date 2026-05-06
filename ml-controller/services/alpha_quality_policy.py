from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AlphaQualityPolicy:
    outcome_limit: int = 1000
    min_samples: int = 30
    min_regime_samples: int = 6
    min_bucket_samples: int = 8
    posterior_full_confidence_samples: int = 20
    posterior_weight_impact_bps: int = 1200
    min_bucket_weight_bps: int = 200
    return_pct_per_r_bps: int = 200
    direction_correct_fallback_r_bps: int = 2500

    def to_builder_kwargs(self) -> dict[str, Any]:
        return {
            "min_samples": self.min_samples,
            "min_regime_samples": self.min_regime_samples,
            "min_bucket_samples": self.min_bucket_samples,
            "posterior_full_confidence_samples": self.posterior_full_confidence_samples,
            "posterior_weight_impact": self.posterior_weight_impact_bps / 10_000,
            "min_bucket_weight": self.min_bucket_weight_bps / 10_000,
            "return_pct_per_r": self.return_pct_per_r_bps / 10_000,
            "direction_correct_fallback_r": self.direction_correct_fallback_r_bps / 10_000,
        }

    def to_dict(self) -> dict[str, int]:
        return {
            "outcome_limit": self.outcome_limit,
            "min_samples": self.min_samples,
            "min_regime_samples": self.min_regime_samples,
            "min_bucket_samples": self.min_bucket_samples,
            "posterior_full_confidence_samples": self.posterior_full_confidence_samples,
            "posterior_weight_impact_bps": self.posterior_weight_impact_bps,
            "min_bucket_weight_bps": self.min_bucket_weight_bps,
            "return_pct_per_r_bps": self.return_pct_per_r_bps,
            "direction_correct_fallback_r_bps": self.direction_correct_fallback_r_bps,
        }


def _quality_section(config: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    alpha_framework = config.get("alphaFramework") or {}
    quality = alpha_framework.get("quality") or {}
    return quality if isinstance(quality, dict) else {}


def _int_value(quality: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(quality.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(value, hi))


def alpha_quality_policy(config: dict[str, Any] | None) -> AlphaQualityPolicy:
    quality = _quality_section(config)
    return AlphaQualityPolicy(
        outcome_limit=_int_value(quality, "outcomeLimit", 1000, 100, 5000),
        min_samples=_int_value(quality, "minSamples", 30, 1, 1000),
        min_regime_samples=_int_value(quality, "minRegimeSamples", 6, 1, 500),
        min_bucket_samples=_int_value(quality, "minBucketSamples", 8, 1, 500),
        posterior_full_confidence_samples=_int_value(quality, "posteriorFullConfidenceSamples", 20, 1, 1000),
        posterior_weight_impact_bps=_int_value(quality, "posteriorWeightImpactBps", 1200, 0, 10000),
        min_bucket_weight_bps=_int_value(quality, "minBucketWeightBps", 200, 0, 2500),
        return_pct_per_r_bps=_int_value(quality, "returnPctPerRBps", 200, 1, 10000),
        direction_correct_fallback_r_bps=_int_value(quality, "directionCorrectFallbackRBps", 2500, 0, 10000),
    )


def resolve_alpha_quality_inputs(
    config: dict[str, Any] | None,
    *,
    limit: int | None = None,
    min_samples: int | None = None,
    min_bucket_samples: int | None = None,
) -> dict[str, Any]:
    policy = alpha_quality_policy(config)
    return {
        "limit": max(100, min(limit if limit is not None else policy.outcome_limit, 5000)),
        "min_samples": max(1, min(min_samples if min_samples is not None else policy.min_samples, 1000)),
        "min_bucket_samples": max(
            1,
            min(min_bucket_samples if min_bucket_samples is not None else policy.min_bucket_samples, 500),
        ),
        "return_pct_per_r": policy.return_pct_per_r_bps / 10_000,
        "direction_correct_fallback_r": policy.direction_correct_fallback_r_bps / 10_000,
        "query_overrides": {
            "limit": limit is not None,
            "min_samples": min_samples is not None,
            "min_bucket_samples": min_bucket_samples is not None,
        },
    }
