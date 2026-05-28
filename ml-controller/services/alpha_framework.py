from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from enum import StrEnum
from statistics import median
from typing import Any


class AlphaBucket(StrEnum):
    TREND_FOLLOWING = "trend_following"
    MEAN_REVERSION = "mean_reversion"
    BREAKOUT_VOL_EXPANSION = "breakout_vol_expansion"
    DEFENSIVE_ACCUMULATION = "defensive_accumulation"


DEFAULT_ALPHA_POLICY: dict[str, Any] = {
    "risk_overlay": {
        "volatility_expansion_ratio": 1.8,
        "volatility_expansion_min_3d": 0.025,
        "extreme_vol_threshold": 0.07,
        "high_vol_threshold": 0.035,
        "liquidity_low_volume": 50_000.0,
        "liquidity_thin_volume": 250_000.0,
        "skip_sizing_cap": 0.35,
        "volatility_expansion_penalty": 1.5,
        "high_vol_penalty": 3.0,
        "extreme_vol_penalty": 8.0,
        "thin_liquidity_penalty": 1.5,
        "low_liquidity_penalty": 5.0,
        "extended_above_fair_value_penalty": 1.0,
        "fragile_structure_penalty": 2.0,
        "constructive_return_min": 0.015,
        "fragile_return_max": -0.04,
        "extreme_vol_skip_confidence_min": 0.70,
        "fair_value_range_lookback": 10,
        "fair_value_atr_multiplier": 0.75,
        "fair_value_min_pct": 0.01,
        "optimistic_value_atr_multiplier": 1.25,
    },
    "allocation": {
        "engine": "sparse_tangent_inverse_risk",
        "controller": "OnlinePortfolioBandit",
        "buy_signal_count": 3,
        "slate_size": 10,
        "score_round_decimals": 1,
        "weights": {
            "bull": {
                "trend_following": 0.35,
                "breakout_vol_expansion": 0.35,
                "mean_reversion": 0.15,
                "defensive_accumulation": 0.15,
            },
            "bear": {
                "defensive_accumulation": 0.40,
                "mean_reversion": 0.25,
                "trend_following": 0.20,
                "breakout_vol_expansion": 0.15,
            },
            "volatile": {
                "defensive_accumulation": 0.45,
                "breakout_vol_expansion": 0.20,
                "trend_following": 0.20,
                "mean_reversion": 0.15,
            },
            "sideways": {
                "mean_reversion": 0.35,
                "defensive_accumulation": 0.25,
                "breakout_vol_expansion": 0.20,
                "trend_following": 0.20,
            },
        },
    },
    "classification": {
        "breakout_near_high_ratio": 0.995,
        "breakout_return_min": 0.03,
        "breakout_volume_ratio_min": 1.15,
        "breakout_forecast_min": 0.03,
        "trend_return_min": 0.015,
        "trend_forecast_min": 0.0,
        "mean_reversion_rsi_max": 45.0,
        "mean_reversion_return_max": 0.0,
        "mean_reversion_forecast_min": 0.0,
    },
    "regime_bucket_multipliers": {
        "bull": {
            "trend_following": 1.15,
            "breakout_vol_expansion": 1.12,
            "mean_reversion": 0.95,
            "defensive_accumulation": 1.00,
        },
        "bear": {
            "trend_following": 0.78,
            "breakout_vol_expansion": 0.82,
            "mean_reversion": 0.90,
            "defensive_accumulation": 1.08,
        },
        "sideways": {
            "trend_following": 0.92,
            "breakout_vol_expansion": 0.96,
            "mean_reversion": 1.12,
            "defensive_accumulation": 1.00,
        },
        "volatile": {
            "trend_following": 0.86,
            "breakout_vol_expansion": 0.92,
            "mean_reversion": 0.84,
            "defensive_accumulation": 1.10,
        },
    },
    "scoring": {
        "bucket_bonus": {
            "trend_following": 2.0,
            "mean_reversion": 1.0,
            "breakout_vol_expansion": 3.0,
            "defensive_accumulation": 0.5,
        },
        "regime_weight_impact": 10.0,
        "overlay_penalty_impact": 1.0,
        "score_min": -12.0,
        "score_max": 8.0,
        "confidence_weight_impact": 0.25,
        "confidence_penalty_impact": 0.01,
        "confidence_min": 0.75,
        "confidence_max": 1.08,
    },
    "execution_overlay": {
        "sizing_min": 0.25,
        "sizing_max": 1.25,
        "high_vol_sizing_multiplier": 0.80,
        "extreme_vol_sizing_multiplier": 0.55,
        "thin_liquidity_sizing_multiplier": 0.85,
        "low_liquidity_sizing_multiplier": 0.45,
        "high_vol_stop_multiplier": 1.18,
        "extreme_vol_stop_multiplier": 1.35,
        "mean_reversion_stop_multiplier": 0.95,
        "bull_trend_target_multiplier": 1.12,
        "non_bull_trend_target_multiplier": 1.05,
        "defensive_risk_target_multiplier": 0.92,
    },
}


def _camel_or_snake(src: dict, camel: str, snake: str, default: Any) -> Any:
    return src.get(camel, src.get(snake, default))


def normalize_alpha_policy(raw: dict | None = None) -> dict[str, Any]:
    raw = raw or {}
    default = DEFAULT_ALPHA_POLICY
    raw_overlay = raw.get("riskOverlay") or raw.get("risk_overlay") or {}
    overlay_default = default["risk_overlay"]
    overlay = {
        "volatility_expansion_ratio": _to_float(
            _camel_or_snake(raw_overlay, "volatilityExpansionRatio", "volatility_expansion_ratio", overlay_default["volatility_expansion_ratio"]),
            overlay_default["volatility_expansion_ratio"],
        ),
        "volatility_expansion_min_3d": _to_float(
            _camel_or_snake(raw_overlay, "volatilityExpansionMin3d", "volatility_expansion_min_3d", overlay_default["volatility_expansion_min_3d"]),
            overlay_default["volatility_expansion_min_3d"],
        ),
        "extreme_vol_threshold": _to_float(
            _camel_or_snake(raw_overlay, "extremeVolThreshold", "extreme_vol_threshold", overlay_default["extreme_vol_threshold"]),
            overlay_default["extreme_vol_threshold"],
        ),
        "high_vol_threshold": _to_float(
            _camel_or_snake(raw_overlay, "highVolThreshold", "high_vol_threshold", overlay_default["high_vol_threshold"]),
            overlay_default["high_vol_threshold"],
        ),
        "liquidity_low_volume": _to_float(
            _camel_or_snake(raw_overlay, "liquidityLowVolume", "liquidity_low_volume", overlay_default["liquidity_low_volume"]),
            overlay_default["liquidity_low_volume"],
        ),
        "liquidity_thin_volume": _to_float(
            _camel_or_snake(raw_overlay, "liquidityThinVolume", "liquidity_thin_volume", overlay_default["liquidity_thin_volume"]),
            overlay_default["liquidity_thin_volume"],
        ),
        "skip_sizing_cap": _to_float(
            _camel_or_snake(raw_overlay, "skipSizingCap", "skip_sizing_cap", overlay_default["skip_sizing_cap"]),
            overlay_default["skip_sizing_cap"],
        ),
        "volatility_expansion_penalty": _to_float(
            _camel_or_snake(raw_overlay, "volatilityExpansionPenalty", "volatility_expansion_penalty", overlay_default["volatility_expansion_penalty"]),
            overlay_default["volatility_expansion_penalty"],
        ),
        "high_vol_penalty": _to_float(
            _camel_or_snake(raw_overlay, "highVolPenalty", "high_vol_penalty", overlay_default["high_vol_penalty"]),
            overlay_default["high_vol_penalty"],
        ),
        "extreme_vol_penalty": _to_float(
            _camel_or_snake(raw_overlay, "extremeVolPenalty", "extreme_vol_penalty", overlay_default["extreme_vol_penalty"]),
            overlay_default["extreme_vol_penalty"],
        ),
        "thin_liquidity_penalty": _to_float(
            _camel_or_snake(raw_overlay, "thinLiquidityPenalty", "thin_liquidity_penalty", overlay_default["thin_liquidity_penalty"]),
            overlay_default["thin_liquidity_penalty"],
        ),
        "low_liquidity_penalty": _to_float(
            _camel_or_snake(raw_overlay, "lowLiquidityPenalty", "low_liquidity_penalty", overlay_default["low_liquidity_penalty"]),
            overlay_default["low_liquidity_penalty"],
        ),
        "extended_above_fair_value_penalty": _to_float(
            _camel_or_snake(raw_overlay, "extendedAboveFairValuePenalty", "extended_above_fair_value_penalty", overlay_default["extended_above_fair_value_penalty"]),
            overlay_default["extended_above_fair_value_penalty"],
        ),
        "fragile_structure_penalty": _to_float(
            _camel_or_snake(raw_overlay, "fragileStructurePenalty", "fragile_structure_penalty", overlay_default["fragile_structure_penalty"]),
            overlay_default["fragile_structure_penalty"],
        ),
        "constructive_return_min": _to_float(
            _camel_or_snake(raw_overlay, "constructiveReturnMin", "constructive_return_min", overlay_default["constructive_return_min"]),
            overlay_default["constructive_return_min"],
        ),
        "fragile_return_max": _to_float(
            _camel_or_snake(raw_overlay, "fragileReturnMax", "fragile_return_max", overlay_default["fragile_return_max"]),
            overlay_default["fragile_return_max"],
        ),
        "extreme_vol_skip_confidence_min": _to_float(
            _camel_or_snake(raw_overlay, "extremeVolSkipConfidenceMin", "extreme_vol_skip_confidence_min", overlay_default["extreme_vol_skip_confidence_min"]),
            overlay_default["extreme_vol_skip_confidence_min"],
        ),
        "fair_value_range_lookback": int(max(1, min(60, _to_float(
            _camel_or_snake(raw_overlay, "fairValueRangeLookback", "fair_value_range_lookback", overlay_default["fair_value_range_lookback"]),
            overlay_default["fair_value_range_lookback"],
        )))),
        "fair_value_atr_multiplier": _to_float(
            _camel_or_snake(raw_overlay, "fairValueAtrMultiplier", "fair_value_atr_multiplier", overlay_default["fair_value_atr_multiplier"]),
            overlay_default["fair_value_atr_multiplier"],
        ),
        "fair_value_min_pct": _to_float(
            _camel_or_snake(raw_overlay, "fairValueMinPct", "fair_value_min_pct", overlay_default["fair_value_min_pct"]),
            overlay_default["fair_value_min_pct"],
        ),
        "optimistic_value_atr_multiplier": _to_float(
            _camel_or_snake(raw_overlay, "optimisticValueAtrMultiplier", "optimistic_value_atr_multiplier", overlay_default["optimistic_value_atr_multiplier"]),
            overlay_default["optimistic_value_atr_multiplier"],
        ),
    }

    raw_alloc = raw.get("allocation") or {}
    alloc_default = default["allocation"]
    weights = {
        regime: dict(bucket_weights)
        for regime, bucket_weights in alloc_default["weights"].items()
    }
    raw_weights = raw_alloc.get("weights") or {}
    for regime, bucket_weights in raw_weights.items():
        normalized_regime = normalize_regime(regime)
        current = weights.setdefault(normalized_regime, dict(weights["sideways"]))
        if isinstance(bucket_weights, dict):
            for bucket in AlphaBucket:
                value = bucket_weights.get(bucket.value)
                if value is not None:
                    current[bucket.value] = max(0.0, _to_float(value, current.get(bucket.value, 0.0)))
    slate_size = int(max(1, min(30, _to_float(
        _camel_or_snake(raw_alloc, "slateSize", "slate_size", alloc_default["slate_size"]),
        alloc_default["slate_size"],
    ))))
    buy_signal_count = int(max(1, min(30, _to_float(
        _camel_or_snake(raw_alloc, "buySignalCount", "buy_signal_count", alloc_default["buy_signal_count"]),
        alloc_default["buy_signal_count"],
    ))))
    score_round_decimals = int(max(0, min(6, _to_float(
        _camel_or_snake(raw_alloc, "scoreRoundDecimals", "score_round_decimals", alloc_default["score_round_decimals"]),
        alloc_default["score_round_decimals"],
    ))))
    raw_scoring = raw.get("scoring") or {}
    scoring_default = default["scoring"]
    raw_bucket_bonus = raw_scoring.get("bucketBonus") or raw_scoring.get("bucket_bonus") or {}
    scoring = {
        "bucket_bonus": {
            bucket.value: max(0.0, _to_float(
                raw_bucket_bonus.get(bucket.value),
                scoring_default["bucket_bonus"][bucket.value],
            ))
            for bucket in AlphaBucket
        },
        "regime_weight_impact": _to_float(
            _camel_or_snake(raw_scoring, "regimeWeightImpact", "regime_weight_impact", scoring_default["regime_weight_impact"]),
            scoring_default["regime_weight_impact"],
        ),
        "overlay_penalty_impact": _to_float(
            _camel_or_snake(raw_scoring, "overlayPenaltyImpact", "overlay_penalty_impact", scoring_default["overlay_penalty_impact"]),
            scoring_default["overlay_penalty_impact"],
        ),
        "score_min": _to_float(_camel_or_snake(raw_scoring, "scoreMin", "score_min", scoring_default["score_min"]), scoring_default["score_min"]),
        "score_max": _to_float(_camel_or_snake(raw_scoring, "scoreMax", "score_max", scoring_default["score_max"]), scoring_default["score_max"]),
        "confidence_weight_impact": _to_float(
            _camel_or_snake(raw_scoring, "confidenceWeightImpact", "confidence_weight_impact", scoring_default["confidence_weight_impact"]),
            scoring_default["confidence_weight_impact"],
        ),
        "confidence_penalty_impact": _to_float(
            _camel_or_snake(raw_scoring, "confidencePenaltyImpact", "confidence_penalty_impact", scoring_default["confidence_penalty_impact"]),
            scoring_default["confidence_penalty_impact"],
        ),
        "confidence_min": _to_float(
            _camel_or_snake(raw_scoring, "confidenceMin", "confidence_min", scoring_default["confidence_min"]),
            scoring_default["confidence_min"],
        ),
        "confidence_max": _to_float(
            _camel_or_snake(raw_scoring, "confidenceMax", "confidence_max", scoring_default["confidence_max"]),
            scoring_default["confidence_max"],
        ),
    }
    if scoring["score_min"] > scoring["score_max"]:
        scoring["score_min"], scoring["score_max"] = scoring["score_max"], scoring["score_min"]
    if scoring["confidence_min"] > scoring["confidence_max"]:
        scoring["confidence_min"], scoring["confidence_max"] = scoring["confidence_max"], scoring["confidence_min"]

    raw_execution = raw.get("executionOverlay") or raw.get("execution_overlay") or {}
    execution_default = default["execution_overlay"]
    execution_overlay = {
        "sizing_min": _to_float(_camel_or_snake(raw_execution, "sizingMin", "sizing_min", execution_default["sizing_min"]), execution_default["sizing_min"]),
        "sizing_max": _to_float(_camel_or_snake(raw_execution, "sizingMax", "sizing_max", execution_default["sizing_max"]), execution_default["sizing_max"]),
        "high_vol_sizing_multiplier": _to_float(
            _camel_or_snake(raw_execution, "highVolSizingMultiplier", "high_vol_sizing_multiplier", execution_default["high_vol_sizing_multiplier"]),
            execution_default["high_vol_sizing_multiplier"],
        ),
        "extreme_vol_sizing_multiplier": _to_float(
            _camel_or_snake(raw_execution, "extremeVolSizingMultiplier", "extreme_vol_sizing_multiplier", execution_default["extreme_vol_sizing_multiplier"]),
            execution_default["extreme_vol_sizing_multiplier"],
        ),
        "thin_liquidity_sizing_multiplier": _to_float(
            _camel_or_snake(raw_execution, "thinLiquiditySizingMultiplier", "thin_liquidity_sizing_multiplier", execution_default["thin_liquidity_sizing_multiplier"]),
            execution_default["thin_liquidity_sizing_multiplier"],
        ),
        "low_liquidity_sizing_multiplier": _to_float(
            _camel_or_snake(raw_execution, "lowLiquiditySizingMultiplier", "low_liquidity_sizing_multiplier", execution_default["low_liquidity_sizing_multiplier"]),
            execution_default["low_liquidity_sizing_multiplier"],
        ),
        "high_vol_stop_multiplier": _to_float(
            _camel_or_snake(raw_execution, "highVolStopMultiplier", "high_vol_stop_multiplier", execution_default["high_vol_stop_multiplier"]),
            execution_default["high_vol_stop_multiplier"],
        ),
        "extreme_vol_stop_multiplier": _to_float(
            _camel_or_snake(raw_execution, "extremeVolStopMultiplier", "extreme_vol_stop_multiplier", execution_default["extreme_vol_stop_multiplier"]),
            execution_default["extreme_vol_stop_multiplier"],
        ),
        "mean_reversion_stop_multiplier": _to_float(
            _camel_or_snake(raw_execution, "meanReversionStopMultiplier", "mean_reversion_stop_multiplier", execution_default["mean_reversion_stop_multiplier"]),
            execution_default["mean_reversion_stop_multiplier"],
        ),
        "bull_trend_target_multiplier": _to_float(
            _camel_or_snake(raw_execution, "bullTrendTargetMultiplier", "bull_trend_target_multiplier", execution_default["bull_trend_target_multiplier"]),
            execution_default["bull_trend_target_multiplier"],
        ),
        "non_bull_trend_target_multiplier": _to_float(
            _camel_or_snake(raw_execution, "nonBullTrendTargetMultiplier", "non_bull_trend_target_multiplier", execution_default["non_bull_trend_target_multiplier"]),
            execution_default["non_bull_trend_target_multiplier"],
        ),
        "defensive_risk_target_multiplier": _to_float(
            _camel_or_snake(raw_execution, "defensiveRiskTargetMultiplier", "defensive_risk_target_multiplier", execution_default["defensive_risk_target_multiplier"]),
            execution_default["defensive_risk_target_multiplier"],
        ),
    }
    if execution_overlay["sizing_min"] > execution_overlay["sizing_max"]:
        execution_overlay["sizing_min"], execution_overlay["sizing_max"] = execution_overlay["sizing_max"], execution_overlay["sizing_min"]

    raw_classification = raw.get("classification") or {}
    classification_default = default["classification"]
    classification = {
        "breakout_near_high_ratio": _to_float(
            _camel_or_snake(raw_classification, "breakoutNearHighRatio", "breakout_near_high_ratio", classification_default["breakout_near_high_ratio"]),
            classification_default["breakout_near_high_ratio"],
        ),
        "breakout_return_min": _to_float(
            _camel_or_snake(raw_classification, "breakoutReturnMin", "breakout_return_min", classification_default["breakout_return_min"]),
            classification_default["breakout_return_min"],
        ),
        "breakout_volume_ratio_min": _to_float(
            _camel_or_snake(raw_classification, "breakoutVolumeRatioMin", "breakout_volume_ratio_min", classification_default["breakout_volume_ratio_min"]),
            classification_default["breakout_volume_ratio_min"],
        ),
        "breakout_forecast_min": _to_float(
            _camel_or_snake(raw_classification, "breakoutForecastMin", "breakout_forecast_min", classification_default["breakout_forecast_min"]),
            classification_default["breakout_forecast_min"],
        ),
        "trend_return_min": _to_float(
            _camel_or_snake(raw_classification, "trendReturnMin", "trend_return_min", classification_default["trend_return_min"]),
            classification_default["trend_return_min"],
        ),
        "trend_forecast_min": _to_float(
            _camel_or_snake(raw_classification, "trendForecastMin", "trend_forecast_min", classification_default["trend_forecast_min"]),
            classification_default["trend_forecast_min"],
        ),
        "mean_reversion_rsi_max": _to_float(
            _camel_or_snake(raw_classification, "meanReversionRsiMax", "mean_reversion_rsi_max", classification_default["mean_reversion_rsi_max"]),
            classification_default["mean_reversion_rsi_max"],
        ),
        "mean_reversion_return_max": _to_float(
            _camel_or_snake(raw_classification, "meanReversionReturnMax", "mean_reversion_return_max", classification_default["mean_reversion_return_max"]),
            classification_default["mean_reversion_return_max"],
        ),
        "mean_reversion_forecast_min": _to_float(
            _camel_or_snake(raw_classification, "meanReversionForecastMin", "mean_reversion_forecast_min", classification_default["mean_reversion_forecast_min"]),
            classification_default["mean_reversion_forecast_min"],
        ),
    }
    classification["breakout_near_high_ratio"] = _to_float(
        min(1.0, max(0.80, classification["breakout_near_high_ratio"])),
        classification_default["breakout_near_high_ratio"],
    )

    raw_multipliers = raw.get("regimeBucketMultipliers") or raw.get("regime_bucket_multipliers") or {}
    multiplier_default = default["regime_bucket_multipliers"]
    regime_bucket_multipliers = {
        regime: dict(bucket_weights)
        for regime, bucket_weights in multiplier_default.items()
    }
    if isinstance(raw_multipliers, dict):
        for regime, bucket_weights in raw_multipliers.items():
            normalized_regime = normalize_regime(str(regime))
            current = regime_bucket_multipliers.setdefault(
                normalized_regime,
                dict(multiplier_default["sideways"]),
            )
            if isinstance(bucket_weights, dict):
                for bucket in AlphaBucket:
                    if bucket.value in bucket_weights:
                        current[bucket.value] = max(0.0, min(3.0, _to_float(bucket_weights[bucket.value], current[bucket.value])))

    return {
        "risk_overlay": overlay,
        "allocation": {
            "engine": str(_camel_or_snake(raw_alloc, "engine", "engine", alloc_default["engine"]) or alloc_default["engine"]),
            "controller": str(_camel_or_snake(raw_alloc, "controller", "controller", alloc_default["controller"]) or alloc_default["controller"]),
            "buy_signal_count": buy_signal_count,
            "slate_size": slate_size,
            "score_round_decimals": score_round_decimals,
            "weights": weights,
        },
        "classification": classification,
        "regime_bucket_multipliers": regime_bucket_multipliers,
        "scoring": scoring,
        "execution_overlay": execution_overlay,
    }


@dataclass(frozen=True)
class RiskOverlay:
    volatility_level: str
    liquidity_level: str
    structure: str
    skip: bool
    penalty: float
    flags: list[str]
    volatility_detail: dict[str, float]
    liquidity_detail: dict[str, float]
    structure_detail: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AlphaContext:
    edge_bucket: AlphaBucket
    regime: str
    regime_surface: dict[str, float]
    regime_weight: float
    score_adjustment: float
    confidence_multiplier: float
    sizing_multiplier: float
    stop_multiplier: float
    target_multiplier: float
    risk_overlay: RiskOverlay

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["edge_bucket"] = self.edge_bucket.value
        data["risk_overlay"] = self.risk_overlay.to_dict()
        return data


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
        return out if math.isfinite(out) else default
    except (TypeError, ValueError):
        return default


def _sorted_price_rows(payload: dict | None) -> list[dict]:
    prices = (payload or {}).get("prices") or []
    rows = [row for row in prices if isinstance(row, dict)]
    if any(row.get("date") for row in rows):
        return sorted(rows, key=lambda row: str(row.get("date") or ""))
    return rows


def _extract_closes(payload: dict | None) -> list[float]:
    closes: list[float] = []
    for row in _sorted_price_rows(payload):
        close = _to_float(row.get("close"), 0.0)
        if close > 0:
            closes.append(close)
    return closes


def _extract_volumes(payload: dict | None) -> list[float]:
    volumes: list[float] = []
    for row in _sorted_price_rows(payload):
        value = row.get("volume") or row.get("Trading_Volume")
        volumes.append(max(0.0, _to_float(value, 0.0)))
    return volumes


def _extract_price_volume_rows(payload: dict | None) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for row in _sorted_price_rows(payload):
        close = _to_float(row.get("close"), 0.0)
        if close <= 0:
            continue
        rows.append({
            "date": row.get("date") or "",
            "close": close,
            "high": _to_float(row.get("high"), close),
            "low": _to_float(row.get("low"), close),
            "volume": max(0.0, _to_float(row.get("volume") or row.get("Trading_Volume"), 0.0)),
        })
    return rows


def _last_indicator(payload: dict | None) -> dict:
    indicators = (payload or {}).get("indicators") or []
    return indicators[-1] if indicators and isinstance(indicators[-1], dict) else {}


def _pct_change(closes: list[float], lookback: int) -> float:
    if len(closes) <= lookback or closes[-lookback - 1] <= 0:
        return 0.0
    return closes[-1] / closes[-lookback - 1] - 1.0


def _realized_volatility(closes: list[float], lookback: int = 10) -> float:
    if len(closes) < 3:
        return 0.0
    window = closes[-(lookback + 1):]
    returns = [
        window[i] / window[i - 1] - 1.0
        for i in range(1, len(window))
        if window[i - 1] > 0
    ]
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((ret - mean) ** 2 for ret in returns) / (len(returns) - 1)
    return math.sqrt(max(0.0, variance))


def _multi_horizon_volatility(closes: list[float]) -> dict[str, float]:
    vol_3d = _realized_volatility(closes, 3)
    vol_10d = _realized_volatility(closes, 10)
    vol_20d = _realized_volatility(closes, 20)
    base = vol_20d if vol_20d > 0 else vol_10d
    expansion_ratio = vol_3d / base if base > 0 else 0.0
    return {
        "vol_3d": round(vol_3d, 6),
        "vol_10d": round(vol_10d, 6),
        "vol_20d": round(vol_20d, 6),
        "expansion_ratio": round(expansion_ratio, 4),
    }


def _liquidity_detail(volumes: list[float]) -> dict[str, float]:
    positive = [v for v in volumes if v > 0]
    med_volume = median(positive) if positive else 0.0
    last_volume = positive[-1] if positive else 0.0
    last_volume_ratio = last_volume / med_volume if med_volume > 0 else 0.0
    return {
        "median_volume": round(med_volume, 2),
        "last_volume": round(last_volume, 2),
        "last_volume_ratio": round(last_volume_ratio, 4),
    }


def _empty_structure_detail(status: str = "no_price_rows", **extra: Any) -> dict[str, Any]:
    return {
        "poc_price": None,
        "fair_value_low": None,
        "fair_value_high": None,
        "price_location": "unknown",
        "volume_weighted_price": None,
        "structure_status": status,
        **extra,
    }


def _price_mismatch_detail(latest: float, expected_current_price: float | None) -> dict[str, Any]:
    expected = _to_float(expected_current_price, 0.0)
    if latest <= 0 or expected <= 0:
        return {"price_mismatch_pct": 0.0, "expected_current_price": expected or None}
    mismatch = abs(latest - expected) / expected
    return {
        "price_mismatch_pct": round(mismatch, 6),
        "expected_current_price": round(expected, 4),
    }


def _structure_detail(
    payload: dict | None,
    policy: dict | None = None,
    expected_current_price: float | None = None,
) -> dict[str, Any]:
    policy = normalize_alpha_policy(policy)
    overlay_policy = policy["risk_overlay"]
    rows = _extract_price_volume_rows(payload)
    if not rows:
        return _empty_structure_detail()
    lookback = int(overlay_policy["fair_value_range_lookback"])
    valuation_rows = rows[-lookback:]
    window_start = str(valuation_rows[0].get("date") or "") if valuation_rows else ""
    window_end = str(valuation_rows[-1].get("date") or "") if valuation_rows else ""
    latest = rows[-1]["close"]
    mismatch = _price_mismatch_detail(latest, expected_current_price)
    if mismatch["price_mismatch_pct"] > 0.02:
        return _empty_structure_detail(
            "price_mismatch",
            latest_close=round(latest, 4),
            window_start_date=window_start or None,
            window_end_date=window_end or None,
            lookback_rows=len(valuation_rows),
            **mismatch,
        )
    total_volume = sum(row["volume"] for row in valuation_rows)
    weighted_price = (
        sum(row["close"] * row["volume"] for row in valuation_rows) / total_volume
        if total_volume > 0
        else sum(row["close"] for row in valuation_rows) / len(valuation_rows)
    )
    avg_range = sum(max(0.0, row["high"] - row["low"]) for row in rows[-lookback:]) / min(len(rows), lookback)
    profile_low = min(row["low"] for row in valuation_rows)
    profile_high = max(row["high"] for row in valuation_rows)
    bin_count = max(8, min(48, int(math.sqrt(len(valuation_rows)) * 8)))
    bin_width = max((profile_high - profile_low) / bin_count, weighted_price * 0.001, 0.01)
    volume_bins: dict[int, float] = {}
    for row in valuation_rows:
        low_idx = int(math.floor((row["low"] - profile_low) / bin_width))
        high_idx = int(math.floor((row["high"] - profile_low) / bin_width))
        if high_idx < low_idx:
            low_idx, high_idx = high_idx, low_idx
        touched = max(1, high_idx - low_idx + 1)
        volume_share = row["volume"] / touched if row["volume"] > 0 else 1.0 / touched
        for idx in range(low_idx, high_idx + 1):
            volume_bins[idx] = volume_bins.get(idx, 0.0) + volume_share
    fair_half_width = max(
        avg_range * overlay_policy["fair_value_atr_multiplier"],
        weighted_price * overlay_policy["fair_value_min_pct"],
    )
    policy_fair_low = weighted_price - fair_half_width
    policy_fair_high = weighted_price + fair_half_width
    if volume_bins:
        poc_idx = max(volume_bins, key=lambda idx: volume_bins[idx])
        poc = profile_low + (poc_idx + 0.5) * bin_width
        target_volume = sum(volume_bins.values()) * 0.70
        selected = {poc_idx}
        selected_volume = volume_bins[poc_idx]
        left = poc_idx - 1
        right = poc_idx + 1
        while selected_volume < target_volume and (left in volume_bins or right in volume_bins):
            left_vol = volume_bins.get(left, -1.0)
            right_vol = volume_bins.get(right, -1.0)
            if right_vol >= left_vol:
                selected.add(right)
                selected_volume += max(0.0, right_vol)
                right += 1
            else:
                selected.add(left)
                selected_volume += max(0.0, left_vol)
                left -= 1
        value_area_low = profile_low + min(selected) * bin_width
        value_area_high = profile_low + (max(selected) + 1) * bin_width
        fair_low = max(value_area_low, policy_fair_low)
        fair_high = min(value_area_high, policy_fair_high)
        if fair_low > fair_high:
            fair_low = policy_fair_low
            fair_high = policy_fair_high
        value_area_volume_pct = selected_volume / sum(volume_bins.values()) if volume_bins else 0.0
    else:
        poc = weighted_price
        fair_low = policy_fair_low
        fair_high = policy_fair_high
        value_area_volume_pct = 0.0
    optimistic_half_width = max(
        avg_range * overlay_policy["optimistic_value_atr_multiplier"],
        weighted_price * overlay_policy["fair_value_min_pct"],
    )
    optimistic_low = fair_high
    optimistic_high = weighted_price + optimistic_half_width
    if optimistic_high < optimistic_low:
        optimistic_high = optimistic_low
    if latest > optimistic_high:
        optimistic_status = "exceeded"
    elif optimistic_low <= latest <= optimistic_high:
        optimistic_status = "inside_optimistic_range"
    else:
        optimistic_status = "upside_available"
    upside_to_optimistic_high_pct = (
        (optimistic_high - latest) / latest
        if latest > 0
        else 0.0
    )
    if latest < fair_low:
        location = "below_fair_value"
    elif latest > fair_high:
        location = "above_fair_value"
    else:
        location = "in_fair_value"
    return {
        "poc_price": round(poc, 4),
        "fair_value_low": round(fair_low, 4),
        "fair_value_high": round(fair_high, 4),
        "optimistic_value_low": round(optimistic_low, 4),
        "optimistic_value_high": round(optimistic_high, 4),
        "optimistic_value_status": optimistic_status,
        "upside_to_optimistic_high_pct": round(upside_to_optimistic_high_pct, 6),
        "value_area_volume_pct": round(value_area_volume_pct, 4),
        "structure_method": "volume_profile_value_area",
        "price_location": location,
        "volume_weighted_price": round(weighted_price, 4),
        "latest_close": round(latest, 4),
        "lookback_rows": len(valuation_rows),
        "window_start_date": window_start or None,
        "window_end_date": window_end or None,
        "structure_status": "ok",
        **mismatch,
    }


def normalize_regime(regime_label: str | None) -> str:
    raw = (regime_label or "").strip().lower()
    if raw.startswith("bull"):
        return "bull"
    if raw.startswith("bear"):
        return "bear"
    if raw.startswith("volatile") or raw.startswith("crisis"):
        return "volatile"
    return "sideways"


def normalize_regime_surface(regime_label: str | None, surface: dict | None = None) -> dict[str, float]:
    weights: dict[str, float] = {"bull": 0.0, "bear": 0.0, "volatile": 0.0, "sideways": 0.0}
    if isinstance(surface, dict):
        for key, value in surface.items():
            regime = normalize_regime(str(key))
            weights[regime] += max(0.0, _to_float(value, 0.0))
    total = sum(weights.values())
    if total <= 0:
        weights[normalize_regime(regime_label)] = 1.0
        return weights
    return {regime: round(value / total, 6) for regime, value in weights.items()}


def dominant_regime(regime_label: str | None, surface: dict | None = None) -> str:
    normalized = normalize_regime_surface(regime_label, surface)
    return max(normalized, key=lambda regime: normalized[regime])


def classify_edge_bucket(rec: dict, ml: dict | None, payload: dict | None, policy: dict | None = None) -> AlphaBucket:
    policy = normalize_alpha_policy(policy)
    classification = policy["classification"]
    closes = _extract_closes(payload)
    latest = closes[-1] if closes else _to_float(rec.get("current_price"), 0.0)
    prev_high = max(closes[:-1]) if len(closes) > 1 else latest
    ret_5d = _pct_change(closes, 5)
    ind = _last_indicator(payload)
    ma20 = _to_float(ind.get("ma20"), 0.0) or (sum(closes[-20:]) / min(len(closes), 20) if closes else 0.0)
    rsi = _to_float(ind.get("rsi14"), 50.0)
    forecast = _to_float((ml or {}).get("forecast_pct"), 0.0)
    volumes = _extract_volumes(payload)
    volume_ratio = 1.0
    if len(volumes) >= 4:
        base = median([v for v in volumes[:-1] if v > 0] or [volumes[-1] or 1.0])
        volume_ratio = (volumes[-1] or 0.0) / base if base > 0 else 1.0

    near_breakout = latest > 0 and prev_high > 0 and latest >= prev_high * classification["breakout_near_high_ratio"]
    if (
        near_breakout
        and ret_5d > classification["breakout_return_min"]
        and (
            volume_ratio >= classification["breakout_volume_ratio_min"]
            or forecast >= classification["breakout_forecast_min"]
        )
    ):
        return AlphaBucket.BREAKOUT_VOL_EXPANSION
    if latest > ma20 and ret_5d > classification["trend_return_min"] and forecast > classification["trend_forecast_min"]:
        return AlphaBucket.TREND_FOLLOWING
    if (
        rsi <= classification["mean_reversion_rsi_max"]
        and ret_5d < classification["mean_reversion_return_max"]
        and forecast >= classification["mean_reversion_forecast_min"]
    ):
        return AlphaBucket.MEAN_REVERSION
    return AlphaBucket.DEFENSIVE_ACCUMULATION


def _regime_weight(bucket: AlphaBucket, regime: str, regime_surface: dict | None = None, policy: dict | None = None) -> float:
    policy = normalize_alpha_policy(policy)
    table: dict[str, dict[str, float]] = policy["regime_bucket_multipliers"]
    surface = normalize_regime_surface(regime, regime_surface)
    return sum(surface[name] * _to_float(table.get(name, table["sideways"]).get(bucket.value), 1.0) for name in surface)


def build_risk_overlay(
    payload: dict | None,
    confidence: float,
    policy: dict | None = None,
    expected_current_price: float | None = None,
) -> RiskOverlay:
    policy = normalize_alpha_policy(policy)
    overlay_policy = policy["risk_overlay"]
    closes = _extract_closes(payload)
    volumes = _extract_volumes(payload)
    volatility_detail = _multi_horizon_volatility(closes)
    liquidity_detail = _liquidity_detail(volumes)
    structure_detail = _structure_detail(payload, policy=policy, expected_current_price=expected_current_price)
    vol = max(volatility_detail["vol_10d"], volatility_detail["vol_3d"] * 0.75)
    flags: list[str] = []
    penalty = 0.0

    if (
        volatility_detail["expansion_ratio"] >= overlay_policy["volatility_expansion_ratio"]
        and volatility_detail["vol_3d"] >= overlay_policy["volatility_expansion_min_3d"]
    ):
        penalty += overlay_policy["volatility_expansion_penalty"]
        flags.append("volatility_expansion")

    if vol >= overlay_policy["extreme_vol_threshold"]:
        volatility_level = "extreme"
        penalty += overlay_policy["extreme_vol_penalty"]
        flags.append("extreme_volatility")
    elif vol >= overlay_policy["high_vol_threshold"]:
        volatility_level = "high"
        penalty += overlay_policy["high_vol_penalty"]
        flags.append("high_volatility")
    else:
        volatility_level = "normal"

    med_volume = liquidity_detail["median_volume"]
    if med_volume < overlay_policy["liquidity_low_volume"]:
        liquidity_level = "low"
        penalty += overlay_policy["low_liquidity_penalty"]
        flags.append("low_liquidity")
    elif med_volume < overlay_policy["liquidity_thin_volume"]:
        liquidity_level = "thin"
        penalty += overlay_policy["thin_liquidity_penalty"]
        flags.append("thin_liquidity")
    else:
        liquidity_level = "normal"

    ret_5d = _pct_change(closes, 5)
    structure = (
        "constructive"
        if ret_5d >= overlay_policy["constructive_return_min"]
        else "fragile"
        if ret_5d <= overlay_policy["fragile_return_max"]
        else "neutral"
    )
    if structure_detail.get("structure_status") == "ok" and structure_detail["price_location"] == "above_fair_value" and volatility_level in {"high", "extreme"}:
        penalty += overlay_policy["extended_above_fair_value_penalty"]
        flags.append("extended_above_fair_value")
    if structure == "fragile":
        penalty += overlay_policy["fragile_structure_penalty"]
        flags.append("fragile_structure")

    skip = liquidity_level == "low" or (
        volatility_level == "extreme"
        and confidence < overlay_policy["extreme_vol_skip_confidence_min"]
    )
    return RiskOverlay(
        volatility_level=volatility_level,
        liquidity_level=liquidity_level,
        structure=structure,
        skip=skip,
        penalty=round(penalty, 2),
        flags=flags,
        volatility_detail=volatility_detail,
        liquidity_detail=liquidity_detail,
        structure_detail=structure_detail,
    )


def build_alpha_context(
    rec: dict,
    ml: dict | None,
    payload: dict | None,
    regime_label: str | None = None,
    regime_surface: dict | None = None,
    policy: dict | None = None,
) -> AlphaContext:
    policy = normalize_alpha_policy(policy)
    bucket = classify_edge_bucket(rec, ml, payload, policy=policy)
    surface = normalize_regime_surface(regime_label, regime_surface)
    regime = dominant_regime(regime_label, surface)
    weight = _regime_weight(bucket, regime, surface, policy=policy)
    confidence = _to_float((ml or {}).get("confidence"), _to_float(rec.get("confidence"), 0.0))
    overlay = build_risk_overlay(
        payload,
        confidence,
        policy=policy,
        expected_current_price=_to_float(rec.get("current_price"), 0.0),
    )

    scoring = policy["scoring"]
    execution_overlay = policy["execution_overlay"]
    bucket_bonus = _to_float(scoring["bucket_bonus"].get(bucket.value), 0.0)
    score_adjustment = max(
        scoring["score_min"],
        min(
            scoring["score_max"],
            bucket_bonus
            + ((weight - 1.0) * scoring["regime_weight_impact"])
            - (overlay.penalty * scoring["overlay_penalty_impact"]),
        ),
    )
    confidence_multiplier = max(
        scoring["confidence_min"],
        min(
            scoring["confidence_max"],
            1.0
            + ((weight - 1.0) * scoring["confidence_weight_impact"])
            - (overlay.penalty * scoring["confidence_penalty_impact"]),
        ),
    )

    sizing_multiplier = weight
    if overlay.volatility_level == "high":
        sizing_multiplier *= execution_overlay["high_vol_sizing_multiplier"]
    elif overlay.volatility_level == "extreme":
        sizing_multiplier *= execution_overlay["extreme_vol_sizing_multiplier"]
    if overlay.liquidity_level == "thin":
        sizing_multiplier *= execution_overlay["thin_liquidity_sizing_multiplier"]
    elif overlay.liquidity_level == "low":
        sizing_multiplier *= execution_overlay["low_liquidity_sizing_multiplier"]
    if overlay.skip:
        sizing_multiplier = min(sizing_multiplier, policy["risk_overlay"]["skip_sizing_cap"])

    stop_multiplier = 1.0
    if overlay.volatility_level == "high":
        stop_multiplier = execution_overlay["high_vol_stop_multiplier"]
    elif overlay.volatility_level == "extreme":
        stop_multiplier = execution_overlay["extreme_vol_stop_multiplier"]
    if bucket == AlphaBucket.MEAN_REVERSION:
        stop_multiplier *= execution_overlay["mean_reversion_stop_multiplier"]

    target_multiplier = 1.0
    if bucket in {AlphaBucket.TREND_FOLLOWING, AlphaBucket.BREAKOUT_VOL_EXPANSION}:
        target_multiplier = (
            execution_overlay["bull_trend_target_multiplier"]
            if regime == "bull"
            else execution_overlay["non_bull_trend_target_multiplier"]
        )
    elif regime in {"bear", "volatile"}:
        target_multiplier = execution_overlay["defensive_risk_target_multiplier"]

    return AlphaContext(
        edge_bucket=bucket,
        regime=regime,
        regime_surface=surface,
        regime_weight=round(weight, 4),
        score_adjustment=round(score_adjustment, 2),
        confidence_multiplier=round(confidence_multiplier, 4),
        sizing_multiplier=round(max(execution_overlay["sizing_min"], min(execution_overlay["sizing_max"], sizing_multiplier)), 4),
        stop_multiplier=round(stop_multiplier, 4),
        target_multiplier=round(target_multiplier, 4),
        risk_overlay=overlay,
    )


def apply_alpha_context(rec: dict, ml: dict | None, ctx: AlphaContext) -> dict:
    context_dict = ctx.to_dict()
    rec["alpha_context"] = context_dict
    rec["score"] = round(max(0.0, _to_float(rec.get("score"), 0.0) + ctx.score_adjustment) * 10) / 10
    if ctx.risk_overlay.skip:
        rec["has_buy_signal"] = 0

    points = rec.get("watch_points") or []
    if not isinstance(points, list):
        points = []
    points.append(
        "Alpha bucket: "
        f"{ctx.edge_bucket.value}, regime={ctx.regime}, "
        f"sizing x{ctx.sizing_multiplier}, risk={ctx.risk_overlay.volatility_level}/{ctx.risk_overlay.liquidity_level}"
    )
    structure = ctx.risk_overlay.structure_detail
    if structure.get("poc_price") is not None and structure.get("structure_status") == "ok":
        points.append(
            "Market structure: "
            f"POC={structure['poc_price']}, "
            f"fair_value={structure['fair_value_low']}~{structure['fair_value_high']}, "
            f"optimistic_value={structure.get('optimistic_value_low')}~{structure.get('optimistic_value_high')}, "
            f"optimistic_status={structure.get('optimistic_value_status') or 'n/a'}, "
            f"upside_to_optimistic_high_pct={structure.get('upside_to_optimistic_high_pct') or 0}, "
            f"location={structure['price_location']}, "
            f"window={structure.get('window_start_date') or 'n/a'}~{structure.get('window_end_date') or 'n/a'}, "
            f"latest_close={structure.get('latest_close') or 'n/a'}"
        )
    elif structure.get("structure_status") == "price_mismatch":
        points.append(
            "Market structure unavailable: "
            f"payload latest_close={structure.get('latest_close')}, "
            f"current_price={structure.get('expected_current_price')}, "
            "price source mismatch"
        )
    rec["watch_points"] = points

    if ml is None:
        return rec

    ml["alpha_context"] = context_dict
    entry = _to_float(ml.get("entry_price"), 0.0)
    stop = _to_float(ml.get("stop_loss"), 0.0)
    target1 = _to_float(ml.get("target1"), 0.0)
    target2 = _to_float(ml.get("target2"), 0.0)
    if entry > 0 and 0 < stop < entry:
        ml["stop_loss"] = round(entry - ((entry - stop) * ctx.stop_multiplier), 4)
    if entry > 0 and target1 > entry:
        ml["target1"] = round(entry + ((target1 - entry) * ctx.target_multiplier), 4)
    if entry > 0 and target2 > entry:
        ml["target2"] = round(entry + ((target2 - entry) * ctx.target_multiplier), 4)
    return rec


def _allocation_weights(
    regime_label: str | None,
    policy: dict | None = None,
    regime_surface: dict | None = None,
) -> dict[str, float]:
    policy = normalize_alpha_policy(policy)
    surface = normalize_regime_surface(regime_label, regime_surface)
    policy_weights = policy["allocation"]["weights"]
    blended = {bucket.value: 0.0 for bucket in AlphaBucket}
    for regime, regime_prob in surface.items():
        bucket_weights = policy_weights.get(regime, policy_weights["sideways"])
        for bucket in AlphaBucket:
            blended[bucket.value] += regime_prob * _to_float(bucket_weights.get(bucket.value), 0.0)
    total = sum(blended.values())
    if total <= 0:
        return dict(policy_weights["sideways"])
    return {bucket: weight / total for bucket, weight in blended.items()}


def _bucket_of(row: dict) -> str | None:
    bucket = (row.get("alpha_context") or {}).get("edge_bucket")
    return bucket if isinstance(bucket, str) and bucket else None


def _bucket_quotas(weights: dict[str, float], slate_size: int) -> dict[str, int]:
    quotas = {bucket: int(math.floor(weight * slate_size)) for bucket, weight in weights.items()}
    remaining = max(0, slate_size - sum(quotas.values()))
    for bucket, _weight in sorted(weights.items(), key=lambda item: item[1], reverse=True):
        if remaining <= 0:
            break
        quotas[bucket] += 1
        remaining -= 1
    return quotas


def regime_aware_allocate(
    recommendations: list[dict],
    regime_label: str | None,
    slate_size: int | None = None,
    policy: dict | None = None,
    regime_surface: dict | None = None,
) -> list[dict]:
    """Diversify the top recommendation slate by alpha bucket.

    The function annotates selected rows and returns them in allocation order.
    It does not mutate the alpha/model score; portfolio diversification belongs
    to the selection/ranking layer, not the predictive score.
    """
    if not recommendations or not any(_bucket_of(row) for row in recommendations):
        return recommendations

    policy = normalize_alpha_policy(policy)
    if slate_size is None:
        slate_size = int(policy["allocation"]["slate_size"])
    slate_size = max(1, min(slate_size, len(recommendations)))
    weights = _allocation_weights(regime_label, policy, regime_surface=regime_surface)
    quotas = _bucket_quotas(weights, slate_size)
    by_bucket: dict[str, list[dict]] = {bucket: [] for bucket in weights}
    overflow: list[dict] = []
    for row in sorted(recommendations, key=lambda item: _to_float(item.get("score")), reverse=True):
        bucket = _bucket_of(row)
        if bucket in by_bucket:
            by_bucket[bucket].append(row)
        else:
            overflow.append(row)

    selected: list[dict] = []
    selected_ids: set[int] = set()
    for bucket in sorted(weights, key=lambda name: weights[name], reverse=True):
        for row in by_bucket[bucket][:quotas.get(bucket, 0)]:
            selected.append(row)
            selected_ids.add(id(row))

    if len(selected) < slate_size:
        remainder = [
            row for row in sorted(recommendations, key=lambda item: _to_float(item.get("score")), reverse=True)
            if id(row) not in selected_ids
        ]
        for row in remainder[: slate_size - len(selected)]:
            selected.append(row)
            selected_ids.add(id(row))

    tail = [
        row for row in sorted(recommendations, key=lambda item: _to_float(item.get("score")), reverse=True)
        if id(row) not in selected_ids
    ]
    ordered = selected + tail
    for idx, row in enumerate(selected):
        row["alpha_allocation"] = {
            "selected": True,
            "selection_rank": idx + 1,
            "regime": dominant_regime(regime_label, regime_surface),
            "regime_surface": normalize_regime_surface(regime_label, regime_surface),
            "bucket": _bucket_of(row),
            "quota": quotas.get(_bucket_of(row) or "", 0),
        }
    for row in tail:
        bucket = _bucket_of(row)
        if bucket:
            row["alpha_allocation"] = {
                "selected": False,
                "regime": dominant_regime(regime_label, regime_surface),
                "regime_surface": normalize_regime_surface(regime_label, regime_surface),
                "bucket": bucket,
                "quota": quotas.get(bucket, 0),
            }
    return ordered
