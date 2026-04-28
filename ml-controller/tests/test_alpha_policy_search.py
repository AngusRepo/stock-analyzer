from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.alpha_framework import DEFAULT_ALPHA_POLICY  # noqa: E402
from services.alpha_policy_search import build_alpha_policy_candidate, extract_alpha_outcomes  # noqa: E402


def _row(
    regime: str,
    bucket: str,
    pnl_r: float,
    selected: bool = True,
    skipped: bool = False,
    volatility_level: str = "normal",
    liquidity_level: str = "normal",
    vol_3d: float | None = None,
    vol_10d: float | None = None,
    expansion_ratio: float | None = None,
    median_volume: float | None = None,
) -> dict:
    risk_overlay = {
        "skip": skipped,
        "volatility_level": volatility_level,
        "liquidity_level": liquidity_level,
    }
    if vol_3d is not None or vol_10d is not None or expansion_ratio is not None:
        risk_overlay["volatility_detail"] = {
            "vol_3d": vol_3d,
            "vol_10d": vol_10d,
            "expansion_ratio": expansion_ratio,
        }
    if median_volume is not None:
        risk_overlay["liquidity_detail"] = {"median_volume": median_volume}
    return {
        "forecast_data": json.dumps({
            "alpha_context": {
                "regime": regime,
                "edge_bucket": bucket,
                "risk_overlay": risk_overlay,
            },
            "alpha_allocation": {"selected": selected, "regime": regime, "bucket": bucket},
        }),
        "trade_pnl_r": pnl_r,
    }


def test_extract_alpha_outcomes_ignores_rows_without_alpha_context():
    rows = [
        {"forecast_data": "{}", "trade_pnl_r": 1.0},
        _row("bull", "trend_following", 0.8),
    ]

    outcomes = extract_alpha_outcomes(rows)

    assert len(outcomes) == 1
    assert outcomes[0].regime == "bull"
    assert outcomes[0].bucket == "trend_following"
    assert outcomes[0].pnl_r == 0.8


def test_extract_alpha_outcomes_uses_policy_return_to_r_conversion():
    rows = [
        {
            **_row("bull", "trend_following", 0.0),
            "trade_pnl_r": None,
            "actual_return_pct": 0.04,
        },
        {
            **_row("bull", "mean_reversion", 0.0),
            "trade_pnl_r": None,
            "direction_correct": False,
        },
    ]

    outcomes = extract_alpha_outcomes(
        rows,
        return_pct_per_r=0.01,
        direction_correct_fallback_r=0.50,
    )

    assert outcomes[0].pnl_r == 4.0
    assert outcomes[1].pnl_r == -0.5


def test_build_alpha_policy_candidate_skips_until_enough_real_outcomes():
    result = build_alpha_policy_candidate([_row("bull", "trend_following", 0.8)], min_samples=3)

    assert result["status"] == "skipped"
    assert result["reason"] == "insufficient_alpha_outcomes"


def test_build_alpha_policy_candidate_adjusts_regime_bucket_weights():
    rows = []
    rows.extend(_row("bull", "trend_following", 1.0) for _ in range(12))
    rows.extend(_row("bull", "mean_reversion", -0.6) for _ in range(8))
    rows.extend(_row("sideways", "mean_reversion", 0.7) for _ in range(8))
    rows.extend(_row("sideways", "breakout_vol_expansion", -0.4) for _ in range(6))
    rows.extend(_row("bear", "defensive_accumulation", 0.3) for _ in range(6))

    result = build_alpha_policy_candidate(rows, min_samples=20, min_regime_samples=4, min_bucket_samples=3)

    assert result["status"] == "completed"
    policy = result["alphaFramework"]
    bull_weights = policy["allocation"]["weights"]["bull"]
    sideways_weights = policy["allocation"]["weights"]["sideways"]
    assert bull_weights["trend_following"] > bull_weights["mean_reversion"]
    assert sideways_weights["mean_reversion"] > sideways_weights["breakout_vol_expansion"]
    assert round(sum(bull_weights.values()), 4) == 1.0


def test_build_alpha_policy_candidate_uses_posterior_regularization_controls():
    rows = []
    rows.extend(_row("bull", "trend_following", 1.0) for _ in range(4))
    rows.extend(_row("bull", "mean_reversion", -1.0) for _ in range(4))

    result = build_alpha_policy_candidate(
        rows,
        min_samples=8,
        min_regime_samples=4,
        min_bucket_samples=4,
        posterior_full_confidence_samples=4,
        posterior_weight_impact=0.30,
        min_bucket_weight=0.05,
    )

    weights = result["alphaFramework"]["allocation"]["weights"]["bull"]
    assert result["status"] == "completed"
    assert weights["trend_following"] > 0.50
    assert weights["mean_reversion"] < 0.05
    assert result["search_policy"]["posterior_full_confidence_samples"] == 4
    assert result["search_policy"]["posterior_weight_impact"] == 0.30
    assert result["search_policy"]["min_bucket_weight"] == 0.05


def test_build_alpha_policy_candidate_adapts_risk_overlay_from_outcome_distribution():
    rows = []
    rows.extend(
        _row(
            "volatile",
            "breakout_vol_expansion",
            -0.8,
            skipped=False,
            volatility_level="high",
            liquidity_level="thin",
            vol_3d=0.070,
            vol_10d=0.060,
            expansion_ratio=2.4,
            median_volume=120_000,
        )
        for _ in range(12)
    )
    rows.extend(
        _row(
            "bull",
            "trend_following",
            0.7,
            skipped=False,
            volatility_level="normal",
            liquidity_level="normal",
            vol_3d=0.018,
            vol_10d=0.020,
            expansion_ratio=1.1,
            median_volume=850_000,
        )
        for _ in range(12)
    )
    rows.extend(
        _row(
            "bear",
            "defensive_accumulation",
            -0.3,
            skipped=True,
            volatility_level="extreme",
            liquidity_level="low",
            vol_3d=0.095,
            vol_10d=0.080,
            expansion_ratio=2.9,
            median_volume=35_000,
        )
        for _ in range(8)
    )

    result = build_alpha_policy_candidate(rows, min_samples=20, min_regime_samples=4, min_bucket_samples=4)

    overlay = result["alphaFramework"]["riskOverlay"]
    default = DEFAULT_ALPHA_POLICY["risk_overlay"]
    assert result["status"] == "completed"
    assert overlay["highVolThreshold"] != default["high_vol_threshold"]
    assert overlay["extremeVolThreshold"] > overlay["highVolThreshold"]
    assert overlay["volatilityExpansionRatio"] != default["volatility_expansion_ratio"]
    assert overlay["liquidityLowVolume"] != default["liquidity_low_volume"]
    assert overlay["liquidityThinVolume"] >= overlay["liquidityLowVolume"]
    assert overlay["skipSizingCap"] < default["skip_sizing_cap"]
    evidence = result["risk_overlay_evidence"]
    assert evidence["method"] == "posterior_numeric_outcome_distribution"
    assert evidence["numeric_sample_counts"]["volatility"] == 32
    assert "alphaFramework.riskOverlay.highVolThreshold" in evidence["adaptive_fields"]
