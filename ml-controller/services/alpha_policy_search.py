from __future__ import annotations

import json
import math
from dataclasses import dataclass
from statistics import mean
from typing import Any

from services.alpha_framework import DEFAULT_ALPHA_POLICY, AlphaBucket, normalize_regime


REGIMES = ("bull", "bear", "volatile", "sideways")


@dataclass(frozen=True)
class AlphaOutcome:
    regime: str
    bucket: str
    pnl_r: float
    selected: bool
    skipped: bool
    volatility_level: str | None = None
    liquidity_level: str | None = None
    vol_3d: float | None = None
    vol_10d: float | None = None
    expansion_ratio: float | None = None
    median_volume: float | None = None


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else default
    except (TypeError, ValueError):
        return default


def _loads_json(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        data = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _outcome_score(
    row: dict,
    *,
    return_pct_per_r: float = 0.02,
    direction_correct_fallback_r: float = 0.25,
) -> float | None:
    if row.get("trade_pnl_r") is not None:
        return _to_float(row.get("trade_pnl_r"))
    pct_per_r = max(0.0001, return_pct_per_r)
    if row.get("trade_pnl_pct") is not None:
        return _to_float(row.get("trade_pnl_pct")) / pct_per_r
    if row.get("actual_return_pct") is not None:
        return _to_float(row.get("actual_return_pct")) / pct_per_r
    if row.get("direction_correct") is not None:
        fallback_r = max(0.0, direction_correct_fallback_r)
        return fallback_r if bool(row.get("direction_correct")) else -fallback_r
    return None


def extract_alpha_outcomes(
    rows: list[dict],
    *,
    return_pct_per_r: float = 0.02,
    direction_correct_fallback_r: float = 0.25,
) -> list[AlphaOutcome]:
    outcomes: list[AlphaOutcome] = []
    for row in rows:
        pnl_r = _outcome_score(
            row,
            return_pct_per_r=return_pct_per_r,
            direction_correct_fallback_r=direction_correct_fallback_r,
        )
        if pnl_r is None:
            continue
        forecast = _loads_json(row.get("forecast_data"))
        ctx = forecast.get("alpha_context") or {}
        if not isinstance(ctx, dict):
            continue
        bucket = ctx.get("edge_bucket")
        if bucket not in {item.value for item in AlphaBucket}:
            continue
        allocation = forecast.get("alpha_allocation") or {}
        risk_overlay = ctx.get("risk_overlay") or {}
        volatility_detail = risk_overlay.get("volatility_detail") if isinstance(risk_overlay.get("volatility_detail"), dict) else {}
        liquidity_detail = risk_overlay.get("liquidity_detail") if isinstance(risk_overlay.get("liquidity_detail"), dict) else {}
        outcomes.append(
            AlphaOutcome(
                regime=normalize_regime(str(ctx.get("regime") or allocation.get("regime") or "")),
                bucket=str(bucket),
                pnl_r=max(-5.0, min(5.0, pnl_r)),
                selected=bool(allocation.get("selected", True)),
                skipped=bool(risk_overlay.get("skip")),
                volatility_level=risk_overlay.get("volatility_level"),
                liquidity_level=risk_overlay.get("liquidity_level"),
                vol_3d=_optional_positive_float(volatility_detail.get("vol_3d")),
                vol_10d=_optional_positive_float(volatility_detail.get("vol_10d")),
                expansion_ratio=_optional_positive_float(volatility_detail.get("expansion_ratio")),
                median_volume=_optional_positive_float(liquidity_detail.get("median_volume")),
            )
        )
    return outcomes


def _optional_positive_float(value: Any) -> float | None:
    out = _to_float(value, -1.0)
    return out if out >= 0 else None


def load_alpha_outcome_rows(limit: int = 1000) -> list[dict]:
    """Load verified prediction outcomes that contain alpha allocation context."""
    from services.d1_client import query as d1_query

    safe_limit = max(1, min(int(limit or 1000), 5000))
    return d1_query(
        """SELECT generated_at, forecast_data, actual_return_pct, trade_pnl_pct,
                  trade_pnl_r, direction_correct
           FROM predictions
           WHERE model_name='ensemble'
             AND forecast_data IS NOT NULL
             AND forecast_data LIKE '%alpha_context%'
             AND (
               trade_pnl_r IS NOT NULL OR trade_pnl_pct IS NOT NULL
               OR actual_return_pct IS NOT NULL OR direction_correct IN (0, 1)
             )
           ORDER BY generated_at DESC
           LIMIT ?""",
        [safe_limit],
    )


def _normalize_weights(weights: dict[str, float], min_bucket_weight: float = 0.02) -> dict[str, float]:
    floor = max(0.0, min(0.25, min_bucket_weight))
    cleaned = {bucket.value: max(floor, _to_float(weights.get(bucket.value), 0.0)) for bucket in AlphaBucket}
    total = sum(cleaned.values())
    if total <= 0:
        return dict(DEFAULT_ALPHA_POLICY["allocation"]["weights"]["sideways"])
    return {bucket: round(value / total, 4) for bucket, value in cleaned.items()}


def _quantile(values: list[float], q: float) -> float | None:
    cleaned = sorted(v for v in values if math.isfinite(v))
    if not cleaned:
        return None
    if len(cleaned) == 1:
        return cleaned[0]
    pos = max(0.0, min(1.0, q)) * (len(cleaned) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return cleaned[lo]
    return cleaned[lo] + (cleaned[hi] - cleaned[lo]) * (pos - lo)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _rounded(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _build_risk_overlay_policy(outcomes: list[AlphaOutcome], min_numeric_samples: int) -> tuple[dict[str, Any], dict[str, Any]]:
    default = DEFAULT_ALPHA_POLICY["risk_overlay"]
    overlay = {
        "volatilityExpansionRatio": default["volatility_expansion_ratio"],
        "volatilityExpansionMin3d": default["volatility_expansion_min_3d"],
        "extremeVolThreshold": default["extreme_vol_threshold"],
        "highVolThreshold": default["high_vol_threshold"],
        "liquidityLowVolume": default["liquidity_low_volume"],
        "liquidityThinVolume": default["liquidity_thin_volume"],
        "skipSizingCap": default["skip_sizing_cap"],
    }
    default_camel = dict(overlay)

    vol_rows = [
        outcome
        for outcome in outcomes
        if outcome.vol_3d is not None or outcome.vol_10d is not None
    ]
    if len(vol_rows) >= min_numeric_samples:
        vol_values = [
            max(outcome.vol_10d or 0.0, (outcome.vol_3d or 0.0) * 0.75)
            for outcome in vol_rows
        ]
        winning_vols = [
            max(outcome.vol_10d or 0.0, (outcome.vol_3d or 0.0) * 0.75)
            for outcome in vol_rows
            if outcome.pnl_r > 0
        ]
        losing_vols = [
            max(outcome.vol_10d or 0.0, (outcome.vol_3d or 0.0) * 0.75)
            for outcome in vol_rows
            if outcome.pnl_r < 0
        ]
        safe_vol = _quantile(winning_vols, 0.75) or _quantile(vol_values, 0.50) or default["high_vol_threshold"]
        risk_vol = _quantile(losing_vols, 0.25) or _quantile(vol_values, 0.75) or default["high_vol_threshold"]
        high_vol = _clamp((safe_vol + risk_vol) / 2.0, 0.005, 0.30)
        extreme_vol = _clamp(
            max(high_vol + 0.005, _quantile(losing_vols, 0.80) or _quantile(vol_values, 0.90) or default["extreme_vol_threshold"]),
            high_vol + 0.005,
            0.50,
        )
        overlay["highVolThreshold"] = _rounded(high_vol)
        overlay["extremeVolThreshold"] = _rounded(extreme_vol)

    expansion_values = [outcome.expansion_ratio for outcome in outcomes if outcome.expansion_ratio is not None]
    losing_expansion = [
        outcome.expansion_ratio
        for outcome in outcomes
        if outcome.expansion_ratio is not None and outcome.pnl_r < 0
    ]
    if len(expansion_values) >= min_numeric_samples:
        expansion_ratio = _quantile(losing_expansion, 0.50) or _quantile(expansion_values, 0.75) or default["volatility_expansion_ratio"]
        overlay["volatilityExpansionRatio"] = _rounded(_clamp(expansion_ratio, 1.0, 5.0))

    vol_3d_values = [outcome.vol_3d for outcome in outcomes if outcome.vol_3d is not None]
    losing_vol_3d = [outcome.vol_3d for outcome in outcomes if outcome.vol_3d is not None and outcome.pnl_r < 0]
    if len(vol_3d_values) >= min_numeric_samples:
        min_3d = _quantile(losing_vol_3d, 0.25) or _quantile(vol_3d_values, 0.75) or default["volatility_expansion_min_3d"]
        overlay["volatilityExpansionMin3d"] = _rounded(_clamp(min_3d, 0.0, 0.30))

    volume_values = [outcome.median_volume for outcome in outcomes if outcome.median_volume is not None]
    risky_volumes = [
        outcome.median_volume
        for outcome in outcomes
        if outcome.median_volume is not None
        and (outcome.pnl_r < 0 or outcome.liquidity_level in {"low", "thin"})
    ]
    if len(volume_values) >= min_numeric_samples:
        low_volume = max(
            _quantile(volume_values, 0.25) or default["liquidity_low_volume"],
            _quantile(risky_volumes, 0.50) or 0.0,
        )
        liquid_volume = _quantile(volume_values, 0.75) or default["liquidity_thin_volume"]
        thin_volume = max(low_volume, (low_volume + liquid_volume) / 2.0)
        overlay["liquidityLowVolume"] = _rounded(_clamp(low_volume, 0.0, 5_000_000.0), 2)
        overlay["liquidityThinVolume"] = _rounded(_clamp(thin_volume, overlay["liquidityLowVolume"], 20_000_000.0), 2)

    skipped = [outcome.pnl_r for outcome in outcomes if outcome.skipped]
    if len(skipped) >= max(2, min_numeric_samples // 2):
        skipped_mean = mean(skipped)
        cap = default["skip_sizing_cap"] + _clamp(skipped_mean * 0.20, -0.15, 0.15)
        overlay["skipSizingCap"] = _rounded(_clamp(cap, 0.10, 0.70))

    adaptive_fields = [
        f"alphaFramework.riskOverlay.{key}"
        for key, value in overlay.items()
        if value != default_camel[key]
    ]
    fallback_fields = [
        f"alphaFramework.riskOverlay.{key}"
        for key, value in overlay.items()
        if value == default_camel[key]
    ]
    evidence = {
        "method": "posterior_numeric_outcome_distribution",
        "min_numeric_samples": min_numeric_samples,
        "numeric_sample_counts": {
            "volatility": len(vol_rows),
            "expansion": len(expansion_values),
            "volatility_3d": len(vol_3d_values),
            "liquidity": len(volume_values),
            "skipped": len(skipped),
        },
        "adaptive_fields": adaptive_fields,
        "fallback_fields": fallback_fields,
        "default_fallback": default_camel,
    }
    return overlay, evidence


def _posterior_bucket_weights(
    outcomes: list[AlphaOutcome],
    regime: str,
    min_bucket_samples: int,
    *,
    posterior_full_confidence_samples: int,
    posterior_weight_impact: float,
    min_bucket_weight: float,
) -> dict[str, float]:
    default = DEFAULT_ALPHA_POLICY["allocation"]["weights"].get(
        regime,
        DEFAULT_ALPHA_POLICY["allocation"]["weights"]["sideways"],
    )
    by_bucket: dict[str, list[float]] = {bucket.value: [] for bucket in AlphaBucket}
    for outcome in outcomes:
        if outcome.regime == regime and not outcome.skipped:
            by_bucket[outcome.bucket].append(outcome.pnl_r)

    raw: dict[str, float] = {}
    for bucket in AlphaBucket:
        values = by_bucket[bucket.value]
        if len(values) < min_bucket_samples:
            raw[bucket.value] = default[bucket.value]
            continue
        avg = max(-1.0, min(1.0, mean(values)))
        sample_confidence = min(1.0, len(values) / max(1, posterior_full_confidence_samples))
        adjusted = max(min_bucket_weight, default[bucket.value] + avg * posterior_weight_impact)
        raw[bucket.value] = default[bucket.value] * (1.0 - sample_confidence) + adjusted * sample_confidence
    return _normalize_weights(raw, min_bucket_weight=min_bucket_weight)


def build_alpha_policy_candidate(
    rows: list[dict],
    *,
    min_samples: int = 30,
    min_regime_samples: int = 6,
    min_bucket_samples: int = 3,
    posterior_full_confidence_samples: int = 20,
    posterior_weight_impact: float = 0.12,
    min_bucket_weight: float = 0.02,
    return_pct_per_r: float = 0.02,
    direction_correct_fallback_r: float = 0.25,
) -> dict[str, Any]:
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

    weights: dict[str, dict[str, float]] = {}
    regime_counts: dict[str, int] = {}
    for regime in REGIMES:
        regime_outcomes = [outcome for outcome in outcomes if outcome.regime == regime]
        regime_counts[regime] = len(regime_outcomes)
        if len(regime_outcomes) < min_regime_samples:
            weights[regime] = dict(DEFAULT_ALPHA_POLICY["allocation"]["weights"][regime])
        else:
            weights[regime] = _posterior_bucket_weights(
                outcomes,
                regime,
                min_bucket_samples,
                posterior_full_confidence_samples=posterior_full_confidence_samples,
                posterior_weight_impact=posterior_weight_impact,
                min_bucket_weight=min_bucket_weight,
            )

    risk_overlay, risk_overlay_evidence = _build_risk_overlay_policy(
        outcomes,
        min_numeric_samples=min_bucket_samples,
    )
    policy = {
        "riskOverlay": risk_overlay,
        "allocation": {
            "slateSize": DEFAULT_ALPHA_POLICY["allocation"]["slate_size"],
            "weights": weights,
        },
    }
    return {
        "status": "completed",
        "alphaFramework": policy,
        "sample_count": len(outcomes),
        "regime_counts": regime_counts,
        "bucket_counts": {
            bucket.value: sum(1 for outcome in outcomes if outcome.bucket == bucket.value)
            for bucket in AlphaBucket
        },
        "skipped_count": sum(1 for outcome in outcomes if outcome.skipped),
        "risk_overlay_evidence": risk_overlay_evidence,
        "search_policy": {
            "min_samples": min_samples,
            "min_regime_samples": min_regime_samples,
            "min_bucket_samples": min_bucket_samples,
            "posterior_full_confidence_samples": posterior_full_confidence_samples,
            "posterior_weight_impact": posterior_weight_impact,
            "min_bucket_weight": min_bucket_weight,
            "return_pct_per_r": return_pct_per_r,
            "direction_correct_fallback_r": direction_correct_fallback_r,
        },
    }
