from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.s12_trade_ev_bootstrap import S12TradeEvBootstrapProvider, load_s12_replay_trade_rows  # noqa: E402


def _row(symbol: str, prediction_date: str, pnl: float, *, market: str = "TWSE", bucket: str = "breakout") -> dict:
    return {
        "symbol": symbol,
        "market": market,
        "prediction_date": prediction_date,
        "trade_pnl_pct": pnl,
        "trade_pnl_r": pnl / 0.04,
        "trade_outcome": "tp1" if pnl > 0 else "structure_stop",
        "max_favorable_pct": max(pnl, 0.0),
        "max_adverse_pct": min(pnl, 0.0),
        "forecast_data": json.dumps({
            "stock_meta": {"market_segment": "LISTED" if market == "TWSE" else "OTC"},
            "alpha_context": {"edge_bucket": bucket},
        }),
    }


def test_load_s12_replay_trade_rows_enforces_strict_pre_run_date_query():
    captured: dict = {}

    def fake_query(sql, params=None, **_kwargs):
        captured["sql"] = sql
        captured["params"] = params
        return []

    load_s12_replay_trade_rows(run_date="2026-07-03", query_fn=fake_query)

    assert "date(p.prediction_date) < date(?)" in captured["sql"]
    assert captured["params"][0] == "2026-07-03"


def test_s12_trade_ev_bootstrap_prefers_market_bucket_before_global():
    rows = [_row("1111", "2026-07-01", 0.02)] * 12
    rows += [_row("2222", "2026-07-01", 0.03)] * 12
    rows += [_row("9999", "2026-07-01", -0.03, market="OTC", bucket="mean_revert")] * 12
    provider = S12TradeEvBootstrapProvider(rows, run_date="2026-07-03", min_samples=20, roundtrip_cost_bps=0)

    ev = provider.build_for_row({
        "symbol": "8091",
        "current_price": 100,
        "stop_loss": 96,
        "market_segment": "LISTED",
        "alpha_context": {"edge_bucket": "breakout"},
    })

    assert ev["status"] == "loaded"
    assert ev["bootstrap_scope"] == "market_segment_alpha_bucket"
    assert ev["sampleCount"] == 24
    assert ev["sample_date_max"] == "2026-07-01"
    assert ev["as_of_guard"] == "prediction_date_strictly_before_run_date"
    assert ev["trade_expected_return_net_pct"] == pytest.approx(0.025)


def test_s12_trade_ev_bootstrap_filters_same_day_rows():
    provider = S12TradeEvBootstrapProvider(
        [
            _row("1111", "2026-07-02", 0.02),
            _row("1111", "2026-07-03", 0.99),
        ],
        run_date="2026-07-03",
        min_samples=1,
        roundtrip_cost_bps=0,
    )

    ev = provider.build_for_row({"symbol": "1111", "current_price": 100, "stop_loss": 96})

    assert ev["sampleCount"] == 1
    assert ev["sample_date_max"] == "2026-07-02"
    assert ev["trade_expected_return_net_pct"] == pytest.approx(0.02)
