from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from services.recommendation_service import build_score_components


REPO_ROOT = Path(__file__).resolve().parents[2]
TECHNICAL_FIXTURE_PATH = REPO_ROOT / "worker" / "src" / "lib" / "technicalIndicatorsV2.fixture.json"


def _load_technical_fixture() -> dict:
    return json.loads(TECHNICAL_FIXTURE_PATH.read_text(encoding="utf-8"))


def test_score_v2_technical_signals_are_canonical_payload_fields():
    payload = build_score_components(
        {
            "score_seed_inputs": {
                "chipFlowSeed40": 18.0,
                "technicalSeed30": 18.0,
                "screenerMomentumSeed20": 12.0,
                "mlEdgeSeed30": 21.0,
                "personaAlphaSeed": 0.0,
            },
            "current_price": 100.0,
            "ma20": 96.0,
            "macd_hist": 0.4,
            "atr14": 2.0,
            "plus_di14": 34.0,
            "minus_di14": 12.0,
            "adx14": 29.0,
            "parabolic_sar": 95.0,
            "cci20": 88.0,
            "rsi14": 58.0,
            "volume_weighted_rsi14": 64.0,
            "volume_momentum_divergence_13_27_10": 125000.0,
            "squeeze_on": 0,
            "squeeze_release": 1,
            "squeeze_momentum": 1.8,
            "obv_temperature_60": 82.0,
            "adaptive_rsi_midline_50": 61.0,
            "adaptive_rsi_upper_50": 84.0,
            "adaptive_rsi_lower_50": 38.0,
            "adaptive_rsi_overbought": 0,
            "adaptive_rsi_oversold": 0,
        },
        raw_score=69.0,
    )

    assert payload["version"] == "score_v2"
    assert payload["weights"] == {
        "mlEdge": 25,
        "chipFlow": 25,
        "technicalStructure": 25,
        "fundamentalQuality": 20,
        "newsTheme": 5,
    }
    assert payload["technicalSignals"]["adx14"] == pytest.approx(29.0)
    assert payload["technicalSignals"]["parabolicSar"] == pytest.approx(95.0)
    assert payload["technicalSignals"]["volumeMomentumDivergence132710"] == pytest.approx(125000.0)
    assert payload["technicalSignals"]["squeezeRelease"] == pytest.approx(1.0)
    assert payload["technicalSignals"]["squeezeMomentum"] == pytest.approx(1.8)
    assert payload["technicalSignals"]["obvTemperature60"] == pytest.approx(82.0)
    assert payload["technicalSignals"]["adaptiveRsiUpper50"] == pytest.approx(84.0)
    assert payload["technicalSignals"]["adaptiveRsiOverbought"] == pytest.approx(0.0)
    assert payload["technicalBreakdown"]["trendStructure"] > 0
    assert payload["technicalBreakdown"]["volatilityStructure"] > 0
    assert payload["technicalBreakdown"]["reversalExtreme"] > 0
    assert payload["technicalBreakdown"]["volumeConfirmation"] > 0
    assert payload["formula"] == "score_v2_total + alphaAdjustment"
    assert "legacyComponents" not in payload


def test_score_v2_technical_signals_match_shared_worker_fixture():
    fixture = _load_technical_fixture()
    expected = fixture["expectedIndicators"]
    closes = fixture["input"]["closes"]
    row = {
        "score_seed_inputs": {
            "chipFlowSeed40": 18.0,
            "technicalSeed30": 18.0,
            "screenerMomentumSeed20": 12.0,
            "mlEdgeSeed30": 21.0,
            "personaAlphaSeed": 0.0,
        },
        "current_price": closes[-1],
        "ma20": expected["ma20"],
        "macd_hist": expected["macdHist"],
        "atr14": expected["atr14"],
        "plus_di14": expected["plusDi14"],
        "minus_di14": expected["minusDi14"],
        "adx14": expected["adx14"],
        "parabolic_sar": expected["parabolicSar"],
        "cci20": expected["cci20"],
        "rsi14": expected["rsi14"],
        "volume_weighted_rsi14": expected["volumeWeightedRsi14"],
        "volume_momentum_divergence_13_27_10": expected["volumeMomentumDivergence132710"],
        "squeeze_on": expected["squeezeOn"],
        "squeeze_release": expected["squeezeRelease"],
        "squeeze_momentum": expected["squeezeMomentum"],
        "obv_temperature_60": expected["obvTemperature60"],
        "adaptive_rsi_midline_50": expected["adaptiveRsiMidline50"],
        "adaptive_rsi_upper_50": expected["adaptiveRsiUpper50"],
        "adaptive_rsi_lower_50": expected["adaptiveRsiLower50"],
        "adaptive_rsi_overbought": expected["adaptiveRsiOverbought"],
        "adaptive_rsi_oversold": expected["adaptiveRsiOversold"],
    }

    payload = build_score_components(row, raw_score=69.0)

    assert payload["technicalSignals"]["plusDi14"] == pytest.approx(expected["plusDi14"])
    assert payload["technicalSignals"]["minusDi14"] == pytest.approx(expected["minusDi14"])
    assert payload["technicalSignals"]["adx14"] == pytest.approx(expected["adx14"])
    assert payload["technicalSignals"]["parabolicSar"] == pytest.approx(expected["parabolicSar"])
    assert payload["technicalSignals"]["cci20"] == pytest.approx(expected["cci20"])
    assert payload["technicalSignals"]["volumeWeightedRsi14"] == pytest.approx(expected["volumeWeightedRsi14"])
    assert payload["technicalSignals"]["volumeMomentumDivergence132710"] == pytest.approx(
        expected["volumeMomentumDivergence132710"]
    )
    assert payload["technicalSignals"]["squeezeOn"] == pytest.approx(expected["squeezeOn"])
    assert payload["technicalSignals"]["squeezeRelease"] == pytest.approx(expected["squeezeRelease"])
    assert payload["technicalSignals"]["squeezeMomentum"] == pytest.approx(expected["squeezeMomentum"])
    assert payload["technicalSignals"]["obvTemperature60"] == pytest.approx(expected["obvTemperature60"])
    assert payload["technicalSignals"]["adaptiveRsiUpper50"] == pytest.approx(expected["adaptiveRsiUpper50"])
    assert payload["technicalSignals"]["adaptiveRsiOverbought"] == pytest.approx(expected["adaptiveRsiOverbought"])
    assert payload["technicalBreakdown"]["trendStructure"] > 0
    assert payload["technicalBreakdown"]["volatilityStructure"] > 0
    assert payload["technicalBreakdown"]["reversalExtreme"] > 0
    assert payload["technicalBreakdown"]["volumeConfirmation"] > 0
    assert sum(payload["technicalBreakdown"].values()) == pytest.approx(
        payload["components"]["technicalStructure"],
        abs=0.2,
    )
    assert "legacyComponents" not in payload


def test_score_v2_builder_preserves_score_v2_seed_projection_fields():
    payload = build_score_components(
        {
            "score_seed_inputs": {
                "chipFlowSeed40": 18.0,
                "technicalSeed30": 18.0,
                "screenerMomentumSeed20": 12.0,
                "mlEdgeSeed30": 21.0,
                "personaAlphaSeed": 0.0,
            },
            "current_price": 100.0,
            "ma20": 96.0,
            "macd_hist": 0.4,
            "atr14": 2.0,
            "plus_di14": 34.0,
            "minus_di14": 12.0,
            "adx14": 29.0,
            "parabolic_sar": 95.0,
            "cci20": 88.0,
            "rsi14": 58.0,
            "volume_weighted_rsi14": 64.0,
            "volume_momentum_divergence_13_27_10": 125000.0,
            "squeeze_on": 0,
            "squeeze_release": 1,
            "squeeze_momentum": 1.8,
            "obv_temperature_60": 82.0,
            "adaptive_rsi_midline_50": 61.0,
            "adaptive_rsi_upper_50": 84.0,
            "adaptive_rsi_lower_50": 38.0,
            "adaptive_rsi_overbought": 0,
            "adaptive_rsi_oversold": 0,
        },
        raw_score=69.0,
    )

    assert payload["seedComponents"]["chipFlowSeed40"] == pytest.approx(18.0)
    assert payload["seedComponents"]["technicalSeed30"] == pytest.approx(18.0)
    assert payload["seedComponents"]["screenerMomentumSeed20"] == pytest.approx(12.0)
    assert payload["seedComponents"]["mlEdgeSeed30"] == pytest.approx(21.0)


def test_score_v2_technical_breakdown_uses_squeeze_and_obv_temperature_without_legacy_volume_proxy():
    payload = build_score_components(
        {
            "score_seed_inputs": {
                "chipFlowSeed40": 10.0,
                "technicalSeed30": 20.0,
                "screenerMomentumSeed20": 0.0,
                "mlEdgeSeed30": 12.0,
                "personaAlphaSeed": 0.0,
            },
            "current_price": 100.0,
            "ma20": 100.0,
            "squeeze_on": 0,
            "squeeze_release": 1,
            "squeeze_momentum": 1.5,
            "obv_temperature_60": 82.0,
        },
        raw_score=42.0,
    )

    assert payload["technicalSignals"]["squeezeRelease"] == pytest.approx(1.0)
    assert payload["technicalSignals"]["obvTemperature60"] == pytest.approx(82.0)
    assert payload["technicalBreakdown"]["volatilityStructure"] > 0
    assert payload["technicalBreakdown"]["volumeConfirmation"] > 0


def test_score_v2_technical_breakdown_uses_adaptive_rsi_instead_of_static_overbought_line():
    payload = build_score_components(
        {
            "score_seed_inputs": {
                "chipFlowSeed40": 10.0,
                "technicalSeed30": 18.0,
                "screenerMomentumSeed20": 0.0,
                "mlEdgeSeed30": 12.0,
                "personaAlphaSeed": 0.0,
            },
            "rsi14": 78.0,
            "adaptive_rsi_midline_50": 63.0,
            "adaptive_rsi_upper_50": 86.0,
            "adaptive_rsi_lower_50": 40.0,
            "adaptive_rsi_overbought": 0,
            "adaptive_rsi_oversold": 0,
        },
        raw_score=42.0,
    )

    assert payload["technicalSignals"]["adaptiveRsiUpper50"] == pytest.approx(86.0)
    assert payload["technicalBreakdown"]["reversalExtreme"] > 0


def test_score_v2_builder_rejects_legacy_storage_scalars_as_seed_source():
    with pytest.raises(ValueError, match="score_seed_inputs"):
        build_score_components(
            {
                "chip_score": 40.0,
                "tech_score": 30.0,
                "momentum_score": 20.0,
                "ml_score": 30.0,
            },
            raw_score=100.0,
        )


def test_score_v2_builder_accepts_normalized_seed_inputs_without_storage_columns():
    payload = build_score_components(
        {
            "score_seed_inputs": {
                "chipFlowSeed40": 20.0,
                "technicalSeed30": 15.0,
                "screenerMomentumSeed20": 10.0,
                "mlEdgeSeed30": 18.0,
                "personaAlphaSeed": 0.0,
            }
        },
        raw_score=53.0,
    )

    assert payload["components"]["chipFlow"] == pytest.approx(12.5)
    assert payload["components"]["technicalStructure"] == pytest.approx(12.5)
    assert payload["components"]["mlEdge"] == pytest.approx(15.0)
    assert payload["seedComponents"]["screenerMomentumSeed20"] == pytest.approx(10.0)
    assert "legacyComponents" not in payload
