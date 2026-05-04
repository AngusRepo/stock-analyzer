from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.market_structure_validation import validate_market_structure  # noqa: E402


def _row(symbol: str, location: str, entry: float, future: float, *, high_vol: bool = False) -> dict:
    fair_low = 95.0
    fair_high = 105.0
    if location == "below_fair_value":
        entry = 92.0
    elif location == "in_fair_value":
        entry = 100.0
    elif location == "above_fair_value":
        entry = 112.0
    return {
        "symbol": symbol,
        "entry_price": entry,
        "future_close": future,
        "forecast_data": json.dumps({
            "alpha_context": {
                "risk_overlay": {
                    "volatility_level": "high" if high_vol else "normal",
                    "flags": ["extended_above_fair_value"] if high_vol and location == "above_fair_value" else [],
                    "structure_detail": {
                        "structure_status": "ok",
                        "fair_value_low": fair_low,
                        "fair_value_high": fair_high,
                        "price_location": location,
                        "latest_close": entry,
                    },
                },
            },
        }),
    }


def test_validate_market_structure_reports_location_and_gate_stats():
    rows = []
    rows.extend(_row(f"B{i}", "below_fair_value", 92, 98 + (i % 2)) for i in range(12))
    rows.extend(_row(f"I{i}", "in_fair_value", 100, 104 + (i % 2)) for i in range(12))
    rows.extend(_row(f"A{i}", "above_fair_value", 112, 103 - (i % 3), high_vol=True) for i in range(12))

    report = validate_market_structure(rows, min_samples=20)

    assert report["status"] == "completed"
    assert report["sample_count"] == 36
    assert report["overall"]["coverage_rate"] > 0.7
    assert report["by_location"]["above_fair_value"]["avg_forward_return"] < 0
    assert report["by_location"]["in_fair_value"]["avg_forward_return"] > 0
    assert report["gate_stats"]["active"]["count"] == 12
    assert report["gate_stats"]["inactive"]["count"] == 24


def test_validate_market_structure_skips_when_samples_are_insufficient():
    report = validate_market_structure([_row("2330", "in_fair_value", 100, 101)], min_samples=3)

    assert report["status"] == "skipped"
    assert report["reason"] == "insufficient_market_structure_samples"
