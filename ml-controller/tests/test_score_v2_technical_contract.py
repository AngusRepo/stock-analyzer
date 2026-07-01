from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from services.recommendation_service import build_score_components


def test_score_v2_technical_signals_are_canonical_payload_fields():
    payload = build_score_components(
        {
            "chip_score": 18.0,
            "tech_score": 18.0,
            "momentum_score": 12.0,
            "ml_score": 21.0,
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
        },
        raw_score=69.0,
    )

    assert payload["version"] == "score_v2"
    assert payload["weights"] == {
        "mlEdge": 25,
        "chipFlow": 25,
        "technicalStructure": 25,
        "fundamentalQuality": 25,
        "newsTheme": 0,
    }
    assert payload["technicalSignals"]["adx14"] == pytest.approx(29.0)
    assert payload["technicalSignals"]["parabolicSar"] == pytest.approx(95.0)
    assert payload["technicalSignals"]["volumeMomentumDivergence132710"] == pytest.approx(125000.0)
    assert payload["technicalBreakdown"]["trendStructure"] > 0
    assert payload["technicalBreakdown"]["volatilityStructure"] > 0
    assert payload["technicalBreakdown"]["reversalExtreme"] > 0
    assert payload["technicalBreakdown"]["volumeConfirmation"] > 0
    assert payload["formula"] == "score_v2_total + alphaAdjustment"
