from __future__ import annotations

import importlib.util
import sys
import time
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


def test_broker_query_timeout_poison_marks_process_for_replacement(monkeypatch):
    proxy = _load_proxy_main()
    poisoned: list[str] = []
    monkeypatch.setenv("SHIOAJI_BROKER_QUERY_TIMEOUT_SECONDS", "0.25")
    monkeypatch.setattr(proxy, "poison_process", lambda reason, **_kwargs: poisoned.append(reason))

    result = proxy.run_broker_query(lambda: (time.sleep(0.35), "late")[1], "hung-sdk-call")

    assert result is None
    assert poisoned == ["broker_query_timeout:hung-sdk-call"]
    time.sleep(0.15)


def test_execution_snapshot_reads_fresh_tick_cache_without_sdk_call(monkeypatch):
    proxy = _load_proxy_main()
    now = datetime.now(proxy.TW_TZ).isoformat()
    proxy.connected = True
    proxy._process_poisoned = False
    proxy.last_ticks["2330"] = {
        "symbol": "2330",
        "price": 100.5,
        "volume": 10,
        "total_volume": 1000,
        "timestamp": now,
        "updated_at": now,
        "session_epoch": 7,
    }
    monkeypatch.setattr(proxy, "run_broker_query", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("SDK I/O forbidden")))

    snapshot = proxy.get_snapshot("2330")

    assert snapshot is not None
    assert snapshot["last"] == 100.5
    assert snapshot["source"] == "streaming_tick_cache"
    assert snapshot["session_epoch"] == 7


def test_batch_quotes_reports_stale_or_missing_cache_without_blocking_sdk(monkeypatch):
    proxy = _load_proxy_main()
    proxy.connected = True
    proxy.last_ticks.clear()
    monkeypatch.setattr(proxy, "recover_orderbook_symbol_async", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(proxy, "subscribe_symbol", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("request path SDK subscribe forbidden")))

    result = proxy.batch_quotes(proxy.BatchRequest(symbols=["2330"]))

    assert result["status"] == "empty"
    assert result["errors"]["2330"]["status"] == "no_tick"


def test_streaming_bar_accumulator_returns_completed_minutes_only(monkeypatch):
    proxy = _load_proxy_main()
    proxy.minute_bars.clear()
    symbol = "6712"
    now = datetime(2026, 7, 14, 9, 5, 20, tzinfo=proxy.TW_TZ)
    monkeypatch.setattr(proxy, "get_tw_now", lambda: now)

    proxy.update_minute_bar(symbol, {
        "price": 88.0,
        "volume": 2,
        "timestamp": "2026-07-14T09:04:01+08:00",
        "updated_at": "2026-07-14T09:04:01+08:00",
        "session_epoch": 3,
    })
    proxy.update_minute_bar(symbol, {
        "price": 89.0,
        "volume": 3,
        "timestamp": "2026-07-14T09:04:45+08:00",
        "updated_at": "2026-07-14T09:04:45+08:00",
        "session_epoch": 3,
    })
    proxy.update_minute_bar(symbol, {
        "price": 90.0,
        "volume": 1,
        "timestamp": "2026-07-14T09:05:05+08:00",
        "updated_at": "2026-07-14T09:05:05+08:00",
        "session_epoch": 3,
    })

    bars = proxy.completed_streaming_bars(symbol, "2026-07-14", "2026-07-14", 100)

    assert len(bars) == 1
    assert bars[0]["ts"] == "2026-07-14T09:04:00+08:00"
    assert bars[0]["open"] == 88.0
    assert bars[0]["high"] == 89.0
    assert bars[0]["close"] == 89.0
    assert bars[0]["volume"] == 5
    assert bars[0]["completed"] is True


def test_market_risk_reads_streaming_proxy_tick_without_sdk(monkeypatch):
    proxy = _load_proxy_main()
    now = datetime.now(proxy.TW_TZ).isoformat()
    proxy.connected = True
    proxy._process_poisoned = False
    proxy.last_ticks["0050"] = {
        "symbol": "0050",
        "price": 200.0,
        "change_rate": -2.1,
        "total_volume": 100_000,
        "timestamp": now,
        "updated_at": now,
        "session_epoch": 9,
    }
    proxy.api = SimpleNamespace(
        snapshots=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("SDK snapshot forbidden")),
    )

    result = proxy.market_risk()

    assert result["status"] == "ok"
    assert result["risk_level"] == "high"
    assert result["proxy_symbol"] == "0050"
    assert result["source"] == "streaming_tick_cache"
