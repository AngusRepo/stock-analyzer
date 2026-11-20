"""KD-06: market_env.history keeps the Worker ADL unit, market_breadth bull %, and missing as None."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import payload_builder  # noqa: E402

DAYS = [f"2026-03-{day:02d}" for day in range(2, 12)]  # d0..d9, one market_breadth row per session
ADVANCES = [900, 800, 700, 1000, 600, 950, 1100, 500, 990, 1200]
DECLINES = [800, 900, None, 700, 1000, 850, 600, 1300, 1000, 500]  # d2 has no decline count
BULL = {DAYS[7]: 25.0, DAYS[8]: 15.0}
LIMIT_DOWN = {DAYS[8]: 4}


def _market_query(sql, params, **_kwargs):
    if "advance_count AS advances" in sql:
        return [
            {"date": d, "advances": a, "declines": c, "bull_alignment_pct": BULL.get(d)}
            for d, a, c in zip(DAYS, ADVANCES, DECLINES)
        ]
    if "sample_size" in sql:
        return [{"date": d, "total": 2000, "limit_down_count": LIMIT_DOWN.get(d)} for d in DAYS]
    if "FROM us_market_signals" in sql or "advance_ratio, bull_alignment_pct" in sql:
        return []
    raise AssertionError(sql)


def _core_query(sql, params, **_kwargs):
    if "LIMIT 500" in sql:
        common = {"risk_score": 30, "risk_level": "yellow", "market_bias_20d": 0.01,
                  "foreign_consecutive_sell": 0, "foreign_net_5d": 0}
        return [
            # NULL Worker columns: the breadth fallback fills them.
            {**common, "date": DAYS[8], "twii_close": 20000.0, "limit_down_count": None,
             "limit_down_pct": None, "adl_value": None, "adl_trend": None},
            # A real 0 is a value, not a gap.
            {**common, "date": DAYS[9], "twii_close": 20100.0, "limit_down_count": 0,
             "limit_down_pct": 0, "adl_value": 0, "adl_trend": "flat"},
        ]
    if "LIMIT 1" in sql:
        return []
    raise AssertionError(sql)


def _history(monkeypatch):
    monkeypatch.setattr(payload_builder.CORE_D1_CLIENT, "query", _core_query)
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, "query", _market_query)
    etf = [{"date": d, "close": 100.0 + i, "symbol": "0050"} for i, d in enumerate(DAYS)]
    monkeypatch.setattr(
        payload_builder,
        "_load_market_symbol_price_rows",
        lambda symbols, run_date, limit: list(reversed(etf)) if symbols == ["0050"] else [],
    )
    monkeypatch.setattr(payload_builder.kv_client, "get_json", lambda key, default=None: default)
    env, *_ = payload_builder.load_market_env(DAYS[-1], include_pipeline_context=False)
    return env.history


def test_adl_uses_worker_five_session_net_and_missing_stays_none(monkeypatch):
    history = _history(monkeypatch)
    net = [a - c if c is not None else None for a, c in zip(ADVANCES, DECLINES)]

    # Windows touching d2 (no decline count) or shorter than 5 sessions stay missing.
    for day in DAYS[:7]:
        assert history[day]["adl_value"] is None and history[day]["adl_trend_numeric"] is None
    window = net[3:8]
    assert history[DAYS[7]]["adl_value"] == sum(window)
    assert sum(window) - window[0] < -50 and history[DAYS[7]]["adl_trend_numeric"] == -1.0
    # NULL market_risk ADL is filled from breadth in the same unit.
    assert history[DAYS[8]]["adl_value"] == sum(net[4:9])
    # A real 0 from market_risk is kept, not overwritten.
    assert history[DAYS[9]]["adl_value"] == 0 and history[DAYS[9]]["adl_trend_numeric"] == 0.0


def test_limit_down_none_is_filled_and_zero_is_kept(monkeypatch):
    history = _history(monkeypatch)
    assert history[DAYS[8]]["limit_down_count"] == 4
    assert history[DAYS[8]]["limit_down_pct"] == 0.002
    assert history[DAYS[9]]["limit_down_count"] == 0 and history[DAYS[9]]["limit_down_pct"] == 0
    # No breadth count -> missing, not 0.
    assert history[DAYS[5]]["limit_down_count"] is None and history[DAYS[5]]["limit_down_pct"] is None


def test_bull_alignment_reads_market_breadth_percent_not_0050_proxy(monkeypatch):
    history = _history(monkeypatch)
    assert history[DAYS[8]]["bull_alignment_pct"] == 15.0
    assert history[DAYS[7]]["bull_alignment_pct"] == 25.0
    assert history[DAYS[9]]["bull_alignment_pct"] is None
    assert all(history[d]["bull_alignment_pct"] is None for d in DAYS[:7])
    # 0050 fallback risk score follows Worker calcRiskScore (no bias/VIX here): missing adds 0,
    # ADL down adds 8, bull alignment 25% (<30%) adds 4.
    assert history[DAYS[6]]["risk_score"] == 0
    assert history[DAYS[7]]["risk_score"] == 12
