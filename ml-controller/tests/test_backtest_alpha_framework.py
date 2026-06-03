from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import Candidate, _macd_hist_last, apply_alpha_framework_to_candidates  # noqa: E402


def _candidate(symbol: str, score: float) -> Candidate:
    return Candidate(
        symbol=symbol,
        date="2026-01-10",
        close=100.0,
        industry="semi",
        base_score=score,
        chip_score=score,
        tech_score=0.0,
        momentum_score=0.0,
        combined_score=score,
    )


def _payload(closes: list[float], volumes: list[float]) -> dict:
    return {
        "prices": [
            {"close": close, "high": close, "low": close, "volume": volume}
            for close, volume in zip(closes, volumes)
        ],
    }


def test_alpha_framework_allocation_changes_backtest_candidate_selection():
    breakout = _candidate("2330", 10.0)
    defensive = _candidate("0050", 5.0)

    out = apply_alpha_framework_to_candidates(
        [breakout, defensive],
        alpha_policy={
            "allocation": {
                "slateSize": 1,
                "weights": {
                    "bull": {
                        "defensive_accumulation": 1.0,
                        "breakout_vol_expansion": 0.0,
                        "trend_following": 0.0,
                        "mean_reversion": 0.0,
                    }
                },
            }
        },
        regime_label="bull",
        payload_by_symbol={
            "2330": _payload([100, 101, 102, 103, 104, 109], [100, 100, 100, 100, 100, 180]),
            "0050": _payload([100, 100, 100, 100, 100, 100], [100, 100, 100, 100, 100, 100]),
        },
        slate_size=1,
    )

    assert out[0].symbol == "0050"
    assert out[0].has_buy_signal == 1
    assert out[0].alpha_allocation["selected"] is True
    assert out[0].alpha_context["edge_bucket"] == "defensive_accumulation"
    assert out[1].has_buy_signal == 0


def test_backtest_macd_uses_ema_signal_not_sma_difference():
    closes = np.array(
        [100 + index * 0.4 + (2.0 if index % 7 == 0 else 0.0) for index in range(60)],
        dtype=np.float64,
    )

    macd_hist = _macd_hist_last(closes)
    sma_difference = float(closes[-12:].mean() - closes[-26:].mean())

    assert macd_hist is not None
    assert abs(macd_hist - sma_difference) > 0.01
