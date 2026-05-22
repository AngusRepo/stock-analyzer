from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.alpha_framework import (  # noqa: E402
    AlphaBucket,
    apply_alpha_context,
    build_alpha_context,
    build_risk_overlay,
    regime_aware_allocate,
    normalize_alpha_policy,
    normalize_regime_surface,
)
from services import recommendation_service  # noqa: E402
from services.recommendation_service import filter_and_score_recommendations  # noqa: E402
from services.recommendation_service import write_predictions_to_d1  # noqa: E402
from services.recommendation_service import merge_llm_reasons_into_recommendations  # noqa: E402
from services.recommendation_service import merge_breeze2_reason_shadow_into_score_components  # noqa: E402


def _payload(symbol: str, closes: list[float], rsi: float = 58.0, volume: float = 1_500_000) -> dict:
    prices = [
        {
            "date": f"2026-04-{idx + 1:02d}",
            "close": close,
            "open": close * 0.99,
            "high": close * 1.02,
            "low": close * 0.98,
            "volume": volume,
        }
        for idx, close in enumerate(closes)
    ]
    return {
        "symbol": symbol,
        "prices": prices,
        "indicators": [{"rsi14": rsi, "macdHist": 0.5, "ma20": sum(closes[-20:]) / min(len(closes), 20)}],
        "chips": [{"foreign_net": 1_000_000, "trust_net": 300_000}],
    }


def _payload_with_volumes(symbol: str, closes: list[float], volumes: list[float]) -> dict:
    start = date(2026, 3, 1)
    prices = [
        {
            "date": (start + timedelta(days=idx)).isoformat(),
            "close": close,
            "open": close * 0.995,
            "high": close * 1.01,
            "low": close * 0.99,
            "volume": volumes[idx],
        }
        for idx, close in enumerate(closes)
    ]
    return {
        "symbol": symbol,
        "prices": prices,
        "indicators": [{"rsi14": 61.0, "macdHist": 0.3, "ma20": sum(closes[-20:]) / min(len(closes), 20)}],
        "chips": [],
    }


def test_build_alpha_context_classifies_breakout_and_applies_bull_regime_weight():
    payload = _payload("2330", [90, 91, 92, 93, 94, 95, 96, 98, 100, 106], rsi=64)
    rec = {"chip_score": 18.0, "tech_score": 18.0}
    ml = {"signal": "BUY", "confidence": 0.74, "forecast_pct": 0.045}

    ctx = build_alpha_context(rec, ml, payload, "bull")

    assert ctx.edge_bucket == AlphaBucket.BREAKOUT_VOL_EXPANSION
    assert ctx.regime_weight > 1.0
    assert ctx.score_adjustment > 0
    assert ctx.risk_overlay.skip is False
    assert ctx.sizing_multiplier >= 1.0


def test_build_alpha_context_penalizes_high_volatility_low_liquidity_setup():
    payload = _payload("2317", [100, 82, 110, 76, 118, 72, 121, 69, 116, 70], rsi=48, volume=10_000)
    rec = {"chip_score": 8.0, "tech_score": 9.0}
    ml = {"signal": "BUY", "confidence": 0.55, "forecast_pct": 0.012}

    ctx = build_alpha_context(rec, ml, payload, "bear")

    assert ctx.risk_overlay.skip is True
    assert ctx.sizing_multiplier < 1.0
    assert ctx.stop_multiplier > 1.0
    assert ctx.score_adjustment < 0
    assert "low_liquidity" in ctx.risk_overlay.flags


def test_risk_overlay_exposes_multi_horizon_volatility_and_market_structure():
    closes = [
        96, 97, 98, 99, 100, 101, 103, 105, 104, 106,
        107, 108, 109, 110, 111, 113, 112, 114, 116, 118,
        119, 121, 124, 126,
    ]
    volumes = [
        500_000, 520_000, 530_000, 540_000, 560_000, 580_000,
        600_000, 4_500_000, 620_000, 640_000, 660_000, 680_000,
        700_000, 720_000, 740_000, 760_000, 780_000, 800_000,
        820_000, 840_000, 860_000, 880_000, 900_000, 920_000,
    ]
    ctx = build_alpha_context(
        {"chip_score": 18.0, "tech_score": 17.0},
        {"signal": "BUY", "confidence": 0.76, "forecast_pct": 0.04},
        _payload_with_volumes("2454", closes, volumes),
        "bull",
    )

    overlay = ctx.risk_overlay.to_dict()
    assert overlay["volatility_detail"]["vol_3d"] > 0
    assert overlay["volatility_detail"]["vol_10d"] > 0
    assert overlay["volatility_detail"]["expansion_ratio"] >= 0
    assert overlay["liquidity_detail"]["median_volume"] >= 500_000
    assert overlay["liquidity_detail"]["last_volume_ratio"] > 0
    assert overlay["structure_detail"]["structure_method"] == "volume_profile_value_area"
    assert overlay["structure_detail"]["poc_price"] > 0
    assert overlay["structure_detail"]["fair_value_low"] < overlay["structure_detail"]["fair_value_high"]
    assert overlay["structure_detail"]["optimistic_value_low"] >= overlay["structure_detail"]["fair_value_high"]
    assert overlay["structure_detail"]["optimistic_value_high"] >= overlay["structure_detail"]["optimistic_value_low"]
    assert overlay["structure_detail"]["optimistic_value_status"] in {
        "upside_available",
        "inside_optimistic_range",
        "exceeded",
    }
    assert "upside_to_optimistic_high_pct" in overlay["structure_detail"]
    assert overlay["structure_detail"]["price_location"] in {
        "below_fair_value",
        "in_fair_value",
        "above_fair_value",
    }


def test_market_structure_uses_recent_value_area_not_full_history_vwap():
    old_prices = [100 + idx for idx in range(30)]
    recent_prices = [250, 252, 251, 253, 252, 254, 253, 255, 254, 253]
    closes = old_prices + recent_prices
    volumes = [2_000_000] * len(old_prices) + [800_000] * len(recent_prices)
    payload = _payload_with_volumes("5292", closes, volumes)

    overlay = build_risk_overlay(payload, confidence=0.8)
    structure = overlay.structure_detail

    assert structure["volume_weighted_price"] == pytest.approx(252.7, abs=3.0)
    assert structure["fair_value_low"] > 230
    assert structure["price_location"] in {"in_fair_value", "above_fair_value"}


def test_market_structure_value_area_uses_volume_profile_bins():
    closes = [100, 101, 102, 150, 151, 152, 153, 154, 155, 156]
    volumes = [100_000, 100_000, 100_000, 5_000_000, 6_000_000, 5_500_000, 5_200_000, 5_100_000, 5_000_000, 4_900_000]
    payload = _payload_with_volumes("3037", closes, volumes)

    overlay = build_risk_overlay(payload, confidence=0.8)
    structure = overlay.structure_detail

    assert structure["structure_method"] == "volume_profile_value_area"
    assert 149 <= structure["poc_price"] <= 153
    assert structure["fair_value_low"] >= 145
    assert structure["fair_value_high"] >= structure["fair_value_low"]
    assert structure["value_area_volume_pct"] >= 0.65
    assert structure["window_start_date"] == "2026-03-01"
    assert structure["window_end_date"] == "2026-03-10"


def test_market_structure_sorts_price_rows_by_date_before_recent_window():
    old_prices = [100 + idx for idx in range(30)]
    recent_prices = [250, 252, 251, 253, 252, 254, 253, 255, 254, 253]
    closes = old_prices + recent_prices
    volumes = [2_000_000] * len(old_prices) + [800_000] * len(recent_prices)
    payload = _payload_with_volumes("2330", closes, volumes)
    payload["prices"] = list(reversed(payload["prices"]))

    overlay = build_risk_overlay(payload, confidence=0.8)
    structure = overlay.structure_detail

    assert structure["volume_weighted_price"] == pytest.approx(252.7, abs=3.0)
    assert structure["poc_price"] > 240
    assert structure["latest_close"] == 253
    assert structure["window_start_date"] == "2026-03-31"
    assert structure["window_end_date"] == "2026-04-09"


def test_market_structure_rejects_price_source_mismatch():
    old_prices = [100 + idx for idx in range(30)]
    recent_prices = [250, 252, 251, 253, 252, 254, 253, 255, 254, 253]
    closes = old_prices + recent_prices
    volumes = [2_000_000] * len(old_prices) + [800_000] * len(recent_prices)
    payload = _payload_with_volumes("2330", closes, volumes)

    overlay = build_risk_overlay(payload, confidence=0.8, expected_current_price=120.0)
    structure = overlay.structure_detail

    assert structure["structure_status"] == "price_mismatch"
    assert structure["poc_price"] is None
    assert structure["latest_close"] == 253


def test_apply_alpha_context_adjusts_recommendation_and_prediction_targets():
    payload = _payload("2454", [90, 91, 93, 95, 98, 101, 104, 108, 112, 116], rsi=62)
    rec = {
        "symbol": "2454",
        "score": 58.0,
        "confidence": 0.72,
        "has_buy_signal": 1,
        "watch_points": [],
    }
    ml = {
        "signal": "BUY",
        "confidence": 0.72,
        "forecast_pct": 0.04,
        "entry_price": 116.0,
        "stop_loss": 110.0,
        "target1": 124.0,
        "target2": 130.0,
    }

    ctx = build_alpha_context(rec, ml, payload, "bull")
    out = apply_alpha_context(rec, ml, ctx)

    assert out["alpha_context"]["edge_bucket"] in {"breakout_vol_expansion", "trend_following"}
    assert out["score"] > 58.0
    assert ml["alpha_context"]["risk_overlay"]["volatility_level"] in {"normal", "high"}
    assert ml["stop_loss"] <= 110.0
    assert ml["target1"] >= 124.0


def test_filter_and_score_recommendations_embeds_alpha_context(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    prediction = {
        "signal": "BUY",
        "confidence": 0.74,
        "forecast_pct": 0.04,
        "entry_price": 106.0,
        "stop_loss": 100.0,
        "target1": 114.0,
        "target2": 120.0,
        "ensemble_v2": {
            "signal": "BUY",
            "confidence": 0.74,
            "forecast_pct": 0.04,
            "signal_source": "ensemble_v2",
        },
    }
    rec = {
        "id": 1,
        "date": "2026-04-26",
        "symbol": "2330",
        "name": "TSMC",
        "sector": "Semis",
        "industry": "IC",
        "chip_score": 18.0,
        "tech_score": 18.0,
    }

    final, sell_count = filter_and_score_recommendations(
        [rec],
        {"2330": prediction},
        [_payload("2330", [90, 91, 92, 93, 94, 95, 96, 98, 100, 106], rsi=64)],
        regime_label="bull",
    )

    assert sell_count == 0
    assert final[0]["alpha_context"]["edge_bucket"] == "breakout_vol_expansion"
    assert prediction["alpha_context"]["edge_bucket"] == "breakout_vol_expansion"
    assert any("Alpha bucket:" in point for point in final[0]["watch_points"])


def test_write_predictions_to_d1_persists_alpha_context(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    write_predictions_to_d1(
        {
            "2330": {
                "signal": "BUY",
                "confidence": 0.74,
                "forecast_pct": 0.04,
                "entry_price": 106.0,
                "stop_loss": 100.0,
                "target1": 114.0,
                "target2": 120.0,
                "feature_version": "v2",
                "ensemble_v2": {"signal": "BUY", "signal_source": "ensemble_v2"},
                "alpha_context": {
                    "edge_bucket": "breakout_vol_expansion",
                    "regime": "bull",
                    "sizing_multiplier": 1.12,
                },
            }
        },
        {"2330": 1},
    )

    forecast_data = next(
        param
        for _sql, params in captured["statements"]
        for param in params
        if isinstance(param, str) and '"alpha_context"' in param
    )
    assert '"alpha_context"' in forecast_data
    assert '"edge_bucket": "breakout_vol_expansion"' in forecast_data


def test_merge_llm_reasons_preserves_domain_watch_points():
    rows = [{
        "symbol": "2330",
        "reason": "template",
        "watch_points": [
            "ML 信心中等，方向未明確，可等待訊號確認",
            "Alpha bucket: breakout_vol_expansion, regime=bull, sizing x0.9, risk=normal/normal",
            "Market structure: POC=2265, fair_value=2062~2123, location=above_fair_value, window=2026-04-13~2026-04-27, latest_close=2265",
        ],
    }]

    merge_llm_reasons_into_recommendations(
        rows,
        {
            "2330": {
                "reason": "LLM reason",
                "watchPoints": ["觀察 2265 支撐", "留意成交量"],
            }
        },
    )

    assert rows[0]["reason"] == "LLM reason"
    assert rows[0]["watch_points"][:2] == ["觀察 2265 支撐", "留意成交量"]
    assert any(point.startswith("Alpha bucket:") for point in rows[0]["watch_points"])
    assert any("window=2026-04-13~2026-04-27" in point for point in rows[0]["watch_points"])


def test_breeze2_shadow_persists_as_score_v2_reason_variant_without_overwriting_gemini_reason():
    rows = [{
        "symbol": "2330",
        "reason": "Gemini reason",
        "score_components": {
            "version": "score_v2",
            "total": 61,
            "finalScore": 63,
            "components": {
                "mlEdge": 20,
                "chipFlow": 18,
                "technicalStructure": 16,
                "fundamentalQuality": 5,
                "newsTheme": 2,
            },
        },
    }]

    merge_breeze2_reason_shadow_into_score_components(
        rows,
        {
            "2330": {
                "source": "breeze2_generation_shadow",
                "decision_effect": "advisory_only",
                "reason": "Breeze2：量能未確認，先等回測。",
                "watchPoints": ["觀察量能", "跌破支撐降風險"],
                "breeze2_context": "generation_shadow",
                "riskFlags": ["volume_confirmation_needed"],
            }
        },
    )

    assert rows[0]["reason"] == "Gemini reason"
    variant = rows[0]["score_components"]["reasonVariants"]["breeze2"]
    assert variant["reason"] == "Breeze2：量能未確認，先等回測。"
    assert variant["decision_effect"] == "advisory_only"
    assert variant["watchPoints"] == ["觀察量能", "跌破支撐降風險"]


def _allocation_row(symbol: str, score: float, bucket: str) -> dict:
    return {
        "symbol": symbol,
        "score": score,
        "alpha_context": {
            "edge_bucket": bucket,
            "regime": "sideways",
        },
    }


def test_regime_aware_allocate_diversifies_sideways_top_slate():
    rows = [
        _allocation_row("A1", 99, "trend_following"),
        _allocation_row("A2", 98, "trend_following"),
        _allocation_row("A3", 97, "trend_following"),
        _allocation_row("M1", 88, "mean_reversion"),
        _allocation_row("M2", 87, "mean_reversion"),
        _allocation_row("D1", 86, "defensive_accumulation"),
        _allocation_row("B1", 85, "breakout_vol_expansion"),
    ]

    allocated = regime_aware_allocate(rows, "sideways", slate_size=4)

    top = allocated[:4]
    top_buckets = [row["alpha_context"]["edge_bucket"] for row in top]
    assert top_buckets.count("mean_reversion") >= 1
    assert top_buckets.count("defensive_accumulation") >= 1
    assert top_buckets.count("trend_following") <= 2
    assert all(row["alpha_allocation"]["selected"] is True for row in top)
    original_scores = {row["symbol"]: row["score"] for row in rows}
    assert all(row["score"] == original_scores[row["symbol"]] for row in allocated)


def test_regime_aware_allocate_keeps_score_order_when_no_alpha_context():
    rows = [
        {"symbol": "A", "score": 30.0},
        {"symbol": "B", "score": 20.0},
        {"symbol": "C", "score": 10.0},
    ]

    allocated = regime_aware_allocate(rows, "bull", slate_size=2)

    assert [row["symbol"] for row in allocated] == ["A", "B", "C"]
    assert all("alpha_allocation" not in row for row in allocated)


def test_regime_aware_allocate_uses_policy_weights_and_slate_size():
    rows = [
        _allocation_row("A1", 99, "trend_following"),
        _allocation_row("A2", 98, "trend_following"),
        _allocation_row("B1", 90, "breakout_vol_expansion"),
        _allocation_row("M1", 89, "mean_reversion"),
        _allocation_row("D1", 88, "defensive_accumulation"),
    ]
    policy = normalize_alpha_policy({
        "allocation": {
            "slateSize": 3,
            "weights": {
                "bull": {
                    "trend_following": 0.0,
                    "breakout_vol_expansion": 0.0,
                    "mean_reversion": 0.0,
                    "defensive_accumulation": 1.0,
                }
            },
        }
    })

    allocated = regime_aware_allocate(rows, "bull", policy=policy)

    assert allocated[0]["symbol"] == "D1"
    assert allocated[0]["alpha_allocation"]["quota"] == 3
    assert sum(1 for row in allocated if row.get("alpha_allocation", {}).get("selected")) == 3


def test_regime_aware_allocate_does_not_mutate_predictive_score():
    rows = [
        _allocation_row("T1", 99.03, "trend_following"),
        _allocation_row("D1", 88.02, "defensive_accumulation"),
    ]
    policy = normalize_alpha_policy({
        "allocation": {
            "slateSize": 1,
            "scoreRoundDecimals": 3,
            "weights": {
                "bull": {
                    "trend_following": 0.0,
                    "breakout_vol_expansion": 0.0,
                    "mean_reversion": 0.0,
                    "defensive_accumulation": 1.0,
                }
            },
        }
    })

    allocated = regime_aware_allocate(rows, "bull", policy=policy)

    assert allocated[0]["symbol"] == "D1"
    assert allocated[0]["score"] == 88.02
    assert "score_boost" not in allocated[0]["alpha_allocation"]


def test_build_alpha_context_uses_policy_overlay_thresholds():
    payload = _payload("2317", [100, 82, 110, 76, 118, 72, 121, 69, 116, 70], rsi=48, volume=80_000)
    policy = normalize_alpha_policy({
        "riskOverlay": {
            "liquidityLowVolume": 100_000,
            "liquidityThinVolume": 300_000,
            "extremeVolThreshold": 0.5,
            "highVolThreshold": 0.4,
        }
    })

    ctx = build_alpha_context(
        {"chip_score": 8.0, "tech_score": 9.0},
        {"signal": "BUY", "confidence": 0.75, "forecast_pct": 0.02},
        payload,
        "bear",
        policy=policy,
    )

    assert ctx.risk_overlay.liquidity_level == "low"
    assert ctx.risk_overlay.skip is True


def test_risk_overlay_uses_policy_penalties_and_structure_thresholds():
    payload = _payload("2317", [100, 82, 110, 76, 118, 72, 121, 69, 116, 70], rsi=48, volume=10_000)
    policy = normalize_alpha_policy({
        "riskOverlay": {
            "volatilityExpansionRatio": 99.0,
            "highVolThreshold": 0.001,
            "extremeVolThreshold": 0.5,
            "liquidityLowVolume": 100_000,
            "liquidityThinVolume": 300_000,
            "highVolPenalty": 7.0,
            "lowLiquidityPenalty": 9.0,
            "fragileReturnMax": -0.02,
            "fragileStructurePenalty": 4.0,
        }
    })

    overlay = build_risk_overlay(payload, confidence=0.80, policy=policy)

    assert overlay.volatility_level == "high"
    assert overlay.liquidity_level == "low"
    assert overlay.structure == "fragile"
    assert overlay.penalty == 20.0


def test_risk_overlay_uses_policy_fair_value_zone_width():
    closes = [100, 101, 102, 103, 104, 105]
    payload = _payload_with_volumes("2454", closes, [1_000_000] * len(closes))
    narrow = normalize_alpha_policy({
        "riskOverlay": {
            "fairValueRangeLookback": 3,
            "fairValueAtrMultiplier": 0.1,
            "fairValueMinPct": 0.001,
        }
    })
    wide = normalize_alpha_policy({
        "riskOverlay": {
            "fairValueRangeLookback": 3,
            "fairValueAtrMultiplier": 3.0,
            "fairValueMinPct": 0.10,
        }
    })

    narrow_overlay = build_risk_overlay(payload, confidence=0.80, policy=narrow)
    wide_overlay = build_risk_overlay(payload, confidence=0.80, policy=wide)

    assert narrow_overlay.structure_detail["price_location"] == "above_fair_value"
    assert wide_overlay.structure_detail["price_location"] == "in_fair_value"


def test_build_alpha_context_uses_policy_scoring_and_execution_overlay():
    payload = _payload("2454", [90, 91, 93, 95, 98, 101, 104, 108, 112, 116], rsi=62)
    policy = normalize_alpha_policy({
        "scoring": {
            "bucketBonus": {
                "breakout_vol_expansion": 6.0,
            },
            "scoreMax": 4.0,
            "confidenceMax": 1.02,
        },
        "executionOverlay": {
            "sizingMax": 0.90,
            "bullTrendTargetMultiplier": 1.30,
            "highVolStopMultiplier": 1.40,
        },
        "riskOverlay": {
            "highVolThreshold": 0.001,
            "extremeVolThreshold": 0.50,
        },
    })

    ctx = build_alpha_context(
        {"chip_score": 18.0, "tech_score": 18.0},
        {"signal": "BUY", "confidence": 0.82, "forecast_pct": 0.04},
        payload,
        "bull",
        policy=policy,
    )

    assert ctx.edge_bucket == AlphaBucket.BREAKOUT_VOL_EXPANSION
    assert ctx.score_adjustment <= 4.0
    assert ctx.confidence_multiplier <= 1.02
    assert ctx.sizing_multiplier <= 0.90
    assert ctx.stop_multiplier == 1.40
    assert ctx.target_multiplier == 1.30


def test_build_alpha_context_uses_policy_classification_thresholds():
    payload = _payload("2330", [90, 91, 92, 93, 94, 95, 96, 98, 100, 106], rsi=64)
    policy = normalize_alpha_policy({
        "classification": {
            "breakoutReturnMin": 0.20,
            "breakoutVolumeRatioMin": 3.0,
            "breakoutForecastMin": 0.20,
        }
    })

    ctx = build_alpha_context(
        {"chip_score": 18.0, "tech_score": 18.0},
        {"signal": "BUY", "confidence": 0.74, "forecast_pct": 0.045},
        payload,
        "bull",
        policy=policy,
    )

    assert ctx.edge_bucket == AlphaBucket.TREND_FOLLOWING


def test_build_alpha_context_uses_policy_regime_bucket_multipliers():
    payload = _payload("2330", [90, 91, 92, 93, 94, 95, 96, 98, 100, 106], rsi=64)
    policy = normalize_alpha_policy({
        "regimeBucketMultipliers": {
            "bear": {
                "breakout_vol_expansion": 1.55,
            }
        }
    })

    ctx = build_alpha_context(
        {"chip_score": 18.0, "tech_score": 18.0},
        {"signal": "BUY", "confidence": 0.74, "forecast_pct": 0.045},
        payload,
        "bear",
        policy=policy,
    )

    assert ctx.edge_bucket == AlphaBucket.BREAKOUT_VOL_EXPANSION
    assert ctx.regime_weight == 1.55


def test_regime_surface_blends_context_weight_instead_of_hard_label():
    payload = _payload("2330", [90, 91, 92, 93, 94, 95, 96, 98, 100, 106], rsi=64)
    rec = {"chip_score": 18.0, "tech_score": 18.0}
    ml = {"signal": "BUY", "confidence": 0.74, "forecast_pct": 0.045}

    ctx = build_alpha_context(
        rec,
        ml,
        payload,
        "bull_market",
        regime_surface={"bull_market": 0.55, "bear_market": 0.25, "sideways": 0.20},
    )

    assert ctx.regime == "bull"
    assert ctx.regime_surface == {"bull": 0.55, "bear": 0.25, "volatile": 0.0, "sideways": 0.2}
    assert 1.0 < ctx.regime_weight < 1.12


def test_regime_surface_blends_allocation_quotas():
    rows = [
        _allocation_row("T1", 99, "trend_following"),
        _allocation_row("T2", 98, "trend_following"),
        _allocation_row("B1", 92, "breakout_vol_expansion"),
        _allocation_row("M1", 88, "mean_reversion"),
        _allocation_row("D1", 87, "defensive_accumulation"),
    ]

    allocated = regime_aware_allocate(
        rows,
        "bull_market",
        slate_size=4,
        regime_surface={"bull_market": 0.5, "sideways": 0.5},
    )

    selected = [row for row in allocated if row.get("alpha_allocation", {}).get("selected")]
    assert len(selected) == 4
    assert selected[0]["alpha_allocation"]["regime_surface"]["bull"] == 0.5
    assert any(row["alpha_allocation"]["bucket"] == "mean_reversion" for row in selected)


def test_normalize_regime_surface_falls_back_to_one_hot_label():
    assert normalize_regime_surface("volatile", {}) == {
        "bull": 0.0,
        "bear": 0.0,
        "volatile": 1.0,
        "sideways": 0.0,
    }
