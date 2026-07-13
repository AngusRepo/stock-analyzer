from __future__ import annotations

import importlib.util
import sys
from types import SimpleNamespace
from datetime import datetime
from pathlib import Path


def _load_proxy_main():
    path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("shioaji_proxy_main", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_batch_orderbooks_returns_partial_data_and_structured_errors(monkeypatch):
    proxy = _load_proxy_main()

    def fake_orderbook_payload(symbol: str, *, refresh: bool = True, lot_type: str = "board_lot"):
        if symbol == "2330":
            return 200, {"status": "ok", "symbol": symbol, "bid_prices": [100.0], "ask_prices": [100.5]}
        return 503, {"status": "waiting_callback", "symbol": symbol, "bidask_event_count": 0}

    monkeypatch.setattr(proxy, "_orderbook_payload", fake_orderbook_payload)

    result = proxy.batch_orderbooks(proxy.BatchRequest(symbols=["2330", "2330", "9914"]))

    assert result["status"] == "partial"
    assert result["count"] == 1
    assert result["error_count"] == 1
    assert result["data"]["2330"]["status"] == "ok"
    assert result["errors"]["9914"]["status"] == "waiting_callback"


def test_orderbook_payload_reports_waiting_callback_when_subscription_has_no_depth(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy.last_bidasks.clear()
    proxy.bidask_stats.clear()

    def fake_recover(symbol: str, reason: str, lot_type: str = "board_lot"):
        proxy.subscribed.add(symbol)
        proxy.bidask_subscribed.add(symbol)

    monkeypatch.setattr(proxy, "recover_orderbook_symbol_async", fake_recover)

    status_code, payload = proxy._orderbook_payload("2330")

    assert status_code == 503
    assert payload["status"] == "waiting_callback"
    assert payload["subscribed"] is True
    assert payload["bidask_subscribed"] is True
    assert payload["bidask_event_count"] == 0


def test_orderbook_payload_returns_fresh_depth_with_callback_telemetry():
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    symbol = "2330"
    now = datetime.now(proxy.TW_TZ).isoformat()
    proxy.last_bidasks[symbol] = {
        "symbol": symbol,
        "bid_prices": [100.0, 99.9],
        "bid_volumes": [10, 8],
        "ask_prices": [100.5, 100.6],
        "ask_volumes": [12, 9],
        "price": 100.25,
        "timestamp": now,
        "updated_at": now,
    }
    proxy.bidask_stats[symbol] = {"event_count": 3, "last_event_at": now, "last_source_time": now}

    status_code, payload = proxy._orderbook_payload(symbol)

    assert status_code == 200
    assert payload["status"] == "ok"
    assert payload["bid_prices"][0] == 100.0
    assert payload["ask_prices"][0] == 100.5
    assert payload["bidask_event_count"] == 3


def test_orderbook_payload_rejects_one_sided_depth():
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    symbol = "2330"
    now = datetime.now(proxy.TW_TZ).isoformat()
    proxy.last_bidasks[symbol] = {
        "symbol": symbol,
        "bid_prices": [100.0],
        "bid_volumes": [10],
        "ask_prices": [],
        "ask_volumes": [],
        "price": 100.0,
        "timestamp": now,
        "updated_at": now,
    }

    status_code, payload = proxy._orderbook_payload(symbol)

    assert status_code == 503
    assert payload["status"] == "no_depth"
    assert payload["bid_levels"] == 1
    assert payload["ask_levels"] == 0


def test_orderbook_payload_registers_symbol_for_warm_watchlist(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy.watched_orderbook_symbols.clear()

    def fake_recover(symbol: str, reason: str, lot_type: str = "board_lot"):
        proxy.subscribed.add(symbol)
        proxy.bidask_subscribed.add(symbol)

    monkeypatch.setattr(proxy, "recover_orderbook_symbol_async", fake_recover)
    proxy._orderbook_payload("2330")

    assert "2330" in proxy.watched_orderbook_symbols


def test_force_bidask_refresh_unsubscribes_before_resubscribe(monkeypatch):
    proxy = _load_proxy_main()
    calls: list[tuple[str, str]] = []
    contract = object()

    class Quote:
        def subscribe(self, contract_arg, quote_type, version, intraday_odd=False):
            assert contract_arg is contract
            calls.append(("subscribe", quote_type))

        def unsubscribe(self, contract_arg, quote_type, version, intraday_odd=False):
            assert contract_arg is contract
            calls.append(("unsubscribe", quote_type))

    proxy.api = SimpleNamespace(
        Contracts=SimpleNamespace(Stocks=SimpleNamespace(get=lambda symbol: contract)),
        quote=Quote(),
    )
    proxy.connected = True
    proxy.subscribed.add("2330")
    proxy.bidask_subscribed.add("2330")
    monkeypatch.setitem(
        sys.modules,
        "shioaji",
        SimpleNamespace(
            constant=SimpleNamespace(
                QuoteType=SimpleNamespace(Tick="tick", BidAsk="bidask"),
                QuoteVersion=SimpleNamespace(v1="v1"),
            ),
        ),
    )

    assert proxy.subscribe_symbol("2330", force_bidask=True) is True
    assert calls == [("unsubscribe", "bidask"), ("subscribe", "bidask")]


def test_odd_lot_orderbook_uses_dedicated_stream_cache():
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    symbol = "2441"
    now = datetime.now(proxy.TW_TZ).isoformat()
    proxy.last_bidasks[symbol] = {
        "bid_prices": [143.0],
        "bid_volumes": [2],
        "ask_prices": [143.5],
        "ask_volumes": [1],
        "timestamp": now,
        "updated_at": now,
    }
    proxy.last_odd_bidasks[symbol] = {
        "bid_prices": [142.5],
        "bid_volumes": [331],
        "ask_prices": [143.0],
        "ask_volumes": [120],
        "timestamp": now,
        "updated_at": now,
        "intraday_odd": True,
    }

    status_code, payload = proxy._orderbook_payload(symbol, lot_type="odd_lot")

    assert status_code == 200
    assert payload["lot_type"] == "odd_lot"
    assert payload["bid_prices"][0] == 142.5
    assert payload["bid_volumes"][0] == 331


def test_request_type_broker_query_fails_fast_when_capacity_is_busy():
    proxy = _load_proxy_main()
    assert proxy._broker_query_capacity.acquire(blocking=False)
    try:
        assert proxy.run_broker_query(lambda: "should-not-run", "test") is None
    finally:
        proxy._broker_query_capacity.release()
