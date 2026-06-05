from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.state_space_overlay_attribution import evaluate_markov_switching_overlay  # noqa: E402


def _row(
    symbol: str,
    *,
    signal: str,
    markov: dict,
    trade_pnl_pct: float | None = None,
    actual_return_pct: float | None = None,
) -> dict:
    return {
        "symbol": symbol,
        "prediction_date": "2026-06-05",
        "trade_signal": "buy" if "BUY" in signal else "hold",
        "signal_raw": signal,
        "trade_pnl_pct": trade_pnl_pct,
        "actual_return_pct": actual_return_pct,
        "forecast_data": json.dumps({
            "signal": signal,
            "state_space_overlays": {
                "schema_version": "state-space-overlays-v1",
                "markov_switching": markov,
            },
        }),
    }


def test_markov_attribution_detects_positive_bearish_skip_candidate():
    rows = [
        _row("A", signal="BUY", markov={"direction": "down", "forecast_pct": -0.03, "confidence": 0.8}, trade_pnl_pct=-0.05),
        _row("B", signal="BUY", markov={"direction": "down", "forecast_pct": -0.02, "confidence": 0.7}, trade_pnl_pct=-0.03),
        _row("C", signal="BUY", markov={"direction": "up", "forecast_pct": 0.02, "confidence": 0.7}, trade_pnl_pct=0.02),
        _row("D", signal="BUY", markov={"direction": "up", "forecast_pct": 0.01, "confidence": 0.6}, trade_pnl_pct=0.01),
        _row("E", signal="BUY", markov={"up_prob": 0.55, "confidence": 0.7}, trade_pnl_pct=0.03),
        _row("F", signal="HOLD", markov={"direction": "down", "forecast_pct": -0.01, "confidence": 0.7}, actual_return_pct=-0.02),
    ]

    report = evaluate_markov_switching_overlay(rows, min_samples=5, min_gate_samples=2)

    assert report["status"] == "completed"
    sim = report["bearish_buy_skip_simulation"]
    assert sim["decision"] == "candidate_positive"
    assert sim["bearish_buy_count"] == 2
    assert sim["avg_outcome_delta"] > 0
    assert report["by_markov_bucket"]["bearish"]["avg_outcome"] < report["by_markov_bucket"]["bullish"]["avg_outcome"]


def test_markov_attribution_reports_fallback_and_insufficient_samples():
    rows = [
        _row(
            "A",
            signal="BUY",
            markov={
                "direction": "down",
                "forecast_pct": -0.03,
                "confidence": 0.8,
                "degraded": True,
                "fallback_reason": "svd_not_converged",
            },
            trade_pnl_pct=-0.05,
        )
    ]

    skipped = evaluate_markov_switching_overlay(rows, min_samples=2)
    assert skipped["status"] == "skipped"
    assert skipped["reason"] == "insufficient_markov_overlay_samples"

    completed = evaluate_markov_switching_overlay(rows, min_samples=1, min_gate_samples=1)
    assert completed["fallback_count"] == 1
    assert completed["fallback_reasons"] == {"svd_not_converged": 1}
