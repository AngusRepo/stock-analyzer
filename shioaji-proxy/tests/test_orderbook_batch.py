from __future__ import annotations

import importlib.util
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

    def fake_orderbook_payload(symbol: str, *, refresh: bool = True):
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

    def fake_subscribe(symbol: str, *, force_bidask: bool = False):
        proxy.subscribed.add(symbol)
        proxy.bidask_subscribed.add(symbol)
        return True

    monkeypatch.setattr(proxy, "subscribe_symbol", fake_subscribe)
    monkeypatch.setattr(proxy, "orderbook_refresh_wait_seconds", lambda: 0)

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
