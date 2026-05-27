from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import payload_builder  # noqa: E402
from services.payload_builder import MarketEnv  # noqa: E402


def test_bulk_load_prices_applies_as_of_date_upper_bound(monkeypatch):
    captured: dict[str, object] = {}

    def fake_query(sql, params=None, timeout=None):
        captured["sql"] = sql
        captured["params"] = params
        captured["timeout"] = timeout
        return [
            {
                "stock_id": 1,
                "date": "2026-05-27",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "volume": 1000,
                "adj_close": 10.5,
                "avg_price": None,
            }
        ]

    monkeypatch.setattr(payload_builder.d1_client, "query", fake_query)

    rows = payload_builder._bulk_load_prices([1], as_of_date="2026-05-27")

    assert rows[1][0]["close"] == 10.5
    assert "date <= ?" in str(captured["sql"])
    assert captured["params"] == [1, "2026-05-27"]


def test_build_payloads_handles_avg_price_only_latest_row(monkeypatch):
    captured_as_of: dict[str, object] = {}
    prices = [
        {
            "date": f"2026-05-{day:02d}",
            "open": None if day == 27 else 40 + day,
            "high": None if day == 27 else 41 + day,
            "low": None if day == 27 else 39 + day,
            "close": None if day == 27 else 40 + day,
            "avg_price": 44.0 if day == 27 else None,
            "volume": 1000 + day,
        }
        for day in range(8, 28)
    ]

    def fake_prices(stock_ids, limit=500, as_of_date=None):
        captured_as_of["prices"] = as_of_date
        return {stock_ids[0]: prices}

    def fake_indicators(stock_ids, limit=500, as_of_date=None):
        captured_as_of["indicators"] = as_of_date
        return {stock_ids[0]: []}

    def fake_chips(symbols, limit=200, as_of_date=None):
        captured_as_of["chips"] = as_of_date
        return {symbols[0]: []}

    def fake_sentiment(stock_ids, limit=90, as_of_date=None):
        captured_as_of["sentiment"] = as_of_date
        return {stock_ids[0]: []}

    def fake_misc(stock_ids, as_of_date=None):
        captured_as_of["misc"] = as_of_date
        return {stock_ids[0]: {}}

    monkeypatch.setattr(payload_builder, "_bulk_load_prices", fake_prices)
    monkeypatch.setattr(payload_builder, "_bulk_load_indicators", fake_indicators)
    monkeypatch.setattr(payload_builder, "_bulk_load_chips", fake_chips)
    monkeypatch.setattr(payload_builder, "_bulk_load_sentiment", fake_sentiment)
    monkeypatch.setattr(payload_builder, "_bulk_load_accuracies", lambda stock_ids: ({stock_ids[0]: {}}, {stock_ids[0]: {}}))
    monkeypatch.setattr(payload_builder, "_bulk_load_per_stock_misc", fake_misc)
    monkeypatch.setattr(
        payload_builder.d1_client,
        "query",
        lambda *_args, **_kwargs: [{"symbol": "4584", "tag": "machinery"}],
    )

    payloads = payload_builder.build_payloads(
        active_stocks=[
            {
                "id": 1,
                "symbol": "4584",
                "name": "君帆",
                "market": "ESB",
                "recommendation_lane": "emerging_watchlist",
            }
        ],
        market_env=MarketEnv(),
        adaptive_params={},
        barrier_params={},
        lifecycle_weights={},
        trading_config={},
        as_of_date="2026-05-27",
    )

    assert len(payloads) == 1
    assert payloads[0].stock_meta["market_segment"] == "EMERGING"
    assert captured_as_of == {
        "prices": "2026-05-27",
        "indicators": "2026-05-27",
        "chips": "2026-05-27",
        "sentiment": "2026-05-27",
        "misc": "2026-05-27",
    }
