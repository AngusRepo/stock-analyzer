from __future__ import annotations

import importlib.util
import sys
import threading
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
    proxy._quote_session_up = True
    symbol = "2330"
    proxy.bidask_subscribed.add(symbol)
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
        "session_epoch": proxy._session_epoch,
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
    proxy._quote_session_up = True
    symbol = "2330"
    proxy.bidask_subscribed.add(symbol)
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
        "session_epoch": proxy._session_epoch,
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
    monkeypatch.setattr(proxy, "is_market_hours", lambda: True)

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
    proxy._quote_session_up = True
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


def test_subscribe_symbol_defers_sdk_call_outside_market_hours(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    monkeypatch.setattr(proxy, "is_market_hours", lambda: False)
    monkeypatch.setattr(
        proxy,
        "run_streaming_control",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("off-hours SDK call forbidden")),
    )

    assert proxy.subscribe_symbol("0050") is False


def test_odd_lot_orderbook_uses_dedicated_stream_cache():
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy._quote_session_up = True
    symbol = "2441"
    proxy.odd_bidask_subscribed.add(symbol)
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
        "session_epoch": proxy._session_epoch,
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


def test_streaming_control_timeout_does_not_poison_broker_owner(monkeypatch):
    proxy = _load_proxy_main()
    poisoned: list[str] = []
    monkeypatch.setenv("SHIOAJI_STREAMING_CONTROL_TIMEOUT_SECONDS", "0.25")
    monkeypatch.setattr(proxy, "poison_process", lambda reason, **_kwargs: poisoned.append(reason))

    result = proxy.run_streaming_control(lambda: (time.sleep(0.35), "late")[1], "slow-subscribe")

    assert result is None
    assert poisoned == []
    assert proxy._streaming_control_timeout_count == 1
    assert proxy._last_streaming_control_timeout_label == "slow-subscribe"
    assert proxy.streaming_control_busy() is True
    time.sleep(0.15)
    assert proxy.streaming_control_busy() is False


def test_recovery_does_not_count_or_reconnect_while_streaming_control_is_active(monkeypatch):
    proxy = _load_proxy_main()
    proxy.subscription_recovery.clear()
    proxy._streaming_control_inflight = True
    reset_calls: list[str] = []
    subscribe_calls: list[str] = []
    monkeypatch.setattr(proxy, "reset_shioaji_connection", lambda reason: reset_calls.append(reason) or True)
    monkeypatch.setattr(proxy, "subscribe_symbol", lambda symbol, **_kwargs: subscribe_calls.append(symbol) or True)

    proxy.recover_orderbook_symbol("2330", "watchdog_waiting_callback")

    assert proxy.subscription_recovery == {}
    assert reset_calls == []
    assert subscribe_calls == []


def test_symbol_recovery_never_reconnects_whole_session_for_one_stale_symbol(monkeypatch):
    proxy = _load_proxy_main()
    proxy._streaming_control_inflight = False
    proxy._quote_session_up = True
    subscribe_calls: list[str] = []
    monkeypatch.setattr(proxy, "_mark_orderbook_recovery", lambda *_args: (99, True))
    monkeypatch.setattr(
        proxy,
        "reset_shioaji_connection",
        lambda *_args: (_ for _ in ()).throw(AssertionError("single-symbol staleness must not reset session")),
    )
    monkeypatch.setattr(proxy, "subscribe_symbol", lambda symbol, **_kwargs: subscribe_calls.append(symbol) or True)

    proxy.recover_orderbook_symbol("4123", "watchdog_stale_depth")

    assert subscribe_calls == ["4123"]


def test_stale_orderbook_request_waits_for_active_refresh(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy._quote_session_up = True
    symbol = "4123"
    proxy.bidask_subscribed.add(symbol)
    proxy.last_bidasks[symbol] = {
        "symbol": symbol,
        "bid_prices": [37.3],
        "bid_volumes": [10],
        "ask_prices": [37.4],
        "ask_volumes": [10],
        "updated_at": "2026-07-15T09:00:00+08:00",
        "session_epoch": proxy._session_epoch,
    }
    monkeypatch.setattr(proxy, "orderbook_refresh_wait_seconds", lambda: 0.1)

    def refresh(symbol_arg: str, _reason: str, _lot_type: str = "board_lot"):
        assert symbol_arg == symbol
        now = datetime.now(proxy.TW_TZ).isoformat()
        proxy.last_bidasks[symbol]["timestamp"] = now
        proxy.last_bidasks[symbol]["updated_at"] = now

    monkeypatch.setattr(proxy, "recover_orderbook_symbol_async", refresh)

    status_code, payload = proxy._orderbook_payload(symbol)

    assert status_code == 200
    assert payload["status"] == "ok"
    assert payload["bid_prices"][0] == 37.3


def test_active_confirmation_accepts_static_book_without_rewriting_source_time(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy._quote_session_up = True
    symbol = "4123"
    proxy.bidask_subscribed.add(symbol)
    now = datetime.now(proxy.TW_TZ)
    source_time = (now - proxy.timedelta(hours=1)).isoformat()
    confirmed_at = now.isoformat()
    proxy.last_bidasks[symbol] = {
        "symbol": symbol,
        "bid_prices": [38.0],
        "bid_volumes": [10],
        "ask_prices": [38.1],
        "ask_volumes": [10],
        "price": 38.05,
        "timestamp": source_time,
        "updated_at": confirmed_at,
        "confirmed_at": confirmed_at,
        "session_epoch": proxy._session_epoch,
    }

    status_code, payload = proxy._orderbook_payload(symbol, refresh=False)

    assert status_code == 200
    assert payload["source_time"] == source_time
    assert payload["confirmed_at"] == confirmed_at
    assert payload["quote_age_ms"] <= proxy.orderbook_max_age_ms()
    assert payload["source_age_ms"] > payload["quote_age_ms"]


def test_live_quote_session_confirms_unchanged_book_in_same_session(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy._quote_session_up = True
    proxy._session_epoch = 7
    symbol = "4123"
    now = datetime(2026, 7, 16, 10, 30, 0, tzinfo=proxy.TW_TZ)
    stale_symbol_time = (now - proxy.timedelta(seconds=30)).isoformat()
    monkeypatch.setattr(proxy, "get_tw_now", lambda: now)
    proxy.bidask_subscribed.add(symbol)
    proxy.last_bidasks[symbol] = {
        "symbol": symbol,
        "bid_prices": [38.0, 37.95, 37.9, 37.85, 37.8],
        "bid_volumes": [10, 9, 8, 7, 6],
        "ask_prices": [38.1, 38.15, 38.2, 38.25, 38.3],
        "ask_volumes": [11, 10, 9, 8, 7],
        "price": 38.05,
        "timestamp": stale_symbol_time,
        "updated_at": stale_symbol_time,
        "confirmed_at": stale_symbol_time,
        "session_epoch": 7,
    }
    status_code, payload = proxy._orderbook_payload(symbol, refresh=False)

    assert status_code == 200
    assert payload["confirmation_mode"] == "quote_session_static_book"
    assert payload["confirmed_at"] == now.isoformat()
    assert payload["symbol_confirmed_at"] == stale_symbol_time
    assert payload["quote_age_ms"] == 0
    assert payload["symbol_confirmation_age_ms"] == 30_000
    assert payload["source_age_ms"] == 30_000


def test_quote_session_cannot_confirm_book_from_prior_session(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy._quote_session_up = True
    proxy._session_epoch = 8
    symbol = "4123"
    now = datetime(2026, 7, 16, 10, 30, 0, tzinfo=proxy.TW_TZ)
    stale_symbol_time = (now - proxy.timedelta(seconds=30)).isoformat()
    monkeypatch.setattr(proxy, "get_tw_now", lambda: now)
    proxy.bidask_subscribed.add(symbol)
    proxy.last_bidasks[symbol] = {
        "bid_prices": [38.0],
        "bid_volumes": [10],
        "ask_prices": [38.1],
        "ask_volumes": [10],
        "timestamp": stale_symbol_time,
        "confirmed_at": stale_symbol_time,
        "session_epoch": 7,
    }
    status_code, payload = proxy._orderbook_payload(symbol, refresh=False)

    assert status_code == 503
    assert payload["status"] == "stale_depth"
    assert payload["confirmation_mode"] == "stale_symbol_event"


def test_quote_session_events_fail_close_during_reconnect_and_recover_after_up(monkeypatch):
    proxy = _load_proxy_main()
    proxy._session_epoch = 7
    proxy._quote_session_up = True
    monkeypatch.setattr(proxy, "active_orderbook_watch_symbols", lambda *_args: [])

    proxy._handle_quote_session_event(200, 12, "MKT", "Reconnecting", 7)

    assert proxy._quote_session_up is False
    assert proxy._quote_session_event_code == 12

    proxy._handle_quote_session_event(200, 13, "MKT", "Reconnected", 7)

    assert proxy._quote_session_up is True
    assert proxy._quote_session_event_code == 13


def test_static_book_remains_stale_while_quote_session_is_down(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy._quote_session_up = False
    proxy._session_epoch = 7
    symbol = "4123"
    now = datetime(2026, 7, 16, 10, 30, 0, tzinfo=proxy.TW_TZ)
    stale_symbol_time = (now - proxy.timedelta(seconds=30)).isoformat()
    monkeypatch.setattr(proxy, "get_tw_now", lambda: now)
    proxy.bidask_subscribed.add(symbol)
    proxy.last_bidasks[symbol] = {
        "bid_prices": [38.0],
        "bid_volumes": [10],
        "ask_prices": [38.1],
        "ask_volumes": [10],
        "timestamp": stale_symbol_time,
        "confirmed_at": stale_symbol_time,
        "session_epoch": 7,
    }
    status_code, payload = proxy._orderbook_payload(symbol, refresh=False)

    assert status_code == 503
    assert payload["status"] == "stale_depth"
    assert payload["confirmation_mode"] == "stale_symbol_event"


def test_watchdog_does_not_recover_unchanged_book_at_execution_freshness_boundary(monkeypatch):
    proxy = _load_proxy_main()
    proxy.connected = True
    proxy._quote_session_up = True
    symbol = "4123"
    now = datetime.now(proxy.TW_TZ)
    thirty_seconds_ago = (now - proxy.timedelta(seconds=30)).isoformat()
    proxy.watched_orderbook_symbols[symbol] = time.time() + 60
    proxy.last_bidasks[symbol] = {
        "bid_prices": [38.0],
        "bid_volumes": [10],
        "ask_prices": [38.1],
        "ask_volumes": [10],
        "timestamp": thirty_seconds_ago,
        "updated_at": thirty_seconds_ago,
        "confirmed_at": thirty_seconds_ago,
    }
    proxy.bidask_stats[symbol] = {"last_event_at": now.isoformat()}
    calls: list[str] = []
    monkeypatch.setattr(proxy, "recover_orderbook_symbol", lambda symbol_arg, *_args: calls.append(symbol_arg))
    monkeypatch.setattr(proxy, "reset_shioaji_connection", lambda *_args: (_ for _ in ()).throw(AssertionError("healthy channel must not reconnect")))

    proxy._watchdog_once()

    assert calls == []


def test_batch_orderbook_refresh_uses_one_shared_deadline(monkeypatch):
    proxy = _load_proxy_main()
    proxy.api = object()
    proxy.connected = True
    proxy.last_bidasks.clear()
    monkeypatch.setattr(proxy, "orderbook_refresh_wait_seconds", lambda: 0.1)
    monkeypatch.setattr(proxy, "recover_orderbook_symbol_async", lambda *_args, **_kwargs: None)

    started = time.monotonic()
    try:
        proxy.batch_orderbooks(proxy.BatchRequest(symbols=["4123", "4541"]))
        raise AssertionError("execution-critical empty batch must fail closed")
    except proxy.HTTPException as exc:
        assert exc.status_code == 503
        assert exc.detail["status"] == "empty"
        assert exc.detail["error_count"] == 2
    elapsed = time.monotonic() - started

    assert elapsed < 0.18


def test_async_recovery_is_singleflight_per_symbol(monkeypatch):
    proxy = _load_proxy_main()
    proxy.subscription_recovery.clear()
    proxy._streaming_control_inflight = False
    proxy._quote_session_up = True
    entered = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def blocking_subscribe(symbol: str, **_kwargs):
        calls.append(symbol)
        entered.set()
        release.wait(timeout=1)
        return False

    monkeypatch.setattr(proxy, "subscribe_symbol", blocking_subscribe)
    proxy.recover_orderbook_symbol_async("4123", "request_stale_depth")
    assert entered.wait(timeout=1)
    proxy.recover_orderbook_symbol_async("4123", "request_stale_depth")
    time.sleep(0.02)
    release.set()
    time.sleep(0.02)

    assert calls == ["4123"]


def test_confirmation_resets_backoff_without_dropping_singleflight_state():
    proxy = _load_proxy_main()
    key = "board_lot:4123"
    proxy.subscription_recovery[key] = {
        "consecutive_failures": 4,
        "next_attempt_at": time.time() + 120,
        "inflight": True,
    }
    confirmed_at = datetime.now(proxy.TW_TZ).isoformat()

    proxy._confirm_orderbook_recovery("4123", {
        "bid_prices": [38.0],
        "ask_prices": [38.1],
        "confirmed_at": confirmed_at,
    })

    state = proxy.subscription_recovery[key]
    assert state["consecutive_failures"] == 0
    assert state["next_attempt_at"] == 0.0
    assert state["inflight"] is True
    assert state["last_confirmed_at"] == confirmed_at


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


def test_tick_normalization_accepts_current_tickstkv1_without_bid_ask_fields():
    proxy = _load_proxy_main()
    tick_time = datetime(2026, 7, 15, 10, 45, 1, tzinfo=proxy.TW_TZ)
    tick = SimpleNamespace(
        code="4123",
        close=37.7,
        volume=1,
        total_volume=1234,
        open=37.5,
        high=37.8,
        low=37.4,
        price_chg=0.3,
        pct_chg=0.8,
        datetime=tick_time,
    )

    normalized = proxy.normalize_stock_tick(tick, 7)

    assert normalized["symbol"] == "4123"
    assert normalized["price"] == 37.7
    assert normalized["bid"] is None
    assert normalized["ask"] is None
    assert normalized["timestamp"] == tick_time.isoformat()
    assert normalized["session_epoch"] == 7
