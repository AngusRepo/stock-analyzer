from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.fusion_market_context import (  # noqa: E402
    build_runtime_market_context,
    context_for_market_segment,
    load_pit_market_contexts,
    market_context_feature_values,
)


def test_runtime_defaults_do_not_masquerade_as_market_evidence():
    context = build_runtime_market_context(
        signal_date="2026-07-22",
        market_env={
            "risk_score": 50.0,
            "twii_return_5d": 0.0,
            "history": {"2026-07-23": {"market_return_5d": 0.20, "risk_score": 90.0}},
        },
        regime_label="bear_market",
        regime_surface={"bear_market": 0.7, "volatile": 0.2, "sideways": 0.1},
        market_segment="LISTED",
    )

    assert context["market_context_available"] is False
    assert context["regime_surface_available"] is True
    assert context["regime_bucket"] == "bear"


def test_runtime_context_uses_exact_signal_date_history_and_interactions():
    context = build_runtime_market_context(
        signal_date="2026-07-22",
        market_env={
            "history": {
                "2026-07-22": {
                    "market_return_5d": -0.08,
                    "market_bias_20d": -0.05,
                    "risk_score": 82,
                    "advance_ratio": 0.22,
                }
            }
        },
        regime_label="volatile",
        regime_surface={"bear_market": 0.35, "volatile": 0.55, "sideways": 0.10},
        market_segment="LISTED",
    )
    row = {"prediction_date": "2026-07-22", "market_regime_context": context}
    values = market_context_feature_values(row, l4_value=0.02)

    assert context["market_context_available"] is True
    assert values["regime_defensive_probability"] == pytest.approx(0.90)
    assert values["l4_defensive_regime_interaction"] == pytest.approx(0.018)
    assert values["market_breadth_balance"] == pytest.approx(-0.56)


def test_historical_loader_uses_only_rows_at_or_before_signal_date():
    def query(sql: str, _params: list):
        if "canonical_market_index_daily" in sql:
            rows = []
            for symbol, base in (("TWII", 100.0), ("TWOII", 50.0)):
                for idx, day in enumerate(("2026-07-15", "2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21", "2026-07-22")):
                    rows.append({
                        "symbol": symbol,
                        "date": day,
                        "close": base + idx,
                        "source": "finlab.market_index",
                        "as_of_date": "2026-07-23",
                    })
            rows.append({
                "symbol": "TWII",
                "date": "2026-07-23",
                "close": 999.0,
                "source": "finlab.market_index",
                "as_of_date": "2026-07-23",
            })
            return rows
        if "FROM market_risk" in sql:
            return [{"date": "2026-07-22", "risk_score": 70, "twii_bias": -3.0, "twii_vol20": 0.24}]
        if "FROM market_breadth" in sql:
            return [{"date": "2026-07-22", "advance_ratio": 0.30, "bull_alignment_pct": 0.35}]
        raise AssertionError(sql)

    contexts = load_pit_market_contexts(query, ["2026-07-22"])
    listed = context_for_market_segment(
        contexts,
        signal_date="2026-07-22",
        market_segment="LISTED",
    )
    otc = context_for_market_segment(
        contexts,
        signal_date="2026-07-22",
        market_segment="OTC",
    )

    assert listed is not None and otc is not None
    assert listed["point_in_time"] is True
    assert listed["source_date"] == "2026-07-22"
    assert listed["market_return_5d"] == pytest.approx(0.05)
    assert listed["market_bias_20d"] == pytest.approx(-0.03)
    assert listed["source_lineage"]["future_rows_used"] is False
    assert otc["market_return_5d"] == pytest.approx(0.10)
