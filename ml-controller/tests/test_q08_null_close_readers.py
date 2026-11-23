"""Q08: readers must treat a stock_prices row with NULL close as an absent session."""
from __future__ import annotations

import math
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import google.cloud as google_cloud
except ImportError:
    google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
try:
    from google.cloud import run_v2  # noqa: F401
except ImportError:
    run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    setattr(google_cloud, "run_v2", run_v2_stub)
    sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)

from routers import optuna  # noqa: E402
from services import payload_builder  # noqa: E402


def _bar(day: str, close):
    return {"stock_id": 7, "date": day, "open": close, "high": close, "low": close,
            "close": close, "volume": None if close is None else 1000,
            "adj_close": close, "avg_price": None}


def test_bulk_load_prices_drops_null_close_session(monkeypatch):
    rows = [_bar("2026-03-30", 10.0), _bar("2026-03-31", None), _bar("2026-04-01", 11.0)]
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, "query", lambda sql, params, **_k: rows)

    out = payload_builder._bulk_load_prices([7], limit=10, as_of_date="2026-04-01")

    assert [r["date"] for r in out[7]] == ["2026-03-30", "2026-04-01"]
    assert all(r["close"] is not None for r in out[7])


def test_bulk_load_prices_null_close_does_not_reach_canonical_basis_check(monkeypatch):
    rows = [_bar("2026-03-30", 10.0), _bar("2026-03-31", None)]
    canonical = [
        {"symbol": "7777", "date": "2026-03-30", "close": 10.0, "adj_close": 9.5, "as_of_date": "2026-11-19"},
        {"symbol": "7777", "date": "2026-03-31", "close": 10.5, "adj_close": 10.0, "as_of_date": "2026-11-19"},
    ]

    def query(sql, params, **_k):
        return canonical if "canonical_market_daily" in sql else rows

    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, "query", query)

    out = payload_builder._bulk_load_prices([7], limit=10, as_of_date="2026-03-31", stock_symbols={7: "7777"})

    assert [r["date"] for r in out[7]] == ["2026-03-30"]
    assert out[7][0]["adj_close"] == 9.5


def test_bulk_load_prices_limit_counts_observed_sessions_only(monkeypatch):
    rows = [_bar("2026-03-27", 9.0), _bar("2026-03-30", 10.0), _bar("2026-03-31", None)]
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, "query", lambda sql, params, **_k: rows)

    out = payload_builder._bulk_load_prices([7], limit=2, as_of_date="2026-03-31")

    assert [r["date"] for r in out[7]] == ["2026-03-27", "2026-03-30"]


def test_observed_closes_skips_null_and_nan():
    assert optuna._observed_closes([1.0, None, float("nan"), 2]) == [1.0, 2.0]


def _install_fake_rrg(monkeypatch, captured: dict):
    def search_rrg_params(prices_by_stock, benchmark_returns):
        captured["prices"] = prices_by_stock
        return {"best_params": {}}

    monkeypatch.setitem(sys.modules, "optuna_rrg", SimpleNamespace(search_rrg_params=search_rrg_params))


def test_rrg_route_d1_path_skips_null_close_instead_of_type_error(monkeypatch):
    captured: dict = {}
    _install_fake_rrg(monkeypatch, captured)
    monkeypatch.setattr(optuna, "resolve_research_data_access",
                        lambda **_k: SimpleNamespace(source="d1", snapshot=None, to_dict=lambda: {"source": "d1"}))
    monkeypatch.setattr(optuna, "_load_twii_history",
                        lambda limit: [{"twii_close": 100.0 + i} for i in range(80)])
    good = [{"close": 10.0 + i} for i in range(100)]
    holed = good[:50] + [{"close": None}] + good[50:]
    short = good[:99] + [{"close": None}]
    monkeypatch.setattr(optuna, "load_domain_top_active_stocks_with_prices",
                        lambda **_k: [{"symbol": "2412", "rows": holed}, {"symbol": "1101", "rows": short}])

    result = optuna.run_rrg(optuna.OptunaReq(push_kv=False, dry_run=True))

    assert result["status"] == "completed"
    assert list(captured["prices"]) == ["2412"]
    assert len(captured["prices"]["2412"]) == 100
    assert all(math.isfinite(c) for c in captured["prices"]["2412"])


def test_rrg_snapshot_path_skips_null_close(monkeypatch):
    market_risk = pl.DataFrame({"date": [f"2026-01-{d:02d}" for d in range(1, 31)],
                                "twii_close": [100.0 + d for d in range(30)]})
    prices = pl.DataFrame({"symbol": ["2412"] * 6, "date": [f"2026-03-{d}" for d in range(25, 31)],
                           "close": [10.0, 11.0, None, 12.0, 13.0, 14.0]})
    monkeypatch.setattr(optuna, "read_snapshot_component",
                        lambda manifest, name, required=True: market_risk if name == "market_risk" else None)
    monkeypatch.setattr(optuna, "_prices_with_symbol_from_snapshot", lambda manifest: prices)

    _, by_stock = optuna._load_rrg_inputs_from_snapshot(
        {}, twii_limit=30, min_twii_rows=10, min_stock_rows=5, top_stock_count=5, stock_price_limit=10,
    )

    assert by_stock == {"2412": [10.0, 11.0, 12.0, 13.0, 14.0]}
